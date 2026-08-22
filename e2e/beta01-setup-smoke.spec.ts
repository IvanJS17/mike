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

// Project-aware cleanup API backed by ProjectCleanup (helper
// e2e/support/beta01-project-cleanup.cjs): registerProjectMarker() se llama
// ANTES de disparar la creación UI con el marcador único owner_id +
// project_name, así un project ID perdido/vencido o un body que no parsea se
// reconcilian en run() (findProjectByMarker); organization/workspace/matter
// usan UUID preasignados registrados ANTES de cada POST (ausencia
// idempotente). run() ejecuta deleteAndVerifyProject PRIMERO (observa
// documents/versions/storage antes de borrar rows y exige read-back cero +
// objetos cero en MinIO/R2) y después el cleanup organization/cascade. NO hay
// callbacks directos de document/version/matter: romperían el descubrimiento
// de storage.
type ProjectCleanupApi = {
  registerProjectMarker(ownerId: string, projectName: string): ProjectCleanupApi;
  adoptProjectId(projectId: string): ProjectCleanupApi;
  registerUuid(table: string, id: string): ProjectCleanupApi;
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
};

const { ProjectCleanup } = require("../support/beta01-project-cleanup.cjs") as {
  ProjectCleanup: new (clients: ProjectCleanupClients) => ProjectCleanupApi;
};

// Client surface que ProjectCleanup inyecta. La MISMA interfaz se falsifica
// en scripts/test-beta01-project-cleanup.sh (cero red); aquí se implementa
// contra el stack local real: REST de Supabase (read-back/count/delete por
// UUID preasignado), API del backend (DELETE /projects/:id con el token del
// owner) y probe directo de objetos en MinIO/R2 (S3-compatible).
type ProjectCleanupClients = {
  findProjectByMarker(
    ownerId: string,
    projectName: string,
  ): Promise<string | null>;
  loadProjectScope(projectId: string): Promise<{
    documentIds: string[];
    versionIds: string[];
    storagePaths: string[];
    executionIds: string[];
    reviewIds: string[];
  }>;
  deleteProject(projectId: string): Promise<{ status: number; text: string }>;
  count(table: string, column: string, values: string[]): Promise<number>;
  deleteUuid(table: string, id: string): Promise<{ status: number; text: string }>;
  storagePathsExist(paths: string[]): Promise<string[]>;
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
  cleanup: ProjectCleanupApi,
): Promise<{
  projectId: string;
  uploadStatus: number;
  uploadBody: Record<string, unknown>;
}> {
  // ANTES de disparar la creación UI se registra el marcador único
  // owner_id + project_name: aunque la respuesta de create/upload se pierda o
  // su body no parsee, run() reconcilia el project ID por marcador.
  cleanup.registerProjectMarker(owner.id, projectName);

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
  // creación: el project ID se adopta en cuanto la URL lo revela, antes de
  // esperar la navegación UI, para que un fallo posterior no deje recursos
  // sin limpiar. NO se registran callbacks directos de document/version:
  // deleteAndVerifyProject (run()) borra primero el proyecto para ver
  // documents/versions/storage y verifica read-back cero + objetos cero en
  // MinIO/R2.
  const projectId = uploaded
    .url()
    .match(/\/projects\/([0-9a-f-]{36})\/documents$/)?.[1];
  if (!projectId)
    throw new Error(
      `Could not read project ID from upload response ${uploaded.url()}`,
    );
  cleanup.adoptProjectId(projectId);
  const uploadBody = JSON.parse(await uploaded.text()) as Record<
    string,
    unknown
  >;
  const uploadStatus = uploaded.status();

  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/, { timeout: 45_000 });
  return { projectId, uploadStatus, uploadBody };
}

async function seedPrivateMatter(
  config: RuntimeConfig,
  projectId: string,
  owner: AuthUser,
  cleanup: ProjectCleanupApi,
): Promise<{ organizationId: string; matterId: string }> {
  const organizationId = randomUUID();
  const workspaceId = randomUUID();
  const matterId = randomUUID();
  const suffix = organizationId.slice(0, 8);

  // UUIDs preasignados y registrados ANTES de cada POST: si el POST no
  // ocurrió, la ausencia es idempotente (404/cero filas en el delete).
  cleanup.registerUuid("organizations", organizationId);
  await restInsert(config, "organizations", {
    id: organizationId,
    name: `Beta 0.1 synthetic org ${suffix}`,
    created_by: owner.id,
  });
  await restInsert(config, "organization_memberships", {
    organization_id: organizationId,
    user_id: owner.id,
    role: "org_owner",
  });
  cleanup.registerUuid("workspaces", workspaceId);
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
  cleanup.registerUuid("matters", matterId);
  await restInsert(config, "matters", {
    id: matterId,
    workspace_id: workspaceId,
    project_id: projectId,
    name: `Beta 0.1 private matter ${suffix}`,
    status: "open",
    created_by: owner.id,
    drive_folder_id: "beta01-shared-drive-folder",
  });
  await restInsert(config, "matter_memberships", {
    matter_id: matterId,
    user_id: owner.id,
    role: "matter_owner",
  });
  return { organizationId, matterId };
}

// ---------------------------------------------------------------------------
// Clientes reales para ProjectCleanup (contra el stack local).
// ---------------------------------------------------------------------------

function readEnvValue(key: string): string | undefined {
  if (process.env[key]) return process.env[key];
  const files = [
    path.join(__dirname, "..", "backend", ".env"),
    path.join(__dirname, "..", "frontend", ".env.local"),
  ];
  let value: string | undefined;
  for (const file of files) {
    try {
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        const match = line.match(new RegExp(`^${key}=(.*)$`));
        if (match) value = match[1].trim().replace(/^"(.*)"$/, "$1");
      }
    } catch {
      // The local-stack setup may not have created an env file yet.
    }
  }
  return value;
}

// Probe real de MinIO/R2: HeadObject por path (S3-compatible); NotFound = el
// objeto ya no existe. Devuelve SOLO los paths que aún existen. Se usa el SDK
// del backend (el harness ya lo instala para el backend).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { S3Client, HeadObjectCommand } = require(
  path.join(
    __dirname,
    "..",
    "backend",
    "node_modules",
    "@aws-sdk",
    "client-s3",
  ),
) as {
  S3Client: new (opts: Record<string, unknown>) => {
    send(command: unknown): Promise<unknown>;
  };
  HeadObjectCommand: new (opts: Record<string, unknown>) => unknown;
};

async function storagePathsExistImpl(paths: string[]): Promise<string[]> {
  if (paths.length === 0) return [];
  const endpoint = readEnvValue("R2_ENDPOINT_URL");
  const accessKeyId = readEnvValue("R2_ACCESS_KEY_ID");
  const secretAccessKey = readEnvValue("R2_SECRET_ACCESS_KEY");
  const bucket = readEnvValue("R2_BUCKET_NAME") ?? "mike";
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "storagePathsExist: R2_ENDPOINT_URL/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY son requeridos (stack local)",
    );
  }
  const client = new S3Client({
    region: "auto",
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  const stillThere: string[] = [];
  for (const key of paths) {
    try {
      await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      stillThere.push(key);
    } catch (error) {
      if ((error as { name?: string })?.name === "NotFound") continue;
      throw error;
    }
  }
  return stillThere;
}

async function countRows(
  config: RuntimeConfig,
  table: string,
  column: string,
  values: string[],
): Promise<number> {
  if (values.length === 0) return 0;
  const encoded = values.map((value) => encodeURIComponent(value)).join(",");
  const filter =
    values.length === 1
      ? `${column}=eq.${encodeURIComponent(values[0])}`
      : `${column}=in.(${encoded})`;
  const result = await restRequest(config, table, `?select=id&${filter}`);
  if (result.status < 200 || result.status >= 300) {
    throw new Error(
      `read-back ${table} ${filter} failed: ${result.status} ${result.text}`,
    );
  }
  return Array.isArray(result.data) ? result.data.length : 0;
}

// Igual que restRequest pero devolviendo filas tipadas para scope.
async function restRows(
  config: RuntimeConfig,
  table: string,
  query: string,
): Promise<Record<string, unknown>[]> {
  const result = await restRequest(config, table, query);
  if (result.status < 200 || result.status >= 300) {
    throw new Error(
      `read ${table} failed: ${result.status} ${result.text}`,
    );
  }
  return Array.isArray(result.data) ? (result.data as Record<string, unknown>[]) : [];
}

function createProjectCleanupClients(
  config: RuntimeConfig,
  owner: AuthUser,
): ProjectCleanupClients {
  return {
    // Reconciliación por marcador único owner_id + project_name: el project
    // ID se busca aunque la respuesta de create/upload se haya perdido.
    async findProjectByMarker(ownerId, projectName) {
      const rows = await restRows(
        config,
        "projects",
        `?select=id&user_id=eq.${encodeURIComponent(ownerId)}&name=eq.${encodeURIComponent(projectName)}`,
      );
      return rows.length > 0 ? String(rows[0].id) : null;
    },

    // Observa documents/versions/storage ANTES de borrar rows.
    async loadProjectScope(projectId) {
      const documentRows = await restRows(
        config,
        "documents",
        `?select=id&project_id=eq.${encodeURIComponent(projectId)}`,
      );
      const documentIds = documentRows.map((row) => String(row.id));
      let versionIds: string[] = [];
      let storagePaths: string[] = [];
      if (documentIds.length > 0) {
        const versionRows = await restRows(
          config,
          "document_versions",
          `?select=id,storage_path,pdf_storage_path&document_id=in.(${documentIds.map(encodeURIComponent).join(",")})`,
        );
        for (const version of versionRows) {
          versionIds.push(String(version.id));
          if (typeof version.storage_path === "string" && version.storage_path.length > 0) {
            storagePaths.push(version.storage_path);
          }
          if (
            typeof version.pdf_storage_path === "string" &&
            version.pdf_storage_path.length > 0
          ) {
            storagePaths.push(version.pdf_storage_path);
          }
        }
      }
      const executionRows = await restRows(
        config,
        "ai_executions",
        `?select=id&project_id=eq.${encodeURIComponent(projectId)}`,
      );
      const executionIds = executionRows.map((row) => String(row.id));
      const reviewRows = await restRows(
        config,
        "ai_reviews",
        `?select=id&project_id=eq.${encodeURIComponent(projectId)}`,
      );
      return {
        documentIds,
        versionIds,
        storagePaths,
        executionIds,
        reviewIds: reviewRows.map((row) => String(row.id)),
      };
    },

    async deleteProject(projectId) {
      return apiRequest(owner.accessToken, `/projects/${projectId}`, {
        method: "DELETE",
      });
    },

    async count(table, column, values) {
      return countRows(config, table, column, values);
    },

    // REST DELETE idempotente por UUID preasignado: 2xx o 404 = ausencia.
    async deleteUuid(table, id) {
      const result = await restRequest(
        config,
        table,
        `?id=eq.${encodeURIComponent(id)}`,
        { method: "DELETE", headers: { Prefer: "return=minimal" } },
      );
      if (result.status === 404) return { status: result.status, text: result.text };
      if (result.status < 200 || result.status >= 300) {
        throw new Error(
          `DELETE ${table} ${id} failed: ${result.status} ${result.text}`,
        );
      }
      return { status: result.status, text: result.text };
    },

    async storagePathsExist(paths) {
      return storagePathsExistImpl(paths);
    },
  };
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

    // Recursos de negocio: cleanup project-aware (Gate 1, fix 2b) — el
    // marcador único owner_id + project_name se registra ANTES de la creación
    // UI y los UUID de organization/workspace/matter se registran antes de
    // cada POST. run() borra primero el proyecto (observando documents/
    // versions/storage), verifica read-back cero y objetos cero en MinIO/R2,
    // y después aplica el cleanup organization/cascade.
    const cleanup = new ProjectCleanup(
      createProjectCleanupClients(config, owner),
    );
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
      // Teardown (criterio Gate 1 fix 2b): cero recursos de negocio y cero
      // objetos por corrida — deleteAndVerifyProject borra primero el
      // proyecto (viendo documents/versions/storage) y verifica read-back
      // cero + objetos cero; después se limpia organization/cascade con los
      // UUID preasignados. Cualquier residuo hace FAIL (run() lanza).
      // NO se afirma "cero usuarios": la cuenta auth fixture determinista
      // (beta01-owner@local.test) permanece y es EXACTAMENTE una cuenta
      // reutilizable entre corridas; los legacy beta01-owner-* ya se
      // limpiaron una sola vez bajo el guard local al inicio de este run.
      await cleanup.run();
    }
  });
});