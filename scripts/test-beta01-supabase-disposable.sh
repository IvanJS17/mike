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
#       terminales ai_executions/receipts/audit no se tocan);
#   cE. Gate 2 fix E — IDs canónicos full 64-char: `docker ps` expone IDs
#       TRUNCADOS (12 chars) y el mundo fake lo modela tal cual: cada
#       candidato se resuelve vía `docker inspect` (full 64-hex) antes de
#       persistirse (pre/owned/recorded guardan id canónico + name/labels/
#       state); un prefix corto que coincide con DOS full ids distintos
#       (ambiguo) o duplicado falla fail-closed sin persistir ni borrar nada;
#       un preexistente cuyo full ID driftó del snapshot falla el cleanup sin
#       eliminar nada propio; el cleanup elimina SÓLO full IDs owned (docker
#       rm -f recibe el full 64-hex, nunca un prefix); el snapshot es
#       read-only (cero mutaciones).
#   cF. Gate 2 fix F — volumen ausente en DOS formatos: el daemon docker real
#       emite "No such volume: <name>" (CLI clásico) y "get <name>: no such
#       volume" (API real, case/whitespace razonables); el helper los
#       interpreta como ABSENCIA y sólo cuando el inspect devolvió status≠0;
#       un error genuino de daemon/permisos sigue siendo FAIL; el cleanup
#       continúa eliminando/verificando owned (containers/network; volumen ya
#       ausente verificado como tal) sin tocar preexisting; el probe contra un
#       nombre de volumen UUID inexistente es read-only (cero mutaciones).
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

# ID canónico docker: 64 hex chars deterministas por token (como en docker
# real, el full id del inspect; `docker ps` expone sólo los primeros 12).
sid() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }

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
    # Como docker real: un prefix ambiguo es un error, no una adivinanza.
    n="$(jq --arg r "$ref" '[.containers[] | select(.id == $r or .name == $r or (.id | startswith($r)))] | length' "$WORLD")"
    if [ "$n" -gt "1" ]; then printf 'Error response from daemon: Multiple IDs found with provided prefix: %s\n' "$ref" >&2; exit 1; fi
    jq --arg r "$ref" '.containers |= map(select(.id != $r and .name != $r and ((.id | startswith($r)) | not)))' "$WORLD" >"$WORLD.tmp" && mv "$WORLD.tmp" "$WORLD"
    ;;
  ls-con)
    key="${1:-}"; val="${2:-}"
    # Igual que docker: `.id[0:12]` — `docker ps` sólo expone el prefix
    # corto; el full 64-hex sólo sale por `docker inspect`.
    jq -r --arg k "$key" --arg v "$val" '
      [.containers[] | select(
        (($k == "") or (.labels | has($k))) and
        (($v == "") or (.labels[$k] == $v))
      )] | .[] | "\(.name)\t\(.id[0:12])\t\(if .running then "Up 2 minutes" else "Exited (1)" end)"' "$WORLD"
    ;;
  ls-running-names)
    jq -r '.containers[] | select(.running) | .name' "$WORLD"
    ;;
  inspect-con)
    ref="$1"
    # Como docker real: primero match EXACTO por full id o nombre; si no,
    # resolución por prefix UNICAMENTE cuando coincide con UN full id. Dos
    # full ids con el mismo prefix corto = error de ambigüedad, nunca [0].
    out="$(jq -c --arg r "$ref" '[.containers[] | select(.id == $r or .name == $r)][0] // empty' "$WORLD")"
    if [ -z "$out" ]; then
      n="$(jq --arg r "$ref" '[.containers[] | select(.id | startswith($r))] | length' "$WORLD")"
      if [ "$n" = "0" ]; then printf 'Error response from daemon: No such container: %s\n' "$ref" >&2; exit 1; fi
      if [ "$n" -gt "1" ]; then printf 'Error response from daemon: Multiple IDs found with provided prefix: %s\n' "$ref" >&2; exit 1; fi
      out="$(jq -c --arg r "$ref" '[.containers[] | select(.id | startswith($r))][0]' "$WORLD")"
    fi
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
    if [ -z "$out" ]; then
      if [ "$kind" = "vol" ]; then
        # Gate 2 fix F: docker real emite el volumen ausente en DOS formatos
        # (CLI clásico "No such volume: <name>" y API "get <name>: no such
        # volume"). VOL_ABSENT_STYLE=classic|daemon los selecciona y
        # VOL_ABSENT_STYLE=genuine inyecta un error REAL de daemon/permisos
        # que el helper NUNCA debe interpretar como absent. El estilo daemon
        # varía case/whitespace a propósito ("GET  <name> : No Such Volume").
        case "${VOL_ABSENT_STYLE:-classic}" in
          daemon)  printf 'Error response from daemon: GET  %s : No Such Volume\n' "$name" >&2 ;;
          genuine) printf 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n' >&2 ;;
          *)       printf 'Error: No such volume: %s\n' "$name" >&2 ;;
        esac
      else
        printf 'Error response from daemon: No such %s: %s\n' "$what" "$name" >&2
      fi
      exit 1
    fi
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
      "$WORLD_CTL" create-container "supabase_db_$pid" "$(printf '%s' "db-$pid-fail" | sha256sum | cut -d' ' -f1)" true "com.supabase.cli.project=$pid"
      "$WORLD_CTL" create-volume "supabase_db_$pid" "com.supabase.cli.project=$pid"
      "$WORLD_CTL" create-network "supabase_network_$pid" "com.supabase.cli.project=$pid"
      exit 1
    fi
    # Full IDs 64-hex como en docker real; `docker ps` los mostrará truncados.
    "$WORLD_CTL" create-container "supabase_db_$pid" "$(printf '%s' "db-$pid" | sha256sum | cut -d' ' -f1)" true "com.supabase.cli.project=$pid"
    "$WORLD_CTL" create-container "supabase_api_$pid" "$(printf '%s' "api-$pid" | sha256sum | cut -d' ' -f1)" true "com.supabase.cli.project=$pid"
    "$WORLD_CTL" create-container "supabase_auth_$pid" "$(printf '%s' "auth-$pid" | sha256sum | cut -d' ' -f1)" true "com.supabase.cli.project=$pid"
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
      "$WORLD_CTL" rm-container "supabase_db_$pid" 2>/dev/null || true
      "$WORLD_CTL" rm-container "supabase_api_$pid" 2>/dev/null || true
      "$WORLD_CTL" rm-container "supabase_auth_$pid" 2>/dev/null || true
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
      "$WORLD_CTL" rm-container "supabase_db_$pid"
      "$WORLD_CTL" create-container "supabase_db_$pid" "$(printf '%s' "SUB-db-$pid" | sha256sum | cut -d' ' -f1)" true "com.supabase.cli.project=$pid"
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
  "$WORLD_CTL" create-container "supabase_db_backend" "$(sid backend-db)" true "com.supabase.cli.project=backend"
  "$WORLD_CTL" create-container "supabase_auth_backend" "$(sid backend-auth)" true "com.supabase.cli.project=backend"
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

# Full ID de un contenedor por nombre (inspección read-only del mundo fake),
# y helper de presencia: compara el FULL id, nunca prefixes truncados.
con_full_id() { "$WORLD_CTL" inspect-con "$1" 2>/dev/null | jq -r '.[0].Id // empty'; }
world_has_con() { [ "$(con_full_id "$1")" = "$2" ]; }

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
printf '[c2] stack preexistente backend preservado (mismos FULL IDs/estado)\n'
run_ai with-backend
if [ "$RUNRC" -eq 0 ]; then ok "c2: exit 0 con stack preexistente"; else bad "c2: exit 0 esperado, rc=$RUNRC"; fi
if [ "$(con_full_id supabase_db_backend)" = "$(sid backend-db)" ] \
  && [ "$("$WORLD_CTL" inspect-con supabase_db_backend 2>/dev/null | jq -r '.[0].State.Running')" = "true" ]; then
  ok "c2: preexistente supabase_db_backend conserva mismo FULL ID (64-hex) y estado"
else
  bad "c2: preexistente supabase_db_backend alterado: id_actual=$(con_full_id supabase_db_backend)"
fi
if [ "$(con_full_id supabase_auth_backend)" = "$(sid backend-auth)" ] \
  && [ "$("$WORLD_CTL" inspect-con supabase_auth_backend 2>/dev/null | jq -r '.[0].State.Running')" = "true" ]; then
  ok "c2: preexistente supabase_auth_backend conserva mismo FULL ID y estado"
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
mut_lines="$(grep -E '^(docker rm -f|docker (volume|network) rm )' "$CALLS" | grep backend | head -2 || true)"
if [ -z "$mut_lines" ]; then
  ok "c2: cero MUTACIONES docker hacia el stack preexistente (sólo inspección read-only)"
else
  bad "c2: docker mutó el stack preexistente: $mut_lines"
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
if [ "$(con_full_id supabase_db_backend)" = "$(sid backend-db)" ]; then
  ok "c3: preexistente intacto tras el cleanup parcial"
else
  bad "c3: preexistente alterado en fallo parcial (id_actual=$(con_full_id supabase_db_backend))"
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
if world_has_con "supabase_db_$PID" "$(sid SUB-db-$PID)"; then
  ok "c4: el sustituto NO fue borrado (fail-closed)"
else
  bad "c4: el sustituto fue eliminado — viola fail-closed"
fi
if world_has_con "supabase_api_$PID" "$(sid api-$PID)" && world_has_con "supabase_auth_$PID" "$(sid auth-$PID)"; then
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

# --- cE: Gate 2 fix E — IDs canónicos full 64-char ---
printf '[cE] IDs canónicos: docker ps truncado -> docker inspect full 64-hex\n'
HELPER="$REPO/e2e/support/beta01-supabase-owner.cjs"
E_PID="beta01aie1test"

# cE-1: short list -> full inspect same accepted; snapshot read-only; estado
#       con full IDs + name/labels/state; cleanup elimina SÓLO full IDs.
printf '[cE-1] happy path: ps corto -> inspect full; snapshot read-only; rm por full ID\n'
reset_world
seed_backend_stack
SNAP_E1="$TMP/state-e1.json"
: >"$CALLS"
if PATH="$BIN:$PATH" node "$HELPER" --snapshot --project-id "$E_PID" --state-file "$SNAP_E1" >"$TMP/e1-snap.out" 2>&1; then
  ok "cE-1: snapshot exit 0 con stack preexistente"
else
  bad "cE-1: snapshot falló: $(cat "$TMP/e1-snap.out")"
fi
if ! grep -Eq '^(docker rm -f|docker (volume|network) rm )' "$CALLS"; then
  ok "cE-1: snapshot read-only — cero mutaciones docker"
else
  bad "cE-1: snapshot mutó docker: $(grep -E '^(docker rm -f|docker (volume|network) rm )' "$CALLS" | head -2)"
fi
if [ "$(jq '[.pre.containers[] | select((.id | test("^[0-9a-f]{64}$")) | not)] | length' "$SNAP_E1")" = "0" ] \
  && [ "$(jq -r --arg n "supabase_db_backend" '.pre.containers[] | select(.name == $n) | .id' "$SNAP_E1")" = "$(sid backend-db)" ]; then
  ok "cE-1: pre.containers persiste FULL IDs 64-hex (no prefixes de ps)"
else
  bad "cE-1: pre.containers sin full IDs: $(jq -c '.pre.containers' "$SNAP_E1")"
fi
if [ "$(jq -r --arg n "supabase_db_backend" '.pre.containers[] | select(.name == $n) | .labels["com.supabase.cli.project"]' "$SNAP_E1")" = "backend" ] \
  && [ "$(jq -r --arg n "supabase_db_backend" '.pre.containers[] | select(.name == $n) | .running' "$SNAP_E1")" = "true" ]; then
  ok "cE-1: pre.containers guarda name/labels/state junto al full ID"
else
  bad "cE-1: faltan name/labels/state en pre: $(jq -c '.pre.containers[0]' "$SNAP_E1")"
fi
# Stack propio (como haría `supabase start` disposable)
"$WORLD_CTL" create-container "supabase_db_$E_PID" "$(sid db-$E_PID)" true "com.supabase.cli.project=$E_PID"
"$WORLD_CTL" create-container "supabase_api_$E_PID" "$(sid api-$E_PID)" true "com.supabase.cli.project=$E_PID"
"$WORLD_CTL" create-container "supabase_auth_$E_PID" "$(sid auth-$E_PID)" true "com.supabase.cli.project=$E_PID"
"$WORLD_CTL" create-volume "supabase_db_$E_PID" "com.supabase.cli.project=$E_PID"
"$WORLD_CTL" create-network "supabase_network_$E_PID" "com.supabase.cli.project=$E_PID"
ps_line="$(PATH="$BIN:$PATH" docker ps -a --filter "label=com.supabase.cli.project=$E_PID" --format '{{.Names}}\t{{.ID}}\t{{.Status}}' 2>/dev/null | grep "^supabase_db_$E_PID" | head -1)"
ps_id="$(printf '%s\n' "$ps_line" | cut -f2)"
ps_name="$(printf '%s\n' "$ps_line" | cut -f1)"
if [ "$ps_name" = "supabase_db_$E_PID" ] && [[ "$ps_id" =~ ^[0-9a-f]{12}$ ]]; then
  ok "cE-1: docker ps expone SÓLO el prefix truncado (12 chars)"
else
  bad "cE-1: docker ps no truncó el ID: $ps_line"
fi
: >"$CALLS"
if PATH="$BIN:$PATH" node "$HELPER" --record --state-file "$SNAP_E1" >"$TMP/e1-rec.out" 2>&1; then
  ok "cE-1: record exit 0 (short list -> full inspect same accepted)"
else
  bad "cE-1: record falló: $(cat "$TMP/e1-rec.out")"
fi
if [ "$(jq '[.recorded.containers[] | select((.id | test("^[0-9a-f]{64}$")) | not)] | length' "$SNAP_E1")" = "0" ] \
  && [ "$(jq -r --arg n "supabase_db_$E_PID" '.recorded.containers[] | select(.name == $n) | .id' "$SNAP_E1")" = "$(sid db-$E_PID)" ] \
  && [ "$(jq -r --arg n "supabase_db_$E_PID" '.recorded.containers[] | select(.name == $n) | .labels["com.supabase.cli.project"]' "$SNAP_E1")" = "$E_PID" ] \
  && [ "$(jq -r --arg n "supabase_db_$E_PID" '.recorded.containers[] | select(.name == $n) | .running' "$SNAP_E1")" = "true" ]; then
  ok "cE-1: recorded persiste FULL IDs (64-hex) + name/labels/state, iguales al inspect"
else
  bad "cE-1: recorded sin full IDs: $(jq -c '.recorded' "$SNAP_E1" | head -c 300)"
fi
: >"$CALLS"
set +e
cleanup_e1="$(PATH="$BIN:$PATH" node "$HELPER" --cleanup --state-file "$SNAP_E1" 2>&1)"
set -e
if [ "$(jq -r '.ok // "false"' <<<"$cleanup_e1")" = "true" ]; then
  ok "cE-1: cleanup exit ok — preexistente verificado por full ID, own eliminado"
else
  bad "cE-1: cleanup falló: $cleanup_e1"
fi
if zero_own "$E_PID"; then ok "cE-1: zero own resources tras cleanup"; else bad "cE-1: residuo propio tras cleanup"; fi
if [ "$(con_full_id supabase_db_backend)" = "$(sid backend-db)" ] && [ "$(con_full_id supabase_auth_backend)" = "$(sid backend-auth)" ]; then
  ok "cE-1: preexistente intacto tras cleanup (mismos full IDs)"
else
  bad "cE-1: preexistente alterado tras cleanup"
fi
rm_args="$(grep '^docker rm -f ' "$CALLS" | awk '{print $4}' | sort -u)"
rm_expected="$(printf '%s\n' "$(sid db-$E_PID)" "$(sid api-$E_PID)" "$(sid auth-$E_PID)" | sort -u)"
if [ "$rm_args" = "$rm_expected" ] && printf '%s\n' "$rm_args" | grep -qE '^[0-9a-f]{64}$'; then
  ok "cE-1: cleanup eliminó SÓLO los full IDs owned (rm -f con 64-hex exactos)"
else
  bad "cE-1: rm -f no usó full IDs exactos: $rm_args"
fi

# cE-2: dos full ids DISTINTOS que comparten el mismo prefix corto -> el
#       snapshot falla fail-closed sin persistir ni mutar nada.
printf '[cE-2] distinto full con mismo prefix -> snapshot FALLA fail-closed\n'
reset_world
AID="$(sid ambig-a)"
BID="${AID%?}$([ "${AID: -1}" = "0" ] && printf 1 || printf 0)"
"$WORLD_CTL" create-container "supabase_ambig_1" "$AID" true "com.supabase.cli.project=backend"
"$WORLD_CTL" create-container "supabase_ambig_2" "$BID" true "com.supabase.cli.project=backend"
SNAP_E2="$TMP/state-e2.json"
rm -f "$SNAP_E2"
if ! PATH="$BIN:$PATH" node "$HELPER" --snapshot --project-id "$E_PID" --state-file "$SNAP_E2" >"$TMP/e2.out" 2>&1; then
  ok "cE-2: snapshot falla con prefix ambiguo (rc≠0)"
else
  bad "cE-2: snapshot debió fallar ante prefix ambiguo: $(cat "$TMP/e2.out")"
fi
if grep -qiE 'ambiguo|multiple id' "$TMP/e2.out"; then
  ok "cE-2: diagnóstico de ambigüedad reportado"
else
  bad "cE-2: falta diagnóstico de ambigüedad: $(cat "$TMP/e2.out")"
fi
if [ ! -f "$SNAP_E2" ]; then
  ok "cE-2: nada se persiste ante el fallo (sin estado)"
else
  bad "cE-2: se persistió estado pese a la ambigüedad"
fi
if [ "$(con_full_id supabase_ambig_1)" = "$AID" ] && [ "$(con_full_id supabase_ambig_2)" = "$BID" ]; then
  ok "cE-2: cero mutaciones — ambos contenedores intactos"
else
  bad "cE-2: los contenedores fueron alterados"
fi

# cE-3: prefix duplicado entre recursos PROPIOS -> record falla fail-closed
#       sin registrar ni borrar nada.
printf '[cE-3] prefix duplicado en recursos del proyecto -> record FALLA\n'
reset_world
SNAP_E3="$TMP/state-e3.json"
PATH="$BIN:$PATH" node "$HELPER" --snapshot --project-id "$E_PID" --state-file "$SNAP_E3" >/dev/null 2>&1 \
  || bad "cE-3: snapshot previo falló"
CID="$(sid dup-c1)"
DID="${CID%?}$([ "${CID: -1}" = "0" ] && printf 1 || printf 0)"
"$WORLD_CTL" create-container "supabase_db_$E_PID" "$CID" true "com.supabase.cli.project=$E_PID"
"$WORLD_CTL" create-container "supabase_api_$E_PID" "$DID" true "com.supabase.cli.project=$E_PID"
if ! PATH="$BIN:$PATH" node "$HELPER" --record --state-file "$SNAP_E3" >"$TMP/e3.out" 2>&1; then
  ok "cE-3: record falla con prefix duplicado (rc≠0)"
else
  bad "cE-3: record debió fallar ante prefix duplicado: $(cat "$TMP/e3.out")"
fi
if grep -qiE 'ambiguo|multiple id' "$TMP/e3.out"; then
  ok "cE-3: diagnóstico de prefix duplicado reportado"
else
  bad "cE-3: falta diagnóstico de prefix duplicado: $(cat "$TMP/e3.out")"
fi
if [ "$(con_full_id "supabase_db_$E_PID")" = "$CID" ] && [ "$(con_full_id "supabase_api_$E_PID")" = "$DID" ]; then
  ok "cE-3: cero mutaciones — recursos propios intactos tras record fallido"
else
  bad "cE-3: se alteraron recursos pese al fallo"
fi
if [ "$(jq -r '.recorded // "null"' "$SNAP_E3")" = "null" ]; then
  ok "cE-3: recorded sigue vacío (nada registrado)"
else
  bad "cE-3: recorded se llenó pese al fallo"
fi

# cE-4: drift REAL del preexistente (mismo nombre, full ID distinto) ->
#       cleanup falla fail-closed sin borrar NADA propio.
printf '[cE-4] preexistente con full ID driftado -> cleanup FALLA sin borrar nada\n'
reset_world
seed_backend_stack
SNAP_E4="$TMP/state-e4.json"
PATH="$BIN:$PATH" node "$HELPER" --snapshot --project-id "$E_PID" --state-file "$SNAP_E4" >/dev/null 2>&1 \
  || bad "cE-4: snapshot previo falló"
"$WORLD_CTL" create-container "supabase_db_$E_PID" "$(sid db-$E_PID)" true "com.supabase.cli.project=$E_PID"
"$WORLD_CTL" create-container "supabase_api_$E_PID" "$(sid api-$E_PID)" true "com.supabase.cli.project=$E_PID"
PATH="$BIN:$PATH" node "$HELPER" --record --state-file "$SNAP_E4" >/dev/null 2>&1 \
  || bad "cE-4: record falló"
"$WORLD_CTL" rm-container "supabase_db_backend"
"$WORLD_CTL" create-container "supabase_db_backend" "$(sid backend-db-drifted)" true "com.supabase.cli.project=backend"
set +e
cE4_out="$(PATH="$BIN:$PATH" node "$HELPER" --cleanup --state-file "$SNAP_E4" 2>&1)"
set -e
if [ "$(jq -r '.ok // "false"' <<<"$cE4_out")" = "false" ]; then
  ok "cE-4: cleanup falla ante drift real del preexistente"
else
  bad "cE-4: cleanup debió fallar ante drift: $cE4_out"
fi
if grep -q 'preexistente' <<<"$cE4_out"; then
  ok "cE-4: diagnóstico apunta al preexistente alterado"
else
  bad "cE-4: diagnóstico inesperado: $cE4_out"
fi
if [ "$(con_full_id "supabase_db_$E_PID")" = "$(sid db-$E_PID)" ] && [ "$(con_full_id "supabase_api_$E_PID")" = "$(sid api-$E_PID)" ]; then
  ok "cE-4: nada propio eliminado (fail-closed ante drift)"
else
  bad "cE-4: se borró algo propio pese al drift"
fi
if [ "$(con_full_id supabase_db_backend)" = "$(sid backend-db-drifted)" ]; then
  ok "cE-4: el container ajeno reemplazado queda intacto (no se toca)"
else
  bad "cE-4: el container ajeno fue alterado"
fi

# --- cF: Gate 2 fix F — volumen ausente (ambos formatos docker; daemon FAIL) ---
printf '[cF] volumen ausente: CLI clásico + API daemon real => absent; daemon/permisos FAIL; cleanup continúa\n'
VOL_UUID="0f2e7c9a-4d9a-4b6e-9c8a-1234567890ab"

# Probe read-only: invoca volumeExists() del helper REAL (módulo, sin CLI)
# contra el docker fake vía PATH con un nombre de volumen UUID inexistente.
cat >"$TMP/probe-vol.cjs" <<'PROBE'
"use strict";
const { SupabaseDisposableOwnership } = require(process.argv[2]);
const owner = new SupabaseDisposableOwnership({});
owner
  .volumeExists(process.argv[3])
  .then((exists) => console.log(JSON.stringify({ absent: exists === false, exists })))
  .catch((err) => {
    console.log(JSON.stringify({ failed: true, message: err.message }));
    process.exit(1);
  });
PROBE

vol_probe() { # $1 = estilo del mensaje (classic|daemon|genuine)
  local style="$1" out
  set +e
  out="$(VOL_ABSENT_STYLE="$style" PATH="$BIN:$PATH" "$REAL_NODE" "$TMP/probe-vol.cjs" "$HELPER" "$VOL_UUID" 2>&1)"
  set -e
  printf '%s' "$out"
}

# cF-1: formato CLI clásico "No such volume: <name>" -> absent; read-only.
printf '[cF-1] formato clásico "No such volume: <uuid>" -> absent; probe read-only\n'
reset_world
: >"$CALLS"
cF1="$(vol_probe classic)"
if [ "$(jq -r '.absent // "false"' <<<"$cF1")" = "true" ]; then
  ok "cF-1: volumen UUID inexistente (clásico) -> volumeExists=false (absent)"
else
  bad "cF-1: absent esperado, got: $cF1"
fi
if ! grep -Eq '^(docker rm -f|docker (volume|network) rm )' "$CALLS"; then
  ok "cF-1: probe read-only — cero mutaciones docker"
else
  bad "cF-1: probe mutó docker: $(grep -E '^(docker rm -f|docker (volume|network) rm )' "$CALLS" | head -2)"
fi

# cF-2: formato API daemon real "get <uuid>: no such volume" con variación de
#       case/whitespace -> absent; read-only.
printf '[cF-2] formato daemon real "get <uuid>: no such volume" (case/whitespace) -> absent\n'
reset_world
: >"$CALLS"
cF2="$(vol_probe daemon)"
if [ "$(jq -r '.absent // "false"' <<<"$cF2")" = "true" ]; then
  ok "cF-2: volumen UUID inexistente (daemon real) -> volumeExists=false (absent)"
else
  bad "cF-2: absent esperado, got: $cF2"
fi
if ! grep -Eq '^(docker rm -f|docker (volume|network) rm )' "$CALLS"; then
  ok "cF-2: probe read-only — cero mutaciones docker"
else
  bad "cF-2: probe mutó docker: $(grep -E '^(docker rm -f|docker (volume|network) rm )' "$CALLS" | head -2)"
fi

# cF-3: error genuino de daemon/permisos en volume inspect -> FAIL (throw),
#       NUNCA absent; cero mutaciones.
printf '[cF-3] error genuino de daemon en volume inspect -> FAIL (no absent)\n'
reset_world
: >"$CALLS"
cF3="$(vol_probe genuine)"
if [ "$(jq -r '.failed // "false"' <<<"$cF3")" = "true" ] && ! grep -q '"absent":true' <<<"$cF3"; then
  ok "cF-3: daemon caído/permisos -> volumeExists THROW (FAIL, no absent)"
else
  bad "cF-3: FAIL esperado ante error genuino: $cF3"
fi
if ! grep -Eq '^(docker rm -f|docker (volume|network) rm )' "$CALLS"; then
  ok "cF-3: cero mutaciones ante error de daemon"
else
  bad "cF-3: se mutó docker ante error de daemon"
fi

# cF-4: cleanup con el volumen registrado YA ausente (ambos formatos):
#       continúa removiendo/verificando owned (containers + network), el
#       volumen ausente se verifica como tal sin error y el stack preexistente
#       queda intacto (mismos full IDs; volumen/network preexistentes).
printf '[cF-4] cleanup continúa con volumen propio ausente (clásico + daemon), preexistente intacto\n'
for style in classic daemon; do
  reset_world
  seed_backend_stack
  SNAP_F4="$TMP/state-f4-$style.json"
  PATH="$BIN:$PATH" "$REAL_NODE" "$HELPER" --snapshot --project-id "$E_PID" --state-file "$SNAP_F4" >/dev/null 2>&1 \
    || bad "cF-4/$style: snapshot previo falló"
  "$WORLD_CTL" create-container "supabase_db_$E_PID" "$(sid db-$E_PID)" true "com.supabase.cli.project=$E_PID"
  "$WORLD_CTL" create-container "supabase_api_$E_PID" "$(sid api-$E_PID)" true "com.supabase.cli.project=$E_PID"
  "$WORLD_CTL" create-container "supabase_auth_$E_PID" "$(sid auth-$E_PID)" true "com.supabase.cli.project=$E_PID"
  "$WORLD_CTL" create-volume "supabase_db_$E_PID" "com.supabase.cli.project=$E_PID"
  "$WORLD_CTL" create-network "supabase_network_$E_PID" "com.supabase.cli.project=$E_PID"
  PATH="$BIN:$PATH" "$REAL_NODE" "$HELPER" --record --state-file "$SNAP_F4" >/dev/null 2>&1 \
    || bad "cF-4/$style: record falló"
  # El volumen propio desaparece entre record y cleanup (estado docker real):
  # `docker volume ls` ya no lo lista y el inspect devuelve el mensaje de
  # volumen ausente del estilo en prueba.
  "$WORLD_CTL" rm-volume "supabase_db_$E_PID"
  : >"$CALLS"
  set +e
  cF4="$(VOL_ABSENT_STYLE="$style" PATH="$BIN:$PATH" "$REAL_NODE" "$HELPER" --cleanup --state-file "$SNAP_F4" 2>&1)"
  set -e
  if [ "$(jq -r '.ok // "false"' <<<"$cF4")" = "true" ]; then
    ok "cF-4/$style: cleanup OK — volumen ausente verificado, cleanup continúa"
  else
    bad "cF-4/$style: cleanup debió continuar: $cF4"
  fi
  if zero_own "$E_PID"; then
    ok "cF-4/$style: zero own tras cleanup (containers/volumes/network propios en cero)"
  else
    bad "cF-4/$style: residuo propio tras cleanup"
  fi
  if [ "$(con_full_id supabase_db_backend)" = "$(sid backend-db)" ] \
    && [ "$(con_full_id supabase_auth_backend)" = "$(sid backend-auth)" ] \
    && "$WORLD_CTL" ls-vol "com.supabase.cli.project" "backend" | grep -q "^supabase_db_backend$" \
    && "$WORLD_CTL" ls-net "com.supabase.cli.project" "backend" | grep -q "^supabase_network_backend$"; then
    ok "cF-4/$style: preexistente intacto (mismos full IDs; volumen/network preexistentes)"
  else
    bad "cF-4/$style: preexistente alterado tras cleanup con volumen ausente"
  fi
  if [ "$(con_full_id "supabase_db_$E_PID" 2>/dev/null || true)" = "" ] \
    && [ "$(con_full_id "supabase_api_$E_PID" 2>/dev/null || true)" = "" ] \
    && [ "$(con_full_id "supabase_auth_$E_PID" 2>/dev/null || true)" = "" ]; then
    ok "cF-4/$style: containers propios eliminados pese al volumen ausente"
  else
    bad "cF-4/$style: containers propios no eliminados"
  fi
  if ! "$WORLD_CTL" ls-net "com.supabase.cli.project" "$E_PID" | grep -q .; then
    ok "cF-4/$style: network propia eliminada pese al volumen ausente"
  else
    bad "cF-4/$style: network propia no eliminada"
  fi
done

printf '== resultado: %d checks, %d fallas ==\n' "$CHECKS" "$FAILS"
[ "$FAILS" -eq 0 ]