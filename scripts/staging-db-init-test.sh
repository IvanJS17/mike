#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
INIT="$ROOT/scripts/staging-db-init.sh"
COMPOSE="$ROOT/compose.staging.yml"
STAGING_UP="$ROOT/scripts/staging-up"
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mike-staging-db-init-test.XXXXXX")"
trap 'rm -rf "$TEST_DIR"' EXIT

FAKE_BIN="$TEST_DIR/bin"
mkdir -p "$FAKE_BIN"
PSQL_LOG="$TEST_DIR/psql.log"

cat >"$FAKE_BIN/psql" <<'FAKE_PSQL'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >> "${PSQL_LOG:?PSQL_LOG is required}"

if [[ "$*" == *"to_regclass('auth.users')"* ]]; then
  printf '1\n'
elif [[ "$*" == *"select to_regclass('public._mike_staging_bootstrap') is not null"* ]]; then
  case "${STAGING_DB_INIT_TEST_STATE:-empty}" in
    initialized|ambiguous) printf 't\n' ;;
    *) printf 'f\n' ;;
  esac
elif [[ "$*" == *"bool_and"* ]]; then
  printf '%s\n' "${STAGING_DB_INIT_TEST_STATE:-ambiguous}"
elif [[ "$*" == *"from pg_class"* ]]; then
  [[ "${STAGING_DB_INIT_TEST_STATE:-empty}" == "nonempty" ]] && printf '1\n' || printf '0\n'
elif [[ "$*" == *"public._mike_staging_bootstrap"* ]]; then
  printf 'ambiguous\n'
elif [[ "$*" == *"with required(name)"* ]]; then
  printf '\n'
elif [[ "$*" == *"-tAc"* ]]; then
  printf '1\n'
fi
FAKE_PSQL
chmod 0755 "$FAKE_BIN/psql"

cat >"$FAKE_BIN/sha256sum" <<'FAKE_SHA256SUM'
#!/usr/bin/env bash
set -euo pipefail
printf '%064d  %s\n' 0 "${1:?schema path is required}"
FAKE_SHA256SUM
chmod 0755 "$FAKE_BIN/sha256sum"

fail() {
  printf 'staging-db-init-test: %s\n' "$*" >&2
  exit 1
}

assert_failure_contains() {
  local expected="$1"
  shift
  local output status
  set +e
  output="$($@ 2>&1)"
  status=$?
  set -e
  (( status != 0 )) || fail "expected failure: $*"
  [[ "$output" == *"$expected"* ]] ||
    fail "failure did not contain '$expected': $output"
}

run_init() {
  local state="$1"
  : >"$PSQL_LOG"
  STAGING_DB_INIT_TEST_STATE="$state" \
    PATH="$FAKE_BIN:$PATH" \
    PSQL_LOG="$PSQL_LOG" \
    PGUSER=postgres \
    PGDATABASE=postgres \
    "$INIT" fresh
}

assert_failure_contains 'Only supported mode is: fresh' env PATH="$FAKE_BIN:$PATH" PSQL_LOG="$PSQL_LOG" "$INIT"
assert_failure_contains 'Only supported mode is: fresh' env PATH="$FAKE_BIN:$PATH" PSQL_LOG="$PSQL_LOG" "$INIT" upgrade

run_init empty >/dev/null
schema_calls="$(grep -c -- '--file /staging/schema.sql' "$PSQL_LOG")"
[[ "$schema_calls" == 1 ]] || fail "fresh mode loaded schema.sql $schema_calls times"
if grep -qE '/staging/migrations|20260424_01' "$PSQL_LOG"; then
  fail 'fresh mode attempted to execute historical migrations'
fi

after_schema="$(cat "$PSQL_LOG")"
[[ "$after_schema" == *"--file /staging/schema.sql"* ]] || fail 'fresh mode did not load canonical schema.sql'

run_init initialized >/dev/null
if grep -q -- '--file /staging/schema.sql' "$PSQL_LOG"; then
  fail 'initialized rerun reloaded schema.sql'
fi
if grep -qE '/staging/migrations|20260424_01' "$PSQL_LOG"; then
  fail 'initialized rerun attempted to execute historical migrations'
fi

assert_failure_contains 'database is not empty' env \
  STAGING_DB_INIT_TEST_STATE=nonempty \
  PATH="$FAKE_BIN:$PATH" PSQL_LOG="$PSQL_LOG" \
  PGUSER=postgres PGDATABASE=postgres "$INIT" fresh
assert_failure_contains 'database state is ambiguous' env \
  STAGING_DB_INIT_TEST_STATE=ambiguous \
  PATH="$FAKE_BIN:$PATH" PSQL_LOG="$PSQL_LOG" \
  PGUSER=postgres PGDATABASE=postgres "$INIT" fresh

if grep -q 'backend/migrations' "$COMPOSE"; then
  fail 'staging Compose still mounts historical migrations'
fi
grep -qF 'command: ["fresh"]' "$COMPOSE" ||
  fail 'staging Compose does not invoke the explicit fresh path'
grep -qF 'compose ps -aq "$service"' "$STAGING_UP" ||
  fail 'staging-up does not observe the stopped db-init container'

printf 'staging-db-init-test: PASS\n'
