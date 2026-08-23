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
# and then runs EXACTLY ONCE the targeted Playwright spec selected by
# BETA01_SMOKE_SPEC (Gate 2 selector, allowlist cerrada):
#   - default (unset/vacía): e2e/beta01-setup-smoke.spec.ts — owner
#     autenticado -> proyecto + matter privado -> upload de
#     e2e/fixtures/beta01-contract.docx con HTTP 201, versión, content hash
#     y metadata de página;
#   - única otra opción: e2e/beta01-ai-smoke.spec.ts (Gate 2 IA, receipts y
#     citations sintéticos);
#   - cualquier otro valor (path, flags, whitespace) falla ANTES de cualquier
#     acción de stack o mutación del repositorio;
#   - BETA01_FAKE_STATE_FILE (Gate 2 fix A): path owned por el runner dentro
#     de SMOKE_DIR, exportado ANTES de arrancar backend/fakes e inicializado
#     vacío (ningún valor heredado/arbitrario llega a hijos); beta01-fakes.cjs
#     persiste ahí provider/drive counters y el spec AI afirma provider=1/
#     drive=0 leyendo ese mismo path; el teardown lo elimina junto con
#     SMOKE_DIR y nunca imprime su contenido.
#   - Gate 2 probe (spec AI): si el POST /ai-executions responde 422, el spec
#     escribe ANTES del teardown, dentro de SMOKE_DIR, gate2-ai-failure-probe.json
#     con modo 0600 y contenido SANEADO (status/code de la respuesta,
#     id/status/error_class de la ejecución, error_class del receipt y
#     contadores provider/drive; NUNCA tokens/keys/texto/PII). En fallo el
#     runner PRESERVA SMOKE_DIR como evidencia; sólo una corrida exitosa lo
#     elimina normalmente.
#   - BETA01_SMOKE_SPEC=e2e/beta01-ai-smoke.spec.ts (Gate 2 fix C) NUNCA
#     reutiliza/resetea/detiene un stack Supabase preexistente: el runner
#     levanta un stack DISPOSABLE exclusivo de la corrida bajo SMOKE_DIR
#     (supabase-project/) con project_id y ports ÚNICOS derivados de RUN_ID
#     sobre la config canónica backend/supabase/config.toml (workdir propio),
#     lo arranca/consulta con `npx supabase start|status --workdir`, y
#     backend/frontend reciben SÓLO las URLs/keys de ese stack; el ownership
#     exacto (containers por ID/label com.supabase.cli.project, volumes,
#     network) lo registra e2e/support/beta01-supabase-owner.cjs y el teardown
#     destruye ÚNICAMENTE esos recursos (incluso ante fallo parcial del start),
#     verificando que todo stack preexistente conserva mismo IDs/estado y que
#     quedan CERO recursos propios; la limpieza NUNCA borra filas (las tablas
#     terminales ai_executions/receipts/audit quedan intactas por diseño).
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
# Usage, from the repo root:
#   bash scripts/e2e-beta01-setup-smoke.sh                            # Gate 1 (setup smoke)
#   BETA01_SMOKE_SPEC=e2e/beta01-ai-smoke.spec.ts bash scripts/e2e-beta01-setup-smoke.sh  # Gate 2 (IA)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"

MINIO_IMAGE="minio/minio:RELEASE.2025-09-07T16-13-09Z"
MINIO_CONTAINER="beta01-minio"
MINIO_HELPER="$ROOT/e2e/support/beta01-minio-owner.cjs"
# Gate 2 spec selector: BETA01_SMOKE_SPEC with a CLOSED allowlist. The
# default preserves Gate 1 behavior EXACTLY (setup smoke); the only other
# accepted value is the Gate 2 AI smoke. Any other value — another path,
# shell flags, whitespace around or inside the value — fails HERE, before
# any stack action, temp dir, or repository mutation.
SPEC="${BETA01_SMOKE_SPEC:-e2e/beta01-setup-smoke.spec.ts}"
case "$SPEC" in
  "e2e/beta01-setup-smoke.spec.ts" | "e2e/beta01-ai-smoke.spec.ts") ;;
  *)
    printf '[beta01-smoke] ERROR: BETA01_SMOKE_SPEC rechazado: %s\n' "$SPEC" >&2
    printf '[beta01-smoke] ERROR: allowlist cerrada: e2e/beta01-setup-smoke.spec.ts, e2e/beta01-ai-smoke.spec.ts\n' >&2
    exit 1
    ;;
esac
[ -f "$ROOT/$SPEC" ] || {
  printf '[beta01-smoke] ERROR: spec permitida pero no existe en el repo: %s\n' "$SPEC" >&2
  exit 1
}
FAKE_FILE="$ROOT/e2e/support/beta01-fakes.cjs"

# Gate 2 fix C: el spec IA usa un stack Supabase DISPOSABLE exclusivo de la
# corrida (project_id/ports/workdir únicos bajo SMOKE_DIR); el spec setup
# (default) conserva EXACTAMENTE el comportamiento Gate 1 (stack canónico,
# reuso seguro vía snapshot si ya estaba corriendo).
SPEC_IS_AI=0
if [ "$SPEC" = "e2e/beta01-ai-smoke.spec.ts" ]; then
  SPEC_IS_AI=1
fi
SUPABASE_OWNER_HELPER="$ROOT/e2e/support/beta01-supabase-owner.cjs"
SBDISPOSABLE_ACTIVE="no"
SBDISPOSABLE_PROJECT=""
SBDISPOSABLE_WORKDIR=""
SBDISPOSABLE_STATE=""

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
# Gate 2 fix A: fake state file owned by the runner. BETA01_FAKE_STATE_FILE
# apunta SIEMPRE al archivo de ESTA corrida dentro de SMOKE_DIR, así ningún
# valor heredado/arbitrario llega al backend ni al spec; se exporta ANTES de
# arrancar backend/fakes y se inicializa vacío para que ningún contenido
# viejo pueda leerse (beta01-fakes.cjs escribe aquí provider/drive counters;
# el teardown elimina el archivo junto con SMOKE_DIR y nunca lo imprime).
FAKE_STATE_FILE="$SMOKE_DIR/fake-state.json"
export BETA01_FAKE_STATE_FILE="$FAKE_STATE_FILE"
: >"$BETA01_FAKE_STATE_FILE" && chmod 600 "$BETA01_FAKE_STATE_FILE"

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
  # Gate 2 fix C: en modo AI el stack Supabase SIEMPRE es disposable propio;
  # la presencia de un stack preexistente no cambia nada aquí (el helper
  # beta01-supabase-owner.cjs registra y verifica los preexistentes por label).
  # El chequeo de reuso aplica sólo al spec setup (comportamiento Gate 1).
  if [ "$SPEC_IS_AI" != "1" ] && [ -n "$PRE_CONTAINERS" ] && grep -qE '^supabase_' <<<"$PRE_CONTAINERS"; then
    log "a Supabase stack was already running — teardown will not stop it"
  elif [ "$SPEC_IS_AI" != "1" ]; then
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
apply_schema() {
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

ensure_supabase() {
  if [ "$SPEC_IS_AI" = "1" ]; then
    ensure_supabase_disposable
    return
  fi
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
  apply_schema
}

# Gate 2 fix C — DISPOSABLE Supabase stack, exclusive property of THIS run.
# Unique project_id/ports/workdir under SMOKE_DIR derived from RUN_ID over the
# canonical config; backend/frontend receive ONLY this stack's URLs/keys; a
# preexisting stack is never reused, reset, stopped nor mutated (ownership
# helper snapshots it and the teardown verifies same IDs/state byte-by-byte).
ensure_supabase_disposable() {
  local seed base api_port db_port shadow_port pooler_port studio_port smtp_port inspector_port analytics_port snap mode status
  SBDISPOSABLE_PROJECT="beta01ai$(printf '%s' "$RUN_ID" | tr -cd 'a-z0-9' | tail -c 10)"
  seed="$(printf '%s' "$RUN_ID" | cksum | awk '{print $1}')"
  base=$(( 56000 + (seed % 1500) ))
  api_port=$base
  db_port=$((base + 1))
  shadow_port=$((base - 1))
  pooler_port=$((base + 8))
  studio_port=$((base + 2))
  smtp_port=$((base + 3))
  inspector_port=$((base + 9))
  analytics_port=$((base + 6))

  # Unique config derived from the canonical one (project_id + every port the
  # CLI binds), never touching backend/supabase/config.toml itself.
  SBDISPOSABLE_WORKDIR="$SMOKE_DIR/supabase-project"
  mkdir -p "$SBDISPOSABLE_WORKDIR/supabase"
  sed \
    -e "s/^project_id = .*/project_id = \"$SBDISPOSABLE_PROJECT\"/" \
    -e "s/^port = 54321/port = $api_port/" \
    -e "s/^port = 54322/port = $db_port/" \
    -e "s/^shadow_port = 54320/shadow_port = $shadow_port/" \
    -e "s/^port = 54329/port = $pooler_port/" \
    -e "s/^port = 54323/port = $studio_port/" \
    -e "s/^port = 54324/port = $smtp_port/" \
    -e "s/^inspector_port = 8083/inspector_port = $inspector_port/" \
    -e "s/^port = 54327/port = $analytics_port/" \
    "$BACKEND/supabase/config.toml" >"$SBDISPOSABLE_WORKDIR/supabase/config.toml"
  log "disposable Supabase config written (project $SBDISPOSABLE_PROJECT, api :$api_port, db :$db_port)"

  # Ownership decision BEFORE any mutation: resources that already carry OUR
  # project label fail closed (stale/racing stack) — never reused nor touched.
  SBDISPOSABLE_STATE="$SMOKE_DIR/supabase-owner.json"
  snap="$(node "$SUPABASE_OWNER_HELPER" --snapshot --project-id "$SBDISPOSABLE_PROJECT" --state-file "$SBDISPOSABLE_STATE")" \
    || fail "supabase disposable ownership snapshot failed (see $SUPABASE_LOG)"
  mode="$(jq -r '.mode // "unknown"' <<<"$snap")"
  if [ "$mode" != "create" ]; then
    fail "supabase disposable: $(jq -r '.reason // "unknown"' <<<"$snap" 2>/dev/null) — FAIL antes de mutar, no se toca nada"
  fi
  SBDISPOSABLE_ACTIVE="yes"

  log "starting DISPOSABLE Supabase stack (--workdir $SBDISPOSABLE_WORKDIR)"
  (cd "$BACKEND" && npx supabase start --workdir "$SBDISPOSABLE_WORKDIR") >"$SUPABASE_LOG" 2>&1 \
    || fail "supabase start (disposable) failed (see $SUPABASE_LOG)"
  SUPABASE_STARTED="yes"

  # URLs/keys from THIS stack only.
  status="$(cd "$BACKEND" && npx supabase status -o json --workdir "$SBDISPOSABLE_WORKDIR")" \
    || fail "supabase status (disposable) failed (see $SUPABASE_LOG)"
  DB_URL="$(jq -r '.DB_URL' <<<"$status")"
  API_URL="$(jq -r '.API_URL' <<<"$status")"
  ANON_KEY="$(jq -r '.ANON_KEY' <<<"$status")"
  SERVICE_KEY="$(jq -r '.SERVICE_ROLE_KEY' <<<"$status")"

  # Record EXACT ownership (containers by ID, volumes, network — label
  # com.supabase.cli.project=<pid>) BEFORE the stack is used.
  node "$SUPABASE_OWNER_HELPER" --record --state-file "$SBDISPOSABLE_STATE" >/dev/null \
    || fail "supabase disposable ownership record failed (see $SUPABASE_LOG)"
  log "disposable Supabase ready: $API_URL (db: ${DB_URL%%\?*})"
  apply_schema
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

  if [ "$SBDISPOSABLE_ACTIVE" = "yes" ]; then
    # Gate 2 fix C: destroy ONLY the disposable stack (recorded containers by
    # ID, volumes, network). A preexisting stack is never stopped; the helper
    # verifies it kept same IDs/state and that zero own resources remain.
    log "teardown: destroying DISPOSABLE Supabase stack (project $SBDISPOSABLE_PROJECT)"
    sb_cleanup="$(node "$SUPABASE_OWNER_HELPER" --cleanup --state-file "$SBDISPOSABLE_STATE" 2>>"$SUPABASE_LOG")"
    sb_rc=$?
    if [ "$sb_rc" -ne 0 ] || [ "$(jq -r '.ok // "false"' <<<"${sb_cleanup:-}" 2>/dev/null)" != "true" ]; then
      log "teardown FAILED — disposable Supabase cleanup: $(jq -r '.reason // .note // "unknown failure"' <<<"${sb_cleanup:-}" 2>/dev/null) (see $SUPABASE_LOG)"
      cleanup_rc=1
    fi
  elif [ "$SUPABASE_STARTED" = "yes" ]; then
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

  if [ "$run_rc" -ne 0 ]; then
    # Gate 2 probe: la evidencia de un fallo LIVE se conserva. El spec escribe
    # gate2-ai-failure-probe.json (0600) dentro de SMOKE_DIR ANTES del
    # teardown; con el stack ya destruido y el runner limpiando normalmente,
    # este directorio se preserva para diagnóstico (logs + probe + fake
    # state). Sólo una corrida EXITOSA elimina SMOKE_DIR normalmente.
    log "run FAILED (exit code $run_rc) — teardown OK; preserving evidence $SMOKE_DIR (gate2-ai-failure-probe.json si el POST ai-executions respondió 422)"
    exit "$run_rc"
  fi

  rm -rf "$SMOKE_DIR"
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
  if [ "$SBDISPOSABLE_ACTIVE" = "yes" ]; then
    # Gate 2 fix C: the disposable stack must be at ZERO own resources; a
    # preexisting stack (other project ids) is verified by the ownership
    # helper and must NOT be flagged here.
    own_containers="$(docker ps -a --filter "label=com.supabase.cli.project=$SBDISPOSABLE_PROJECT" --format '{{.Names}}' | grep -E "^supabase_.*_${SBDISPOSABLE_PROJECT}$" || true)"
    if [ -n "$own_containers" ]; then
      log "RESIDUE: own disposable supabase containers still running:"
      log "$own_containers"
      residue=1
    fi
  elif [ "$SUPABASE_STARTED" = "yes" ]; then
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