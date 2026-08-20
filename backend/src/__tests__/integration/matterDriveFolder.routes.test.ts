import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const { checkMatterAccess } = vi.hoisted(() => ({
  checkMatterAccess: vi.fn(),
}));

type Row = Record<string, unknown>;
const rows: Record<string, Row[]> = {
  matters: [
    {
      id: "matter-1",
      project_id: "project-1",
      drive_folder_id: "folder-1",
      updated_at: "2026-08-20T00:00:00.000Z",
    },
  ],
};

function queryFor(table: string) {
  let current = [...(rows[table] ?? [])];
  let pendingUpdate: Row | null = null;
  const query: Record<string, any> = {};
  query.select = vi.fn(() => query);
  query.eq = vi.fn((column: string, value: unknown) => {
    current = current.filter((row) => row[column] === value);
    return query;
  });
  query.update = vi.fn((payload: Row) => {
    pendingUpdate = payload;
    return query;
  });
  query.single = vi.fn(async () => {
    if (pendingUpdate) {
      for (const row of current) Object.assign(row, pendingUpdate);
    }
    return { data: current[0] ?? null, error: null };
  });
  query.maybeSingle = query.single;
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
    res.locals.userId = "user-1";
    next();
  },
  requireMfaIfEnrolled: (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));
vi.mock("../../lib/aiAccess", () => ({
  checkMatterAccess: (...args: unknown[]) => checkMatterAccess(...args),
  assertMatterAccessFresh: vi.fn(),
}));

import { app } from "../../app";

const baseAccess = {
  ok: true as const,
  projectId: "project-1",
  organizationId: "org-1",
  authorizationEpoch: 1,
};
const route = "/projects/project-1/matters/matter-1/drive-folder";

beforeEach(() => {
  vi.clearAllMocks();
  rows.matters[0] = {
    id: "matter-1",
    project_id: "project-1",
    drive_folder_id: "folder-1",
    updated_at: "2026-08-20T00:00:00.000Z",
  };
  checkMatterAccess.mockResolvedValue({
    ...baseAccess,
    role: "matter_owner",
  });
});

describe("matter Shared Drive folder settings", () => {
  it("lets the matter owner read and update the explicit folder", async () => {
    const read = await request(app).get(route).set("Authorization", "Bearer test");

    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      matter_id: "matter-1",
      project_id: "project-1",
      drive_folder_id: "folder-1",
      role: "matter_owner",
      can_edit: true,
    });

    const update = await request(app)
      .patch(route)
      .set("Authorization", "Bearer test")
      .send({ drive_folder_id: "folder-2" });

    expect(update.status).toBe(200);
    expect(update.body).toMatchObject({
      drive_folder_id: "folder-2",
      role: "matter_owner",
      can_edit: true,
    });
  });

  it("lets an editor view the folder but rejects changes", async () => {
    checkMatterAccess.mockResolvedValue({
      ...baseAccess,
      role: "editor",
    });

    const read = await request(app).get(route).set("Authorization", "Bearer test");
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      drive_folder_id: "folder-1",
      role: "editor",
      can_edit: false,
    });

    const update = await request(app)
      .patch(route)
      .set("Authorization", "Bearer test")
      .send({ drive_folder_id: "folder-2" });

    expect(update.status).toBe(403);
    expect(update.body).toEqual({
      code: "matter_owner_required",
      detail: "Only the matter owner can change the Shared Drive folder",
    });
  });

  it("fails closed for a crossed project, revoked access, or an unsafe folder value", async () => {
    checkMatterAccess.mockResolvedValueOnce({
      ...baseAccess,
      projectId: "other-project",
      role: "matter_owner",
    });
    const crossed = await request(app).get(route).set("Authorization", "Bearer test");
    expect(crossed.status).toBe(404);

    checkMatterAccess.mockResolvedValueOnce({ ok: false });
    const revoked = await request(app).get(route).set("Authorization", "Bearer test");
    expect(revoked.status).toBe(404);

    const invalid = await request(app)
      .patch(route)
      .set("Authorization", "Bearer test")
      .send({ drive_folder_id: "https://drive.google.com/folders/secret" });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({
      code: "invalid_drive_folder_id",
      detail: "Shared Drive folder ID is invalid",
    });
  });
});
