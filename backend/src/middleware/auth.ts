import { Request, Response, NextFunction } from "express";
import { createServerSupabase } from "../lib/supabase";
import { syncProfileEmail } from "../lib/userLookup";
import { sendInternalError } from "../lib/httpError";
import { createRequestSupabase } from "../lib/authSession";
import { requestOriginIsTrusted } from "../lib/origins";
import {
  buildAuthenticatedIdentity,
  type AuthenticatedIdentity,
} from "../lib/recovery/identity/authStateMatrix";

const isDev = process.env.NODE_ENV !== "production";
const devLog = (...args: Parameters<typeof console.log>) => {
  if (isDev) console.log(...args);
};

const BEARER_CLIENT_HEADER = "x-mike-client";
const BEARER_CLIENT_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function configuredBearerClients(
  env: NodeJS.ProcessEnv = process.env,
): Set<string> {
  return new Set(
    (env.MIKE_NON_BROWSER_BEARER_CLIENTS ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter((name) => BEARER_CLIENT_NAME.test(name)),
  );
}

function requestHasBrowserContext(req: Request): boolean {
  return Boolean(
    req.get("origin") || req.get("sec-fetch-site") || req.get("sec-fetch-mode"),
  );
}

function allowedBearerClient(req: Request): string | null {
  const name = req.get(BEARER_CLIENT_HEADER)?.trim().toLowerCase() ?? "";
  if (!BEARER_CLIENT_NAME.test(name)) return null;
  return configuredBearerClients().has(name) ? name : null;
}

function summarizeMfaFactors(
  factors:
    | Array<{
        factor_type?: string;
        status?: string;
      }>
    | null
    | undefined,
) {
  return (factors ?? []).map((factor) => ({
    type: factor.factor_type ?? "unknown",
    status: factor.status ?? "unknown",
  }));
}

function isLoginMfaBootstrapRoute(req: Request) {
  const path = req.originalUrl.split("?")[0];
  if (path === "/auth/session" || path.startsWith("/auth/mfa/")) {
    return true;
  }
  return (
    (req.method === "GET" || req.method === "POST") &&
    (path === "/user/profile" || path === "/users/profile")
  );
}

type LoginMfaResult =
  | { allowed: true; mfaSatisfied: boolean }
  | { allowed: false };

async function enforceLoginMfaIfEnabled(
  req: Request,
  res: Response,
  admin: ReturnType<typeof createServerSupabase>,
  token: string,
): Promise<LoginMfaResult> {
  if (isLoginMfaBootstrapRoute(req)) {
    return { allowed: true, mfaSatisfied: false };
  }

  const { data, error } = await admin
    .from("user_profiles")
    .select("mfa_on_login")
    .eq("user_id", res.locals.userId)
    .maybeSingle();

  if (error) {
    devLog("[auth/mfa] login preference lookup failed", {
      method: req.method,
      path: req.originalUrl,
      userId: res.locals.userId,
      error: error.message,
      code: error.code,
    });
    sendInternalError(res, error);
    return { allowed: false };
  }

  const { data: assurance, error: assuranceError } =
    await admin.auth.mfa.getAuthenticatorAssuranceLevel(token);

  if (assuranceError) {
    devLog("[auth/mfa] login assurance lookup failed", {
      method: req.method,
      path: req.originalUrl,
      userId: res.locals.userId,
      error: assuranceError.message,
    });
    console.error("[auth/mfa] login assurance lookup failed", assuranceError);
    res.status(401).json({
      code: "authentication_failed",
      detail: "Unable to verify authentication. Please sign in again.",
    });
    return { allowed: false };
  }

  const mfaSatisfied = assurance.currentLevel === "aal2";
  const profile = data as { mfa_on_login?: boolean } | null;
  if (
    profile?.mfa_on_login === true &&
    assurance.nextLevel === "aal2" &&
    !mfaSatisfied
  ) {
    devLog("[auth/mfa] login verification required", {
      method: req.method,
      path: req.originalUrl,
      userId: res.locals.userId,
    });
    res.status(403).json({
      code: "mfa_verification_required",
      detail: "MFA verification required",
    });
    return { allowed: false };
  }

  return { allowed: true, mfaSatisfied };
}

function getAdminClient(res: Response) {
  try {
    return createServerSupabase();
  } catch {
    res.status(500).json({ detail: "Server auth is not configured" });
    return null;
  }
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const auth = req.headers.authorization ?? "";
  const bearer = auth.startsWith("Bearer ");
  let bearerClientName: string | null = null;

  if (bearer) {
    if (requestHasBrowserContext(req)) {
      res.status(403).json({
        code: "browser_bearer_prohibited",
        detail: "Browser clients must use the cookie session.",
      });
      return;
    }
    bearerClientName = allowedBearerClient(req);
    if (!bearerClientName) {
      res.status(401).json({
        code: "bearer_client_not_allowed",
        detail: "This API client is not allowed.",
      });
      return;
    }
  }

  const admin = getAdminClient(res);
  if (!admin) return;

  let token = "";
  let user: Awaited<ReturnType<typeof admin.auth.getUser>>["data"]["user"] =
    null;

  if (bearer) {
    token = auth.slice(7).trim();
    if (!token) {
      res.status(401).json({ detail: "Invalid or expired session" });
      return;
    }
    const result = await admin.auth.getUser(token);
    user = result.data.user;
    res.locals.authSource = "bearer";
  } else {
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      !requestOriginIsTrusted(req.get("origin"))
    ) {
      res.status(403).json({
        code: "untrusted_origin",
        detail: "The request origin is not allowed.",
      });
      return;
    }

    try {
      const authClient = createRequestSupabase(req, res);
      const result = await authClient.auth.getUser();
      user = result.data.user;
      if (user) {
        const sessionResult = await authClient.auth.getSession();
        token = sessionResult.data.session?.access_token ?? "";
        res.locals.authClient = authClient;
        res.locals.authSource = "cookie";
      }
    } catch (error) {
      console.error("[auth] cookie session initialization failed", error);
      res.status(500).json({ detail: "Server auth is not configured" });
      return;
    }
  }

  if (!user || !token) {
    res.status(401).json({ detail: "Invalid or expired session" });
    return;
  }

  res.locals.userId = user.id;
  res.locals.userEmail = user.email?.toLowerCase() ?? "";
  res.locals.token = token;
  const syncError = await syncProfileEmail(admin, user.id, user.email);
  if (syncError) {
    devLog("[auth/profile-email] sync failed", {
      method: req.method,
      path: req.originalUrl,
      userId: user.id,
      error: syncError.message,
    });
  }
  const mfa = await enforceLoginMfaIfEnabled(req, res, admin, token);
  if (!mfa.allowed) return;

  const transport: AuthenticatedIdentity["transport"] = bearerClientName
    ? { kind: "non_browser_bearer", client_name: bearerClientName }
    : { kind: "web_session" };
  try {
    res.locals.authenticatedIdentity = buildAuthenticatedIdentity({
      user_id: user.id,
      transport,
      mfa_satisfied: mfa.mfaSatisfied,
    });
  } catch {
    res.status(401).json({
      code: "authentication_failed",
      detail: "Unable to verify authentication. Please sign in again.",
    });
    return;
  }
  next();
}

export async function requireMfaIfEnrolled(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = typeof res.locals.token === "string" ? res.locals.token : "";
  if (!token) {
    devLog("[auth/mfa] missing auth session", {
      method: req.method,
      path: req.originalUrl,
    });
    res.status(401).json({ detail: "Missing auth session" });
    return;
  }

  const admin = getAdminClient(res);
  if (!admin) return;
  const { data, error } =
    await admin.auth.mfa.getAuthenticatorAssuranceLevel(token);

  if (error) {
    devLog("[auth/mfa] assurance lookup failed", {
      method: req.method,
      path: req.originalUrl,
      userId: res.locals.userId,
      error: error.message,
    });
    console.error("[auth/mfa] assurance lookup failed", error);
    res.status(401).json({
      code: "authentication_failed",
      detail: "Unable to verify authentication. Please sign in again.",
    });
    return;
  }

  devLog("[auth/mfa] assurance level", {
    method: req.method,
    path: req.originalUrl,
    userId: res.locals.userId,
    currentLevel: data.currentLevel,
    nextLevel: data.nextLevel,
    required: data.nextLevel === "aal2" && data.currentLevel !== "aal2",
  });

  if (isDev) {
    const { data: userData, error: userError } =
      await admin.auth.getUser(token);
    devLog("[auth/mfa] user factors", {
      method: req.method,
      path: req.originalUrl,
      userId: res.locals.userId,
      factorCount: userData.user?.factors?.length ?? 0,
      factors: summarizeMfaFactors(userData.user?.factors),
      error: userError?.message ?? null,
    });
  }

  if (data.nextLevel === "aal2" && data.currentLevel !== "aal2") {
    devLog("[auth/mfa] verification required", {
      method: req.method,
      path: req.originalUrl,
      userId: res.locals.userId,
    });
    res.status(403).json({
      code: "mfa_verification_required",
      detail: "MFA verification required",
    });
    return;
  }

  const identity = res.locals.authenticatedIdentity as
    | AuthenticatedIdentity
    | undefined;
  if (identity) {
    try {
      res.locals.authenticatedIdentity = buildAuthenticatedIdentity({
        ...identity,
        mfa_satisfied: data.currentLevel === "aal2",
      });
    } catch {
      res.status(401).json({
        code: "authentication_failed",
        detail: "Unable to verify authentication. Please sign in again.",
      });
      return;
    }
  }

  next();
}
