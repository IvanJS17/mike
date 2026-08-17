import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

const root = resolve(new URL("../..", import.meta.url).pathname);
const digest = "a".repeat(64);

function productionEnv() {
  return {
    PUBLIC_URL: "https://litt.example.invalid",
    APP_DOMAIN: "litt.example.invalid",
    ACME_EMAIL: "ops@example.invalid",
    SOURCE_OFFER_URL: "https://github.com/IvanJS17/mike",
    LITT_DATA_ROOT: "/srv/litt-data",
    LITT_SECRETS_ROOT: "/srv/litt-data/secrets",
    LITT_CADDY_IMAGE: `caddy:2.10.0@sha256:${digest}`,
    LITT_FRONTEND_IMAGE: `ghcr.io/ivanjs17/litt-frontend@sha256:${digest}`,
    LITT_BACKEND_IMAGE: `ghcr.io/ivanjs17/litt-backend@sha256:${digest}`,
    LITT_DB_IMAGE: `supabase/postgres:17.6.1.136@sha256:${digest}`,
    LITT_AUTH_IMAGE: `supabase/gotrue:v2.189.0@sha256:${digest}`,
    LITT_REST_IMAGE: `postgrest/postgrest:v14.12@sha256:${digest}`,
    POSTGRES_PASSWORD: "postgres-contract-password",
    SUPABASE_AUTH_PASSWORD: "auth-contract-password",
    POSTGREST_AUTHENTICATOR_PASSWORD: "rest-contract-password",
    JWT_SECRET: "jwt-contract-secret-with-at-least-32-characters",
    SUPABASE_ANON_KEY: "anon-contract-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-contract-key",
    SMTP_HOST: "smtp.example.invalid",
    SMTP_PORT: "587",
    SMTP_USER: "smtp-user",
    SMTP_PASSWORD: "smtp-password",
    SMTP_ADMIN_EMAIL: "admin@example.invalid",
    SMTP_SENDER_NAME: "LiTT",
    R2_ENDPOINT_URL: "https://objects.example.invalid",
    R2_ACCESS_KEY_ID: "r2-access-key",
    R2_SECRET_ACCESS_KEY: "r2-secret-key",
    R2_BUCKET_NAME: "litt-production",
    R2_SSE_CUSTOMER_KEY: "r2-sse-customer-key",
  };
}

function renderCompose() {
  const env = productionEnv();
  const dir = mkdtempSync(join(tmpdir(), "litt-prod-contract-"));
  const secretsDir = join(dir, "secrets");
  mkdirSync(secretsDir);
  env.LITT_SECRETS_ROOT = secretsDir;
  for (const name of ["backend.env", "db.env", "auth.env", "rest.env"]) {
    writeFileSync(join(secretsDir, name), "CONTRACT=1\n");
  }
  const envFile = join(dir, ".env");
  writeFileSync(
    envFile,
    Object.entries(env)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n",
  );
  try {
    const output = execFileSync(
      "docker",
      [
        "compose",
        "--env-file",
        envFile,
        "--profile",
        "ops",
        "-f",
        resolve(root, "compose.prod.yml"),
        "config",
        "--format",
        "json",
      ],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return JSON.parse(output);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("production compose exposes only Caddy on ports 80 and 443", () => {
  const config = renderCompose();
  const services = config.services;
  const expected = ["auth", "backend", "caddy", "db", "frontend", "migrations", "rest"];
  assert.deepEqual(Object.keys(services).sort(), expected.sort());

  for (const [name, service] of Object.entries(services)) {
    assert.equal("build" in service, false, `${name} must use a CI image`);
    assert.match(service.image, /@sha256:[0-9a-f]{64}$/);
    if (name === "caddy") continue;
    assert.equal(service.ports, undefined, `${name} must not publish a host port`);
  }

  assert.deepEqual(
    services.caddy.ports.map(({ published, target }) => ({ published, target })),
    [
      { published: "80", target: 80 },
      { published: "443", target: 443 },
    ],
  );
});

test("production compose keeps data and secrets on explicit host paths", () => {
  const config = renderCompose();
  const volumeSources = Object.values(config.services)
    .flatMap((service) => service.volumes ?? [])
    .map((volume) => (typeof volume === "string" ? volume : volume.source));

  assert.ok(volumeSources.some((source) => source.startsWith("/srv/litt-data/")));
  assert.match(readFileSync(resolve(root, "compose.prod.yml"), "utf8"), /LITT_SECRETS_ROOT/);
  assert.match(readFileSync(resolve(root, "compose.prod.yml"), "utf8"), /env_file:/);
  assert.equal(volumeSources.some((source) => source.includes("node_modules")), false);
});

test("production Caddy routes API, Supabase Auth, and PostgREST without local services", () => {
  const caddyfile = readFileSync(
    resolve(root, "infra/production/Caddyfile"),
    "utf8",
  );
  for (const route of ["/api/*", "/supabase/auth/v1/*", "/supabase/rest/v1/*"]) {
    assert.match(caddyfile, new RegExp(route.replaceAll("*", "\\*")));
  }
  assert.match(caddyfile, /admin off/);
  assert.match(caddyfile, /auto_https/);
  assert.doesNotMatch(caddyfile, /mailpit|rustfs|storage|gateway/i);
});

test("production compose does not carry local-only services or mutable image tags", () => {
  const compose = readFileSync(
    resolve(root, "compose.prod.yml"),
    "utf8",
  );
  assert.doesNotMatch(compose, /mailpit|rustfs|ollama|supabase-studio|gateway/i);
  assert.doesNotMatch(compose, /:latest\b/);
});
