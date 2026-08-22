#!/usr/bin/env bash
#
# Contractual test for the Beta 0.1 project-aware cleanup (Gate 1, fix 2b).
#
# Demonstrates, WITHOUT raising the stack and with ZERO network, that the
# cleanup helper (e2e/support/beta01-project-cleanup.cjs) satisfies the único
# criterio de cleanup de datos/storage:
#
#   c1. respuesta de create/upload PERDIDA y body inválido: el marcador
#       owner_id + project_name reconcilia el project ID (findProjectByMarker)
#       y el cleanup borra project + documents + versions + objetos;
#   c2. fallo parcial: UUID preasignados de organization/workspace/matter se
#       registran ANTES de cada POST y se limpian aunque un POST no ocurrió
#       (ausencia idempotente); cuando un delete falla, el resto se limpia y
#       el fallo se reporta;
#   c3. deleteAndVerifyProject observa STORAGE ANTES de las rows (captura los
#       storage paths mientras document_versions existe) y verifica cero filas
#       (project, documents, document_versions y filas business ligadas) y
#       cero objetos en MinIO/R2; un 2xx solo NO basta;
#   c4. cualquier residuo hace FAIL: un objeto de storage que sobrevive al
#       DELETE o un delete de proyecto que falla hacen que run() lance y
#       reporte.
#
# The storage/DB/API clients are FAKES in-memory with the same interface the
# spec injects; globalThis.fetch is replaced by a spy that fails hard, so this
# test can never touch HTTP.
#
# Usage: bash scripts/test-beta01-project-cleanup.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLEANUP_HELPER="$ROOT/e2e/support/beta01-project-cleanup.cjs"
TMP="$(mktemp -d /tmp/beta01-project-cleanup.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

TEST_PROGRAM="$TMP/cleanup-contract.cjs"
cat >"$TEST_PROGRAM" <<'NODE'
"use strict";

const helperPath = process.argv[2];
if (!helperPath) throw new Error("missing helper path");
const { ProjectCleanup } = require(helperPath);

// ZERO network: any fetch in this contractual test is a bug.
globalThis.fetch = async function spyFetch() {
  throw new Error("project-cleanup contractual test must never perform HTTP requests");
};

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures += 1;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// In-memory fake stack with the same client surface the spec injects into
// ProjectCleanup: findProjectByMarker / loadProjectScope / deleteProject /
// count / deleteUuid / storagePathsExist.
//
// Rows are plain objects with string ids. The fake deleteProject mimics the
// backend contract (deleteUserProjects + FK cascades): it deletes the project
// row, its documents/document_versions and the ai_* business rows, and deletes
// the storage objects DISCOVERED from document_versions while they still
// exist. deleteUuid mimics the REST DELETE with FK cascade for
// organization → workspace → matter → memberships. An event log records every
// call so the test can prove ORDER.
// ---------------------------------------------------------------------------
function fakeStack(options = {}) {
  const tables = new Map();
  const storage = new Map(); // path -> true
  const events = [];
  const leakObjects = options.leakObjects ?? false; // c4: residuo de storage
  const failProjectDelete = options.failProjectDelete ?? false;

  function rows(table) {
    return tables.get(table) ?? [];
  }

  function rowsWhere(table, column, values) {
    const wanted = new Set(values);
    return rows(table).filter((row) => wanted.has(String(row[column])));
  }

  function removeWhere(table, column, values) {
    const wanted = new Set(values);
    const remaining = rows(table).filter(
      (row) => !wanted.has(String(row[column])),
    );
    tables.set(table, remaining);
    return remaining;
  }

  function seed(table, row) {
    const current = rows(table);
    current.push({ ...row });
    tables.set(table, current);
  }

  function unique(values) {
    return [...new Set(values.filter((v) => typeof v === "string" && v.length > 0))];
  }

  // Cascada FK: organizations → (organization_memberships, workspaces) →
  // (workspace_memberships, matters) → (matter_memberships).
  function cascadeDelete(table, id) {
    if (table === "matters") {
      removeWhere("matters", "id", [id]);
      removeWhere("matter_memberships", "matter_id", [id]);
    } else if (table === "workspaces") {
      removeWhere("workspaces", "id", [id]);
      removeWhere("workspace_memberships", "workspace_id", [id]);
      const matterIds = unique(
        rowsWhere("matters", "workspace_id", [id]).map((r) => String(r.id)),
      );
      removeWhere("matters", "id", matterIds);
      removeWhere("matter_memberships", "matter_id", matterIds);
    } else if (table === "organizations") {
      removeWhere("organizations", "id", [id]);
      removeWhere("organization_memberships", "organization_id", [id]);
      const workspaceIds = unique(
        rowsWhere("workspaces", "organization_id", [id]).map((r) => String(r.id)),
      );
      removeWhere("workspaces", "id", workspaceIds);
      removeWhere("workspace_memberships", "workspace_id", workspaceIds);
      const matterIds = unique(
        workspaceIds.flatMap((wsId) =>
          rowsWhere("matters", "workspace_id", [wsId]).map((r) => String(r.id)),
        ),
      );
      removeWhere("matters", "id", matterIds);
      removeWhere("matter_memberships", "matter_id", matterIds);
    }
  }

  const clients = {
    // c1: reconcilia por marcador único owner_id + project_name aunque la
    // respuesta se perdió (el caller nunca adoptó el ID).
    async findProjectByMarker(ownerId, projectName) {
      events.push(`findProjectByMarker:${ownerId}:${projectName}`);
      const found = rows("projects").find(
        (row) => row.user_id === ownerId && row.name === projectName,
      );
      return found ? String(found.id) : null;
    },

    // Observa storage ANTES de borrar rows: si las versiones existen, sus
    // storage paths se capturan aquí (el backend fake los borrará después).
    async loadProjectScope(projectId) {
      events.push(`loadProjectScope:${projectId}`);
      const documentIds = unique(
        rowsWhere("documents", "project_id", [projectId]).map((r) => String(r.id)),
      );
      const versionIds = unique(
        documentIds.flatMap((docId) =>
          rowsWhere("document_versions", "document_id", [docId]).map((r) => String(r.id)),
        ),
      );
      const storagePaths = unique(
        documentIds.flatMap((docId) =>
          rowsWhere("document_versions", "document_id", [docId]).flatMap((row) =>
            [row.storage_path, row.pdf_storage_path].filter(
              (p) => typeof p === "string" && p.length > 0,
            ),
          ),
        ),
      );
      const executionIds = unique(
        rowsWhere("ai_executions", "project_id", [projectId]).map((r) => String(r.id)),
      );
      const reviewIds = unique(
        rowsWhere("ai_reviews", "project_id", [projectId]).map((r) => String(r.id)),
      );
      return { documentIds, versionIds, storagePaths, executionIds, reviewIds };
    },

    // DELETE /projects/:id del backend: borra el proyecto, sus filas
    // business (cascada) y los objetos descubiertos desde document_versions
    // MIENTRAS las versiones existen. Si las versiones se borraran antes, no
    // habría paths que descubrir — el helper garantiza el orden opuesto.
    async deleteProject(projectId) {
      events.push(`deleteProject:${projectId}`);
      if (failProjectDelete) {
        throw new Error("boom (deleteProject failed)");
      }
      const documentIds = unique(
        rowsWhere("documents", "project_id", [projectId]).map((r) => String(r.id)),
      );
      const discovered = unique(
        documentIds.flatMap((docId) =>
          rowsWhere("document_versions", "document_id", [docId]).flatMap((row) =>
            [row.storage_path, row.pdf_storage_path].filter(
              (p) => typeof p === "string" && p.length > 0,
            ),
          ),
        ),
      );
      if (!leakObjects) {
        for (const path of discovered) storage.delete(path);
      }
      const executionIds = unique(
        rowsWhere("ai_executions", "project_id", [projectId]).map((r) => String(r.id)),
      );
      const reviewIds = unique(
        rowsWhere("ai_reviews", "project_id", [projectId]).map((r) => String(r.id)),
      );
      removeWhere("documents", "project_id", [projectId]);
      removeWhere("document_versions", "document_id", documentIds);
      // Filas con FK directa al proyecto.
      for (const table of [
        "ai_document_version_pages",
        "ai_executions",
        "ai_reviews",
        "ai_review_exports",
        "ai_review_drive_publications",
        "chats",
        "tabular_reviews",
        "project_subfolders",
      ]) {
        removeWhere(table, "project_id", [projectId]);
      }
      // Filas ligadas vía execution_id / review_id (sin columna project_id).
      removeWhere("ai_output_versions", "execution_id", executionIds);
      removeWhere("ai_receipts", "execution_id", executionIds);
      removeWhere("ai_review_items", "review_id", reviewIds);
      removeWhere("ai_review_decisions", "review_id", reviewIds);
      removeWhere("projects", "id", [projectId]);
      return { status: 204, text: "" };
    },

    // Read-back: cuántas filas de `table` tienen `column` en `values`.
    async count(table, column, values) {
      events.push(`count:${table}:${column}:${values.join(",")}`);
      return rowsWhere(table, column, values).length;
    },

    // DELETE REST idempotente por UUID preasignado con cascada FK;
    // ausencia = 404 = éxito.
    async deleteUuid(table, id) {
      events.push(`deleteUuid:${table}:${id}`);
      const existed = rowsWhere(table, "id", [id]).length > 0;
      if (existed) cascadeDelete(table, id);
      return { status: existed ? 204 : 404, text: "" };
    },

    // Probes MinIO/R2: devuelve SOLO los paths que aún existen.
    async storagePathsExist(paths) {
      events.push(`storagePathsExist:${paths.join(",") || "(none)"}`);
      return paths.filter((path) => storage.has(path));
    },

    // Test surface.
    _seed: seed,
    _storage: storage,
    _events: events,
    _rows: rows,
  };
  return clients;
}

function seedJourney(stack, projectId, ownerId, projectName) {
  stack._seed("projects", { id: projectId, user_id: ownerId, name: projectName });
  stack._seed("documents", { id: "doc-1", project_id: projectId, status: "ready" });
  stack._seed("document_versions", {
    id: "version-1",
    document_id: "doc-1",
    storage_path: `documents/${ownerId}/doc-1/source.docx`,
    pdf_storage_path: `documents/${ownerId}/doc-1/convert.pdf`,
  });
  stack._storage.set(`documents/${ownerId}/doc-1/source.docx`, true);
  stack._storage.set(`documents/${ownerId}/doc-1/convert.pdf`, true);
  stack._seed("ai_document_version_pages", {
    id: "page-1",
    document_id: "doc-1",
    document_version_id: "version-1",
    project_id: projectId,
    page: 1,
    content: "x",
    content_sha256: "a".repeat(64),
  });
  stack._seed("ai_executions", {
    id: "exec-1",
    project_id: projectId,
    document_id: "doc-1",
    document_version_id: "version-1",
    status: "succeeded",
  });
  stack._seed("ai_output_versions", { id: "output-1", execution_id: "exec-1" });
  stack._seed("ai_receipts", { id: "receipt-1", execution_id: "exec-1" });
  stack._seed("ai_reviews", {
    id: "review-1",
    execution_id: "exec-1",
    matter_id: "matter-1",
    project_id: projectId,
    reviewer_user_id: "reviewer-1",
    status: "approved",
  });
  stack._seed("ai_review_items", { id: "item-1", review_id: "review-1", project_id: projectId });
  stack._seed("ai_review_decisions", { id: "decision-1", review_id: "review-1", project_id: projectId });
  stack._seed("ai_review_exports", {
    id: "export-1",
    review_id: "review-1",
    execution_id: "exec-1",
    matter_id: "matter-1",
    project_id: projectId,
    content_sha256: "b".repeat(64),
  });
  stack._seed("ai_review_drive_publications", {
    id: "publication-1",
    review_id: "review-1",
    execution_id: "exec-1",
    matter_id: "matter-1",
    project_id: projectId,
    status: "published",
    sha256: "c".repeat(64),
  });
  stack._seed("chats", { id: "chat-1", project_id: projectId });
  stack._seed("tabular_reviews", { id: "tabular-1", project_id: projectId });
  stack._seed("project_subfolders", { id: "folder-1", project_id: projectId });
}

function seedTenant(stack, ids) {
  stack._seed("organizations", { id: ids.organizationId, name: "org" });
  stack._seed("organization_memberships", {
    organization_id: ids.organizationId,
    user_id: "owner-1",
    role: "org_owner",
  });
  stack._seed("workspaces", {
    id: ids.workspaceId,
    organization_id: ids.organizationId,
    name: "ws",
  });
  stack._seed("workspace_memberships", {
    workspace_id: ids.workspaceId,
    user_id: "owner-1",
    role: "workspace_admin",
  });
  stack._seed("matters", {
    id: ids.matterId,
    workspace_id: ids.workspaceId,
    project_id: "proj-1",
    name: "matter",
    status: "open",
  });
  stack._seed("matter_memberships", {
    matter_id: ids.matterId,
    user_id: "owner-1",
    role: "matter_owner",
  });
}

// Simula el POST de matter que NO ocurrió: registra los UUID preasignados
// ANTES de cada POST pero deja matter (y su membership) sin crear.
function seedTenantWithoutMatter(stack, ids) {
  stack._seed("organizations", { id: ids.organizationId, name: "org" });
  stack._seed("organization_memberships", {
    organization_id: ids.organizationId,
    user_id: "owner-1",
    role: "org_owner",
  });
  stack._seed("workspaces", {
    id: ids.workspaceId,
    organization_id: ids.organizationId,
    name: "ws",
  });
  stack._seed("workspace_memberships", {
    workspace_id: ids.workspaceId,
    user_id: "owner-1",
    role: "workspace_admin",
  });
}

async function main() {
  // -------------------------------------------------------------------------
  // c1 — respuesta de create/upload PERDIDA y body inválido: el marcador
  // reconciliado deja cero filas y cero objetos.
  // -------------------------------------------------------------------------
  {
    const stack = fakeStack();
    const ownerId = "owner-1";
    const projectName = "Beta 0.1 synthetic MSA contract";
    const cleanup = new ProjectCleanup(stack);
    // Registro ANTES de disparar la creación UI (el marcador aún no tiene ID).
    cleanup.registerProjectMarker(ownerId, projectName);
    // "La UI creó" el proyecto y PERDIÓ la respuesta / el body no parseó:
    // el caller nunca adoptó el project ID.
    seedJourney(stack, "proj-1", ownerId, projectName);
    await cleanup.run();

    check("c1 reconcilia project por marcador owner+name",
      stack._events.some((e) => e.startsWith("findProjectByMarker")),
      stack._events.filter((e) => e.startsWith("findProjectByMarker")).join(","));
    check("c1 zero projects", (await stack.count("projects", "id", ["proj-1"])) === 0);
    check("c1 zero documents", (await stack.count("documents", "project_id", ["proj-1"])) === 0);
    check("c1 zero document_versions",
      (await stack.count("document_versions", "document_id", ["doc-1"])) === 0);
    check("c1 zero ai_executions",
      (await stack.count("ai_executions", "project_id", ["proj-1"])) === 0);
    check("c1 zero ai_reviews",
      (await stack.count("ai_reviews", "project_id", ["proj-1"])) === 0);
    check("c1 zero storage objects",
      (await stack.storagePathsExist([
        `documents/${ownerId}/doc-1/source.docx`,
        `documents/${ownerId}/doc-1/convert.pdf`,
      ])).length === 0);
    // El marcador NO reconcilia proyectos de otros owners con el mismo nombre.
    stack._seed("projects", { id: "proj-other", user_id: "owner-2", name: projectName });
    const other = await stack.findProjectByMarker(ownerId, projectName);
    check("c1 marker scoped to owner+name", other === null || String(other) !== "proj-other",
      `found=${other}`);
  }

  // -------------------------------------------------------------------------
  // c2 — fallo parcial: UUID preasignados registrados ANTES del POST se
  // limpian aunque un POST no ocurrió (ausencia idempotente); y si un delete
  // falla, el resto se limpia igual y el fallo se reporta.
  // -------------------------------------------------------------------------
  {
    const stack = fakeStack();
    const cleanup = new ProjectCleanup(stack);
    const ids = { organizationId: "org-1", workspaceId: "ws-1", matterId: "matter-1" };
    // Registro ANTES de cada POST (el POST de matter nunca ocurrió aquí).
    cleanup.registerUuid("organizations", ids.organizationId);
    cleanup.registerUuid("workspaces", ids.workspaceId);
    cleanup.registerUuid("matters", ids.matterId);
    // Org y workspace SÍ se crearon; el POST de matter falló: no hay fila.
    seedTenantWithoutMatter(stack, ids);

    await cleanup.run();
    check("c2 org cleaned", (await stack.count("organizations", "id", [ids.organizationId])) === 0);
    check("c2 workspace cleaned", (await stack.count("workspaces", "id", [ids.workspaceId])) === 0);
    check("c2 matter absence idempotent", (await stack.count("matters", "id", [ids.matterId])) === 0);
    check("c2 organization_memberships cascade cleaned",
      (await stack.count("organization_memberships", "organization_id", [ids.organizationId])) === 0);
    check("c2 workspace_memberships cascade cleaned",
      (await stack.count("workspace_memberships", "workspace_id", [ids.workspaceId])) === 0);

    // Variante B: un delete falla (boom) pero los demás UUIDs se limpian y el
    // fallo se reporta (nunca pasa residuo en silencio).
    const stackB = fakeStack();
    const realDeleteUuid = stackB.deleteUuid.bind(stackB);
    stackB.deleteUuid = async (table, id) => {
      if (table === "workspaces") throw new Error("boom (delete de workspace)");
      return realDeleteUuid(table, id);
    };
    const cleanupB = new ProjectCleanup(stackB);
    cleanupB.registerUuid("organizations", "org-2");
    cleanupB.registerUuid("workspaces", "ws-2");
    cleanupB.registerUuid("matters", "matter-2");
    seedTenant(stackB, {
      organizationId: "org-2",
      workspaceId: "ws-2",
      matterId: "matter-2",
    });
    let cleanupBError = null;
    try {
      await cleanupB.run();
    } catch (error) {
      cleanupBError = error;
    }
    check("c2b partial UUID failure is reported",
      cleanupBError !== null && String(cleanupBError.message).includes("workspaces"),
      cleanupBError ? cleanupBError.message : "run() no lanzó");
    check("c2b org still cleaned despite later failure",
      (await stackB.count("organizations", "id", ["org-2"])) === 0);
    check("c2b matter with failing sibling still cleaned",
      (await stackB.count("matters", "id", ["matter-2"])) === 0);
  }

  // -------------------------------------------------------------------------
  // c3 — deleteAndVerifyProject observa STORAGE ANTES de las rows y verifica
  // cero filas y cero objetos; 2xx solo NO basta (aunque el DELETE devolvió
  // 204, el helper exige read-back cero).
  // -------------------------------------------------------------------------
  {
    const stack = fakeStack();
    const ownerId = "owner-1";
    const projectName = "Beta 0.1 synthetic MSA order";
    const cleanup = new ProjectCleanup(stack);
    cleanup.registerProjectMarker(ownerId, projectName);
    seedJourney(stack, "proj-3", ownerId, projectName);
    cleanup.adoptProjectId("proj-3"); // la URL/response sí reveló el ID
    await cleanup.run();

    // Orden: loadProjectScope (observa storage) ANTES de deleteProject.
    const scopeIdx = stack._events.indexOf("loadProjectScope:proj-3");
    const deleteIdx = stack._events.indexOf("deleteProject:proj-3");
    check("c3 storage observed before rows", scopeIdx >= 0 && deleteIdx > scopeIdx,
      `scope@${scopeIdx} delete@${deleteIdx}`);
    // Read-back cero incluyendo filas business ligadas.
    for (const [table, column, values, label] of [
      ["projects", "id", ["proj-3"], "projects"],
      ["documents", "project_id", ["proj-3"], "documents"],
      ["document_versions", "document_id", ["doc-1"], "document_versions"],
      ["ai_document_version_pages", "project_id", ["proj-3"], "ai_document_version_pages"],
      ["ai_executions", "project_id", ["proj-3"], "ai_executions"],
      ["ai_output_versions", "execution_id", ["exec-1"], "ai_output_versions"],
      ["ai_receipts", "execution_id", ["exec-1"], "ai_receipts"],
      ["ai_reviews", "project_id", ["proj-3"], "ai_reviews"],
      ["ai_review_items", "review_id", ["review-1"], "ai_review_items"],
      ["ai_review_decisions", "review_id", ["review-1"], "ai_review_decisions"],
      ["ai_review_exports", "project_id", ["proj-3"], "ai_review_exports"],
      ["ai_review_drive_publications", "project_id", ["proj-3"], "ai_review_drive_publications"],
      ["chats", "project_id", ["proj-3"], "chats"],
      ["tabular_reviews", "project_id", ["proj-3"], "tabular_reviews"],
      ["project_subfolders", "project_id", ["proj-3"], "project_subfolders"],
    ]) {
      const remaining = await stack.count(table, column, values);
      check(`c3 zero ${label}`, remaining === 0, `remaining=${remaining}`);
    }
    // Objetos: cero en MinIO/R2 (probe directo, no confía en el 2xx).
    const stillThere = await stack.storagePathsExist([
      `documents/${ownerId}/doc-1/source.docx`,
      `documents/${ownerId}/doc-1/convert.pdf`,
    ]);
    check("c3 zero storage objects", stillThere.length === 0,
      `still=${stillThere.join(",") || "none"}`);
  }

  // -------------------------------------------------------------------------
  // c4 — cualquier residuo hace FAIL: un objeto de storage que sobrevive al
  // DELETE (backend falló) hace que run() lance y reporte; lo mismo si el
  // DELETE del proyecto lanza.
  // -------------------------------------------------------------------------
  {
    const stack = fakeStack({ leakObjects: true }); // el backend "olvidó" borrar objetos
    const ownerId = "owner-1";
    const projectName = "Beta 0.1 synthetic MSA leak";
    const cleanup = new ProjectCleanup(stack);
    cleanup.registerProjectMarker(ownerId, projectName);
    seedJourney(stack, "proj-4", ownerId, projectName);
    let residueError = null;
    try {
      await cleanup.run();
    } catch (error) {
      residueError = error;
    }
    check("c4 storage residue makes FAIL",
      residueError !== null && String(residueError.message).includes("storage"),
      residueError ? residueError.message : "run() no lanzó");

    const stackProj = fakeStack({ failProjectDelete: true });
    const cleanupProj = new ProjectCleanup(stackProj);
    cleanupProj.registerProjectMarker("owner-1", "Beta 0.1 synthetic MSA boom");
    seedJourney(stackProj, "proj-5", "owner-1", "Beta 0.1 synthetic MSA boom");
    let projectError = null;
    try {
      await cleanupProj.run();
    } catch (error) {
      projectError = error;
    }
    check("c4 failed project delete is reported",
      projectError !== null && String(projectError.message).includes("deleteProject"),
      projectError ? projectError.message : "run() no lanzó");
  }

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`FAIL unhandled: ${error.message}`);
  process.exit(1);
});
NODE

node "$TEST_PROGRAM" "$CLEANUP_HELPER"
echo "ALL PASS — beta01 project cleanup contractual test OK"