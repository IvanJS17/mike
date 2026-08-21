#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
SMOKE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mike-staging-smoke.XXXXXX")"
ENV_FILE="$SMOKE_DIR/.env.staging"
PORT="$(python3 - <<'PY'
import socket
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
)"
PROJECT="mike-staging-smoke-$$"
PUBLIC_URL="http://localhost:$PORT"

python3 - "$ENV_FILE" "$PORT" "$PUBLIC_URL" "$PROJECT" <<'PY'
import base64
import hashlib
import hmac
import json
import secrets
import sys
import time
from pathlib import Path

path, port, public_url, project = sys.argv[1:]
now = int(time.time())
secret = secrets.token_urlsafe(48)

def encode(value):
    return base64.urlsafe_b64encode(
        json.dumps(value, separators=(",", ":")).encode()
    ).rstrip(b"=").decode()

def jwt(role):
    header = encode({"alg": "HS256", "typ": "JWT"})
    payload = encode({
        "aud": "authenticated",
        "exp": now + 3600,
        "iat": now,
        "iss": "supabase",
        "role": role,
    })
    unsigned = f"{header}.{payload}".encode()
    signature = hmac.new(secret.encode(), unsigned, hashlib.sha256).digest()
    return f"{unsigned.decode()}.{base64.urlsafe_b64encode(signature).rstrip(b'=').decode()}"

values = {
    "STAGING_COMPOSE_PROJECT": project,
    "STAGING_PROXY_PORT": port,
    "STAGING_PUBLIC_URL": public_url,
    "STAGING_DISABLE_SIGNUP": "true",
    "STAGING_POSTGRES_PASSWORD": secrets.token_hex(24),
    "STAGING_JWT_SECRET": secret,
    "STAGING_SUPABASE_ANON_KEY": jwt("anon"),
    "STAGING_SUPABASE_SERVICE_ROLE_KEY": jwt("service_role"),
    "STAGING_DOWNLOAD_SIGNING_SECRET": secrets.token_hex(32),
    "STAGING_USER_API_KEYS_ENCRYPTION_SECRET": secrets.token_hex(32),
}
Path(path).write_text(
    "# synthetic disposable staging smoke values\n"
    + "\n".join(f"{key}={value}" for key, value in values.items())
    + "\n",
    encoding="utf-8",
)
Path(path).chmod(0o600)
PY

export STAGING_ENV_FILE="$ENV_FILE"
export STAGING_COMPOSE_PROJECT="$PROJECT"
# shellcheck source=scripts/staging-common.sh
source "$ROOT/scripts/staging-common.sh"

status=0
cleanup() {
  local current=$? down_status
  trap - EXIT INT TERM
  set +e
  "$ROOT/scripts/staging-down"
  down_status=$?
  if [[ "$down_status" -ne 0 ]]; then
    current="$down_status"
  fi
  if [[ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" 2>/dev/null)" ]]; then
    printf 'staging smoke: cleanup left project containers\n' >&2
    current=1
  fi
  rm -rf "$SMOKE_DIR"
  exit "$current"
}
trap cleanup EXIT INT TERM

"$ROOT/scripts/staging-up" --contract-only
"$ROOT/scripts/staging-up"

health_body="$(curl --fail --silent --show-error --max-time 10 "$PUBLIC_URL/api/health")"
python3 - "$health_body" <<'PY'
import json
import sys
if json.loads(sys.argv[1]) != {"ok": True}:
    raise SystemExit("unexpected backend health payload")
PY
curl --fail --silent --show-error --max-time 10 "$PUBLIC_URL/" >/dev/null
curl --fail --silent --show-error --max-time 10 "$PUBLIC_URL/auth/v1/health" >/dev/null

missing_tables="$(compose exec -T db psql -U postgres -d postgres -Atc "
with required(name) as (
  values
    ('user_profiles'),
    ('documents'),
    ('document_versions'),
    ('workflows'),
    ('tabular_reviews'),
    ('organizations'),
    ('workspaces'),
    ('matters'),
    ('ai_executions'),
    ('ai_reviews'),
    ('ai_review_exports'),
    ('ai_redline_bundles'),
    ('ai_review_drive_publications')
)
select coalesce(string_agg(name, ', ' order by name), '')
  from required
 where to_regclass('public.' || name) is null;
")"
missing_tables="${missing_tables//$'\n'/}"
[[ -z "$missing_tables" ]] || fail "staging smoke is missing current schema tables: $missing_tables"

bootstrap_mode="$(compose exec -T db psql -U postgres -d postgres -Atc \
  "select mode from public._mike_staging_bootstrap where id is true;")"
[[ "$bootstrap_mode" == "fresh" ]] ||
  fail "staging smoke found unexpected bootstrap mode: $bootstrap_mode"

public_relation_count_before="$(compose exec -T db psql -U postgres -d postgres -Atc "
select count(*)
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f');
")"
compose run --rm --no-deps db-init fresh >/dev/null
public_relation_count_after="$(compose exec -T db psql -U postgres -d postgres -Atc "
select count(*)
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f');
")"
[[ "$public_relation_count_after" == "$public_relation_count_before" ]] ||
  fail "staging db-init rerun changed the public relation count"

# No users or business fixtures are created by this smoke; all content is empty
# and synthetic until an explicit future E2E gate creates its own identities.
users="$(compose exec -T db psql -U postgres -d postgres -Atc "select count(*) from auth.users;")"
[[ "$users" == "0" ]] || fail "staging smoke found non-synthetic auth users: $users"

printf 'staging-smoke: PASS (frontend, Auth, API, empty auth DB)\n'
