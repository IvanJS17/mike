import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { contentSha256 } from "../../lib/documentVersions";
import type { DriveClient, DriveFileMetadata } from "../../lib/googleDrive";

const {
  checkMatterAccess,
  assertEpochFresh,
  downloadFile,
  recordAuditEvent,
  driveClient,
} = vi.hoisted(() => ({
  checkMatterAccess: vi.fn(),
  assertEpochFresh: vi.fn(),
  downloadFile: vi.fn(),
  recordAuditEvent: vi.fn(),
  driveClient: {
    uploadDocx: vi.fn(),
    getFile: vi.fn(),
  },
}));

const reportBytes = Buffer.from("approved-report-docx");
const reportSha256 = contentSha256(reportBytes);
const rows: Record<string, Record<string, unknown>[]> = {
  ai_executions: [
    {
      id: "execution-1",
      user_id: "reviewer-1",
      matter_id: "matter-1",
      project_id: "project-1",
      document_id: "source-document-1",
      document_version_id: "source-version-1",
      document_content_sha256: "a".repeat(64),
      status: "succeeded",
    },
  ],
  ai_reviews: [
    {
      id: "review-1",
      execution_id: "execution-1",
      matter_id: "matter-1",
      project_id: "project-1",
      reviewer_user_id: "reviewer-1",
      status: "approved",
      created_at: "2026-08-19T12:00:00.000Z",
      completed_at: "2026-08-19T12:05:00.000Z",
    },
  ],
  ai_review_exports: [
    {
      id: "export-1",
      review_id: "review-1",
      execution_id: "execution-1",
      matter_id: "matter-1",
      project_id: "project-1",
      source_document_version_id: "source-version-1",
      document_id: "report-document-1",
      document_version_id: "report-version-1",
      report_version: 1,
      filename: "Informe de revision humana.docx",
      content_sha256: reportSha256,
      actor_user_id: "reviewer-1",
      created_at: "2026-08-19T12:06:00.000Z",
    },
  ],
  matters: [
    {
      id: "matter-1",
      project_id: "project-1",
      drive_folder_id: "shared-drive-folder-1",
    },
  ],
  document_versions: [
    {
      id: "report-version-1",
      document_id: "report-document-1",
      storage_path: "generated/ai-review-reports/report-1/report.docx",
      source: "ai_review_report",
      filename: "Informe de revision humana.docx",
      file_type: "docx",
      size_bytes: reportBytes.byteLength,
      content_sha256: reportSha256,
      deleted_at: null,
    },
  ],
  ai_review_drive_publications: [],
};

let ids = 0;

function nextId(table: string): string {
  ids += 1;
  return `${table}-${ids}`;
}

function queryFor(table: string) {
  let current = [...(rows[table] ?? [])];
  const query: Record<string, any> = {};
  query.select = vi.fn(() => query);
  query.eq = vi.fn((column: string, value: unknown) => {
    current = current.filter((row) => row[column] === value);
    return query;
  });
  query.is = vi.fn((column: string, value: unknown) => {
    current = current.filter((row) => (row[column] ?? null) === value);
    return query;
  });
  query.insert = vi.fn((payload: Record<string, unknown>) => {
    const inserted = { id: nextId(table), ...payload };
    rows[table].push(inserted);
    current = [inserted];
    return query;
  });
  query.update = vi.fn((payload: Record<string, unknown>) => {
    for (const row of current) Object.assign(row, payload);
    return query;
  });
  query.single = vi.fn(async () => ({ data: current[0] ?? null, error: null }));
  query.maybeSingle = query.single;
  query.then = (
    resolve: (value: unknown) => unknown,
    reject?: (error: unknown) => unknown,
  ) => Promise.resolve({ data: current, error: null }).then(resolve, reject);
  return query;
}

const db = {
  from: vi.fn((table: string) => queryFor(table)),
};

vi.mock("../../lib/supabase", () => ({
  createServerSupabase: vi.fn(() => db),
}));
vi.mock("../../middleware/auth", () => ({
  requireAuth: (
    _req: unknown,
    res: { locals: Record<string, unknown> },
    next: () => void,
  ) => {
    res.locals.userId = "reviewer-1";
    next();
  },
  requireMfaIfEnrolled: (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));
vi.mock("../../lib/aiAccess", () => ({
  checkMatterAccess: (...args: unknown[]) => checkMatterAccess(...args),
}));
vi.mock("../../lib/tenancy", () => ({
  assertEpochFresh: (...args: unknown[]) => assertEpochFresh(...args),
}));
vi.mock("../../lib/storage", () => ({
  downloadFile: (...args: unknown[]) => downloadFile(...args),
  uploadFile: vi.fn(),
  deleteFile: vi.fn(),
  buildContentDisposition: (kind: string, filename: string) =>
    `${kind}; filename=\"${filename}\"`,
}));
vi.mock("../../lib/googleDrive", () => ({
  getGoogleDriveClient: vi.fn(() => driveClient),
}));
vi.mock("../../lib/audit", () => ({
  recordAuditEvent: (...args: unknown[]) => recordAuditEvent(...args),
}));
vi.mock("../../lib/chat/tools/documentOps", () => ({
  generateDocx: vi.fn(),
}));

import { app } from "../../app";

const route =
  "/projects/project-1/ai-executions/execution-1/review/report/publish";

function driveFile(
  id: string,
  overrides: Partial<DriveFileMetadata> = {},
): DriveFileMetadata {
  return {
    id,
    parents: ["shared-drive-folder-1"],
    size: String(reportBytes.byteLength),
    md5Checksum: "md5-checksum-1",
    appProperties: {
      matter_id: "matter-1",
      review_id: "review-1",
      export_id: "export-1",
      sha256: reportSha256,
      format_version: "beta-0.1",
    },
    ...overrides,
  };
}

beforeEach(() => {
  ids = 0;
  vi.clearAllMocks();
  rows.ai_review_drive_publications.length = 0;
  rows.ai_reviews[0].status = "approved";
  rows.ai_review_exports[0].content_sha256 = reportSha256;
  rows.ai_review_exports[0].matter_id = "matter-1";
  rows.ai_review_exports[0].project_id = "project-1";
  rows.matters[0].drive_folder_id = "shared-drive-folder-1";
  rows.document_versions[0].source = "ai_review_report";
  rows.document_versions[0].content_sha256 = reportSha256;
  checkMatterAccess.mockResolvedValue({
    ok: true,
    role: "editor",
    projectId: "project-1",
    organizationId: "org-1",
    authorizationEpoch: 1,
  });
  assertEpochFresh.mockResolvedValue(undefined);
  downloadFile.mockResolvedValue(
    reportBytes.buffer.slice(
      reportBytes.byteOffset,
      reportBytes.byteOffset + reportBytes.byteLength,
    ),
  );
  let uploadCount = 0;
  driveClient.uploadDocx.mockImplementation(
    async (input: Parameters<DriveClient["uploadDocx"]>[0]) => {
      uploadCount += 1;
      return driveFile(`drive-file-${uploadCount}`, {
        parents: [input.parentId],
        appProperties: input.appProperties,
        size: String(input.bytes.byteLength),
      });
    },
  );
  driveClient.getFile.mockImplementation(async (fileId: string) =>
    driveFile(fileId),
  );
  recordAuditEvent.mockResolvedValue(undefined);
});

describe("approved AI review report Drive publication", () => {
  it("uploads the approved DOCX with scoped appProperties and verifies the file", async () => {
    const response = await request(app)
      .post(route)
      .set("Authorization", "Bearer test");

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      id: "ai_review_drive_publications-1",
      export_id: "export-1",
      status: "published",
      file_id: "drive-file-1",
      drive_folder_id: "shared-drive-folder-1",
      sha256: reportSha256,
      format_version: "beta-0.1",
      size_bytes: reportBytes.byteLength,
      checksum: "md5-checksum-1",
    });
    expect(driveClient.uploadDocx).toHaveBeenCalledOnce();
    expect(driveClient.uploadDocx).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Informe de revision humana.docx",
        parentId: "shared-drive-folder-1",
        bytes: reportBytes,
        appProperties: {
          matter_id: "matter-1",
          review_id: "review-1",
          export_id: "export-1",
          sha256: reportSha256,
          format_version: "beta-0.1",
        },
      }),
    );
    expect(driveClient.getFile).toHaveBeenCalledWith("drive-file-1");
    expect(rows.ai_review_drive_publications[0]).toMatchObject({
      status: "published",
      file_id: "drive-file-1",
    });
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: "ai.review.drive_published",
        eventDetail: expect.objectContaining({
          publication_id: "ai_review_drive_publications-1",
          export_id: "export-1",
          file_id: "drive-file-1",
          sha256: reportSha256,
        }),
      }),
    );
    const auditText = JSON.stringify(recordAuditEvent.mock.calls[0][1]);
    expect(auditText).not.toContain("generated/ai-review-reports");
  });

  it("returns the same publication and file on a repeated export+sha request", async () => {
    const first = await request(app)
      .post(route)
      .set("Authorization", "Bearer test");
    expect(first.status).toBe(201);

    const second = await request(app)
      .post(route)
      .set("Authorization", "Bearer test");

    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.file_id).toBe(first.body.file_id);
    expect(driveClient.uploadDocx).toHaveBeenCalledOnce();
    expect(driveClient.getFile).toHaveBeenCalledOnce();
    expect(rows.ai_review_drive_publications).toHaveLength(1);
  });

  it.each([
    ["review_not_approved", () => (rows.ai_reviews[0].status = "in_progress")],
    ["folder_not_configured", () => (rows.matters[0].drive_folder_id = null)],
    [
      "scope_mismatch",
      () => (rows.ai_review_exports[0].matter_id = "other-matter"),
    ],
    [
      "export_hash_mismatch",
      () => (rows.ai_review_exports[0].content_sha256 = "b".repeat(64)),
    ],
    [
      "permission_denied",
      () => checkMatterAccess.mockResolvedValue({ ok: false }),
    ],
    [
      "authorization_revoked",
      () => assertEpochFresh.mockRejectedValue(new Error("revoked")),
    ],
  ] as const)(
    "fails closed for %s without uploading",
    async (_code, arrange) => {
      arrange();

      const response = await request(app)
        .post(route)
        .set("Authorization", "Bearer test");

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(driveClient.uploadDocx).not.toHaveBeenCalled();
      expect(rows.ai_review_drive_publications).toHaveLength(0);
    },
  );

  it("marks a publication failed with a safe code when Drive verification fails", async () => {
    driveClient.getFile.mockResolvedValue(
      driveFile("drive-file-1", { parents: ["other-folder"] }),
    );

    const response = await request(app)
      .post(route)
      .set("Authorization", "Bearer test");

    expect(response.status).toBe(502);
    expect(response.body).toMatchObject({
      code: "drive_publication_failed",
      publication: { status: "failed", failure_code: "drive_file_invalid" },
    });
    expect(rows.ai_review_drive_publications[0]).toMatchObject({
      status: "failed",
      failure_code: "drive_file_invalid",
      file_id: null,
    });
    expect(JSON.stringify(response.body)).not.toContain("other-folder");
  });

  it("marks an upload error failed without exposing provider details", async () => {
    driveClient.uploadDocx.mockRejectedValue(
      new Error("Bearer live-drive-token was rejected"),
    );

    const response = await request(app)
      .post(route)
      .set("Authorization", "Bearer test");

    expect(response.status).toBe(502);
    expect(response.body).toMatchObject({
      code: "drive_publication_failed",
      publication: { status: "failed", failure_code: "drive_upload_failed" },
    });
    expect(JSON.stringify(response.body)).not.toContain("live-drive-token");
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: "ai.review.drive_publication_failed",
        eventDetail: expect.objectContaining({
          failure_code: "drive_upload_failed",
        }),
      }),
    );
  });
});
