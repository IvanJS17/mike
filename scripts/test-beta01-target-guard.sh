#!/usr/bin/env bash
#
# Contractual test for the local-only target guard (Gate 1, fix 1).
#
# Demonstrates, WITHOUT raising the stack:
#   1. hostile URLs/keys injected via env are rejected with non-zero exit;
#   2. ZERO HTTP requests are made (guard is pure validation);
#   3. the secret value is NEVER printed to stdout/stderr;
#   4. a happy local config (loopback + demo keys) is still accepted.
#
# Usage: bash scripts/test-beta01-target-guard.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GUARD="$ROOT/e2e/support/beta01-target-guard.cjs"
TMP="$(mktemp -d /tmp/beta01-target-guard.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

# A hostile-but-plausible setup: remote Supabase project, hosted API and R2.
HOSTILE_SUPABASE_URL="https://prjref.supabase.co"
HOSTILE_API_BASE="https://api.remote-host.invalid"
HOSTILE_R2_ENDPOINT="https://accountid.r2.cloudflarestorage.com"

# Forged/ demo JWTs are built at RUNTIME, never committed as literals: the
# gitleaks `jwt` rule flags header.payload.signature strings in the repo.
# Semantics stay identical (iss/role decide accept/reject; signatures are
# never verified by the guard).
jwt_for() { # role issuer
  node -e '
    const [role, iss] = process.argv.slice(1);
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const header = enc({ alg: "HS256", typ: "JWT" });
    const payload = enc({ iss, role, exp: 1983812996 });
    process.stdout.write(header + "." + payload + ".sig-" + role);
  ' "$1" "$2"
}
HOSTILE_SERVICE_KEY="$(jwt_for service_role supabase)"
HOSTILE_ANON_KEY="$(jwt_for anon supabase)"
# A happy local config: loopback URLs + Supabase CLI demo keys (iss=supabase-demo).
LOCAL_SUPABASE_URL="http://127.0.0.1:54321"
LOCAL_SERVICE_KEY="$(jwt_for service_role supabase-demo)"
LOCAL_ANON_KEY="$(jwt_for anon supabase-demo)"
LOCAL_API_BASE="http://localhost:3001"
LOCAL_R2_ENDPOINT="http://localhost:9000"

# ---------------------------------------------------------------------------
# fetch spy: preloaded into the node process via NODE_OPTIONS. Any HTTP
# request would touch globalThis.fetch; the spy records it and fails hard.
# ---------------------------------------------------------------------------
SPY_FILE="$TMP/fetch-spy.cjs"
SPY_MARKER="$TMP/fetch-called"
cat >"$SPY_FILE" <<'SPY'
const fs = require("node:fs");
const marker = process.env.BETA01_FETCH_SPY_MARKER;
globalThis.fetch = async function spyFetch() {
  fs.writeFileSync(marker, "fetch was called\n");
  throw new Error("target-guard must never perform HTTP requests");
};
SPY
export BETA01_FETCH_SPY_MARKER="$SPY_MARKER"
export NODE_OPTIONS="--require=$SPY_FILE"

# ---------------------------------------------------------------------------
# Case 1: hostile URLs/keys must be rejected (non-zero exit, no secret printed)
# ---------------------------------------------------------------------------
hostile_output="$TMP/hostile.out"
hostile_err="$TMP/hostile.err"
set +e
(
  export SUPABASE_URL="$HOSTILE_SUPABASE_URL" \
    SUPABASE_SECRET_KEY="$HOSTILE_SERVICE_KEY" \
    SUPABASE_ANON_KEY="$HOSTILE_ANON_KEY" \
    MIKE_API_BASE_URL="$HOSTILE_API_BASE" \
    R2_ENDPOINT_URL="$HOSTILE_R2_ENDPOINT" \
    R2_ACCESS_KEY_ID="hostile" \
    R2_SECRET_ACCESS_KEY="hostile"
  node "$GUARD"
) >"$hostile_output" 2>"$hostile_err"
HOSTILE_RC=$?
set -e

[ "$HOSTILE_RC" -ne 0 ] || {
  cat "$hostile_output" "$hostile_err"
  echo "FAIL: hostile config was NOT rejected (exit 0)"
  exit 1
}
if [ -f "$SPY_MARKER" ]; then
  echo "FAIL: hostile run performed HTTP requests"
  cat "$SPY_MARKER"
  exit 1
fi
if grep -qF "$HOSTILE_SERVICE_KEY" "$hostile_output" "$hostile_err" 2>/dev/null; then
  echo "FAIL: hostile secret was printed"
  exit 1
fi
echo "PASS hostile: exit=$HOSTILE_RC, zero HTTP requests, secret not printed"
echo "  guard said: $(cat "$hostile_err" "$hostile_output" | head -1)"

# ---------------------------------------------------------------------------
# Case 2: happy local config (loopback + demo keys) must be accepted
# ---------------------------------------------------------------------------
happy_output="$TMP/happy.out"
happy_err="$TMP/happy.err"
set +e
(
  export BETA01_TARGET_GUARD_ENV_ONLY=1 \
    SUPABASE_URL="$LOCAL_SUPABASE_URL" \
    SUPABASE_SECRET_KEY="$LOCAL_SERVICE_KEY" \
    SUPABASE_ANON_KEY="$LOCAL_ANON_KEY" \
    MIKE_API_BASE_URL="$LOCAL_API_BASE" \
    R2_ENDPOINT_URL="$LOCAL_R2_ENDPOINT" \
    R2_ACCESS_KEY_ID="minioadmin" \
    R2_SECRET_ACCESS_KEY="minioadmin" \
    R2_BUCKET_NAME="mike"
  node "$GUARD"
) >"$happy_output" 2>"$happy_err"
HAPPY_RC=$?
set -e

[ "$HAPPY_RC" -eq 0 ] || {
  cat "$happy_output" "$happy_err"
  echo "FAIL: happy local config was rejected (exit $HAPPY_RC)"
  exit 1
}
if [ -f "$SPY_MARKER" ]; then
  echo "FAIL: happy run performed HTTP requests"
  exit 1
fi
echo "PASS happy: exit=0, zero HTTP requests"
echo "  guard said: $(cat "$happy_output" | head -1)"

# ---------------------------------------------------------------------------
# Case 3: an inherited env var that DIFFERS from the locally wired .env must
# be rejected as a conflict (process.env must not override the local harness).
# ---------------------------------------------------------------------------
CONFLICT_SRC=""
if [ -f "$ROOT/backend/.env" ]; then
  CONFLICT_SRC="$ROOT/backend/.env"
elif [ -f "$ROOT/frontend/.env.local" ]; then
  CONFLICT_SRC="$ROOT/frontend/.env.local"
fi
# The conflict case needs the wired local SUPABASE_URL to exist in .env.
if [ -n "$CONFLICT_SRC" ] && ! grep -qE '^SUPABASE_URL=' "$CONFLICT_SRC"; then
  CONFLICT_SRC=""
fi

if [ -n "$CONFLICT_SRC" ]; then
  conflict_output="$TMP/conflict.out"
  conflict_err="$TMP/conflict.err"
  set +e
  (
    # Force an inherited value that cannot match the locally wired URL.
    export BETA01_TARGET_GUARD_ENV_ONLY=0 \
      SUPABASE_URL="http://127.0.0.1:59999" \
      SUPABASE_SECRET_KEY="$LOCAL_SERVICE_KEY" \
      SUPABASE_ANON_KEY="$LOCAL_ANON_KEY"
    node "$GUARD"
  ) >"$conflict_output" 2>"$conflict_err"
  CONFLICT_RC=$?
  set -e
  [ "$CONFLICT_RC" -ne 0 ] || {
    echo "FAIL: inherited env differing from local .env was NOT rejected"
    exit 1
  }
  echo "PASS conflict: exit=$CONFLICT_RC — inherited env differs from local .env"
  echo "  guard said: $(cat "$conflict_err" "$conflict_output" | head -1)"
else
  echo "SKIP conflict: no local .env file present to conflict with"
fi
echo "ALL PASS — target guard contractual test OK"