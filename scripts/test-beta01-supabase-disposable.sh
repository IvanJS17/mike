#!/usr/bin/env bash
#
# Contractual test for Gate 2 fix C — Supabase DISPOSABLE
# (scripts/e2e-beta01-setup-smoke.sh + e2e/support/beta01-supabase-owner.cjs).
#
# WITHOUT a live stack and WITHOUT touching the real repo, proves:
#   c1. unique isolation: BETA01_SMOKE_SPEC=e2e/beta01-ai-smoke.spec.ts genera
#       workdir/project_id/ports ÚNICOS bajo SMOKE_DIR a partir de la config
#       canónica (nunca "backend"/5432x); start/status van con --workdir al
#       stack disposable; backend/.env y frontend/.env.local reciben SÓLO las
#       URLs/keys de ese stack (puertos/keys del pid de la corrida); dos
#       corridas usan project_id/ports distintos; el CERO residual de recursos
#       propios se verifica al final;
#   c2. preexisting preserved: un stack supabase_*_backend preexistente
#       conserva mismos containers/volumes/network (mismos IDs/estado) y nunca
#       es detenido, reusado ni tocado por el runner AI;
#   c3. partial start cleanup: si `supabase start` falla a medias (contendores
#       creados, sin registro), el trap destruye SÓLO los recursos con el
#       label del proyecto (patrón supabase_*_<pid>) y la corrida termina en
#       error con el stack preexistente intacto;
#   c4. ID/label race fail-closed: un sustituto que toma el nombre del
#       container registrado hace FALLAR el teardown SIN borrar nada (ni el
#       sustituto ni el resto del stack);
#   c5. zero own resources after: tras corridas AI exitosas no queda NINGÚN
#       container/volume/network con el label com.supabase.cli.project=<pid>;
#   c6. Gate 1 intacto: el spec setup usa EXACTAMENTE el flujo actual (start/
#       status/stop SIN --workdir, sin helper de ownership) y el teardown
#       sigue siendo limpio;
#   c7. inmutabilidad: el runner jamás ejecuta DELETE vía psql (las tablas
#       terminales ai_executions/receipts/audit no se tocan).
#
# El stack se simula con un "docker world" (world-ctl) + stubs de
# npx/node/curl/psql/setsid en un PATH prefijado; el helper real
# beta01-supabase-owner.cjs se COPIA al sandbox y corre contra el docker
# fake (exec inyectable vía PATH), de modo que el contrato ejercita el código
# real del helper Y el runner, con cero red y cero docker.
#
# Usage: bash scripts/test-beta01-supabase-disposable.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d /tmp/beta01-supabase-disposable.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

REPO="$TMP/repo"
BIN="$TMP/bin"
CALLS="$TMP/calls.log"
WORLD="$TMP/world.json"
WORLD_CTL="$TMP/world-ctl.sh"
RUN_OUT="$TMP/run.out"
PLAYWRIGHT_CMD="$TMP/playwright.cmd"
PSQL_LOG="$TMP/psql.log"
PID_FILE="$TMP/last-pid"
API_PORT="$TMP/last-api-port"
DB_PORT="$TMP/last-db-port"
REAL_NODE="$(command -v node)"
export CALLS WORLD WORLD_CTL RUN_OUT PLAYWRIGHT_CMD PSQL_LOG PID_FILE API_PORT DB_PORT REAL_NODE BIN
PRE_SMOKE_DIRS="$(ls -d /tmp/beta01-smoke.* 2>/dev/null | wc -l)"
CHECKS=0
FAILS=0

ok()  { CHECKS=$((CHECKS + 1)); printf '  ok   %s\n' "$1"; }
bad() { CHECKS=$((CHECKS + 1)); FAILS=$((FAILS + 1)); printf '  FAIL %s\n' "$1"; }

# ---------------------------------------------------------------------------
# Sandbox repo: copia el runner y el helper REAL (bajo test); el resto son
# esqueletos. ROOT deriva de la propia ubicación del runner, así TODO el boot
# ocurre dentro de $TMP y el worktree real queda a salvo.
# ---------------------------------------------------------------------------
mkdir -p "$REPO/scripts" "$REPO/e2e/support" "$REPO/backend/supabase" "$REPO/frontend"
cp "$HERE/e2e-beta01-setup-smoke.sh" "$REPO/scripts/"
cp "$HERE/../e2e/support/beta01-supabase-owner.cjs" "$REPO/e2e/support/"
# Config canónica REAL del backend: el runner deriva la config disposable con
# sed sobre este archivo, así el contrato ejercita el fixture verdadero.
cp "$HERE/../backend/supabase/config.toml" "$REPO/backend/supabase/"
: >"$REPO/e2e/beta01-setup-smoke.spec.ts"
: >"$REPO/e2e/beta01-ai-smoke.spec.ts"
: >"$REPO/e2e/support/beta01-minio-owner.cjs"
: >"$REPO/e2e/support/beta01-target-guard.cjs"
: >"$REPO/e2e/support/beta01-fakes.cjs"
: >"$REPO/backend/.env.example"
touch "$REPO/frontend/.keep"

# ---------------------------------------------------------------------------
# world-ctl: mini-daemon docker en un archivo JSON ($WORLD). Cada recurso
# lleva labels estilo docker; inspect devuelve JSON exacto como docker.
# ---------------------------------------------------------------------------
printf '%s\n' '{"containers":[],"volumes":[],"networks":[]}' >"$WORLD"
cat >"$WORLD_CTL" <<'CTL'
#!/usr/bin/env bash
set -euo pipefail
WORLD="${WORLD:?}"
cmd="$1"; shift
case "$cmd" in
  create-container)
    name="$1"; id="$2"; running="$3"; shift 3
    labels="{}"
    for kv in "$@"; do k="${kv%%=*}"; v="${kv#*=}"; labels="$(jq -c --arg k "$k" --arg v "$v" '. + {($k): $v}' <<<"$labels")"; done
    jq --arg n "$name" --arg i "$id" --argjson r "$running" --argjson l "$labels" \
      '.containers += [{"name":$n,"id":$i,"running":$r,"labels":$l}]' "$WORLD" >"$WORLD.tmp" && mv "$WORLD.tmp" "$WORLD"
    ;;
  rm-container)
    ref="$1"
    jq --arg r "$ref" '.containers |= map(select(.id != $r and .name != $r))' "$WORLD" >"$WORLD.tmp" && mv "$WORLD.tmp" "$WORLD"
    ;;
  ls-con)
    key="${1:-}"; val="${2:-}"
    jq -r --arg k "$key" --arg v "$val" '
      [.containers[] | select(
        (($k == "") or (.labels | has($k))) and
        (($v == "") or (.labels[$k] == $v))
      )] | .[] | "\(.name)\t\(.id)\t\(if .running then "Up 2 minutes" else "Exited (1)" end)"' "$WORLD"
    ;;
  ls-running-names)
    jq -r '.containers[] | select(.running) | .name' "$WORLD"
    ;;
  inspect-con)
    ref="$1"
    out="$(jq -c --arg r "$ref" '[.containers[] | select(.id == $r or .name == $r)][0] // empty' "$WORLD")"
    if [ -z "$out" ]; then printf 'Error response from daemon: No such container: %s\n' "$ref" >&2; exit 1; fi
    jq -c --argjson o "$out" '[{"Id":$o.id,"Name":("/" + $o.name),"Config":{"Labels":$o.labels},"State":{"Running":$o.running}}]' <<<"$out"
    ;;
  create-volume|create-network)
    kind="${cmd#create-}"; name="$1"; shift
    labels="{}"
    for kv in "$@"; do k="${kv%%=*}"; v="${kv#*=}"; labels="$(jq -c --arg k "$k" --arg v "$v" '. + {($k): $v}' <<<"$labels")"; done
    jq --arg n "$name" --argjson l "$labels" --arg k "${kind}s" '.[$k] += [{"name":$n,"labels":$l}]' "$WORLD" >"$WORLD.tmp" && mv "$WORLD.tmp" "$WORLD"
    ;;
  rm-volume|rm-network)
    kind="${cmd#rm-}"; name="$1"
    jq --arg n "$name" --arg k "${kind}s" '.[$k] |= map(select(.name != $n))' "$WORLD" >"$WORLD.tmp" && mv "$WORLD.tmp" "$WORLD"
    ;;
  ls-vol|ls-net)
    kind="${cmd#ls-}"; key="${1:-}"; val="${2:-}"
    case "$kind" in vol) s="volumes" ;; net) s="networks" ;; esac
    jq -r --arg k "$key" --arg v "$val" --arg s "$s" '
      [.[$s][] | select(
        (($k == "") or (.labels | has($k))) and
        (($v == "") or (.labels[$k] == $v))
      )] | .[] | .name' "$WORLD"
    ;;
  inspect-vol|inspect-net)
    kind="${cmd#inspect-}"; name="$1"
    case "$kind" in vol) s="volumes"; what="volume" ;; net) s="networks"; what="network" ;; esac
    out="$(jq -c --arg n "$name" --arg s "$s" '[.[$s][] | select(.name == $n)][0] // empty' "$WORLD")"
    if [ -z "$out" ]; then printf 'Error response from daemon: No such %s: %s\n' "$what" "$name" >&2; exit 1; fi
    jq -c --argjson o "$out" '[{"Name":$o.name}]' <<<"$out"
    ;;
  *)
    echo "world-ctl: comando desconocido: $cmd" >&2
    exit 2
    ;;
esac
CTL
chmod +x "$WORLD_CTL"

# ---------------------------------------------------------------------------
# Stubs (docker/npx/node/curl/psql/npm/setsid). Cada stub registra su
# invocación en CALLS; el mundo docker simula el daemon real.
# ---------------------------------------------------------------------------
mkdir -p "$BIN"
cat >"$BIN/docker" <<'STUB'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >>"$CALLS"
sub="$1"; shift
case "$sub" in
  ps)
    all=0; key=""; val=""; fmt=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -a) all=1 ;;
        --filter) shift; f="$1"
          case "$f" in
            label=com.supabase.cli.project=*) key="com.supabase.cli.project"; val="${f##*=}" ;;
            label=com.supabase.cli.project)   key="com.supabase.cli.project" ;;
          esac ;;
        --format) shift; fmt="$1" ;;
      esac
      shift
    done
    if [ "$all" = "1" ]; then
      if [ -n "$key" ]; then out="$("$WORLD_CTL" ls-con "$key" "$val")"; else out="$("$WORLD_CTL" ls-con)"; fi
    else
      out="$("$WORLD_CTL" ls-running-names)"
    fi
    case "$fmt" in
      *"{{.ID}}"*) printf '%s\n' "$out" ;;
      *) printf '%s\n' "$out" | cut -f1 ;;
    esac
    ;;
  container)
    op="$1"; shift
    case "$op" in
      inspect) "$WORLD_CTL" inspect-con "$1" || exit 1 ;;
    esac
    ;;
  inspect) "$WORLD_CTL" inspect-con "$1" || exit 1 ;;
  rm)
    [ "${1:-}" = "-f" ] && shift
    "$WORLD_CTL" rm-container "$1"
    ;;
  volume|network)
    kind="$sub"; op="$1"; shift
    case "$kind" in volume) k=vol ;; network) k=net ;; esac
    case "$op" in
      ls)
        key=""; val=""
        while [ $# -gt 0 ]; do
          case "$1" in
            --filter) shift; f="$1"
              case "$f" in
                label=com.supabase.cli.project=*) key="com.supabase.cli.project"; val="${f##*=}" ;;
                label=com.supabase.cli.project)   key="com.supabase.cli.project" ;;
              esac ;;
            --format) shift ;;
          esac
          shift
        done
        "$WORLD_CTL" "ls-$k" "$key" "$val"
        ;;
      inspect) "$WORLD_CTL" "inspect-$k" "$1" || exit 1 ;;
      rm) "$WORLD_CTL" "rm-$kind" "$1" ;;
    esac
    ;;
esac
exit 0
STUB
cat >"$BIN/npx" <<'STUB'
#!/usr/bin/env bash
printf 'npx %s\n' "$*" >>"$CALLS"

workdir_of() {
  local wd=""
  while [ $# -gt 0 ]; do
    if [ "$1" = "--workdir" ]; then shift; wd="$1"; fi
    shift
  done
  printf '%s' "$wd"
}

case "$*" in
  *"supabase start"*)
    wd="$(workdir_of "$@")"
    if [ -z "$wd" ]; then exit 0; fi
    cfg="$wd/supabase/config.toml"
    [ -f "$cfg" ] || { printf 'FAKE config ausente: %s\n' "$cfg" >&2; exit 1; }
    pid="$(sed -n 's/^project_id = "\(.*\)"/\1/p' "$cfg" | head -1)"
    api="$(awk '/^\[api\]/{f=1} f&&/^port =/{gsub(/port = /,""); print; exit}' "$cfg")"
    db="$(awk '/^\[db\]/{f=1} f&&/^port =/{gsub(/port = /,""); print; exit}' "$cfg")"
    printf '%s\n' "$pid" >"$PID_FILE"
    printf '%s\n' "$api" >"$API_PORT"
    printf '%s\n' "$db" >"$DB_PORT"
    if [ "${FAKE_START_FAIL:-0}" = "1" ]; then
      # Fallo parcial: sólo el container db+volumen+network alcanzan a crearse.
      "$WORLD_CTL" create-container "supabase_db_$pid" "id-$pid-db" true "com.supabase.cli.project=$pid"
      "$WORLD_CTL" create-volume "supabase_db_$pid" "com.supabase.cli.project=$pid"
      "$WORLD_CTL" create-network "supabase_network_$pid" "com.supabase.cli.project=$pid"
      exit 1
    fi
    "$WORLD_CTL" create-container "supabase_db_$pid" "id-$pid-db" true "com.supabase.cli.project=$pid"
    "$WORLD_CTL" create-container "supabase_api_$pid" "id-$pid-api" true "com.supabase.cli.project=$pid"
    "$WORLD_CTL" create-container "supabase_auth_$pid" "id-$pid-auth" true "com.supabase.cli.project=$pid"
    "$WORLD_CTL" create-volume "supabase_db_$pid" "com.supabase.cli.project=$pid"
    "$WORLD_CTL" create-network "supabase_network_$pid" "com.supabase.cli.project=$pid"
    ;;
  *"supabase status"*)
    wd="$(workdir_of "$@")"
    if [ -z "$wd" ]; then
      printf '%s\n' '{"DB_URL":"postgresql://postgres:***@127.0.0.1:54322/postgres","API_URL":"http://127.0.0.1:54321","ANON_KEY":"anon-setup","SERVICE_ROLE_KEY":"service-setup"}'
      exit 0
    fi
    cfg="$wd/supabase/config.toml"
    pid="$(sed -n 's/^project_id = "\(.*\)"/\1/p' "$cfg" | head -1)"
    api="$(awk '/^\[api\]/{f=1} f&&/^port =/{gsub(/port = /,""); print; exit}' "$cfg")"
    db="$(awk '/^\[db\]/{f=1} f&&/^port =/{gsub(/port = /,""); print; exit}' "$cfg")"
    printf '%s\n' "{\"DB_URL\":\"postgresql://postgres:***@127.0.0.1:$db/postgres\",\"API_URL\":\"http://127.0.0.1:$api\",\"ANON_KEY\":\"anon-$pid\",\"SERVICE_ROLE_KEY\":\"service-$pid\"}"
    ;;
  *"supabase stop"*)
    # Simula el CLI real: elimina los recursos del proyecto (canónico o --workdir).
    wd="$(workdir_of "$@")"
    if [ -n "$wd" ]; then
      cfg="$wd/supabase/config.toml"
      if [ -f "$cfg" ]; then pid="$(sed -n 's/^project_id = "\(.*\)"/\1/p' "$cfg" | head -1)"; else exit 0; fi
      for c in $("$WORLD_CTL" ls-con "com.supabase.cli.project" "$pid"); do :; done
      "$WORLD_CTL" rm-container "id-$pid-db" 2>/dev/null || true
      "$WORLD_CTL" rm-container "id-$pid-api" 2>/dev/null || true
      "$WORLD_CTL" rm-container "id-$pid-auth" 2>/dev/null || true
      "$WORLD_CTL" rm-volume "supabase_db_$pid" 2>/dev/null || true
      "$WORLD_CTL" rm-network "supabase_network_$pid" 2>/dev/null || true
    else
      # Stop canónico (setup): elimina los recursos con label del proyecto.
      while IFS=$'\t' read -r name id _; do
        [ -n "$id" ] && "$WORLD_CTL" rm-container "$id" 2>/dev/null || true
      done < <("$WORLD_CTL" ls-con "com.supabase.cli.project")
      for v in $("$WORLD_CTL" ls-vol "com.supabase.cli.project"); do "$WORLD_CTL" rm-volume "$v" 2>/dev/null || true; done
      for n in $("$WORLD_CTL" ls-net "com.supabase.cli.project"); do "$WORLD_CTL" rm-network "$n" 2>/dev/null || true; done
    fi
    ;;
  *"playwright test"*)
    printf '%s\n' "$*" >>"$PLAYWRIGHT_CMD"
    # Race injection: un proceso ajeno reemplaza el container db registrado.
    if [ "${FAKE_RACE:-}" = "substitute" ] && [ -s "$PID_FILE" ]; then
      pid="$(cat "$PID_FILE")"
      "$WORLD_CTL" rm-container "id-$pid-db"
      "$WORLD_CTL" create-container "supabase_db_$pid" "id-SUB-$pid-db" true "com.supabase.cli.project=$pid"
    fi
    ;;
esac
exit 0
STUB
cat >"$BIN/node" <<'STUB'
#!/usr/bin/env bash
printf 'node %s\n' "$*" >>"$CALLS"
# Nota: el stub ES `node`, así que "$*" = "$1 $2 ..." (el argv0 no forma parte).
# Anteponer un espacio a "$*" normaliza el matching del primer argumento:
# `node -e <script>` -> "$*"="-e <script>" -> " $*"=" -e <script>".
case " $*" in
  *"beta01-minio-owner.cjs --snapshot"*) printf '%s\n' '{"mode":"create"}' ; exit 0 ;;
  *"beta01-minio-owner.cjs --start"*)    printf '%s\n' '{"id":"stub-minio","mode":"create"}' ; exit 0 ;;
  *"beta01-minio-owner.cjs --verify"*)   printf '%s\n' '{"ok":true}' ; exit 0 ;;
  *"beta01-minio-owner.cjs --cleanup"*)  printf '%s\n' '{"ok":true}' ; exit 0 ;;
  *"beta01-target-guard.cjs"*)           printf '%s\n' 'guard-ok' ; exit 0 ;;
  *" -e "*)                              printf '%s\n' 'bucket mike ready' ; exit 0 ;;
esac
exec "$REAL_NODE" "$@"
STUB
cat >"$BIN/curl" <<'STUB'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >>"$CALLS"
sleep 0.2
exit 0
STUB
cat >"$BIN/psql" <<'STUB'
#!/usr/bin/env bash
printf 'psql %s\n' "$*" >>"$CALLS"
printf '%s\n' "$*" >>"$PSQL_LOG"
exit 0
STUB
cat >"$BIN/npm" <<'STUB'
#!/usr/bin/env bash
printf 'npm %s\n' "$*" >>"$CALLS"
case "$*" in
  *"run dev "*) printf '%s\n' 'beta01-fakes preloaded (stub)' ;;
esac
exit 0
STUB
cat >"$BIN/setsid" <<'STUB'
#!/usr/bin/env bash
exec "$@"
STUB
chmod +x "$BIN"/*

# ---------------------------------------------------------------------------
# Harness
# ---------------------------------------------------------------------------
reset_world() {
  printf '%s\n' '{"containers":[],"volumes":[],"networks":[]}' >"$WORLD"
  : >"$CALLS"
  : >"$PSQL_LOG"
  rm -f "$PLAYWRIGHT_CMD" "$PID_FILE" "$API_PORT" "$DB_PORT"
  rm -f "$REPO/backend/.env" "$REPO/backend/.env.hosted.bak" \
        "$REPO/frontend/.env.local" "$REPO/frontend/.env.local.hosted.bak"
}

seed_backend_stack() {
  "$WORLD_CTL" create-container "supabase_db_backend" "id-backend-db" true "com.supabase.cli.project=backend"
  "$WORLD_CTL" create-container "supabase_auth_backend" "id-backend-auth" true "com.supabase.cli.project=backend"
  "$WORLD_CTL" create-volume "supabase_db_backend" "com.supabase.cli.project=backend"
  "$WORLD_CTL" create-network "supabase_network_backend" "com.supabase.cli.project=backend"
}

# run_ai [with-backend] [extra-fake-env...]; deja RUNRC, PID, API, DB.
run_ai() {
  local mode="" a
  local extra=()
  for a in "$@"; do
    if [ "$a" = "with-backend" ]; then mode="with-backend"; else extra+=("$a"); fi
  done
  reset_world
  [ "$mode" = "with-backend" ] && seed_backend_stack
  : >"$RUN_OUT"
  set +e
  (
    # Env del fake en un subshell: evita el constructo frágil
    # `VAR=x "$@" \ PATH=... cmd` (que bash ejecuta como comando "PATH=...").
    export BETA01_SMOKE_SPEC=e2e/beta01-ai-smoke.spec.ts
    export PATH="$BIN:$PATH"
    for kv in "${extra[@]}"; do export "$kv"; done
    bash "$REPO/scripts/e2e-beta01-setup-smoke.sh" >"$RUN_OUT" 2>&1
  )
  RUNRC=$?
  set -e
  PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  API="$(cat "$API_PORT" 2>/dev/null || true)"
  DB="$(cat "$DB_PORT" 2>/dev/null || true)"
}

run_default() {
  reset_world
  : >"$RUN_OUT"
  set +e
  PATH="$BIN:$PATH" bash "$REPO/scripts/e2e-beta01-setup-smoke.sh" >"$RUN_OUT" 2>&1
  RUNRC=$?
  set -e
}

zero_own() {
  local pid="$1" c v n
  c="$("$WORLD_CTL" ls-con "com.supabase.cli.project" "$pid" | wc -l)"
  v="$("$WORLD_CTL" ls-vol "com.supabase.cli.project" "$pid" | wc -l)"
  n="$("$WORLD_CTL" ls-net "com.supabase.cli.project" "$pid" | wc -l)"
  [ "$c" = "0" ] && [ "$v" = "0" ] && [ "$n" = "0" ]
}

world_has_con() { "$WORLD_CTL" ls-con "com.supabase.cli.project" "$1" | grep -q "$2"; }

# ---------------------------------------------------------------------------
# Casos (contrato)
# ---------------------------------------------------------------------------
printf '== beta01 supabase disposable: contract checks ==\n'

# --- c1: unique isolation + wiring exclusivo + cero propio (2 corridas) ----
printf '[c1] AI run #1: aislamiento único, env exclusivo, zero own\n'
run_ai
if [ "$RUNRC" -eq 0 ]; then ok "c1: exit 0 (teardown limpio)"; else bad "c1: exit 0 esperado, rc=$RUNRC"; fi
case "$PID" in
  beta01ai[a-z0-9]*) ok "c1: project_id único generado ($PID)";;
  *) bad "c1: project_id inesperado ($PID)";;
esac
[ "$PID" != "backend" ] && ok "c1: project_id ≠ canónico 'backend'" || bad "c1: project_id == backend (reuso!)"
if [ -n "$API" ] && [ "$API" -ge 56000 ] && [ "$API" -le 57600 ] && [ "$API" != "54321" ]; then
  ok "c1: api port único fuera del rango canónico ($API)"
else
  bad "c1: api port inesperado ($API)"
fi
if [ -n "$DB" ] && [ "$DB" = "$((API + 1))" ] && [ "$DB" != "54322" ]; then
  ok "c1: db port = api+1 y ≠ canónico ($DB)"
else
  bad "c1: db port inesperado ($DB)"
fi
if grep -qE "^npx supabase start --workdir /tmp/beta01-smoke\..*/supabase-project$" "$CALLS"; then
  ok "c1: supabase start usa --workdir bajo SMOKE_DIR"
else
  bad "c1: start sin --workdir bajo SMOKE_DIR: $(grep 'npx supabase start' "$CALLS" | head -1)"
fi
if grep -qE "^npx supabase status -o json --workdir /tmp/beta01-smoke\." "$CALLS"; then
  ok "c1: supabase status consulta el stack disposable (--workdir)"
else
  bad "c1: status no usó --workdir"
fi
if grep -q "beta01-supabase-owner.cjs --snapshot" "$CALLS" \
  && grep -q "beta01-supabase-owner.cjs --record" "$CALLS" \
  && grep -q "beta01-supabase-owner.cjs --cleanup" "$CALLS"; then
  ok "c1: ownership snapshot/record/cleanup invocados"
else
  bad "c1: faltan invocaciones del helper de ownership"
fi
if grep -q "SUPABASE_URL=http://127.0.0.1:$API" "$REPO/backend/.env" \
  && grep -q "SUPABASE_SECRET_KEY=service-$PID" "$REPO/backend/.env"; then
  ok "c1: backend/.env apunta SÓLO al stack disposable (URL+service key del pid)"
else
  bad "c1: backend/.env no apunta al stack disposable"
fi
if grep -q "NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:$API" "$REPO/frontend/.env.local" \
  && grep -q "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=anon-$PID" "$REPO/frontend/.env.local"; then
  ok "c1: frontend/.env.local apunta SÓLO al stack disposable (URL+anon key del pid)"
else
  bad "c1: frontend/.env.local no apunta al stack disposable"
fi
if grep -q "127.0.0.1:$DB" "$PSQL_LOG" && ! grep -q "127.0.0.1:54322" "$PSQL_LOG"; then
  ok "c1: schema/migraciones/grants contra la DB disposable (puerto $DB, nunca 54322)"
else
  bad "c1: psql no usó la DB disposable: $(head -1 "$PSQL_LOG")"
fi
if [ "$(ls -d /tmp/beta01-smoke.* 2>/dev/null | wc -l)" = "$PRE_SMOKE_DIRS" ]; then
  ok "c1: teardown — sin dirs /tmp/beta01-smoke.* residuales"
else
  bad "c1: quedaron dirs /tmp/beta01-smoke.*"
fi
if zero_own "$PID"; then
  ok "c1: zero own resources después (containers/volumes/network con label del pid)"
else
  bad "c1: quedan recursos con label del pid: $( "$WORLD_CTL" ls-con "com.supabase.cli.project" "$PID" | cut -f1 | tr '\n' ' ')"
fi
PID1="$PID"; API1="$API"; DB1="$DB"

printf '[c1] AI run #2: project_id y ports distintos por corrida\n'
run_ai
if [ "$RUNRC" -eq 0 ] && [ "$PID" != "$PID1" ] && [ "$API" != "$API1" ] && [ "$DB" != "$DB1" ]; then
  ok "c1: segunda corrida genera project_id/ports distintos ($PID1/$API1 -> $PID/$API)"
else
  bad "c1: corridas comparten aislamiento (rc=$RUNRC, pid1=$PID1 pid2=$PID api1=$API1 api2=$API)"
fi
if zero_own "$PID"; then ok "c1: zero own resources después de la 2ª corrida"; else bad "c1: residuo en 2ª corrida"; fi

printf '[c7] inmutabilidad: el runner nunca ejecuta DELETE (tablas terminales intactas)\n'
if ! grep -qi 'delete' "$CALLS"; then
  ok "c7: cero DELETE en toda la corrida (ai_executions/receipts/audit no se tocan)"
else
  bad "c7: se detectó DELETE: $(grep -i delete "$CALLS" | head -2)"
fi

# --- c2: preexisting preserved ---
printf '[c2] stack preexistente backend preservado (mismos IDs/estado)\n'
run_ai with-backend
if [ "$RUNRC" -eq 0 ]; then ok "c2: exit 0 con stack preexistente"; else bad "c2: exit 0 esperado, rc=$RUNRC"; fi
if "$WORLD_CTL" ls-con "com.supabase.cli.project" "backend" | grep -q "supabase_db_backend.id-backend-db.Up"; then
  ok "c2: container preexistente supabase_db_backend conserva mismo ID y estado"
else
  bad "c2: preexistente supabase_db_backend alterado: $("$WORLD_CTL" ls-con "com.supabase.cli.project" "backend" | tr '\n' ' ')"
fi
if "$WORLD_CTL" ls-con "com.supabase.cli.project" "backend" | grep -q "supabase_auth_backend.id-backend-auth.Up"; then
  ok "c2: container preexistente supabase_auth_backend conserva mismo ID y estado"
else
  bad "c2: preexistente supabase_auth_backend alterado"
fi
if "$WORLD_CTL" ls-vol "com.supabase.cli.project" "backend" | grep -q "^supabase_db_backend$"; then
  ok "c2: volumen preexistente intacto"
else
  bad "c2: volumen preexistente alterado"
fi
if "$WORLD_CTL" ls-net "com.supabase.cli.project" "backend" | grep -q "^supabase_network_backend$"; then
  ok "c2: network preexistente intacta"
else
  bad "c2: network preexistente alterada"
fi
if ! grep -qE 'rm .*(backend|id-backend)' "$CALLS"; then
  ok "c2: cero MUTACIONES docker hacia el stack preexistente (sólo inspección read-only por ID)"
else
  bad "c2: docker mutó el stack preexistente: $(grep -E 'rm .*(backend|id-backend)' "$CALLS" | head -2)"
fi
if ! grep -q '^npx supabase stop' "$CALLS"; then
  ok "c2: el runner AI nunca invoca supabase stop (no detiene nada)"
else
  bad "c2: se invocó supabase stop en modo AI"
fi
if zero_own "$PID"; then ok "c2: zero own resources"; else bad "c2: residuo propio"; fi

# --- c3: partial start cleanup ---
printf '[c3] fallo parcial de supabase start -> cleanup destruye SÓLO lo propio\n'
run_ai with-backend FAKE_START_FAIL=1
if [ "$RUNRC" -eq 1 ]; then ok "c3: corrida falla (rc=1) al fallar start"; else bad "c3: rc=1 esperado, rc=$RUNRC"; fi
if grep -q 'supabase start (disposable) failed' "$RUN_OUT"; then
  ok "c3: error primario del start preservado"
else
  bad "c3: no aparece el error del start disposable"
fi
if zero_own "$PID"; then
  ok "c3: partial stack destruido (zero own resources con label del pid)"
else
  bad "c3: quedó el partial stack: $("$WORLD_CTL" ls-con "com.supabase.cli.project" "$PID" | cut -f1 | tr '\n' ' ')"
fi
if "$WORLD_CTL" ls-con "com.supabase.cli.project" "backend" | grep -q "supabase_db_backend.id-backend-db.Up"; then
  ok "c3: preexistente intacto tras el cleanup parcial"
else
  bad "c3: preexistente alterado en fallo parcial"
fi
if grep -q 'teardown verified after run failure' "$RUN_OUT"; then
  ok "c3: teardown verificado tras fallo (exit code del run preservado)"
else
  bad "c3: falta aviso de teardown tras fallo"
fi

# --- c4: ID/label race fail-closed ---
printf '[c4] sustituto del container db -> teardown FALLA sin borrar nada\n'
run_ai FAKE_RACE=substitute
if [ "$RUNRC" -eq 1 ]; then ok "c4: corrida falla por race (rc=1)"; else bad "c4: rc=1 esperado, rc=$RUNRC"; fi
if grep -q 'ID race' "$RUN_OUT"; then
  ok "c4: error de ID race reportado en teardown"
else
  bad "c4: falta diagnóstico de ID race: $(grep -i 'teardown FAILED' "$RUN_OUT" | head -2)"
fi
if world_has_con "$PID" "id-SUB-$PID-db"; then
  ok "c4: el sustituto NO fue borrado (fail-closed)"
else
  bad "c4: el sustituto fue eliminado — viola fail-closed"
fi
if world_has_con "$PID" "id-$PID-api" && world_has_con "$PID" "id-$PID-auth"; then
  ok "c4: resto del stack registrado NO fue borrado (abort ante race)"
else
  bad "c4: se borraron containers no implicados en la race"
fi

# --- c6: Gate 1 intacto (spec setup) ---
printf '[c6] spec setup mantiene comportamiento Gate 1 (sin --workdir, sin helper)\n'
run_default
if [ "$RUNRC" -eq 0 ]; then ok "c6: exit 0 (setup smoke con teardown limpio)"; else bad "c6: exit 0 esperado, rc=$RUNRC"; fi
if grep -q '^npx supabase start$' "$CALLS" && ! grep -q '^npx supabase start --workdir' "$CALLS"; then
  ok "c6: supabase start SIN --workdir (stack canónico, flujo Gate 1)"
else
  bad "c6: start no usa el flujo canónico: $(grep 'npx supabase start' "$CALLS" | head -1)"
fi
if grep -q '^npx supabase stop$' "$CALLS"; then
  ok "c6: supabase stop canónico invocado en teardown"
else
  bad "c6: falta stop canónico"
fi
if ! grep -q 'beta01-supabase-owner.cjs' "$CALLS"; then
  ok "c6: helper de ownership NO se usa en el spec setup"
else
  bad "c6: helper de ownership invocado en setup"
fi
if grep -q '127.0.0.1:54322' "$PSQL_LOG"; then
  ok "c6: psql contra el stack canónico (54322) como antes"
else
  bad "c6: psql no usó el stack canónico: $(head -1 "$PSQL_LOG")"
fi
if zero_own "backend" || [ "$("$WORLD_CTL" ls-con | wc -l)" = "0" ]; then
  ok "c6: cero containers tras el teardown setup"
else
  bad "c6: quedaron containers tras setup: $("$WORLD_CTL" ls-con | cut -f1 | tr '\n' ' ')"
fi

printf '== resultado: %d checks, %d fallas ==\n' "$CHECKS" "$FAILS"
[ "$FAILS" -eq 0 ]