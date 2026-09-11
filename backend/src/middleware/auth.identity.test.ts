import type { NextFunction, Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  admin,
  requestClient,
  createServerSupabase,
  createRequestSupabase,
  syncProfileEmail,
} = vi.hoisted(() => {
  const admin = {
    from: vi.fn(),
    auth: {
      getUser: vi.fn(),
      mfa: { getAuthenticatorAssuranceLevel: vi.fn() },
    },
  };
  const requestClient = {
    auth: {
      getUser: vi.fn(),
      getSession: vi.fn(),
    },
  };
  return {
    admin,
    requestClient,
    createServerSupabase: vi.fn(() => admin),
    createRequestSupabase: vi.fn(() => requestClient),
    syncProfileEmail: vi.fn(async () => null),
  };
});

vi.mock("../lib/supabase", () => ({ createServerSupabase }));
vi.mock("../lib/authSession", () => ({ createRequestSupabase }));
vi.mock("../lib/userLookup", () => ({ syncProfileEmail }));

import { requireAuth, requireMfaIfEnrolled } from "./auth";

const USER = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "lawyer@example.test",
};

function request(
  input: {
    authorization?: string;
    clientName?: string;
    origin?: string;
    secFetchSite?: string;
    method?: string;
  } = {},
): Request {
  const headers: Record<string, string> = {};
  if (input.authorization) headers.authorization = input.authorization;
  if (input.clientName) headers["x-mike-client"] = input.clientName;
  if (input.origin) headers.origin = input.origin;
  if (input.secFetchSite) headers["sec-fetch-site"] = input.secFetchSite;
  return {
    headers,
    method: input.method ?? "GET",
    originalUrl: "/governed-probe",
    get(name: string) {
      return headers[name.toLowerCase()];
    },
  } as unknown as Request;
}

function response(): Response & { statusCode?: number; body?: unknown } {
  const res = {
    locals: {},
    statusCode: undefined as number | undefined,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return res as unknown as Response & { statusCode?: number; body?: unknown };
}

function profileResult(mfaOnLogin = false) {
  admin.from.mockReturnValue({
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        maybeSingle: vi.fn(async () => ({
          data: { mfa_on_login: mfaOnLogin },
          error: null,
        })),
      })),
    })),
  });
}

function assurance(currentLevel: "aal1" | "aal2", nextLevel: "aal1" | "aal2") {
  admin.auth.mfa.getAuthenticatorAssuranceLevel.mockResolvedValue({
    data: { currentLevel, nextLevel },
    error: null,
  });
}

async function run(req: Request) {
  const res = response();
  const next = vi.fn() as unknown as NextFunction;
  await requireAuth(req, res, next);
  return { res, next };
}

const originalBearerClients = process.env.MIKE_NON_BROWSER_BEARER_CLIENTS;

afterEach(() => {
  if (originalBearerClients === undefined) {
    delete process.env.MIKE_NON_BROWSER_BEARER_CLIENTS;
  } else {
    process.env.MIKE_NON_BROWSER_BEARER_CLIENTS = originalBearerClients;
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MIKE_NON_BROWSER_BEARER_CLIENTS =
    "loadtest,backend-integration-test";
  admin.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null });
  requestClient.auth.getUser.mockResolvedValue({
    data: { user: USER },
    error: null,
  });
  requestClient.auth.getSession.mockResolvedValue({
    data: { session: { access_token: "cookie-access-token" } },
    error: null,
  });
  profileResult(false);
  assurance("aal2", "aal2");
});

describe("requireAuth — governed request identity", () => {
  it("attaches a named allowlisted non-browser Bearer identity", async () => {
    const { res, next } = await run(
      request({
        authorization: "Bearer test-access-token",
        clientName: "loadtest",
      }),
    );

    expect(next).toHaveBeenCalledOnce();
    expect(res.locals.authSource).toBe("bearer");
    expect(res.locals.authenticatedIdentity).toEqual({
      user_id: USER.id,
      transport: { kind: "non_browser_bearer", client_name: "loadtest" },
      mfa_satisfied: true,
    });
    expect(JSON.stringify(res.locals.authenticatedIdentity)).not.toContain(
      "test-access-token",
    );
  });

  it.each([
    { origin: "https://app.example.test" },
    { secFetchSite: "same-origin" },
  ])(
    "rejects browser-context Bearer before token validation: %o",
    async (browser) => {
      const { res, next } = await run(
        request({
          authorization: "Bearer browser-token",
          clientName: "loadtest",
          ...browser,
        }),
      );

      expect(res.statusCode).toBe(403);
      expect(res.body).toEqual({
        code: "browser_bearer_prohibited",
        detail: "Browser clients must use the cookie session.",
      });
      expect(admin.auth.getUser).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "", "unknown-client"])(
    "rejects an unnamed or unallowlisted Bearer before token validation (%s)",
    async (clientName) => {
      const { res, next } = await run(
        request({
          authorization: "Bearer test-access-token",
          ...(clientName ? { clientName } : {}),
        }),
      );

      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual({
        code: "bearer_client_not_allowed",
        detail: "This API client is not allowed.",
      });
      expect(admin.auth.getUser).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
    },
  );

  it("attaches a cookie web-session identity with observed MFA assurance", async () => {
    assurance("aal1", "aal2");
    const { res, next } = await run(request());

    expect(next).toHaveBeenCalledOnce();
    expect(res.locals.authSource).toBe("cookie");
    expect(res.locals.authenticatedIdentity).toEqual({
      user_id: USER.id,
      transport: { kind: "web_session" },
      mfa_satisfied: false,
    });
    expect(admin.auth.mfa.getAuthenticatorAssuranceLevel).toHaveBeenCalledWith(
      "cookie-access-token",
    );
  });

  it("refreshes the typed identity when the route MFA guard observes AAL2", async () => {
    admin.auth.mfa.getAuthenticatorAssuranceLevel
      .mockReset()
      .mockResolvedValueOnce({
        data: { currentLevel: "aal1", nextLevel: "aal2" },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { currentLevel: "aal2", nextLevel: "aal2" },
        error: null,
      });
    const req = request();
    const { res, next } = await run(req);
    expect(next).toHaveBeenCalledOnce();
    expect(res.locals.authenticatedIdentity.mfa_satisfied).toBe(false);

    const mfaNext = vi.fn() as unknown as NextFunction;
    await requireMfaIfEnrolled(req, res, mfaNext);

    expect(mfaNext).toHaveBeenCalledOnce();
    expect(res.locals.authenticatedIdentity).toEqual({
      user_id: USER.id,
      transport: { kind: "web_session" },
      mfa_satisfied: true,
    });
  });

  it("enforces the login MFA preference while preserving typed assurance", async () => {
    profileResult(true);
    assurance("aal1", "aal2");
    const { res, next } = await run(request());

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({
      code: "mfa_verification_required",
      detail: "MFA verification required",
    });
    expect(res.locals.authenticatedIdentity).toBeUndefined();
    expect(next).not.toHaveBeenCalled();
  });
});
