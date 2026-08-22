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
 *   5. limpiar los datos sintéticos (proyecto, organización, usuario).
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
const OWNER_PASSWORD = "Beta01OwnerPass-2026!";

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
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/, { timeout: 45_000 });
  const projectId = page.url().match(/\/projects\/([0-9a-f-]{36})$/)?.[1];
  if (!projectId)
    throw new Error(`Could not read created project ID from ${page.url()}`);
  const uploaded = await uploadResponse;
  const uploadBody = JSON.parse(await uploaded.text()) as Record<
    string,
    unknown
  >;
  return { projectId, uploadStatus: uploaded.status(), uploadBody };
}

async function seedPrivateMatter(
  config: RuntimeConfig,
  projectId: string,
  owner: AuthUser,
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
  await restInsert(config, "matter_memberships", {
    matter_id: matterId,
    user_id: owner.id,
    role: "matter_owner",
  });
  return { organizationId, matterId };
}

async function cleanupProject(
  config: RuntimeConfig,
  owner: AuthUser,
  projectId: string | null,
  organizationId: string | null,
): Promise<void> {
  if (projectId) {
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
  }
}

test.describe("Beta 0.1 setup smoke", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("owner autenticado crea proyecto+matter privado y sube el DOCX con 201/versión/hash/metadata", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const config = runtimeConfig();

    const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const ownerSeed = await createAuthUser(
      config,
      `beta01-owner-${suffix}@mike.local`,
      OWNER_PASSWORD,
    );
    const owner = await signIn(config, ownerSeed);

    let projectId: string | null = null;
    let organizationId: string | null = null;
    try {
      await loginInUi(page, owner);
      const created = await createProjectAndUploadDocx(
        page,
        `Beta 0.1 synthetic MSA ${suffix}`,
      );
      projectId = created.projectId;

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
      );
      organizationId = tenant.organizationId;

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
      // Limpieza de datos sintéticos: proyecto (API) + organización (REST)
      // cascaden documentos, versiones, workspaces, matters y membresías.
      // El usuario sintético NO se borra: audit_events es insert-only (W1.13)
      // con FK "on delete set null" hacia auth.users, así que hard-delete del
      // usuario dispara el trigger anti-UPDATE y GoTrue devuelve 500 — el
      // borrado de cuentas con auditoría está bloqueado por diseño. Los
      // usuarios beta01-*@mike.local se reutilizan entre corridas (misma
      // convención que e2e@mike.local del auth.setup); el stack local los
      // contiene únicamente.
      await cleanupProject(config, owner, projectId, organizationId);
    }
  });
});