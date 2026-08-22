import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";

/**
 * Beta 0.1 — journey gate 2: AI execution smoke.
 *
 * Focal spec extraída del viaje integrado (e2e/beta01-integrated-journey.spec.ts)
 * que reutiliza los helpers Gate 1 (owner/project/matter/DOCX vía
 * ProjectCleanup + target-guard + fake provider) y llega ÚNICAMENTE hasta la
 * ejecución IA con estado `succeeded` y la verificación de receipt/citations.
 *
 * NO cubre human review, informe DOCX, redline ni publicación en Shared Drive
 * (gates posteriores).
 *
 * Criterio (único):
 *   1. el fake provider determinista (e2e/support/beta01-fakes.cjs, preloaded
 *      por el harness en el proceso del backend) responde exactamente R4/R6/R9
 *      con citation_id, finding_text, quote, span/page/document/version y
 *      quote_sha256 en minúsculas; el spec afirma una sola llamada al provider;
 *   2. la ejecución termina `succeeded` con el workflow default
 *      civil-mercantil-mx-v0.1/v0.1 y hashes de playbook/input/output/receipt
 *      ligados (receipt canónico == estado/output/playbook/input de la
 *      ejecución);
 *   3. 3 citas `verified` y el quote_sha256 de cada cita coincide con el hash
 *      del slice exacto de la página persistida (ai_document_version_pages);
 *      omitir quote_sha256 es un caso contractual negativo que la resolución
 *      del backend rechaza (verificado sin stack en
 *      scripts/test-beta01-fake-provider.sh).
 *
 * Cleanup Gate 1 reutilizado: ProjectCleanup.run() (proyecto + documentos +
 * versiones + objetos + organización/cascade, cero residuos) y usuarios auth
 * borrados.
 */

const DOCX_FIXTURE = path.join(__dirname, "fixtures/beta01-contract.docx");
// The guard resolves API_BASE below from env/.env; it stays a module-level
// default so apiRequest() reads the same validated value.
let API_BASE = "http://localhost:3001";
const FAKE_STATE_FILE =
  process.env.BETA01_FAKE_STATE_FILE ??
  path.join(os.tmpdir(), "mike-beta01-fake-provider.json");

const OWNER_PASSWORD = "Beta01OwnerPass-2026!";
const REVIEWER_PASSWORD = "Beta01ReviewerPass-2026!";

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

// Project-aware cleanup API backed by ProjectCleanup (helper
// e2e/support/beta01-project-cleanup.cjs): registerProjectMarker() se llama
// ANTES de disparar la creación UI con el marcador único owner_id +
// project_name; organization/workspace/matter usan UUID preasignados
// registrados ANTES de cada POST (ausencia idempotente). run() ejecuta
// deleteAndVerifyProject PRIMERO (observa documents/versions/storage antes de
// borrar rows y exige read-back cero + objetos cero en MinIO/R2) y después el
// cleanup organization/cascade.
type ProjectCleanupApi = {
  registerProjectMarker(ownerId: string, projectName: string): ProjectCleanupApi;
  adoptProjectId(projectId: string): ProjectCleanupApi;
  registerUuid(table: string, id: string): ProjectCleanupApi;
  run(): Promise<void>;
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

const { ProjectCleanup } = require("./support/beta01-project-cleanup.cjs") as {
  ProjectCleanup: new (clients: ProjectCleanupClients) => ProjectCleanupApi;
};

// Same guard the smoke runner uses as fail-fast; it throws with sanitized
// errors (never key values) when a target is not local or conflicts with the
// wired .env. Must run BEFORE any auth/REST call in this spec.
const { assertLocalTargets } = require("./support/beta01-target-guard.cjs") as {
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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

async function deleteUser(
  config: RuntimeConfig,
  userId: string,
): Promise<void> {
  const result = await fetch(
    `${config.supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
    {
      method: "DELETE",
      headers: {
        apikey: config.anonKey,
        Authorization: `Bearer ${config.serviceKey}`,
      },
    },
  );
  if (!result.ok && result.status !== 404) {
    throw new Error(`Supabase user cleanup failed: ${result.status}`);
  }
}

async function createAuthUser(
  config: RuntimeConfig,
  email: string,
  password: string,
): Promise<{ id: string; email: string; password: string }> {
  const created = await fetch(`${config.supabaseUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: config.anonKey,
      Authorization: `Bearer ${config.serviceKey}`,
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const createdBody = await parseResponse(created);
  if (!created.ok && created.status !== 422) {
    throw new Error(
      `Supabase user seed failed: ${created.status} ${createdBody.text}`,
    );
  }
  const createdUser =
    createdBody.data && typeof createdBody.data === "object"
      ? (createdBody.data as { user?: { id?: string }; id?: string })
      : null;
  const id = createdUser?.user?.id ?? createdUser?.id;
  if (id) return { id, email, password };

  const signedIn = await fetch(
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
  const signInBody = await parseResponse(signedIn);
  const user =
    signInBody.data && typeof signInBody.data === "object"
      ? (signInBody.data as { user?: { id?: string } }).user
      : null;
  if (!signedIn.ok || !user?.id) {
    throw new Error(`Supabase existing user lookup failed: ${signInBody.text}`);
  }
  return { id: user.id, email, password };
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
  ownerId: string,
  cleanup: ProjectCleanupApi,
): Promise<string> {
  // ANTES de disparar la creación UI se registra el marcador único
  // owner_id + project_name: aunque la respuesta de create/upload se pierda o
  // su body no parsee, run() reconcilia el project ID por marcador.
  cleanup.registerProjectMarker(ownerId, projectName);

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
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/, { timeout: 45_000 });
  const projectId = page.url().match(/\/projects\/([0-9a-f-]{36})$/)?.[1];
  if (!projectId)
    throw new Error(`Could not read created project ID from ${page.url()}`);
  // NO se registran callbacks directos de document/version: deleteAndVerifyProject
  // (run()) borra primero el proyecto para ver documents/versions/storage y
  // verifica read-back cero + objetos cero en MinIO/R2.
  cleanup.adoptProjectId(projectId);
  await expect(page.getByText("beta01-contract.docx")).toBeVisible({
    timeout: 20_000,
  });
  return projectId;
}

async function seedPrivateMatter(
  config: RuntimeConfig,
  projectId: string,
  owner: AuthUser,
  reviewer: AuthUser,
  cleanup: ProjectCleanupApi,
): Promise<{ organizationId: string; workspaceId: string; matterId: string }> {
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
  await restInsert(config, "organization_memberships", [
    { organization_id: organizationId, user_id: owner.id, role: "org_owner" },
    { organization_id: organizationId, user_id: reviewer.id, role: "editor" },
  ]);
  cleanup.registerUuid("workspaces", workspaceId);
  await restInsert(config, "workspaces", {
    id: workspaceId,
    organization_id: organizationId,
    name: `Beta 0.1 synthetic workspace ${suffix}`,
    created_by: owner.id,
  });
  await restInsert(config, "workspace_memberships", [
    { workspace_id: workspaceId, user_id: owner.id, role: "workspace_admin" },
    { workspace_id: workspaceId, user_id: reviewer.id, role: "editor" },
  ]);
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
  await restInsert(config, "matter_memberships", [
    { matter_id: matterId, user_id: owner.id, role: "matter_owner" },
    { matter_id: matterId, user_id: reviewer.id, role: "editor" },
  ]);
  return { organizationId, workspaceId, matterId };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected JSON object");
  }
  return value as Record<string, unknown>;
}

function assertHash(value: unknown, label: string): asserts value is string {
  expect(value, label).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));
}

// ---------------------------------------------------------------------------
// Clientes reales para ProjectCleanup (contra el stack local).
// ---------------------------------------------------------------------------

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

test.describe("Beta 0.1 AI smoke (Gate 2)", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("AI execution succeeds with deterministic receipts/citations", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const config = runtimeConfig();
    fs.rmSync(FAKE_STATE_FILE, { force: true });

    const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const ownerSeed = await createAuthUser(
      config,
      `beta01-owner-${suffix}@mike.local`,
      OWNER_PASSWORD,
    );
    const reviewerSeed = await createAuthUser(
      config,
      `beta01-reviewer-${suffix}@mike.local`,
      REVIEWER_PASSWORD,
    );
    const owner = await signIn(config, ownerSeed);
    const reviewer = await signIn(config, reviewerSeed);

    // Cleanup project-aware (Gate 1, fix 2b): el marcador único owner_id +
    // project_name se registra ANTES de la creación UI y los UUID de
    // organization/workspace/matter se registran antes de cada POST. run()
    // borra primero el proyecto (observando documents/versions/storage),
    // verifica read-back cero y objetos cero en MinIO/R2, y después aplica el
    // cleanup organization/cascade.
    const cleanup = new ProjectCleanup(
      createProjectCleanupClients(config, owner),
    );
    let projectId: string | null = null;
    try {
      await loginInUi(page, owner);
      projectId = await createProjectAndUploadDocx(
        page,
        `Beta 0.1 synthetic MSA ${suffix}`,
        owner.id,
        cleanup,
      );
      const tenant = await seedPrivateMatter(
        config,
        projectId,
        owner,
        reviewer,
        cleanup,
      );

      // ── Ejecución IA (fake provider determinista, R4/R6/R9) ─────────────
      await page.goto(`/projects/${projectId}/ai-executions`);
      await expect(page.getByTestId("ai-execution-panel")).toBeVisible({
        timeout: 20_000,
      });
      const matterInput = page.getByPlaceholder("UUID del asunto asignado");
      await matterInput.fill(tenant.matterId);
      await matterInput.blur();
      await page
        .getByLabel("Referencia de credencial (no es la API key)")
        .fill("deepseek:env");
      await expect(
        page.getByRole("button", { name: "Iniciar revisión" }),
      ).toBeEnabled({ timeout: 15_000 });
      await page.getByRole("button", { name: "Iniciar revisión" }).click();
      await expect(page.getByTestId("ai-execution-result")).toContainText(
        "succeeded",
        { timeout: 75_000 },
      );

      // ── Receipt/citations: workflow default y hashes ligados ────────────
      const executionList = await apiRequest(
        owner.accessToken,
        `/projects/${projectId}/ai-executions`,
      );
      expect(executionList.status).toBe(200);
      const executions = executionList.data as Record<string, unknown>[];
      const execution = executions.find(
        (candidate) => candidate.matter_id === tenant.matterId,
      );
      expect(execution).toBeTruthy();
      const executionId = String(asRecord(execution).id);
      expect(asRecord(execution).status).toBe("succeeded");
      const playbook = asRecord(asRecord(execution).playbook);
      expect(playbook.workflow_id).toBe("civil-mercantil-mx-v0.1");
      expect(playbook.workflow_version).toBe("v0.1");
      assertHash(playbook.playbook_sha256, "playbook hash");
      assertHash(asRecord(execution).input_sha256, "input hash");
      assertHash(asRecord(execution).document_content_sha256, "document hash");

      const receiptResponse = await apiRequest(
        owner.accessToken,
        `/projects/${projectId}/ai-executions/${executionId}/receipt`,
      );
      const outputResponse = await apiRequest(
        owner.accessToken,
        `/projects/${projectId}/ai-executions/${executionId}/output`,
      );
      expect(receiptResponse.status).toBe(200);
      expect(outputResponse.status).toBe(200);
      const receipt = asRecord(receiptResponse.data);
      const receiptCanonical = asRecord(receipt.canonical_json);
      const output = asRecord(outputResponse.data);
      assertHash(receipt.receipt_sha256, "receipt hash");
      assertHash(output.output_sha256, "output hash");
      expect(output.output_sha256).toBe(sha256(String(output.output_text)));
      expect(asRecord(receiptCanonical.result).status).toBe("succeeded");
      expect(asRecord(receiptCanonical.result).output_sha256).toBe(
        output.output_sha256,
      );
      expect(asRecord(receiptCanonical.playbook).playbook_sha256).toBe(
        playbook.playbook_sha256,
      );
      expect(asRecord(receiptCanonical.input).input_sha256).toBe(
        asRecord(execution).input_sha256,
      );

      // ── 3 citas verified + el quote_sha256 coincide con el slice exacto ──
      const pagesResponse = await restRequest(
        config,
        "ai_document_version_pages",
        `?select=page,content,content_sha256&document_version_id=eq.${encodeURIComponent(String(asRecord(execution).document_version_id))}`,
      );
      expect(pagesResponse.status).toBe(200);
      const pages = pagesResponse.data as {
        page: number;
        content: string;
        content_sha256: string;
      }[];
      expect(pages).toHaveLength(1);
      const citations = output.citation_refs as Record<string, unknown>[];
      expect(citations).toHaveLength(3);
      for (const citation of citations) {
        expect(citation.verified).toBe(true);
        assertHash(citation.quote_sha256, "quote hash");
        const span = asRecord(citation.span);
        const page = pages.find(
          (candidate) => candidate.page === citation.page,
        );
        expect(page).toBeTruthy();
        expect(
          sha256(
            page!.content.slice(Number(span.start_char), Number(span.end_char)),
          ),
        ).toBe(citation.quote_sha256);
      }

      // Determinismo: una sola corrida, una sola llamada al provider fake.
      const fakeState = JSON.parse(
        fs.readFileSync(FAKE_STATE_FILE, "utf8"),
      ) as {
        provider_calls: number;
        drive_upload_calls: number;
      };
      expect(fakeState.provider_calls).toBe(1);
      expect(fakeState.drive_upload_calls).toBe(0);
    } finally {
      // Teardown (criterio Gate 1 fix 2b): cero recursos de negocio y cero
      // objetos por corrida — deleteAndVerifyProject borra primero el
      // proyecto (viendo documents/versions/storage) y verifica read-back
      // cero + objetos cero; después se limpia organization/cascade con los
      // UUID preasignados. Cualquier residuo hace FAIL (run() lanza).
      await cleanup.run();
      await Promise.all(
        [owner.id, reviewer.id].map((userId) => deleteUser(config, userId)),
      );
      fs.rmSync(FAKE_STATE_FILE, { force: true });
      expect(fs.existsSync(FAKE_STATE_FILE)).toBe(false);
    }
  });
});