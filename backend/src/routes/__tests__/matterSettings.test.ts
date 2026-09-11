import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  rpc,
  getMatterMembership,
  maybeSingle,
  evaluateInitialAccess,
  recheckFreshAccessViaPort,
} = vi.hoisted(() => ({
  rpc: vi.fn(),
  getMatterMembership: vi.fn(),
  maybeSingle: vi.fn(),
  evaluateInitialAccess: vi.fn(),
  recheckFreshAccessViaPort: vi.fn(),
}));

vi.mock("../../middleware/auth", () => ({
  requireAuth: (
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (_req.header("x-test-auth") !== "yes") {
      res.status(401).json({ detail: "authentication required" });
      return;
    }
    res.locals.authenticatedIdentity = {
      user_id: IDS.owner,
      transport: { kind: "web_session" },
      mfa_satisfied: true,
    };
    next();
  },
  requireMfaIfEnrolled: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next(),
}));

vi.mock("../../lib/supabase", () => ({
  createServerSupabase: vi.fn(() => ({
    from: () => ({
      select: () => ({
        eq: function () {
          return this;
        },
        maybeSingle,
      }),
    }),
    rpc,
  })),
}));

vi.mock("../../lib/recovery/authorization/supabaseTenancyReadPort", () => ({
  createSupabaseTenancyReadPort: vi.fn(() => ({
    getMatter: vi.fn(),
    getMatterMembership,
  })),
}));
vi.mock("../../lib/recovery/authorization/tenancyReadPort", () => ({
  evaluateInitialAccess,
  recheckFreshAccessViaPort,
}));

import { matterSettingsRouter } from "../matterSettings";

const IDS = {
  owner: "11111111-1111-4111-8111-111111111111",
  organization: "22222222-2222-4222-8222-222222222222",
  matter: "33333333-3333-4333-8333-333333333333",
  project: "44444444-4444-4444-8444-444444444444",
  workspace: "55555555-5555-4555-8555-555555555555",
} as const;

const scope = {
  user_id: IDS.owner,
  organization_id: IDS.organization,
  workspace_id: IDS.workspace,
  matter_id: IDS.matter,
  membership_role: "matter_owner" as const,
  authorization_epoch: 7,
  requires_explicit_matter_membership: true,
};

function matterRow(drive_folder_id: string | null = "old-folder") {
  return {
    id: IDS.matter,
    project_id: IDS.project,
    workspace_id: IDS.workspace,
    drive_folder_id,
    workspaces: { organization_id: IDS.organization },
  };
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/projects/:projectId/matters", matterSettingsRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  recheckFreshAccessViaPort.mockReset();
  getMatterMembership
    .mockReset()
    .mockResolvedValue({
      user_id: IDS.owner,
      matter_id: IDS.matter,
      role: "matter_owner",
      status: "active",
    });
  maybeSingle.mockResolvedValue({ data: matterRow(), error: null });
  rpc.mockResolvedValue({
    data: {
      matter_id: IDS.matter,
      project_id: IDS.project,
      organization_id: IDS.organization,
      drive_folder_id: "new-folder",
    },
    error: null,
  });
  evaluateInitialAccess.mockResolvedValue({
    kind: "decision",
    decision: { outcome: "allow", scope },
  });
  recheckFreshAccessViaPort.mockResolvedValue({
    kind: "recheck",
    result: { fresh: true },
  });
});

describe("matter Drive folder settings routes", () => {
  it("allows the explicit matter owner to edit a public matter", async () => {
    evaluateInitialAccess.mockResolvedValue({
      kind: "decision",
      decision: {
        outcome: "allow",
        scope: {
          ...scope,
          membership_role: "org_owner",
          requires_explicit_matter_membership: false,
        },
      },
    });
    const result = await request(makeApp())
      .patch(`/projects/${IDS.project}/matters/${IDS.matter}/drive-folder`)
      .set("x-test-auth", "yes")
      .send({ drive_folder_id: "new-folder" });
    expect(result.status).toBe(200);
    expect(result.body.can_edit).toBe(true);
    expect(rpc).toHaveBeenCalledOnce();
  });

  it("reports the explicit owner's settings authority for a public matter", async () => {
    evaluateInitialAccess.mockResolvedValue({
      kind: "decision",
      decision: {
        outcome: "allow",
        scope: {
          ...scope,
          membership_role: "org_owner",
          requires_explicit_matter_membership: false,
        },
      },
    });
    const result = await request(makeApp())
      .get(`/projects/${IDS.project}/matters/${IDS.matter}/drive-folder`)
      .set("x-test-auth", "yes");
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ role: "matter_owner", can_edit: true });
  });
  it.each(["id", "project_id", "workspace_id"])(
    "denies a returned row with mismatched %s",
    async (field) => {
      maybeSingle.mockResolvedValue({
        data: {
          ...matterRow(),
          [field]: "66666666-6666-4666-8666-666666666666",
        },
        error: null,
      });
      for (const method of ["get", "patch"] as const) {
        const call = request(makeApp())
          [
            method
          ](`/projects/${IDS.project}/matters/${IDS.matter}/drive-folder`)
          .set("x-test-auth", "yes");
        const response = await (method === "patch"
          ? call.send({ drive_folder_id: "new-folder" })
          : call);
        expect(response.status).toBe(404);
        expect(response.body).toEqual({
          code: "not_found",
          detail: "Not found.",
        });
      }
      expect(rpc).not.toHaveBeenCalled();
    },
  );

  it("does not return a stale folder when access is revoked during the read", async () => {
    recheckFreshAccessViaPort.mockResolvedValueOnce({
      kind: "recheck",
      result: { fresh: false, code: "authorization_revoked" },
    });
    const response = await request(makeApp())
      .get(`/projects/${IDS.project}/matters/${IDS.matter}/drive-folder`)
      .set("x-test-auth", "yes");
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ code: "not_found", detail: "Not found." });
  });

  it("requires the authenticated API session", async () => {
    const response = await request(makeApp()).get(
      `/projects/${IDS.project}/matters/${IDS.matter}/drive-folder`,
    );
    expect(response.status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("returns the current setting, role, and edit capability through the route and current tenancy adapter", async () => {
    const response = await request(makeApp())
      .get(`/projects/${IDS.project}/matters/${IDS.matter}/drive-folder`)
      .set("x-test-auth", "yes");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      matter_id: IDS.matter,
      project_id: IDS.project,
      drive_folder_id: "old-folder",
      role: "matter_owner",
      can_edit: true,
    });
    expect(response.text).not.toContain("organization_id");
  });

  it.each([
    [
      "editor",
      { ...scope, membership_role: "editor" },
      403,
      "matter_owner_required",
    ],
    [
      "org owner only",
      {
        ...scope,
        membership_role: "org_owner",
        requires_explicit_matter_membership: false,
      },
      403,
      "matter_owner_required",
    ],
    ["outsider", { outcome: "not_found" }, 404, "not_found"],
    [
      "MFA",
      { outcome: "denied", code: "mfa_required", reason: "mfa_required" },
      403,
      "mfa_required",
    ],
  ])("enforces %s authorization", async (_label, decision, status, code) => {
    getMatterMembership.mockResolvedValue(
      _label === "org owner only"
        ? null
        : {
            user_id: IDS.owner,
            matter_id: IDS.matter,
            role: "editor",
            status: "active",
          },
    );
    evaluateInitialAccess.mockResolvedValue({
      kind: "decision",
      decision:
        "outcome" in decision
          ? decision
          : { outcome: "allow", scope: decision },
    });
    const response = await request(makeApp())
      .patch(`/projects/${IDS.project}/matters/${IDS.matter}/drive-folder`)
      .set("x-test-auth", "yes")
      .send({ drive_folder_id: "new-folder" });
    expect(response.status).toBe(status);
    expect(response.body.code).toBe(code);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects invalid fields, denies stale/source-mismatched fresh authorization, and acknowledges a clear", async () => {
    for (const body of [
      {},
      { drive_folder_id: "bad/id" },
      { drive_folder_id: "folder", extra: true },
    ]) {
      const response = await request(makeApp())
        .patch(`/projects/${IDS.project}/matters/${IDS.matter}/drive-folder`)
        .set("x-test-auth", "yes")
        .send(body);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("invalid_drive_folder_id");
    }

    recheckFreshAccessViaPort.mockResolvedValueOnce({
      kind: "recheck",
      result: {
        fresh: false,
        code: "stale_authorization_epoch",
        reason: "secret",
      },
    });
    const stale = await request(makeApp())
      .patch(`/projects/${IDS.project}/matters/${IDS.matter}/drive-folder`)
      .set("x-test-auth", "yes")
      .send({ drive_folder_id: "new-folder" });
    expect(stale.status).toBe(403);
    expect(stale.body).toEqual({
      code: "authorization_revoked",
      detail: "Authorization revoked.",
    });
    expect(stale.text).not.toContain("secret");

    recheckFreshAccessViaPort.mockResolvedValueOnce({
      kind: "recheck",
      result: { fresh: true },
    });
    rpc.mockResolvedValueOnce({
      data: {
        matter_id: IDS.matter,
        project_id: "66666666-6666-4666-8666-666666666666",
        organization_id: IDS.organization,
        drive_folder_id: null,
      },
      error: null,
    });
    const mismatch = await request(makeApp())
      .patch(`/projects/${IDS.project}/matters/${IDS.matter}/drive-folder`)
      .set("x-test-auth", "yes")
      .send({ drive_folder_id: null });
    expect(mismatch.status).toBe(500);
    expect(mismatch.body).toMatchObject({ code: "internal_error" });

    rpc.mockResolvedValueOnce({
      data: {
        matter_id: IDS.matter,
        project_id: IDS.project,
        organization_id: IDS.organization,
        drive_folder_id: null,
      },
      error: null,
    });
    const cleared = await request(makeApp())
      .patch(`/projects/${IDS.project}/matters/${IDS.matter}/drive-folder`)
      .set("x-test-auth", "yes")
      .send({ drive_folder_id: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.drive_folder_id).toBeNull();
  });
});
