#!/usr/bin/env bash
#
# Beta 0.1 — journey gate 1: deterministic setup smoke.
#
# Mirrors the stack shape of .github/workflows/e2e.yml on this machine:
#   - MinIO container acting as the R2 S3-compatible object storage
#     (R2_* -> MinIO, the diagnosed local pattern);
#   - local Supabase CLI stack (schema + migrations + service_role grants);
#   - backend API started with the local Beta fakes preloaded into Node
#     (e2e/support/beta01-fakes.cjs via NODE_OPTIONS);
#   - frontend built for production and served with `next start`
#     (CI pattern: no dev server, no hydration overlay);
# and then runs EXACTLY ONCE the targeted Playwright spec
# e2e/beta01-setup-smoke.spec.ts: owner autenticado -> proyecto + matter
# privado -> upload de e2e/fixtures/beta01-contract.docx con HTTP 201,
# versión, content hash y metadata de página.
#
# Teardown is unconditional (trap EXIT): every process and container this
# script started is stopped/removed, and it fails if any of its own
# processes/containers remain. Container ownership is SAFE: MinIO is created
# (labelled fixture/owner/run, exact container ID recorded) only when
# `beta01-minio` did not exist before, and teardown removes ONLY that ID and
# verifies it disappeared; a preexisting container is reused only when it is
# running/healthy with the fixture label and is never stopped/removed by this
# script (see e2e/support/beta01-minio-owner.cjs).
#
# Usage, from the repo root:  bash scripts/e2e-beta01-setup-smoke.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"

MINIO_IMAGE="minio/minio:RELEASE.2025-09-07T16-13-09Z"
MINIO_CONTAINER="beta01-minio"
MINIO_HELPER="$ROOT/e2e/support/beta01-minio-owner.cjs"
SPEC="e2e/beta01-setup-smoke.spec.ts"
FAKE_FILE="$ROOT/e2e/support/beta01-fakes.cjs"

SMOKE_DIR="$(mktemp -d /tmp/beta01-smoke.XXXXXX)"
BACKEND_LOG="$SMOKE_DIR/backend.log"
FRONTEND_LOG="$SMOKE_DIR/frontend.log"
MINIO_LOG="$SMOKE_DIR/minio.log"
SUPABASE_LOG="$SMOKE_DIR/supabase.log"
BUILD_LOG="$SMOKE_DIR/frontend-build.log"
# Unique per run: identifies this smoke's MinIO container (label
# com.mike.beta01.run) and scopes the ownership state file.
RUN_ID="$(basename "$SMOKE_DIR")"
MINIO_STATE="$SMOKE_DIR/minio-owner.json"

BACKEND_PID=""
FRONTEND_PID=""
SUPABASE_STARTED="no"
MINIO_STARTED="no"
PRE_CONTAINERS=""
PRE_WATCHERS=""

log()  { printf '[beta01-smoke] %s\n' "$*"; }
fail() { printf '[beta01-smoke] ERROR: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Target isolation: inherited environment variables must NEVER redirect the
# smoke to a remote Supabase/API/R2. We drop every target variable the caller
# might have exported, and wire_env() below exports the LOCAL harness values
# explicitly so child processes see only the local stack.
# ---------------------------------------------------------------------------
TARGET_VARS=(
  SUPABASE_URL
  SUPABASE_SECRET_KEY
  SUPABASE_ANON_KEY
  NEXT_PUBLIC_SUPABASE_URL
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY
  NEXT_PUBLIC_API_BASE_URL
  MIKE_API_BASE_URL
  R2_ENDPOINT_URL
  R2_ACCESS_KEY_ID
  R2_SECRET_ACCESS_KEY
  R2_BUCKET_NAME
)
clear_inherited_targets() {
  local v
  for v in "${TARGET_VARS[@]}"; do
    unset "$v"
  done
  log "inherited target variables cleared"
}

# ---------------------------------------------------------------------------
# Pre-boot snapshot: remember what already existed so teardown only removes
# what THIS smoke created.
# ---------------------------------------------------------------------------
snapshot() {
  PRE_CONTAINERS="$(docker ps --format '{{.Names}}' | sort)"
  if [ -n "$PRE_CONTAINERS" ] && grep -qE '^supabase_' <<<"$PRE_CONTAINERS"; then
    log "a Supabase stack was already running — teardown will not stop it"
  else
    SUPABASE_STARTED="yes"
  fi
  PRE_WATCHERS="$(ps -eo args | grep -E 'watch src/index\.ts|next-server' | grep -v grep || true)"
}

# ---------------------------------------------------------------------------
# MinIO (R2-shaped object storage) + bucket
# ---------------------------------------------------------------------------
wait_http() { # url name tries
  local url="$1" name="$2" tries="${3:-120}" i
  for i in $(seq 1 "$tries"); do
    if curl -sf "$url" >/dev/null 2>&1; then
      log "$name ready (try $i)"
      return 0
    fi
    sleep 1
  done
  return 1
}

ensure_minio() {
  local snap mode reason start verify
  # Ownership decision BEFORE any mutation. The helper records in the state
  # file whether THIS run created the container (exact ID, MINIO_STARTED=yes)
  # or will reuse a preexisting labelled one (MINIO_STARTED=no); teardown
  # (`--cleanup` from the trap) deletes ONLY the recorded ID or verifies the
  # preexisting one kept the same ID/state — never a stranger's container.
  snap="$(node "$MINIO_HELPER" --snapshot --state-file "$MINIO_STATE" --run-id "$RUN_ID" 2>>"$MINIO_LOG")" \
    || fail "MinIO ownership snapshot failed (see $MINIO_LOG)"
  mode="$(jq -r '.mode // "unknown"' <<<"$snap")"
  case "$mode" in
    create)
      log "starting MinIO ($MINIO_IMAGE) as owned fixture (run $RUN_ID)"
      start="$(node "$MINIO_HELPER" --start "$MINIO_IMAGE" --state-file "$MINIO_STATE" 2>>"$MINIO_LOG")" \
        || fail "MinIO container create failed: $(jq -r '.error // "(see $MINIO_LOG)"' <<<"${start:-}" 2>/dev/null)"
      MINIO_STARTED=yes
      log "MinIO started (MINIO_STARTED=yes) — container id $(jq -r '.id' <<<"$start")"
      ;;
    reuse)
      MINIO_STARTED=no
      log "MinIO container '$MINIO_CONTAINER' preexists with fixture label — reusing (MINIO_STARTED=no, never stopped/removed)"
      verify="$(node "$MINIO_HELPER" --verify --state-file "$MINIO_STATE" 2>>"$MINIO_LOG")" \
        || fail "MinIO preexisting container no longer reusable: $(jq -r '.reason // "(see $MINIO_LOG)"' <<<"${verify:-}" 2>/dev/null)"
      ;;
    fail)
      reason="$(jq -r '.reason // "no cumple el criterio de ownership"' <<<"$snap")"
      fail "MinIO container '$MINIO_CONTAINER': $reason — FAIL antes de usar/limpiar, no se toca"
      ;;
    *)
      fail "MinIO ownership snapshot returned unknown mode: $mode"
      ;;
  esac
  wait_http "http://localhost:9000/minio/health/ready" "MinIO" 60 \
    || fail "MinIO did not become ready (see $MINIO_LOG)"
  # Create the bucket with the backend's own S3 client (no aws CLI needed).
  log "ensuring bucket 'mike'"
  (cd "$BACKEND" && node -e '
    const { S3Client, CreateBucketCommand } = require("@aws-sdk/client-s3");
    const client = new S3Client({
      region: "auto",
      endpoint: "http://localhost:9000",
      forcePathStyle: true,
      credentials: { accessKeyId: "minioadmin", secretAccessKey: "minioadmin" },
    });
    client.send(new CreateBucketCommand({ Bucket: "mike" })).then(
      () => console.log("bucket mike ready"),
      (err) => {
        if (err && (err.name === "BucketAlreadyOwnedByYou" || err.name === "BucketAlreadyExists")) {
          console.log("bucket mike already exists");
        } else {
          console.error(err);
          process.exit(1);
        }
      },
    );
  ') || fail "bucket creation failed"
}

# ---------------------------------------------------------------------------
# Supabase CLI stack + schema/migrations/grants (same recipe as e2e-local-stack.sh)
# ---------------------------------------------------------------------------
ensure_supabase() {
  if [ "$SUPABASE_STARTED" = "yes" ]; then
    log "starting local Supabase stack"
    (cd "$BACKEND" && npx supabase start) >"$SUPABASE_LOG" 2>&1 \
      || fail "supabase start failed (see $SUPABASE_LOG)"
  else
    log "Supabase stack already running — reusing it"
  fi
  local status
  status="$(cd "$BACKEND" && npx supabase status -o json)" \
    || fail "supabase status failed"
  DB_URL="$(jq -r '.DB_URL' <<<"$status")"
  API_URL="$(jq -r '.API_URL' <<<"$status")"
  ANON_KEY="$(jq -r '.ANON_KEY' <<<"$status")"
  SERVICE_KEY="$(jq -r '.SERVICE_ROLE_KEY' <<<"$status")"

  if [ "$(psql "$DB_URL" -tAc "SELECT to_regclass('public.user_profiles') IS NULL")" = "t" ]; then
    log "loading schema.sql into fresh database"
    psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$BACKEND/schema.sql"
  fi
  for m in "$BACKEND"/migrations/*.sql; do
    psql "$DB_URL" -q -f "$m" >/dev/null 2>&1 \
      || log "warning: migration returned non-zero (already applied?): $(basename "$m")"
  done
  psql "$DB_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
GRANT USAGE ON SCHEMA public TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;
NOTIFY pgrst, 'reload schema';
SQL
}

# ---------------------------------------------------------------------------
# Env wiring (idempotent, preserves everything else; one-time hosted backups)
# ---------------------------------------------------------------------------
set_kv() { # file key value
  local file=$1 key=$2 value=$3
  if grep -q "^${key}=" "$file" 2>/dev/null; then
    awk -v k="$key" -v v="$value" \
      'index($0, k"=") == 1 { print k "=" v; next } { print }' \
      "$file" >"$file.tmp" && mv "$file.tmp" "$file"
  else
    echo "${key}=${value}" >>"$file"
  fi
}

wire_env() {
  [ -f "$BACKEND/.env" ] || cp "$BACKEND/.env.example" "$BACKEND/.env"
  [ -f "$BACKEND/.env.hosted.bak" ] || cp "$BACKEND/.env" "$BACKEND/.env.hosted.bak"
  set_kv "$BACKEND/.env" SUPABASE_URL "$API_URL"
  set_kv "$BACKEND/.env" SUPABASE_SECRET_KEY "$SERVICE_KEY"
  # R2_* -> MinIO (same mapping CI uses; uploads must land in the container).
  set_kv "$BACKEND/.env" R2_ENDPOINT_URL "http://localhost:9000"
  set_kv "$BACKEND/.env" R2_ACCESS_KEY_ID "minioadmin"
  set_kv "$BACKEND/.env" R2_SECRET_ACCESS_KEY "minioadmin"
  set_kv "$BACKEND/.env" R2_BUCKET_NAME "mike"
  # e2e is not testing throttling (same overrides as CI / e2e-local-stack.sh).
  for cap in GENERAL CHAT CHAT_CREATE UPLOAD EXPORT DATA_DELETE; do
    set_kv "$BACKEND/.env" "RATE_LIMIT_${cap}_MAX" 100000
  done

  touch "$FRONTEND/.env.local"
  [ -f "$FRONTEND/.env.local.hosted.bak" ] || cp "$FRONTEND/.env.local" "$FRONTEND/.env.local.hosted.bak"
  set_kv "$FRONTEND/.env.local" NEXT_PUBLIC_SUPABASE_URL "$API_URL"
  set_kv "$FRONTEND/.env.local" NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY "$ANON_KEY"
  set_kv "$FRONTEND/.env.local" NEXT_PUBLIC_API_BASE_URL "http://localhost:3001"

  # Export the LOCAL harness values explicitly so every child process
  # (backend, frontend, Playwright) sees exactly the local stack, never an
  # inherited remote target. The spec's target guard enforce the same bounds.
  export SUPABASE_URL="$API_URL"
  export SUPABASE_SECRET_KEY="$SERVICE_KEY"
  export SUPABASE_ANON_KEY="$ANON_KEY"
  export NEXT_PUBLIC_SUPABASE_URL="$API_URL"
  export NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY="$ANON_KEY"
  export NEXT_PUBLIC_API_BASE_URL="http://localhost:3001"
  export MIKE_API_BASE_URL="http://localhost:3001"
  export R2_ENDPOINT_URL="http://localhost:9000"
  export R2_ACCESS_KEY_ID="minioadmin"
  export R2_SECRET_ACCESS_KEY="minioadmin"
  export R2_BUCKET_NAME="mike"
  log "local target variables exported (supabase/api/r2 -> local harness)"
}

# ---------------------------------------------------------------------------
# Servers
# ---------------------------------------------------------------------------
build_frontend() {
  log "building frontend (production, CI pattern)"
  (npm run build --prefix "$FRONTEND") >"$BUILD_LOG" 2>&1 \
    || fail "frontend build failed (see $BUILD_LOG)"
}

start_servers() {
  log "starting backend with Beta fakes preloaded (NODE_OPTIONS=$FAKE_FILE)"
  setsid env NODE_OPTIONS="--require=$FAKE_FILE" npm run dev --prefix "$BACKEND" \
    >"$BACKEND_LOG" 2>&1 &
  BACKEND_PID=$!
  wait_http "http://localhost:3001/health" "backend" 150 \
    || fail "backend not ready (see $BACKEND_LOG)"
  grep -q "beta01-fakes" "$BACKEND_LOG" \
    || fail "Beta fakes were not loaded into the backend process (see $BACKEND_LOG)"

  log "starting frontend (next start, production)"
  setsid npm run start --prefix "$FRONTEND" >"$FRONTEND_LOG" 2>&1 &
  FRONTEND_PID=$!
  wait_http "http://localhost:3000" "frontend" 120 \
    || fail "frontend not ready (see $FRONTEND_LOG)"
}

# ---------------------------------------------------------------------------
# Teardown + residue verification
# ---------------------------------------------------------------------------
cleanup() {
  local run_rc=$? cleanup_rc=0 minio_cleanup
  trap - EXIT
  set +e
  log "teardown: stopping own servers"
  if [ -n "$BACKEND_PID" ]; then
    kill -- "-$BACKEND_PID" 2>/dev/null
    wait "$BACKEND_PID" 2>/dev/null
  fi
  if [ -n "$FRONTEND_PID" ]; then
    kill -- "-$FRONTEND_PID" 2>/dev/null
    wait "$FRONTEND_PID" 2>/dev/null
  fi
  for port in 3000 3001; do
    for _ in $(seq 1 30); do
      ss -tln 2>/dev/null | grep -q ":$port " || break
      sleep 1
    done
  done

  if [ "$SUPABASE_STARTED" = "yes" ]; then
    log "teardown: stopping local Supabase stack (containers removed, data volume kept)"
    (cd "$BACKEND" && npx supabase stop) >"$SUPABASE_LOG" 2>&1
  fi

  log "teardown: MinIO ownership cleanup"
  minio_cleanup="$(node "$MINIO_HELPER" --cleanup --state-file "$MINIO_STATE" 2>>"$MINIO_LOG")"
  if [ $? -ne 0 ]; then
    log "teardown FAILED — MinIO ownership cleanup failed: $(jq -r '.reason // .error // "unknown failure"' <<<"${minio_cleanup:-}" 2>/dev/null) (see $MINIO_LOG)"
    cleanup_rc=1
  fi

  verify_clean || cleanup_rc=1

  if [ "$cleanup_rc" -ne 0 ]; then
    if [ "$run_rc" -ne 0 ]; then
      log "teardown FAILED — run exit code $run_rc and cleanup both failed; preserving $SMOKE_DIR"
    else
      log "teardown FAILED — cleanup failed; preserving $SMOKE_DIR"
    fi
    exit 1
  fi

  rm -rf "$SMOKE_DIR"
  if [ "$run_rc" -ne 0 ]; then
    log "teardown verified after run failure (exit code $run_rc) — result remains FAILED"
    exit "$run_rc"
  fi
  log "teardown OK — zero own processes/containers left"
  exit 0
}

verify_clean() {
  local residue=0 own_containers now_watchers

  # The MinIO container is NOT checked here: its lifecycle is owned by the
  # beta01-minio-owner helper, whose --cleanup already removed OUR created
  # container (and verified it disappeared) or verified a preexisting one kept
  # the same ID/state, failing the teardown otherwise. The Supabase stack is
  # ours ONLY when this run started it (SUPABASE_STARTED=yes); when it was
  # already running we reuse it and the residue check must not flag it.
  if [ "$SUPABASE_STARTED" = "yes" ]; then
    own_containers="$(docker ps --format '{{.Names}}' | grep -E '^supabase_' || true)"
    if [ -n "$own_containers" ]; then
      log "RESIDUE: own supabase containers still running:"
      log "$own_containers"
      residue=1
    fi
  fi

  now_watchers="$(ps -eo args | grep -E 'watch src/index\.ts|next-server' | grep -v grep || true)"
  if [ -n "$now_watchers" ] && [ "$now_watchers" != "$PRE_WATCHERS" ]; then
    log "RESIDUE: new server processes still running:"
    log "$(comm -13 <(printf '%s\n' "$PRE_WATCHERS") <(printf '%s\n' "$now_watchers") | sed 's/^/  /')"
    residue=1
  fi

  if [ "$residue" = "1" ]; then
    log "teardown FAILED — residue of the smoke remains"
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
trap cleanup EXIT
clear_inherited_targets
snapshot
ensure_minio
ensure_supabase
wire_env

# Fail-fast: reject any non-local target BEFORE building/running anything.
# This is the same guard the spec enforces before mutating Supabase.
GUARD_OUT="$(node "$ROOT/e2e/support/beta01-target-guard.cjs" 2>&1)" \
  || fail "target guard rejected the effective configuration: $GUARD_OUT"

build_frontend
start_servers

log "running Playwright spec: $SPEC"
(cd "$ROOT" && CI=true npx playwright test "$SPEC" --workers=1 --retries=0)
TEST_RC=$?
log "playwright exit code: $TEST_RC"
exit "$TEST_RC"