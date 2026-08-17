import { createServerSupabase } from "./supabase";
import { checkStorageReadiness } from "./storage";

export type ReadinessCheck = () => Promise<void>;
export type ReadinessDependencies = {
  database: ReadinessCheck;
  storage: ReadinessCheck;
  auth: ReadinessCheck;
};

type ReadinessCheckResult = {
  ok: boolean;
  duration_ms: number;
};

export type ReadinessResult = {
  ok: boolean;
  checks: {
    database: ReadinessCheckResult;
    storage: ReadinessCheckResult;
    auth: ReadinessCheckResult;
  };
};

const defaultDependencies: ReadinessDependencies = {
  database: async () => {
    const { error } = await createServerSupabase()
      .from("user_profiles")
      .select("id", { head: true })
      .limit(1);
    if (error) throw error;
  },
  storage: checkStorageReadiness,
  auth: async () => {
    const baseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, "");
    if (!baseUrl) throw new Error("SUPABASE_URL is not configured");
    const response = await fetch(`${baseUrl}/auth/v1/settings`, {
      headers: {
        apikey: process.env.SUPABASE_PUBLISHABLE_KEY ?? "",
        Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY ?? ""}`,
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Auth readiness returned ${response.status}`);
  },
};

async function runCheck(check: ReadinessCheck): Promise<ReadinessCheckResult> {
  const started = Date.now();
  try {
    await check();
    return { ok: true, duration_ms: Date.now() - started };
  } catch {
    return { ok: false, duration_ms: Date.now() - started };
  }
}

export async function evaluateReadiness(
  dependencies: ReadinessDependencies = defaultDependencies,
): Promise<ReadinessResult> {
  const [database, storage, auth] = await Promise.all([
    runCheck(dependencies.database),
    runCheck(dependencies.storage),
    runCheck(dependencies.auth),
  ]);
  return {
    ok: database.ok && storage.ok && auth.ok,
    checks: { database, storage, auth },
  };
}
