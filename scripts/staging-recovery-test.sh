#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
RECOVERY="$ROOT/scripts/staging-recovery"
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mike-staging-recovery-test.XXXXXX")"
BACKUP_DIR="$TEST_DIR/backups"
CONTAINER="mike-staging-recovery-test-$$"
PROJECT_LABEL="mike-staging-recovery-test"
POSTGRES_IMAGE='postgres:17-alpine'
POSTGRES_CONTAINER_PORT=5432
POSTGRES_USER='postgres'
POSTGRES_DB='postgres'
PASSWORD="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
POSTGRES_ENV_FILE="$TEST_DIR/postgres.env"
READINESS_TIMEOUT_SECONDS="${STAGING_RECOVERY_TEST_READINESS_TIMEOUT_SECONDS:-120}"
FAILURE_TIMEOUT_SECONDS="${STAGING_RECOVERY_TEST_FAILURE_TIMEOUT_SECONDS:-5}"
CLEANUP_TIMEOUT_SECONDS="${STAGING_RECOVERY_TEST_CLEANUP_TIMEOUT_SECONDS:-10}"
TEST_SUCCESS=0
declare -a CONTAINERS=()

fail() {
  printf 'staging-recovery-test: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local haystack="$1" needle="$2"
  [[ "$haystack" == *"$needle"* ]] || fail "output did not contain '$needle': $haystack"
}

assert_not_contains() {
  local haystack="$1" needle="$2"
  [[ "$haystack" != *"$needle"* ]] || fail "output contained forbidden secret text"
}

require_positive_integer() {
  local name="$1" value="$2"
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || fail "$name must be a positive integer"
}

allocate_port() {
  python3 - <<'PY'
import socket

with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
}

container_ids() {
  docker ps -aq --filter "name=^${1}$"
}

container_snapshot() {
  docker inspect \
    --format '{{.State.Status}}|{{.State.ExitCode}}|{{.State.Error}}' \
    "$1"
}

sanitize_diagnostic() {
  local diagnostic="$1" secret="${2-}"
  if [[ -n "$secret" ]]; then
    diagnostic="${diagnostic//"$secret"/[redacted]}"
  fi
  printf '%s' "$diagnostic"
}

wait_for_postgres() {
  local container="$1" port="$2" password="$3" postgres_user="$4" postgres_db="$5" timeout_seconds="$6"
  local deadline=$((SECONDS + timeout_seconds))
  local snapshot state exit_code state_error diagnostic

  while :; do
    if ! snapshot="$(container_snapshot "$container" 2>/dev/null)" || [[ -z "$snapshot" ]]; then
      fail "PostgreSQL readiness failed: container $container disappeared while waiting"
    fi
    IFS='|' read -r state exit_code state_error <<< "$snapshot"
    state="${state:-unknown}"
    exit_code="${exit_code:-unknown}"
    state_error="${state_error:-none}"
    diagnostic="$(sanitize_diagnostic \
      "container=$container probe_port=$port state=$state exit_code=$exit_code error=$state_error" \
      "$password")"

    case "$state" in
      exited|dead|removing)
        fail "PostgreSQL readiness failed: terminal container state ($diagnostic)"
        ;;
    esac

    if docker exec "$container" \
      pg_isready \
      --port="$port" \
      --username="$postgres_user" \
      --dbname="$postgres_db" >/dev/null 2>&1 &&
      docker exec \
        --env "PGPASSWORD=$password" \
        --env PGCONNECT_TIMEOUT=1 \
        "$container" \
        psql \
        --no-psqlrc \
        --quiet \
        --username="$postgres_user" \
        --dbname="$postgres_db" \
        --command='SELECT 1' >/dev/null 2>&1; then
      return 0
    fi
    if (( SECONDS >= deadline )); then
      fail "PostgreSQL readiness timed out after ${timeout_seconds}s ($diagnostic)"
    fi
    sleep 1
done
}

wait_for_container_absent() {
  local container="$1" deadline="$2"
  local ids

  while :; do
    if ! ids="$(container_ids "$container" 2>/dev/null)"; then
      printf 'staging-recovery-test: unable to inspect cleanup container %s\n' "$container" >&2
      return 1
    fi
    [[ -z "$ids" ]] && return 0
    if (( SECONDS >= deadline )); then
      printf 'staging-recovery-test: cleanup deadline exceeded for container %s\n' "$container" >&2
      return 1
    fi
    sleep 1
done
}

remove_container() {
  local container="$1" ids deadline remaining
  deadline=$((SECONDS + CLEANUP_TIMEOUT_SECONDS))
  if ! ids="$(container_ids "$container" 2>/dev/null)"; then
    printf 'staging-recovery-test: unable to inspect container %s before cleanup\n' "$container" >&2
    return 1
  fi
  if [[ -n "$ids" ]]; then
    remaining=$((deadline - SECONDS))
    if (( remaining > 0 )); then
      timeout --signal=TERM --kill-after=2s "${remaining}s" \
        docker rm -f "$container" >/dev/null 2>&1 || true
    fi
  fi
  wait_for_container_absent "$container" "$deadline"
}

container_is_absent() {
  local ids
  ids="$(container_ids "$1" 2>/dev/null)" || return 1
  [[ -z "$ids" ]]
}

register_container() {
  CONTAINERS+=("$1")
}

cleanup() {
  local current=$?
  local container
  trap - EXIT INT TERM
  set +e

  for container in "${CONTAINERS[@]}"; do
    remove_container "$container" || {
      printf 'staging-recovery-test: cleanup left container %s\n' "$container" >&2
      current=1
    }
  done

  rm -rf -- "$TEST_DIR"
  if [[ -e "$TEST_DIR" ]]; then
    printf 'staging-recovery-test: cleanup left temporary files\n' >&2
    current=1
  fi

  for container in "${CONTAINERS[@]}"; do
    if ! container_is_absent "$container"; then
      printf 'staging-recovery-test: verified container residue %s\n' "$container" >&2
      current=1
    fi
  done
  if [[ -e "$TEST_DIR" ]]; then
    printf 'staging-recovery-test: verified temporary residue %s\n' "$TEST_DIR" >&2
    current=1
  fi

  if (( current == 0 && TEST_SUCCESS )); then
    printf 'staging-recovery-test: PASS (corruption rejected, clean restore verified, cleanup verified)\n'
  fi
  exit "$current"
}
trap cleanup EXIT INT TERM

[[ -x "$RECOVERY" ]] || fail "missing executable recovery CLI: $RECOVERY"
command -v docker >/dev/null 2>&1 || fail 'docker is required'
command -v timeout >/dev/null 2>&1 || fail 'timeout is required'
command -v pg_dump >/dev/null 2>&1 || fail 'pg_dump is required'
command -v pg_restore >/dev/null 2>&1 || fail 'pg_restore is required'
command -v psql >/dev/null 2>&1 || fail 'psql is required'
command -v python3 >/dev/null 2>&1 || fail 'python3 is required'
require_positive_integer STAGING_RECOVERY_TEST_READINESS_TIMEOUT_SECONDS "$READINESS_TIMEOUT_SECONDS"
require_positive_integer STAGING_RECOVERY_TEST_FAILURE_TIMEOUT_SECONDS "$FAILURE_TIMEOUT_SECONDS"
require_positive_integer STAGING_RECOVERY_TEST_CLEANUP_TIMEOUT_SECONDS "$CLEANUP_TIMEOUT_SECONDS"

PORT="$(allocate_port)"

run_readiness_failure_test() {
  local failure_output failure_status failure_elapsed failure_started

  failure_started=$SECONDS
  set +e
  failure_output="$(wait_for_postgres \
    "$CONTAINER" \
    1 \
    "$PASSWORD" \
    "$POSTGRES_USER" \
    "$POSTGRES_DB" \
    "$FAILURE_TIMEOUT_SECONDS" 2>&1)"
  failure_status=$?
  set -e
  failure_elapsed=$((SECONDS - failure_started))

  (( failure_status != 0 )) || fail 'invalid-port readiness failure was accepted'
  (( failure_elapsed <= FAILURE_TIMEOUT_SECONDS + 2 )) ||
    fail "invalid-port failure exceeded readiness deadline: ${failure_elapsed}s"
  assert_contains "$failure_output" 'timed out'
  assert_contains "$failure_output" 'state=running'
  assert_not_contains "$failure_output" "$PASSWORD"
}

mkdir -p "$BACKUP_DIR"
printf 'POSTGRES_PASSWORD=%s\nPOSTGRES_USER=%s\nPOSTGRES_DB=%s\n' \
  "$PASSWORD" "$POSTGRES_USER" "$POSTGRES_DB" > "$POSTGRES_ENV_FILE"
chmod 0600 "$POSTGRES_ENV_FILE"
[[ -z "$(container_ids "$CONTAINER")" ]] ||
  fail "refusing to reuse an existing container name: $CONTAINER"
register_container "$CONTAINER"

docker run --detach \
  --name "$CONTAINER" \
  --label "com.mike.staging.recovery-test=$PROJECT_LABEL" \
  --env-file "$POSTGRES_ENV_FILE" \
  --publish "127.0.0.1:$PORT:$POSTGRES_CONTAINER_PORT" \
  --no-healthcheck \
  "$POSTGRES_IMAGE" >/dev/null

run_readiness_failure_test

export PGHOST=127.0.0.1
export PGPORT="$PORT"
export PGUSER="$POSTGRES_USER"
export PGPASSWORD="$PASSWORD"
export PGDATABASE="$POSTGRES_DB"
export PGCONNECT_TIMEOUT=5

wait_for_postgres \
  "$CONTAINER" \
  "$POSTGRES_CONTAINER_PORT" \
  "$PASSWORD" \
  "$POSTGRES_USER" \
  "$POSTGRES_DB" \
  "$READINESS_TIMEOUT_SECONDS"

psql --no-psqlrc --set ON_ERROR_STOP=1 --dbname="$POSTGRES_DB" <<'SQL'
CREATE DATABASE staging_source;
CREATE DATABASE "recovery-test";
SQL

export PGDATABASE=staging_source
psql --no-psqlrc --set ON_ERROR_STOP=1 <<'SQL'
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE public._mike_staging_bootstrap (
  id boolean PRIMARY KEY CHECK (id IS TRUE),
  mode text NOT NULL CHECK (mode = 'fresh'),
  schema_sha256 text NOT NULL CHECK (schema_sha256 ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public._mike_staging_bootstrap (id, mode, schema_sha256)
VALUES (TRUE, 'fresh', repeat('a', 64));

CREATE TABLE public.matters (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL
);
CREATE TABLE public.documents (
  id uuid PRIMARY KEY,
  status text NOT NULL
);
CREATE TABLE public.document_versions (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL,
  version_number integer NOT NULL,
  content_sha256 text NOT NULL
);
CREATE TABLE public.ai_reviews (
  id uuid PRIMARY KEY,
  matter_id uuid NOT NULL,
  status text NOT NULL
);
CREATE TABLE public.ai_review_drive_publications (
  id uuid PRIMARY KEY,
  matter_id uuid NOT NULL,
  status text NOT NULL,
  sha256 text NOT NULL
);

INSERT INTO public.matters (id, name, status)
VALUES ('00000000-0000-0000-0000-000000000001', 'Synthetic recovery matter', 'open');
INSERT INTO public.documents (id, status)
VALUES ('00000000-0000-0000-0000-000000000002', 'ready');
INSERT INTO public.document_versions (id, document_id, version_number, content_sha256)
VALUES (
  '00000000-0000-0000-0000-000000000003',
  '00000000-0000-0000-0000-000000000002',
  1,
  repeat('b', 64)
);
INSERT INTO public.ai_reviews (id, matter_id, status)
VALUES (
  '00000000-0000-0000-0000-000000000004',
  '00000000-0000-0000-0000-000000000001',
  'approved'
);
INSERT INTO public.ai_review_drive_publications (id, matter_id, status, sha256)
VALUES (
  '00000000-0000-0000-0000-000000000005',
  '00000000-0000-0000-0000-000000000001',
  'published',
  repeat('c', 64)
);
SQL

export STAGING_RECOVERY_SOURCE=staging
set +e
backup_output="$("$RECOVERY" backup --output-dir "$BACKUP_DIR" 2>&1)"
backup_status=$?
set -e
(( backup_status == 0 )) || fail "backup failed: $backup_output"
assert_contains "$backup_output" 'backup: PASS'
assert_not_contains "$backup_output" "$PASSWORD"

mapfile -t dumps < <(printf '%s\n' "$BACKUP_DIR"/*.dump)
(( ${#dumps[@]} == 1 )) || fail "expected one dump, found ${#dumps[@]}"
DUMP="${dumps[0]}"
MANIFEST="$DUMP.manifest.json"
[[ -f "$MANIFEST" ]] || fail "missing manifest: $MANIFEST"
[[ "$(stat -c '%a' "$DUMP")" == 600 ]] || fail 'dump is not mode 0600'
[[ "$(stat -c '%a' "$MANIFEST")" == 600 ]] || fail 'manifest is not mode 0600'
manifest_text="$(<"$MANIFEST")"
assert_not_contains "$manifest_text" "$PASSWORD"

CORRUPTED_DUMP="$TEST_DIR/corrupted.dump"
CORRUPTED_MANIFEST="$CORRUPTED_DUMP.manifest.json"
cp -- "$DUMP" "$CORRUPTED_DUMP"
cp -- "$MANIFEST" "$CORRUPTED_MANIFEST"
chmod 0600 "$CORRUPTED_DUMP" "$CORRUPTED_MANIFEST"
printf 'corruption' >> "$CORRUPTED_DUMP"
python3 - "$CORRUPTED_MANIFEST" "$(basename "$CORRUPTED_DUMP")" <<'PY'
import json
import sys
from pathlib import Path

path, dump_name = sys.argv[1:]
manifest = json.loads(Path(path).read_text(encoding="utf-8"))
manifest["dump_file"] = dump_name
manifest["size_bytes"] = Path(str(path).removesuffix(".manifest.json")).stat().st_size
Path(path).write_text(
    json.dumps(manifest, indent=2, sort_keys=True) + "\n",
    encoding="utf-8",
)
Path(path).chmod(0o600)
PY

export STAGING_RECOVERY_TARGET=recovery-test
export STAGING_RECOVERY_TARGET_EPHEMERAL=true
export PGDATABASE=recovery-test
set +e
corrupt_output="$("$RECOVERY" restore-verify \
  --dump "$CORRUPTED_DUMP" \
  --manifest "$CORRUPTED_MANIFEST" 2>&1)"
corrupt_status=$?
set -e
(( corrupt_status != 0 )) || fail 'corrupted dump was accepted'
assert_contains "$corrupt_output" 'checksum'
assert_not_contains "$corrupt_output" "$PASSWORD"

psql --no-psqlrc --set ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE public.recovery_sentinel (value text NOT NULL);
INSERT INTO public.recovery_sentinel VALUES ('must not be replaced');
SQL
set +e
nonempty_output="$("$RECOVERY" restore-verify \
  --dump "$DUMP" \
  --manifest "$MANIFEST" 2>&1)"
nonempty_status=$?
set -e
(( nonempty_status != 0 )) || fail 'non-empty recovery target was accepted'
assert_contains "$nonempty_output" 'not empty'
assert_not_contains "$nonempty_output" "$PASSWORD"
psql --no-psqlrc --set ON_ERROR_STOP=1 --command='DROP TABLE public.recovery_sentinel'

restore_output="$("$RECOVERY" restore-verify \
  --dump "$DUMP" \
  --manifest "$MANIFEST" 2>&1)"
assert_contains "$restore_output" 'restore-verify: PASS'
assert_not_contains "$restore_output" "$PASSWORD"

for table in _mike_staging_bootstrap matters documents document_versions ai_reviews ai_review_drive_publications; do
  count="$(psql --no-psqlrc --tuples-only --no-align --command="SELECT count(*) FROM public.\"$table\";")"
  [[ "$count" =~ ^[[:space:]]*[1-9][0-9]*[[:space:]]*$ ]] ||
    fail "restored table has no synthetic rows: $table ($count)"
done

TEST_SUCCESS=1
exit 0
