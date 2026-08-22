"use strict";
/*
 * Beta 0.1 — local-only target guard.
 *
 * Shared by scripts/e2e-beta01-setup-smoke.sh and e2e/beta01-setup-smoke.spec.ts.
 * Pure validation: NEVER performs HTTP requests and NEVER prints secret values.
 * Enforces that every external target the setup smoke would touch resolves to
 * the LOCAL harness stack (loopback URLs + local demo keys), so inherited
 * environment variables can never redirect the smoke to a remote Supabase/API/
 * R2 target.
 *
 * CLI:  node e2e/support/beta01-target-guard.cjs   (exit 0 = local, 1 = reject)
 */

const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.join(__dirname, "..", "..");
const ENV_FILES = [
  path.join(REPO_ROOT, "backend", ".env"),
  path.join(REPO_ROOT, "frontend", ".env.local"),
];

// Loopback hosts only: localhost, 127.0.0.1, [::1]. A URL with any other host
// (including 0.0.0.0, private ranges or DNS names) is a remote target.
const LOOPBACK_RE =
  /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/.*)?$/i;

function readDotEnvValue(key) {
  let value;
  for (const file of ENV_FILES) {
    try {
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        const match = line.match(new RegExp(`^${key}=(.*)$`));
        if (match) value = match[1].trim().replace(/^"(.*)"$/, "$1");
      }
    } catch {
      // File may not exist (fresh checkout); env-only config is fine.
    }
  }
  return value;
}

function isLoopbackUrl(value) {
  return typeof value === "string" && LOOPBACK_RE.test(value);
}

// Decodes a JWT payload WITHOUT verifying the signature. Enough to prove the
// key belongs to the local Supabase CLI stack (demo issuer), never a hosted
// project. Never logs the token itself.
function jwtIssRole(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    );
    return { iss: payload.iss, role: payload.role };
  } catch {
    return null;
  }
}

// Collects the effective value for a key: process env wins over .env, and a
// conflict between the two is reported (inherited vars must not override the
// locally wired values). Setting BETA01_TARGET_GUARD_ENV_ONLY=1 skips .env
// files entirely (used by the contractual test for deterministic runs).
function resolveKey(env, key, errors, conflictLabel) {
  const envValue = env[key] && env[key].length > 0 ? env[key] : undefined;
  if (process.env.BETA01_TARGET_GUARD_ENV_ONLY === "1") return envValue;
  const fileValue = readDotEnvValue(key);
  if (envValue && fileValue && envValue !== fileValue) {
    errors.push(
      `${conflictLabel}: variable ${key} heredada en el entorno difiere del valor local (${conflictLabel})`,
    );
  }
  return envValue ?? fileValue;
}

// Validates the effective Supabase/API/R2 targets. Returns a config object or
// throws with a sanitized message (never includes key values).
function assertLocalTargets(env = process.env) {
  const errors = [];

  const supabaseUrl = resolveKey(env, "SUPABASE_URL", errors, "supabase");
  const serviceKey = resolveKey(
    env,
    "SUPABASE_SECRET_KEY",
    errors,
    "supabase",
  );
  const anonKey =
    resolveKey(env, "SUPABASE_ANON_KEY", errors, "supabase") ??
    resolveKey(
      env,
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY",
      errors,
      "supabase",
    );
  const apiBase =
    resolveKey(env, "MIKE_API_BASE_URL", errors, "api") ??
    "http://localhost:3001";
  const r2Endpoint = resolveKey(env, "R2_ENDPOINT_URL", errors, "r2");
  const r2AccessKey = resolveKey(env, "R2_ACCESS_KEY_ID", errors, "r2");
  const r2SecretKey = resolveKey(env, "R2_SECRET_ACCESS_KEY", errors, "r2");

  if (!supabaseUrl) {
    errors.push("supabase: falta SUPABASE_URL");
  } else if (!isLoopbackUrl(supabaseUrl)) {
    errors.push("supabase: SUPABASE_URL no es loopback/local");
  }
  if (!serviceKey) {
    errors.push("supabase: falta SUPABASE_SECRET_KEY");
  } else {
    const jwt = jwtIssRole(serviceKey);
    if (!jwt || jwt.iss !== "supabase-demo" || jwt.role !== "service_role") {
      errors.push("supabase: SUPABASE_SECRET_KEY no corresponde al stack local (iss/role demo requerido)");
    }
  }
  if (!anonKey) {
    errors.push("supabase: falta la anon key local");
  } else {
    const jwt = jwtIssRole(anonKey);
    if (!jwt || jwt.iss !== "supabase-demo" || jwt.role !== "anon") {
      errors.push("supabase: la anon key no corresponde al stack local (iss/role demo requerido)");
    }
  }
  if (!isLoopbackUrl(apiBase)) {
    errors.push("api: MIKE_API_BASE_URL no es loopback/local");
  }
  if (r2Endpoint && !isLoopbackUrl(r2Endpoint)) {
    errors.push("r2: R2_ENDPOINT_URL no es loopback/local");
  }
  if (
    r2AccessKey &&
    r2SecretKey &&
    (r2AccessKey !== "minioadmin" || r2SecretKey !== "minioadmin")
  ) {
    errors.push("r2: las credenciales R2 no corresponden al MinIO local del harness");
  }

  if (errors.length > 0) {
    throw new Error(
      `target-guard: configuración rechazada — ${errors.join("; ")}`,
    );
  }
  return { supabaseUrl, serviceKey, anonKey, apiBase };
}

module.exports = { assertLocalTargets, isLoopbackUrl, jwtIssRole };

// CLI entry — used by the contractual test (scripts/test-beta01-target-guard.sh)
// and as a fail-fast check in scripts/e2e-beta01-setup-smoke.sh. Prints only
// sanitized errors (key VALUES are never printed) and exits 1 on rejection.
if (require.main === module) {
  try {
    assertLocalTargets(process.env);
    console.log("target-guard: config local aceptada");
    process.exit(0);
  } catch (error) {
    console.error(String(error.message));
    process.exit(1);
  }
}