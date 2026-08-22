import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";

/**
 * Beta 0.1 — journey gate 1: deterministic setup smoke.
 *
 * Runs ONLY the setup + upload leg of the integrated journey (later gates
 * add AI execution, human review and Drive publication). Against the stack
 * booted by scripts/e2e-beta01-setup-smoke.sh it must:
 *   1. autenticar al owner contra el Supabase local;
 *   2. crear un proyecto y un matter privado (sólo el owner es miembro);
 *   3. cargar e2e/fixtures/beta01-contract.docx por la UI;
 *   4. confirmar HTTP 201 y la metadata de la versión: version_number=1,
 *      content hash del fixture, size_bytes y metadata de página;
 *   5. limpiar TODOS los recursos de negocio creados (proyecto, documento,
 *      versión, matter, organización) dejando EXACTAMENTE una cuenta auth
 *      fixture reutilizable (beta01-owner@local.test); no se afirma
 *      "cero usuarios".
 *
 * Fixture determinista (Gate 1, fix 2): la identidad del owner es local y
 * determinista (beta01-owner@local.test, password fixture no secreto) y la
 * gestiona un helper idempotente (e2e/support/beta01-user-fixture.cjs):
 * lookup por email, crear sólo si falta, reutilizar si existe. Los usuarios
 * legacy `beta01-owner-*` acumulados por corridas anteriores se limpian UNA
 * sola vez por corrida, sólo bajo el guard local aprobado y sin tocar
 * usuarios ajenos; nunca en un target no-loopback.
 *
 * Target isolation: before ANY mutation (auth, REST seeds, uploads) the
 * local-only guard (e2e/support/beta01-target-guard.cjs) validates that
 * MIKE_API_BASE_URL, SUPABASE_URL and R2 endpoints are loopback and that the
 * keys belong to the local Supabase demo stack. Hostile/remote targets or an
 * inherited env var that conflicts with the wired .env reject the run here.
 */

const DOCX_FIXTURE = path.join(__dirname, "fixtures", "beta01-contract.docx");
// The guard resolves API_BASE below from env/.env; it stays a module-level
// default so apiRequest() reads the same validated value.
let API_BASE = "http://localhost:3001";

type RuntimeConfig = {
  supabaseUrl: string;
  serviceKey: string;
  anonKey: string;
};

type AuthUser = {
  id: string;
  email: string;
  password: string;
  accessToken: string;
};

type ApiResult = {
  status: number;
  data: unknown;
  text: string;
};

// Auth admin client interface (Supabase GoTrue admin + token endpoints).
// The same interface is faked by scripts/test-beta01-user-fixture.sh so the
// idempotent fixture logic is contractual without raising the stack.
type AuthAdminClient = {
  lookupByCredentials(
    email: string,
    password: string,
  ): Promise<{ id: string } | null>;
  createUser(email: string, password: string): Promise<{ id: string } | null>;
  listUsers(): Promise<Array<{ id: string; email: string }>>;
  deleteUser(id: string): Promise<void>;
};

// Registered-cleanup API backed by TrackedCleanup (helper): every business
// resource registers its deleteFn as soon as its ID is known; run() removes
// them in reverse registration order (children before parents) and reports
// any failure without skipping the remaining steps.
type TrackedCleanupApi = {
  register(label: string, deleteFn: () => Promise<void>): TrackedCleanupApi;
  size: number;
  run(): Promise<void>;
};

// Deterministic local fixture (Gate 1, fix 2): beta01-owner@local.test is a
// reusable auth identity managed by an idempotent helper
// (e2e/support/beta01-user-fixture.cjs): lookup por email, crear sólo si
// falta, reutilizar si existe. Password fixture NO secreto.
const {
  OWNER_FIXTURE,
  ensureFixtureUser,
  cleanLegacyOwnerUsers,
  TrackedCleanup,
} = require("../support/beta01-user-fixture.cjs") as {
  OWNER_FIXTURE: { email: string; password: string };
  ensureFixtureUser(
    authAdmin: AuthAdminClient,
    fixture: { email: string; password: string },
  ): Promise<{
    user: { id: string; email: string; password: string };
    created: boolean;
  }>;
  cleanLegacyOwnerUsers(
    authAdmin: AuthAdminClient,
    fixtureEmail: string,
  ): Promise<number>;
  TrackedCleanup: new () => TrackedCleanupApi;
};

// Same guard the smoke runner uses as fail-fast; it throws with sanitized
// errors (never key values) when a target is not local or conflicts with the
// wired .env. Must run BEFORE any auth/REST call in this spec.
const { assertLocalTargets } = require("../support/beta01-target-guard.cjs") as {
  assertLocalTargets(env?: NodeJS.ProcessEnv): {
    supabaseUrl: string;
    serviceKey: string;
    anonKey: string;
    apiBase: string;
  };
};

function runtimeConfig(): RuntimeConfig {
  const config = assertLocalTargets(process.env);
  API_BASE = config.apiBase;
  return {
    supabaseUrl: config.supabaseUrl,
    serviceKey: config.serviceKey,
    anonKey: config.anonKey,
  };
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function parseResponse(response: Response): Promise<ApiResult> {
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { status: response.status, data, text };
}

async function apiRequest(
  token: string,
  route: string,
  init: RequestInit = {},
): Promise<ApiResult> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  headers.set("Authorization", `Bearer ${token}`);
  return parseResponse(await fetch(`${API_BASE}${route}`, { ...init, headers }));
}

async function restRequest(
  config: RuntimeConfig,
  table: string,
  query = "",
  init: RequestInit = {},
): Promise<ApiResult> {
  const headers = new Headers(init.headers);
  headers.set("apikey", config.serviceKey);
  headers.set("Authorization", `Bearer ${config.serviceKey}`);
  headers.set("Accept", "application/json");
  return parseResponse(
    await fetch(`${config.supabaseUrl}/rest/v1/${table}${query}`, {
      ...init,
      headers,
    }),
  );
}

async function restInsert(
  config: RuntimeConfig,
  table: string,
  value: unknown,
): Promise<unknown> {
  const result = await restRequest(config, table, "", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(value),
  });
  if (result.status < 200 || result.status >= 300) {
    throw new Error(
      `Supabase seed ${table} failed: ${result.status} ${result.text}`,
    );
  }
  return result.data;
}

// Real Supabase auth-admin client (GoTrue admin + token endpoint). Same
// interface the contractual test fakes in-memory.
function createAuthAdminClient(config: RuntimeConfig): AuthAdminClient {
  return {
    async lookupByCredentials(email, password) {
      const response = await fetch(
        `${config.supabaseUrl}/auth/v1/token?grant_type=password`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: config.anonKey,
          },
          body: JSON.stringify({ email, password }),
        },
      );
      if (!response.ok) return null; // no existe o credenciales distintas
      const data = (await parseResponse(response)).data as {
        user?: { id?: string };
      } | null;
      return data?.user?.id ? { id: data.user.id } : null;
    },

    async createUser(email, password) {
      const response = await fetch(
        `${config.supabaseUrl}/auth/v1/admin/users`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: config.serviceKey,
            Authorization: `Bearer ${config.serviceKey}`,
          },
          body: JSON.stringify({ email, password, email_confirm: true }),
        },
      );
      const createdBody = await parseResponse(response);
      if (!response.ok && response.status !== 422) {
        throw new Error(
          `Supabase user seed failed: ${response.status} ${createdBody.text}`,
        );
      }
      if (!response.ok) return null; // 422: ya existe con otras credenciales
      const createdUser =
        createdBody.data && typeof createdBody.data === "object"
          ? (createdBody.data as { user?: { id?: string }; id?: string })
          : null;
      const id = createdUser?.user?.id ?? createdUser?.id;
      return id ? { id } : null;
    },

    async listUsers() {
      const response = await fetch(
        `${config.supabaseUrl}/auth/v1/admin/users?per_page=1000`,
        {
          headers: {
            apikey: config.serviceKey,
            Authorization: `Bearer ${config.serviceKey}`,
          },
        },
      );
      if (!response.ok) {
        throw new Error(`Supabase user list failed: ${response.status}`);
      }
      const data = (await parseResponse(response)).data as
        | Array<{ id: string; email: string }>
        | null;
      return Array.isArray(data) ? data : [];
    },

    async deleteUser(userId) {
      const response = await fetch(
        `${config.supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
        {
          method: "DELETE",
          headers: {
            apikey: config.serviceKey,
            Authorization: `Bearer ${config.serviceKey}`,
          },
        },
      );
      if (!response.ok && response.status !== 404) {
        throw new Error(`Supabase user cleanup failed: ${response.status}`);
      }
    },
  };
}

async function signIn(
  config: RuntimeConfig,
  credentials: { id: string; email: string; password: string },
): Promise<AuthUser> {
  const response = await fetch(
    `${config.supabaseUrl}/auth/v1/token?grant_type=password`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: config.anonKey,
      },
      body: JSON.stringify({
        email: credentials.email,
        password: credentials.password,
      }),
    },
  );
  const result = await parseResponse(response);
  const data = result.data as {
    access_token?: string;
    user?: { id?: string };
  } | null;
  if (!response.ok || !data?.access_token || data.user?.id !== credentials.id) {
    throw new Error(`Supabase sign-in failed: ${result.status} ${result.text}`);
  }
  return {
    ...credentials,
    accessToken: data.access_token,
  };
}

async function loginInUi(page: Page, user: AuthUser): Promise<void> {
  await page.goto("/login");
  await expect(page).toHaveURL(/\/login/);
  await page.fill("#email", user.email);
  await page.fill("#password", user.password);
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL(/\/assistant/, { timeout: 15_000 });
}

async function createProjectAndUploadDocx(
  page: Page,
  projectName: string,
  config: RuntimeConfig,
  owner: AuthUser,
  cleanup: TrackedCleanupApi,
): Promise<{
  projectId: string;
  uploadStatus: number;
  uploadBody: Record<string, unknown>;
}> {
  await page.goto("/projects");
  await expect(page.getByRole("button", { name: "New project" })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole("button", { name: "New project" }).click();
  await page.getByPlaceholder("Project name").fill(projectName);
  await page.getByRole("button", { name: "Next", exact: true }).click();

  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: /^Upload/ }).click();
  await (await chooser).setFiles(DOCX_FIXTURE);
  await expect(page.getByRole("button", { name: /^Upload \(1\)/ })).toBeVisible(
    { timeout: 5_000 },
  );
  const uploadResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /\/projects\/[0-9a-f-]{36}\/documents$/.test(response.url()),
    { timeout: 30_000 },
  );
  await page.locator('button[type="submit"]').click();
  const uploaded = await uploadResponse;

  // El POST /projects/<id>/documents es la confirmación SERVER-SIDE de la
  // creación: los IDs de proyecto/documento/versión se registran aquí mismo
  // ("conforme se crean"), antes de esperar la navegación UI, para que un
  // fallo posterior no deje recursos sin limpiar.
  const projectId = uploaded
    .url()
    .match(/\/projects\/([0-9a-f-]{36})\/documents$/)?.[1];
  if (!projectId)
    throw new Error(
      `Could not read project ID from upload response ${uploaded.url()}`,
    );
  const uploadBody = JSON.parse(await uploaded.text()) as Record<
    string,
    unknown
  >;
  cleanup.register("project", () =>
    deleteAndVerifyProject(config, owner, projectId),
  );
  const uploadStatus = uploaded.status();
  if (uploadStatus >= 200 && uploadStatus < 300) {
    cleanup.register("document", () =>
      deleteRowById(config, "documents", String(uploadBody.id)),
    );
    cleanup.register("version", () =>
      deleteRowById(
        config,
        "document_versions",
        String(uploadBody.current_version_id),
      ),
    );
  }

  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/, { timeout: 45_000 });
  return { projectId, uploadStatus, uploadBody };
}

async function seedPrivateMatter(
  config: RuntimeConfig,
  projectId: string,
  owner: AuthUser,
  cleanup: TrackedCleanupApi,
): Promise<{ organizationId: string; matterId: string }> {
  const organizationId = randomUUID();
  const workspaceId = randomUUID();
  const matterId = randomUUID();
  const suffix = organizationId.slice(0, 8);

  await restInsert(config, "organizations", {
    id: organizationId,
    name: `Beta 0.1 synthetic org ${suffix}`,
    created_by: owner.id,
  });
  // Registro inmediato: si cualquier insert posterior falla, el cleanup
  // final elimina la organización (el DELETE REST cascada sus recursos).
  cleanup.register("organization", () =>
    deleteAndVerifyOrganization(config, organizationId),
  );
  await restInsert(config, "organization_memberships", {
    organization_id: organizationId,
    user_id: owner.id,
    role: "org_owner",
  });
  await restInsert(config, "workspaces", {
    id: workspaceId,
    organization_id: organizationId,
    name: `Beta 0.1 synthetic workspace ${suffix}`,
    created_by: owner.id,
  });
  await restInsert(config, "workspace_memberships", {
    workspace_id: workspaceId,
    user_id: owner.id,
    role: "workspace_admin",
  });
  await restInsert(config, "matters", {
    id: matterId,
    workspace_id: workspaceId,
    project_id: projectId,
    name: `Beta 0.1 private matter ${suffix}`,
    status: "open",
    created_by: owner.id,
    drive_folder_id: "beta01-shared-drive-folder",
  });
  cleanup.register("matter", () =>
    deleteRowById(config, "matters", matterId),
  );
  await restInsert(config, "matter_memberships", {
    matter_id: matterId,
    user_id: owner.id,
    role: "matter_owner",
  });
  return { organizationId, matterId };
}

async function deleteAndVerifyProject(
  config: RuntimeConfig,
  owner: AuthUser,
  projectId: string,
): Promise<void> {
  const result = await apiRequest(owner.accessToken, `/projects/${projectId}`, {
    method: "DELETE",
  });
  if (result.status !== 204 && result.status !== 404) {
    throw new Error(`Project cleanup failed: ${result.status} ${result.text}`);
  }
  const remainingProject = await restRequest(
    config,
    "projects",
    `?select=id&id=eq.${encodeURIComponent(projectId)}`,
  );
  if (
    remainingProject.status < 200 ||
    remainingProject.status >= 300 ||
    (Array.isArray(remainingProject.data) &&
      remainingProject.data.length > 0)
  ) {
    throw new Error(
      `Project cleanup verification failed: ${remainingProject.text}`,
    );
  }
}

async function deleteAndVerifyOrganization(
  config: RuntimeConfig,
  organizationId: string,
): Promise<void> {
  const result = await restRequest(
    config,
    "organizations",
    `?id=eq.${encodeURIComponent(organizationId)}`,
    { method: "DELETE", headers: { Prefer: "return=minimal" } },
  );
  if (result.status < 200 || result.status >= 300) {
    throw new Error(
      `Organization cleanup failed: ${result.status} ${result.text}`,
    );
  }
  const remainingOrganization = await restRequest(
    config,
    "organizations",
    `?select=id&id=eq.${encodeURIComponent(organizationId)}`,
  );
  if (
    remainingOrganization.status < 200 ||
    remainingOrganization.status >= 300 ||
    (Array.isArray(remainingOrganization.data) &&
      remainingOrganization.data.length > 0)
  ) {
    throw new Error(
      `Organization cleanup verification failed: ${remainingOrganization.text}`,
    );
  }
}

// Delete idempotente de una fila por ID: 2xx o 404 = ya no existe; cualquier
// otro estado es un fallo real de limpieza (lo reporta TrackedCleanup sin
// detener el resto de los pasos).
async function deleteRowById(
  config: RuntimeConfig,
  table: string,
  id: string,
): Promise<void> {
  const result = await restRequest(
    config,
    table,
    `?id=eq.${encodeURIComponent(id)}`,
    { method: "DELETE", headers: { Prefer: "return=minimal" } },
  );
  if (result.status < 200 || result.status >= 300) {
    if (result.status === 404) return;
    throw new Error(
      `DELETE ${table} ${id} failed: ${result.status} ${result.text}`,
    );
  }
}

test.describe("Beta 0.1 setup smoke", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("owner autenticado crea proyecto+matter privado y sube el DOCX con 201/versión/hash/metadata", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    // El guard local corre ANTES de cualquier mutación (legacy cleanup,
    // fixture, seeds, uploads): todo lo de abajo existe sólo bajo target
    // loopback aprobado.
    const config = runtimeConfig();
    const authAdmin = createAuthAdminClient(config);

    // Limpieza única de cuentas legacy de corridas anteriores: usuarios
    // `beta01-owner-*` distintos del fixture determinista. Nunca toca
    // usuarios ajenos y nunca corre en target no-loopback.
    await cleanLegacyOwnerUsers(authAdmin, OWNER_FIXTURE.email);

    // Fixture idempotente: la primera corrida crea la cuenta; las siguientes
    // reutilizan exactamente la misma (mismo user_id, password fixture local
    // no secreto). La cuenta permanece al final: es la ÚNICA cuenta auth
    // fixture reutilizable entre corridas.
    const ownerSeed = await ensureFixtureUser(authAdmin, OWNER_FIXTURE);
    const owner = await signIn(config, ownerSeed.user);

    // Recursos de negocio: se registran conforme se crean; aunque falle
    // cualquier step, el finally elimina los IDs ya capturados en orden
    // seguro (hijos antes que padres).
    const cleanup = new TrackedCleanup();
    try {
      await loginInUi(page, owner);
      const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
      const created = await createProjectAndUploadDocx(
        page,
        `Beta 0.1 synthetic MSA ${suffix}`,
        config,
        owner,
        cleanup,
      );
      const projectId = created.projectId;

      // HTTP 201 + metadata de la respuesta de upload (versión 1, docx).
      expect(created.uploadStatus).toBe(201);
      expect(created.uploadBody.filename).toBe("beta01-contract.docx");
      expect(created.uploadBody.file_type).toBe("docx");
      expect(created.uploadBody.active_version_number).toBe(1);
      expect(created.uploadBody.size_bytes).toBe(
        fs.statSync(DOCX_FIXTURE).size,
      );
      // Metadata de página: el fixture es DOCX (sin page count intrínseco);
      // el campo debe estar presente y ser null en esta fase.
      expect(created.uploadBody).toHaveProperty("page_count", null);

      const tenant = await seedPrivateMatter(
        config,
        projectId,
        owner,
        cleanup,
      );

      // Matter privado: la única membresía es la del owner.
      const membershipResult = await restRequest(
        config,
        "matter_memberships",
        `?select=user_id,role&matter_id=eq.${encodeURIComponent(tenant.matterId)}`,
      );
      expect(membershipResult.status).toBe(200);
      expect(membershipResult.data).toEqual([
        { user_id: owner.id, role: "matter_owner" },
      ]);

      // Fila de versión: número, source, content hash, tamaño y ruta real.
      const versionId = String(created.uploadBody.current_version_id);
      expect(versionId).toMatch(/^[0-9a-f-]{36}$/);
      const versionResult = await restRequest(
        config,
        "document_versions",
        `?select=id,version_number,source,filename,file_type,size_bytes,content_sha256,page_count,storage_path&id=eq.${versionId}`,
      );
      expect(versionResult.status).toBe(200);
      const version = (versionResult.data as Record<string, unknown>[])[0];
      expect(version).toBeTruthy();
      expect(version.version_number).toBe(1);
      expect(version.source).toBe("upload");
      expect(version.filename).toBe("beta01-contract.docx");
      expect(version.file_type).toBe("docx");
      expect(version.size_bytes).toBe(fs.statSync(DOCX_FIXTURE).size);
      expect(version.content_sha256).toBe(
        sha256Hex(fs.readFileSync(DOCX_FIXTURE)),
      );
      expect(version.page_count).toBeNull();
      expect(String(version.storage_path)).toMatch(/^documents\//);

      // El documento quedó ready con la versión apuntada.
      const documentResult = await restRequest(
        config,
        "documents",
        `?select=id,status,current_version_id&id=eq.${String(created.uploadBody.id)}`,
      );
      expect(documentResult.status).toBe(200);
      const document = (documentResult.data as Record<string, unknown>[])[0];
      expect(document).toBeTruthy();
      expect(document.status).toBe("ready");
      expect(document.current_version_id).toBe(versionId);

      // Visible vía API pública del proyecto para el owner.
      const projectDocuments = await apiRequest(
        owner.accessToken,
        `/projects/${projectId}/documents`,
      );
      expect(projectDocuments.status).toBe(200);
      const listed = (projectDocuments.data as { id: string }[]).find(
        (row) => row.id === created.uploadBody.id,
      );
      expect(listed).toBeTruthy();
    } finally {
      // Teardown (criterio Gate 1 fix 2): cero recursos de negocio por
      // corrida — cada ID se registró conforme se creó y TrackedCleanup
      // elimina los conocidos en orden seguro (versión/documento/matter/
      // organización/proyecto) aunque un step haya fallado.
      // NO se afirma "cero usuarios": la cuenta auth fixture determinista
      // (beta01-owner@local.test) permanece y es EXACTAMENTE una cuenta
      // reutilizable entre corridas; los legacy beta01-owner-* ya se
      // limpiaron una sola vez bajo el guard local al inicio de este run.
      await cleanup.run();
    }
  });
});