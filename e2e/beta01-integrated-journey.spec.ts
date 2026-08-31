import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

import path from "node:path";
import { test, expect, type Page } from "@playwright/test";

type ProjectCleanupInstance = {
  registerProjectMarker(ownerId: string, projectName: string): ProjectCleanupInstance;
  adoptProjectId(projectId: string): ProjectCleanupInstance;
  registerUuid(table: string, id: string): ProjectCleanupInstance;
  run(): Promise<void>;
};

const { ProjectCleanup } = require("./support/beta01-project-cleanup.cjs") as {
  ProjectCleanup: new (clients: ProjectCleanupClients) => ProjectCleanupInstance;
};

const DOCX_FIXTURE = path.join(__dirname, "fixtures/beta01-contract.docx");
const API_BASE = process.env.MIKE_API_BASE_URL ?? "http://localhost:3001";
const FAKE_STATE_FILE = process.env.BETA01_FAKE_STATE_FILE ?? "";
// The AI runner owns a fully disposable Supabase stack. In that mode the
// stack owner, not DELETE /projects/:id, performs business-data teardown:
// deleting append-only AI rows individually would violate their database
// contract. The shell runner verifies the owned containers, volumes and
// network are gone before it reports success. Direct spec runs keep the
// canonical ProjectCleanup path and therefore fail closed if not disposable.
const DISPOSABLE_STACK = process.env.BETA01_DISPOSABLE_STACK === "1";

const OWNER_PASSWORD = "Beta01OwnerPass-2026!";
const REVIEWER_PASSWORD = "Beta01ReviewerPass-2026!";
const OUTSIDER_PASSWORD = "Beta01OutsiderPass-2026!";

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

type ProjectCleanupClients = {
  findProjectByMarker(ownerId: string, projectName: string): Promise<string | null>;
  loadProjectScope(projectId: string): Promise<{
    documentIds: string[];
    versionIds: string[];
    storagePaths: string[];
    executionIds: string[];
    reviewIds: string[];
  }>;
  deleteProject(projectId: string): Promise<ApiResult>;
  count(table: string, column: string, values: string[]): Promise<number>;
  deleteUuid(table: string, id: string): Promise<ApiResult>;
  storagePathsExist(paths: string[]): Promise<string[]>;
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

function runtimeConfig(): RuntimeConfig {
  const supabaseUrl = readEnvValue("SUPABASE_URL");
  const serviceKey = readEnvValue("SUPABASE_SECRET_KEY");
  const anonKey =
    readEnvValue("SUPABASE_ANON_KEY") ??
    readEnvValue("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY");
  if (!supabaseUrl || !serviceKey || !anonKey) {
    throw new Error(
      "Beta 0.1 E2E requires SUPABASE_URL, SUPABASE_SECRET_KEY and the local anon key",
    );
  }
  return { supabaseUrl, serviceKey, anonKey };
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
  return parseResponse(
    await fetch(`${API_BASE}${route}`, { ...init, headers }),
  );
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

async function restRows(
  config: RuntimeConfig,
  table: string,
  query: string,
): Promise<Record<string, unknown>[]> {
  const result = await restRequest(config, table, query);
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`Supabase read ${table} failed: ${result.status} ${result.text}`);
  }
  return Array.isArray(result.data) ? (result.data as Record<string, unknown>[]) : [];
}

async function countRows(
  config: RuntimeConfig,
  table: string,
  column: string,
  values: string[],
): Promise<number> {
  if (values.length === 0) return 0;
  const filter = values.length === 1
    ? `${column}=eq.${encodeURIComponent(values[0])}`
    : `${column}=in.(${values.map(encodeURIComponent).join(",")})`;
  return (await restRows(config, table, `?select=id&${filter}`)).length;
}

function createProjectCleanupClients(
  config: RuntimeConfig,
  owner: AuthUser,
): ProjectCleanupClients {
  return {
    async findProjectByMarker(ownerId, projectName) {
      const rows = await restRows(
        config,
        "projects",
        `?select=id&user_id=eq.${encodeURIComponent(ownerId)}&name=eq.${encodeURIComponent(projectName)}`,
      );
      return rows.length > 0 ? String(rows[0].id) : null;
    },
    async loadProjectScope(projectId) {
      const documents = await restRows(
        config,
        "documents",
        `?select=id&project_id=eq.${encodeURIComponent(projectId)}`,
      );
      const documentIds = documents.map((row) => String(row.id));
      const versions = documentIds.length === 0
        ? []
        : await restRows(
            config,
            "document_versions",
            `?select=id,storage_path,pdf_storage_path&document_id=in.(${documentIds.map(encodeURIComponent).join(",")})`,
          );
      const executions = await restRows(config, "ai_executions", `?select=id&project_id=eq.${encodeURIComponent(projectId)}`);
      const reviews = await restRows(config, "ai_reviews", `?select=id&project_id=eq.${encodeURIComponent(projectId)}`);
      return {
        documentIds,
        versionIds: versions.map((row) => String(row.id)),
        storagePaths: versions.flatMap((row) =>
          [row.storage_path, row.pdf_storage_path].filter(
            (value): value is string => typeof value === "string" && value.length > 0,
          ),
        ),
        executionIds: executions.map((row) => String(row.id)),
        reviewIds: reviews.map((row) => String(row.id)),
      };
    },
    async deleteProject(projectId) {
      return apiRequest(owner.accessToken, `/projects/${projectId}`, { method: "DELETE" });
    },
    async count(table, column, values) {
      return countRows(config, table, column, values);
    },
    async deleteUuid(table, id) {
      const result = await restRequest(config, table, `?id=eq.${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { Prefer: "return=minimal" },
      });
      if (result.status !== 404 && (result.status < 200 || result.status >= 300)) {
        throw new Error(`Supabase DELETE ${table} failed: ${result.status} ${result.text}`);
      }
      return result;
    },
    async storagePathsExist(paths) {
      if (paths.length === 0) return [];
      const endpoint = readEnvValue("R2_ENDPOINT_URL");
      const accessKeyId = readEnvValue("R2_ACCESS_KEY_ID");
      const secretAccessKey = readEnvValue("R2_SECRET_ACCESS_KEY");
      const bucket = readEnvValue("R2_BUCKET_NAME") ?? "mike";
      if (!endpoint || !accessKeyId || !secretAccessKey) {
        throw new Error("storage cleanup requires local R2 credentials");
      }
      const { S3Client, HeadObjectCommand } = require(
        path.join(__dirname, "..", "backend", "node_modules", "@aws-sdk", "client-s3"),
      ) as {
        S3Client: new (options: Record<string, unknown>) => { send(command: unknown): Promise<unknown> };
        HeadObjectCommand: new (input: Record<string, unknown>) => unknown;
      };
      const client = new S3Client({ region: "auto", endpoint, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } });
      const existing: string[] = [];
      for (const key of paths) {
        try {
          await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
          existing.push(key);
        } catch (error) {
          if ((error as { name?: string }).name !== "NotFound") throw error;
        }
      }
      return existing;
    },
  };
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
        apikey: config.serviceKey,
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
      apikey: config.serviceKey,
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
): Promise<string> {
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
): Promise<{ organizationId: string; workspaceId: string; matterId: string }> {
  const organizationId = randomUUID();
  const workspaceId = randomUUID();
  const matterId = randomUUID();
  const suffix = organizationId.slice(0, 8);

  await restInsert(config, "organizations", {
    id: organizationId,
    name: `Beta 0.1 synthetic org ${suffix}`,
    created_by: owner.id,
  });
  await restInsert(config, "organization_memberships", [
    { organization_id: organizationId, user_id: owner.id, role: "org_owner" },
    { organization_id: organizationId, user_id: reviewer.id, role: "editor" },
  ]);
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

async function cleanupProject(
  config: RuntimeConfig,
  owner: AuthUser,
  cleanup: ProjectCleanupInstance,
  projectId: string | null,
  organizationId: string | null,
): Promise<void> {
  if (DISPOSABLE_STACK) return;
  if (projectId) {
    await cleanup.run();
  }
  if (organizationId) {
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
}

test.describe("Beta 0.1 integrated synthetic journey", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("owner to reviewer to fake Drive preserves the verified scope", async ({
    page,
    browser,
  }) => {
    test.setTimeout(180_000);
    const config = runtimeConfig();
    if (!FAKE_STATE_FILE) {
      throw new Error("BETA01_FAKE_STATE_FILE must be runner-owned");
    }

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
    const outsiderSeed = await createAuthUser(
      config,
      `beta01-outsider-${suffix}@mike.local`,
      OUTSIDER_PASSWORD,
    );
    const owner = await signIn(config, ownerSeed);
    const reviewer = await signIn(config, reviewerSeed);
    const outsider = await signIn(config, outsiderSeed);

    let projectId: string | null = null;
    let organizationId: string | null = null;
    const projectName = `Beta 0.1 synthetic MSA ${suffix}`;
    const cleanup = new ProjectCleanup(createProjectCleanupClients(config, owner));
    cleanup.registerProjectMarker(owner.id, projectName);
    let reviewerContext: Awaited<ReturnType<typeof browser.newContext>> | null =
      null;
    try {
      await loginInUi(page, owner);
      projectId = await createProjectAndUploadDocx(page, projectName);
      cleanup.adoptProjectId(projectId);
      const tenant = await seedPrivateMatter(
        config,
        projectId,
        owner,
        reviewer,
      );
      organizationId = tenant.organizationId;

      const projectResponse = await apiRequest(
        owner.accessToken,
        `/projects/${projectId}`,
      );
      expect(projectResponse.status).toBe(200);
      const projectShell = projectResponse.data;

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
      const aiStartResponsePromise = page.waitForResponse((response) => {
        const pathname = new URL(response.url()).pathname;
        return (
          response.request().method() === "POST" &&
          /\/projects\/[^/]+\/ai-executions$/.test(pathname)
        );
      });
      await page.getByRole("button", { name: "Iniciar revisión" }).click();
      const aiStartResponse = await aiStartResponsePromise;
      if (!aiStartResponse.ok()) {
        throw new Error(
          `AI execution start failed: ${aiStartResponse.status} ${await aiStartResponse.text()}`,
        );
      }
      await expect(page.getByTestId("ai-execution-result")).toContainText("succeeded", {
        timeout: 75_000,
      });

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

      reviewerContext = await browser.newContext({
        storageState: { cookies: [], origins: [] },
      });
      await loginInUi(await reviewerContext.newPage(), reviewer);
      const reviewerPage = reviewerContext.pages()[0];
      await reviewerPage.route(`**/projects/${projectId}`, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(projectShell),
        });
      });
      await reviewerPage.goto(`/projects/${projectId}/ai-executions`);
      await expect(reviewerPage.getByTestId("ai-execution-panel")).toBeVisible({
        timeout: 20_000,
      });
      await expect(
        reviewerPage.getByRole("button", { name: "Abrir revisión humana" }),
      ).toBeVisible({ timeout: 20_000 });
      await reviewerPage
        .getByRole("button", { name: "Abrir revisión humana" })
        .click();

      const reviewSection = reviewerPage.getByTestId("ai-review-section");
      await expect(reviewSection).toBeVisible({ timeout: 20_000 });
      await expect(reviewSection.locator("article")).toHaveCount(3);
      await expect(reviewSection.getByText(/Cita .*verificada/)).toHaveCount(3);

      const r4 = reviewSection
        .locator("article")
        .filter({ hasText: "Hallazgo R4-" })
        .first();
      const r6 = reviewSection
        .locator("article")
        .filter({ hasText: "Hallazgo R6-" })
        .first();
      const r9 = reviewSection
        .locator("article")
        .filter({ hasText: "Hallazgo R9-" })
        .first();
      await expect(r4).toBeVisible();
      await expect(r6).toBeVisible();
      await expect(r9).toBeVisible();

      await r4.getByRole("button", { name: "Rechazar hallazgo" }).click();
      await expect(r4).toContainText("Rechazado");

      const editedFinding =
        "R6: verificar alcance y tope de pena antes de aceptar el contrato.";
      await r6.getByLabel(/Editar hallazgo R6-/).fill(editedFinding);
      await r6.getByRole("button", { name: "Guardar edición" }).click();
      await expect(r6).toContainText("Editado");
      await expect(r6).toContainText(editedFinding);

      await r9.getByRole("button", { name: "Aceptar hallazgo" }).click();
      await expect(r9).toContainText("Aceptado");
      await expect(reviewSection.getByText("Pendiente")).toHaveCount(0);

      await reviewSection
        .getByRole("button", { name: "Aprobar revisión" })
        .click();
      await expect(reviewSection).toContainText("Aprobada", {
        timeout: 20_000,
      });
      await expect(reviewSection.getByText("Pendiente")).toHaveCount(0);

      const downloadPromise = reviewerPage.waitForEvent("download");
      await reviewSection
        .getByRole("button", { name: "Descargar informe Word" })
        .click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toBe(
        "Informe de revision humana.docx",
      );
      const reportPath = await download.path();
      expect(reportPath).toBeTruthy();
      const reportXml = execFileSync(
        "unzip",
        ["-p", reportPath!, "word/document.xml"],
        { encoding: "utf8" },
      );
      expect(reportXml).toContain("R6-pena-01-c1");
      expect(reportXml).toContain("R9-ley-foro-01-c1");
      expect(reportXml).toContain("No incluido por decisión del revisor");

      const redlineReviewResponse = await apiRequest(
        reviewer.accessToken,
        `/projects/${projectId}/ai-executions/${executionId}/review`,
      );
      expect(redlineReviewResponse.status).toBe(200);
      const redlineReview = asRecord(redlineReviewResponse.data);
      const redlineItems = redlineReview.items as Record<string, unknown>[];
      for (const item of redlineItems) {
        if (item.status === "rejected") continue;
        const citations = item.citation_refs as Record<string, unknown>[];
        const invalidCitations = citations.filter(
          (citation) => citation.verified !== true,
        );
        expect(
          invalidCitations,
          `redline citations for ${String(item.item_key)}`,
        ).toHaveLength(0);
      }

      const bundleResponse = await apiRequest(
        reviewer.accessToken,
        `/projects/${projectId}/ai-executions/${executionId}/review/redline-bundle`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        },
      );
      if (bundleResponse.status !== 201) {
        throw new Error(
          `Redline bundle creation failed: ${bundleResponse.status} ${bundleResponse.text}`,
        );
      }
      const bundle = asRecord(bundleResponse.data);
      const canonicalBundle = asRecord(bundle.canonical_json);
      const actions = canonicalBundle.actions as Record<string, unknown>[];
      expect(actions).toHaveLength(2);
      expect(actions.map((action) => action.citation_id).sort()).toEqual([
        "R6-pena-01-c1",
        "R9-ley-foro-01-c1",
      ]);
      expect(JSON.stringify(bundle)).not.toContain("R4-contraprestacion-01-c1");
      assertHash(bundle.bundle_sha256, "redline bundle hash");

      await reviewSection
        .getByRole("button", { name: "Publicar en Shared Drive" })
        .click();
      const publicationStatus = reviewerPage.getByTestId(
        "drive-publication-status",
      );
      await expect(publicationStatus).toContainText("Publicado", {
        timeout: 30_000,
      });
      await expect(publicationStatus.locator("a")).toHaveAttribute(
        "href",
        /beta01-drive-file/,
      );
      await reviewerPage.reload();
      await expect(reviewerPage.getByTestId("ai-review-section")).toContainText(
        "Publicado",
        { timeout: 30_000 },
      );
      await expect(
        reviewerPage.getByTestId("drive-publication-status").locator("a"),
      ).toHaveAttribute("href", /beta01-drive-file/);

      const fakeState = JSON.parse(
        fs.readFileSync(FAKE_STATE_FILE, "utf8"),
      ) as {
        provider_calls: number;
        drive_upload_calls: number;
        drive_get_calls: number;
      };
      expect(fakeState.provider_calls).toBe(1);
      expect(fakeState.drive_upload_calls).toBe(1);
      expect(fakeState.drive_get_calls).toBeGreaterThanOrEqual(1);

      const auditResponse = await restRequest(
        config,
        "audit_events",
        "?select=event_type,event_detail,actor_user_id&order=created_at.desc&limit=300",
      );
      expect(auditResponse.status).toBe(200);
      const scopedAudit = (
        auditResponse.data as Record<string, unknown>[]
      ).filter((row) => JSON.stringify(row.event_detail).includes(projectId!));
      for (const eventType of [
        "document.uploaded",
        "ai.execution.started",
        "ai.execution.completed",
        "ai.review.created",
        "ai.review.item_decided",
        "ai.review.completed",
        "ai.review.report_exported",
        "ai.review.redline_bundle_created",
        "ai.review.drive_published",
      ]) {
        expect(
          scopedAudit.some((row) => row.event_type === eventType),
          `audit event ${eventType}`,
        ).toBe(true);
      }

      for (const route of [
        `/projects/${projectId}/matters/${tenant.matterId}/drive-folder`,
        `/projects/${projectId}/ai-executions/${executionId}/receipt`,
        `/projects/${projectId}/ai-executions/${executionId}/output`,
        `/projects/${projectId}/ai-executions/${executionId}/review/report/publish`,
      ]) {
        const outsiderResponse = await apiRequest(outsider.accessToken, route);
        expect(outsiderResponse.status, `outsider ${route}`).toBe(404);
      }
    } finally {
      await reviewerContext?.close();
      await cleanupProject(config, owner, cleanup, projectId, organizationId);
      if (!DISPOSABLE_STACK) {
        await Promise.all(
          [owner.id, reviewer.id, outsider.id].map((userId) =>
            deleteUser(config, userId),
          ),
        );
      }

    }
  });
});
