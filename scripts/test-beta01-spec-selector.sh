#!/usr/bin/env bash
#
# Contractual test for the Gate 2 runner spec selector
# (scripts/e2e-beta01-setup-smoke.sh).
#
# WITHOUT a live stack and WITHOUT touching the real repo, proves:
#   c1. default (BETA01_SMOKE_SPEC unset o vacía) selecciona EXACTAMENTE
#       e2e/beta01-setup-smoke.spec.ts y Playwright corre ese spec con
#       --workers=1 --retries=0;
#   c2. BETA01_SMOKE_SPEC=e2e/beta01-ai-smoke.spec.ts selecciona el spec IA
#       con los mismos workers/retries;
#   c3. cualquier otro valor (path arbitrario, flags, whitespace) FALLA con
#       exit 1 ANTES de cualquier acción de stack: cero llamadas a stubs y
#       cero mutaciones (sin backend/.env, sin dirs /tmp/beta01-smoke.*);
#   c4. el lifecycle Gate 1 queda intacto: los casos exitosos recorren el
#       boot completo (minio -> supabase -> env -> build -> servers) y
#       terminan con teardown limpio (exit 0);
#   c5. (Gate 2 fix A) el runner crea BETA01_FAKE_STATE_FILE dentro de su
#       SMOKE_DIR, lo exporta antes de bootear backend/spec (ambos ven el
#       MISMO path runner-owned, inicializado vacío) y el teardown lo elimina
#       con SMOKE_DIR sin imprimir jamás su contenido;
#   c6. (Gate 2 fix A) un BETA01_FAKE_STATE_FILE heredado arbitrario queda
#       reemplazado por el path del runner antes de mutar nada: ningún hijo
#       ve el path heredado y el archivo arbitrario externo no se toca.
#
# El stack completo se simula con stubs en un PATH prefijado; cada stub
# registra su invocación en CALLS, así "cero mutaciones" es una aserción
# exacta. El runner corre sobre una COPIA del repo en un sandbox $TMP/repo:
# jamás se tocan archivos del worktree real.
#
# Usage: bash scripts/test-beta01-spec-selector.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d /tmp/beta01-spec-selector.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

REPO="$TMP/repo"
BIN="$TMP/bin"
CALLS="$TMP/calls.log"
PLAYWRIGHT_CMD="$TMP/playwright.cmd"
# Gate 2 fix A: los stubs del stack registran aquí el BETA01_FAKE_STATE_FILE
# que VE cada lado (backend vía npm run dev, spec vía npx playwright) y el
# estado del archivo en ese momento (inicializado vacío por el runner).
STATE_ENV="$TMP/state-env.log"
RUN_OUT="$TMP/run.out"
export CALLS PLAYWRIGHT_CMD STATE_ENV RUN_OUT
PRE_SMOKE_DIRS="$(ls -d /tmp/beta01-smoke.* 2>/dev/null | wc -l)"
CHECKS=0
FAILS=0

ok()  { CHECKS=$((CHECKS + 1)); printf '  ok   %s\n' "$1"; }
bad() { CHECKS=$((CHECKS + 1)); FAILS=$((FAILS + 1)); printf '  FAIL %s\n' "$1"; }

# ---------------------------------------------------------------------------
# Sandbox repo: copia del runner + esqueleto mínimo (specs y helpers que el
# boot toca). El runner deriva ROOT de su propia ubicación, así que la copia
# hace que TODO el boot ocurra dentro de $TMP y el worktree real quede a salvo.
# ---------------------------------------------------------------------------
mkdir -p "$REPO/scripts" "$REPO/e2e/support" "$REPO/backend" "$REPO/frontend"
cp "$HERE/e2e-beta01-setup-smoke.sh" "$REPO/scripts/"
: >"$REPO/e2e/beta01-setup-smoke.spec.ts"
: >"$REPO/e2e/beta01-ai-smoke.spec.ts"
: >"$REPO/e2e/support/beta01-minio-owner.cjs"
: >"$REPO/e2e/support/beta01-target-guard.cjs"
: >"$REPO/e2e/support/beta01-fakes.cjs"
: >"$REPO/backend/.env.example"
touch "$REPO/frontend/.keep"

# ---------------------------------------------------------------------------
# Stubs del stack (docker/npx/stack/node/npm/curl/psql/setsid). Cada stub
# registra "$0 $*" en CALLS y responde exactamente lo que el boot del runner
# necesita para llegar a la línea de Playwright sin levantar nada real.
# ---------------------------------------------------------------------------
mkdir -p "$BIN"
cat >"$BIN/docker" <<'STUB'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >>"$CALLS"
exit 0
STUB
cat >"$BIN/node" <<'STUB'
#!/usr/bin/env bash
printf 'node %s\n' "$*" >>"$CALLS"
case "$*" in
  *"beta01-minio-owner.cjs --snapshot"*) printf '%s\n' '{"mode":"create"}' ;;
  *"beta01-minio-owner.cjs --start"*)   printf '%s\n' '{"id":"stub-minio","mode":"create"}' ;;
  *"beta01-minio-owner.cjs --cleanup"*) printf '%s\n' '{"ok":true}' ;;
  *"beta01-target-guard.cjs"*)          printf '%s\n' 'guard-ok' ;;
  *" -e "*)                             printf '%s\n' 'bucket mike ready' ;;
esac
exit 0
STUB
cat >"$BIN/npm" <<'STUB'
#!/usr/bin/env bash
printf 'npm %s\n' "$*" >>"$CALLS"
case "$*" in
  *"run dev "*)
    # Backend process (fix A): registra el fake state path que VE y que el
    # archivo fue inicializado vacío por el runner antes del boot.
    printf 'backend-fake-state=%s\n' "${BETA01_FAKE_STATE_FILE:-UNSET}" >>"$STATE_ENV"
    if [ -n "${BETA01_FAKE_STATE_FILE:-}" ] && [ -f "$BETA01_FAKE_STATE_FILE" ] && [ ! -s "$BETA01_FAKE_STATE_FILE" ]; then
      printf 'backend-fake-state-init=empty\n' >>"$STATE_ENV"
    else
      printf 'backend-fake-state-init=BAD\n' >>"$STATE_ENV"
    fi
    printf '%s\n' 'beta01-fakes preloaded (stub)'
    ;;
esac
exit 0
STUB
cat >"$BIN/npx" <<'STUB'
#!/usr/bin/env bash
printf 'npx %s\n' "$*" >>"$CALLS"
case "$*" in
  *"supabase status"*)
    printf '%s\n' '{"DB_URL":"postgresql://postgres:postgres@127.0.0.1:54322/postgres","API_URL":"http://127.0.0.1:54321","ANON_KEY":"anon","SERVICE_ROLE_KEY":"service"}'
    ;;
  *"playwright test"*)
    printf '%s\n' "$*" >>"$PLAYWRIGHT_CMD"
    # Spec process (fix A): registra el fake state path que VE y que el
    # archivo está inicializado (vacío) al arrancar Playwright.
    printf 'spec-fake-state=%s\n' "${BETA01_FAKE_STATE_FILE:-UNSET}" >>"$STATE_ENV"
    if [ -n "${BETA01_FAKE_STATE_FILE:-}" ] && [ -f "$BETA01_FAKE_STATE_FILE" ] && [ ! -s "$BETA01_FAKE_STATE_FILE" ]; then
      printf 'spec-fake-state-init=empty\n' >>"$STATE_ENV"
    else
      printf 'spec-fake-state-init=BAD\n' >>"$STATE_ENV"
    fi
    ;;
esac
exit 0
STUB
cat >"$BIN/curl" <<'STUB'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >>"$CALLS"
# Latencia mínima realista: sin ella, wait_http (éxito instantáneo) corre el
# grep "beta01-fakes" del runner en carrera contra el job de fondo que aún no
# escribió su log (el backend real tardaría segundos en responder).
sleep 0.3
exit 0
STUB
cat >"$BIN/psql" <<'STUB'
#!/usr/bin/env bash
printf 'psql %s\n' "$*" >>"$CALLS"
exit 0
STUB
cat >"$BIN/setsid" <<'STUB'
#!/usr/bin/env bash
exec "$@"
STUB
chmod +x "$BIN"/*

# ---------------------------------------------------------------------------
# run_ok: caso que DEBE llegar a Playwright (default o AI permitido).
#   $1 = valor de BETA01_SMOKE_SPEC ("__UNSET__" = variable ausente)
#   $2 = spec esperada en la línea de Playwright
#   $3 = etiqueta
# ---------------------------------------------------------------------------
run_ok() {
  local value="$1" expected="$2" label="$3" rc cmd
  local backend_state spec_state backend_init spec_init
  : >"$CALLS"
  : >"$STATE_ENV"
  : >"$RUN_OUT"
  rm -f "$PLAYWRIGHT_CMD"
  set +e
  if [ "$value" = "__UNSET__" ]; then
    PATH="$BIN:$PATH" bash "$REPO/scripts/e2e-beta01-setup-smoke.sh" >"$RUN_OUT" 2>&1
  else
    BETA01_SMOKE_SPEC="$value" PATH="$BIN:$PATH" bash "$REPO/scripts/e2e-beta01-setup-smoke.sh" >"$RUN_OUT" 2>&1
  fi
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then ok "$label: exit 0 (teardown limpio)"; else bad "$label: exit 0 esperado, rc=$rc"; fi
  cmd="$(cat "$PLAYWRIGHT_CMD" 2>/dev/null || true)"
  case "$cmd" in
    *"playwright test $expected --workers=1 --retries=0"*)
      ok "$label: playwright usa exactamente '$expected' con workers=1/retries=0" ;;
    *)
      bad "$label: playwright NO usó '$expected' (cmd=$cmd)"
      ;;
  esac
  if grep -q '^docker ' "$CALLS"; then ok "$label: lifecycle — docker invocado (minio)"; else bad "$label: lifecycle — docker no invocado"; fi
  if grep -q '^npx supabase start' "$CALLS"; then ok "$label: lifecycle — supabase start"; else bad "$label: lifecycle — supabase start no invocado"; fi
  if grep -q '^npm run build' "$CALLS"; then ok "$label: lifecycle — frontend build"; else bad "$label: lifecycle — frontend build no invocado"; fi
  if grep -q '^curl ' "$CALLS"; then ok "$label: lifecycle — health checks (curl)"; else bad "$label: lifecycle — curl no invocado"; fi
  if grep -q '^npx playwright test' "$CALLS"; then ok "$label: lifecycle — playwright invocado"; else bad "$label: lifecycle — playwright no invocado"; fi
  if [ "$(ls -d /tmp/beta01-smoke.* 2>/dev/null | wc -l)" = "$PRE_SMOKE_DIRS" ]; then
    ok "$label: teardown — sin dirs /tmp/beta01-smoke.* residuales"
  else
    bad "$label: teardown — quedaron dirs /tmp/beta01-smoke.*"
  fi

  # Gate 2 fix A: el runner crea/exporta BETA01_FAKE_STATE_FILE dentro de su
  # SMOKE_DIR; backend (npm run dev) y spec (npx playwright) ven el MISMO
  # path runner-owned (jamás un valor heredado/arbitrario), el archivo está
  # inicializado vacío antes de mutar, y el runner nunca imprime su contenido.
  backend_state="$(sed -n 's/^backend-fake-state=//p' "$STATE_ENV" | head -1 || true)"
  spec_state="$(sed -n 's/^spec-fake-state=//p' "$STATE_ENV" | head -1 || true)"
  backend_init="$(sed -n 's/^backend-fake-state-init=//p' "$STATE_ENV" | head -1 || true)"
  spec_init="$(sed -n 's/^spec-fake-state-init=//p' "$STATE_ENV" | head -1 || true)"
  case "$backend_state" in
    /tmp/beta01-smoke.*/fake-state.json)
      ok "$label: fixA — backend ve el fake state path del runner en SMOKE_DIR" ;;
    *) bad "$label: fixA — backend NO ve path runner-owned (got: $backend_state)" ;;
  esac
  case "$spec_state" in
    /tmp/beta01-smoke.*/fake-state.json)
      ok "$label: fixA — spec ve el fake state path del runner en SMOKE_DIR" ;;
    *) bad "$label: fixA — spec NO ve path runner-owned (got: $spec_state)" ;;
  esac
  if [ -n "$backend_state" ] && [ "$backend_state" = "$spec_state" ]; then
    ok "$label: fixA — backend y spec comparten el MISMO fake state path"
  else
    bad "$label: fixA — paths backend/spec difieren o faltan"
  fi
  if [ "$backend_init" = "empty" ]; then
    ok "$label: fixA — fake state inicializado vacío antes del boot del backend"
  else
    bad "$label: fixA — fake state NO vacío en el boot del backend (got: $backend_init)"
  fi
  if [ "$spec_init" = "empty" ]; then
    ok "$label: fixA — fake state vacío al arrancar el spec"
  else
    bad "$label: fixA — fake state NO vacío al arrancar el spec (got: $spec_init)"
  fi
  if grep -qE 'provider_calls|drive_upload_calls' "$RUN_OUT"; then
    bad "$label: fixA — el runner imprimió contenido del fake state"
  else
    ok "$label: fixA — el runner nunca imprime el contenido del fake state"
  fi
}

# ---------------------------------------------------------------------------
# expect_reject: valor FUERA de la allowlist -> exit 1 con CERO efectos.
#   $1 = valor de BETA01_SMOKE_SPEC
#   $2 = etiqueta
# ---------------------------------------------------------------------------
expect_reject() {
  local value="$1" label="$2" rc
  # El sandbox persiste entre casos: los runs exitosos anteriores dejaron
  # .env/.env.local (wire_env). Se limpian ANTES para que la aserción de
  # cero mutaciones sea genuina para ESTE run.
  rm -f "$REPO/backend/.env" "$REPO/backend/.env.hosted.bak" \
        "$REPO/frontend/.env.local" "$REPO/frontend/.env.local.hosted.bak"
  : >"$CALLS"
  set +e
  BETA01_SMOKE_SPEC="$value" PATH="$BIN:$PATH" bash "$REPO/scripts/e2e-beta01-setup-smoke.sh" >/dev/null 2>&1
  rc=$?
  set -e
  if [ "$rc" -eq 1 ]; then ok "$label: exit 1"; else bad "$label: exit 1 esperado, rc=$rc"; fi
  if [ ! -s "$CALLS" ]; then ok "$label: cero invocaciones de stack (CALLS vacío)"; else bad "$label: CALLS NO vacío: $(cat "$CALLS")"; fi
  if [ ! -e "$REPO/backend/.env" ]; then ok "$label: cero mutaciones — sin backend/.env"; else bad "$label: se creó backend/.env"; fi
  if [ ! -e "$REPO/frontend/.env.local" ]; then ok "$label: cero mutaciones — sin frontend/.env.local"; else bad "$label: se creó frontend/.env.local"; fi
  if [ "$(ls -d /tmp/beta01-smoke.* 2>/dev/null | wc -l)" = "$PRE_SMOKE_DIRS" ]; then
    ok "$label: cero mutaciones — sin dirs /tmp/beta01-smoke.* nuevos"
  else
    bad "$label: se crearon dirs /tmp/beta01-smoke.*"
  fi
}

# ---------------------------------------------------------------------------
# Casos (contrato)
# ---------------------------------------------------------------------------
printf '== beta01 spec selector: contract checks ==\n'

printf '[c1] default (variable ausente) -> setup\n'
run_ok __UNSET__ e2e/beta01-setup-smoke.spec.ts "default"

printf '[c1] valor vacío explícito -> default exacto (setup)\n'
run_ok "" e2e/beta01-setup-smoke.spec.ts "empty"

printf '[c2] BETA01_SMOKE_SPEC=AI -> spec IA\n'
run_ok e2e/beta01-ai-smoke.spec.ts e2e/beta01-ai-smoke.spec.ts "ai"

printf '[fixA] BETA01_FAKE_STATE_FILE heredado arbitrario -> reemplazado antes de mutar\n'
ARBITRARY_STATE="$TMP/arbitrary-fake-state.json"
printf '%s\n' '{"provider_calls":999,"drive_upload_calls":7,"junk":"arbitrary"}' >"$ARBITRARY_STATE"
BETA01_FAKE_STATE_FILE="$ARBITRARY_STATE" run_ok e2e/beta01-ai-smoke.spec.ts e2e/beta01-ai-smoke.spec.ts "ai-with-inherited-state"
if grep -q '"junk"' "$ARBITRARY_STATE" 2>/dev/null; then
  ok "fixA — el archivo heredado arbitrario no se mutó (reemplazo limpio por path del runner)"
else
  bad "fixA — el archivo heredado arbitrario fue alterado"
fi

printf '[c3] path arbitrario -> fail con cero mutaciones\n'
expect_reject "e2e/other.spec.ts" "arbitrary-path"

printf '[c3] flags -> fail con cero mutaciones\n'
expect_reject "--workers=4" "flags"

printf '[c3] spec permitido + flags -> fail con cero mutaciones\n'
expect_reject "e2e/beta01-setup-smoke.spec.ts --headed" "spec-plus-flags"

printf '[c3] whitespace delante -> fail con cero mutaciones\n'
expect_reject " e2e/beta01-setup-smoke.spec.ts" "ws-prefix"

printf '[c3] whitespace detrás -> fail con cero mutaciones\n'
expect_reject "e2e/beta01-setup-smoke.spec.ts " "ws-trailing"

printf '== resultado: %d checks, %d fallas ==\n' "$CHECKS" "$FAILS"
[ "$FAILS" -eq 0 ]