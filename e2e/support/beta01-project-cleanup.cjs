"use strict";
/*
 * Beta 0.1 — project-aware cleanup with storage verification (Gate 1, fix 2b).
 *
 * Único criterio de cleanup de datos/storage, diseñado para que una respuesta
 * perdida, un token vencido o un body que no parsea jamás dejen residuo:
 *
 *   1. registerProjectMarker(ownerId, projectName) se llama ANTES de disparar
 *      la creación UI. El marcador es único (owner_id + project_name) y
 *      permite a run() reconciliar/buscar el project ID en teardown aunque la
 *      respuesta de create/upload nunca llegó o su JSON falló al parsear
 *      (findProjectByMarker consulta projects por owner+name).
 *   2. organization/workspace/matter usan UUID preasignados y se registran
 *      con registerUuid() ANTES de cada POST; si el POST nunca ocurrió la
 *      fila no existe y el borrado es idempotente (404/cero filas = éxito).
 *   3. NO hay callbacks directos de document/version/matter: borrar esas
 *      filas antes del DELETE del proyecto rompería el descubrimiento de
 *      storage (el backend ya no vería document_versions para borrar sus
 *      objetos). Orden obligatorio en run(): deleteAndVerifyProject PRIMERO
 *      (observa documents/versions/storage mientras existen) y DESPUÉS el
 *      cleanup organization/cascade con los UUID pre-registrados.
 *   4. deleteAndVerifyProject captura el scope del proyecto (documentIds,
 *      versionIds, storage paths, executionIds, reviewIds) ANTES de borrar,
 *      borra vía API del backend y exige read-back cero para project,
 *      documents, document_versions y TODA fila business ligada
 *      (ai_executions, ai_reviews, ai_review_items, ai_review_decisions,
 *      ai_review_exports, ai_review_drive_publications,
 *      ai_document_version_pages, ai_output_versions, ai_receipts, chats,
 *      tabular_reviews, project_subfolders) y que los storage paths
 *      capturados ya no existan en MinIO/R2. Un 2xx por sí solo NO basta.
 *   5. Cualquier residuo o paso fallido hace que run() lance (FAIL).
 *
 * Todo el I/O está inyectado para que la MISMA lógica corra contra el stack
 * local real (e2e/beta01-setup-smoke.spec.ts y
 * e2e/beta01-integrated-journey.spec.ts) y contra un fake en memoria con
 * cero red (scripts/test-beta01-project-cleanup.sh):
 *
 *   findProjectByMarker(ownerId, projectName) -> Promise<string|null>
 *   deleteProject(projectId)                   -> Promise<{status,text}>
 *   loadProjectScope(projectId)                -> Promise<{
 *       documentIds, versionIds, storagePaths, executionIds, reviewIds }>
 *   count(table, column, values)               -> Promise<number>
 *   deleteUuid(table, id)                      -> Promise<void>
 *   storagePathsExist(paths)                   -> Promise<string[]>  // aún existen
 */

class ProjectCleanup {
  constructor(clients) {
    this._clients = clients;
    this._markers = []; // { ownerId, projectName, projectId }
    this._uuids = []; // { table, id }
  }

  // ANTES de disparar la creación UI: registra el marcador único
  // owner_id + project_name. Con él, run() reconcilia el ID aunque la
  // respuesta se pierda/venza o su body falle al parsear.
  registerProjectMarker(ownerId, projectName) {
    this._markers.push({ ownerId, projectName, projectId: null });
    return this;
  }

  // Cuando la respuesta/URL finalmente revela el project ID.
  adoptProjectId(projectId) {
    const pending = [...this._markers]
      .reverse()
      .find((marker) => marker.projectId === null);
    if (pending) pending.projectId = projectId;
    return this;
  }

  // ANTES de cada POST de organization/workspace/matter (UUID preasignado).
  // Si el POST no ocurrió, la ausencia es idempotente (404/cero filas).
  registerUuid(table, id) {
    this._uuids.push({ table, id });
    return this;
  }

  async deleteAndVerifyProject(projectId) {
    // Observa storage/rows ANTES de borrar nada (el backend debe poder ver
    // document_versions para descubrir y borrar sus objetos en MinIO/R2).
    const scope = await this._clients.loadProjectScope(projectId);
    const result = await this._clients.deleteProject(projectId);
    if (result.status !== 204 && result.status !== 404) {
      throw new Error(
        `Project cleanup failed: ${result.status} ${result.text}`,
      );
    }

    // Read-back cero: project + documents + document_versions + filas
    // business ligadas al proyecto.
    const zeroChecks = [
      ["projects", "id", [projectId]],
      ["documents", "project_id", [projectId]],
      ["document_versions", "document_id", scope.documentIds],
      ["ai_document_version_pages", "document_version_id", scope.versionIds],
      ["ai_executions", "project_id", [projectId]],
      ["ai_output_versions", "execution_id", scope.executionIds],
      ["ai_receipts", "execution_id", scope.executionIds],
      ["ai_reviews", "project_id", [projectId]],
      ["ai_review_items", "review_id", scope.reviewIds],
      ["ai_review_decisions", "review_id", scope.reviewIds],
      ["ai_review_exports", "project_id", [projectId]],
      ["ai_review_drive_publications", "project_id", [projectId]],
      ["chats", "project_id", [projectId]],
      ["tabular_reviews", "project_id", [projectId]],
      ["project_subfolders", "project_id", [projectId]],
    ];
    const residue = [];
    for (const [table, column, values] of zeroChecks) {
      if (values.length === 0) continue;
      const remaining = await this._clients.count(table, column, values);
      if (remaining > 0) residue.push(`${table}(${column}=${values.join(",")}):${remaining}`);
    }

    // Storage: los paths capturados ya no deben existir en MinIO/R2.
    const stillThere = await this._clients.storagePathsExist(scope.storagePaths);
    if (stillThere.length > 0) {
      residue.push(`storage:${stillThere.join(",")}`);
    }

    if (residue.length > 0) {
      throw new Error(
        `deleteAndVerifyProject residue for ${projectId}: ${residue.join("; ")}`,
      );
    }
  }

  // Orden obligatorio: deleteAndVerifyProject PRIMERO (ve documents/versions/
  // storage), luego el cleanup organization/cascade de los UUID preasignados.
  async run() {
    const failures = [];

    for (const marker of this._markers) {
      const projectId =
        marker.projectId ??
        (await this._clients.findProjectByMarker(
          marker.ownerId,
          marker.projectName,
        ));
      if (!projectId) continue; // nunca se creó: idempotente
      try {
        await this.deleteAndVerifyProject(projectId);
      } catch (error) {
        failures.push(
          `project ${projectId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    for (const { table, id } of this._uuids) {
      try {
        await this._clients.deleteUuid(table, id); // idempotente ante ausencia
        const remaining = await this._clients.count(table, "id", [id]);
        if (remaining > 0) {
          failures.push(`${table} ${id}: ${remaining} rows remain`);
        }
      } catch (error) {
        failures.push(
          `${table} ${id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `ProjectCleanup FAILED (${failures.length}): ${failures.join("; ")}`,
      );
    }
  }
}

module.exports = { ProjectCleanup };