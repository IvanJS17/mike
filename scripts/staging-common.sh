#!/usr/bin/env bash
set -euo pipefail

STAGING_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
export STAGING_ROOT
STAGING_COMPOSE_FILE="$STAGING_ROOT/compose.staging.yml"
STAGING_ENV_FILE="${STAGING_ENV_FILE:-$STAGING_ROOT/.env.staging}"

fail() {
  printf 'staging: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

if [[ ! -f "$STAGING_COMPOSE_FILE" ]]; then
  fail "missing compose file: $STAGING_COMPOSE_FILE"
fi

if [[ -L "$STAGING_ENV_FILE" || ! -f "$STAGING_ENV_FILE" ]]; then
  fail "missing regular env file: $STAGING_ENV_FILE (copy .env.staging.example first)"
fi

# Read only simple KEY=value lines. Compose performs the full dotenv parsing;
# this helper is intentionally limited to validation of the required contract.
env_value() {
  local key="$1" line
  local override="${!key-}"
  if [[ -n "$override" ]]; then
    printf '%s\n' "$override"
    return 0
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      "$key="*) printf '%s\n' "${line#*=}"; return 0 ;;
    esac
  done < "$STAGING_ENV_FILE"
  return 1
}

STAGING_PROJECT="$(env_value STAGING_COMPOSE_PROJECT || true)"
STAGING_PROJECT="${STAGING_PROJECT:-mike-staging}"
if [[ "$STAGING_PROJECT" != "mike-staging" &&
  ! "$STAGING_PROJECT" =~ ^mike-staging-smoke-[0-9]+$ ]]; then
  fail "STAGING_COMPOSE_PROJECT must be mike-staging or a generated mike-staging-smoke-PID project"
fi

compose() {
  docker compose \
    --project-name "$STAGING_PROJECT" \
    --env-file "$STAGING_ENV_FILE" \
    --file "$STAGING_COMPOSE_FILE" \
    "$@"
}

validate_env() {
  local key value
  local required=(
    STAGING_PROXY_PORT
    STAGING_PUBLIC_URL
    STAGING_POSTGRES_PASSWORD
    STAGING_JWT_SECRET
    STAGING_SUPABASE_ANON_KEY
    STAGING_SUPABASE_SERVICE_ROLE_KEY
    STAGING_DOWNLOAD_SIGNING_SECRET
    STAGING_USER_API_KEYS_ENCRYPTION_SECRET
  )
  for key in "${required[@]}"; do
    value="$(env_value "$key" || true)"
    [[ -n "$value" ]] || fail "$key is required in $STAGING_ENV_FILE"
    case "$value" in
      replace-with-*|your-*|REPLACE_WITH_*|REPLACE_WITH-*|CHANGE_ME*|'<*>' )
        fail "$key still contains an example placeholder"
        ;;
    esac
  done

  local port
  port="$(env_value STAGING_PROXY_PORT)"
  [[ "$port" =~ ^[0-9]+$ ]] || fail "STAGING_PROXY_PORT must be numeric"
  (( port >= 1024 && port <= 65535 )) || fail "STAGING_PROXY_PORT must be between 1024 and 65535"

  local public_url
  public_url="$(env_value STAGING_PUBLIC_URL)"
  [[ "$public_url" == "http://localhost:$port" ]] ||
    fail "STAGING_PUBLIC_URL must equal http://localhost:$port"

  local password
  password="$(env_value STAGING_POSTGRES_PASSWORD)"
  [[ "$password" =~ ^[A-Za-z0-9._~-]{32,}$ ]] ||
    fail "STAGING_POSTGRES_PASSWORD must be at least 32 URL-safe characters"

  local jwt_secret
  jwt_secret="$(env_value STAGING_JWT_SECRET)"
  [[ "${#jwt_secret}" -ge 32 ]] || fail "STAGING_JWT_SECRET must be at least 32 characters"

  [[ "$(env_value STAGING_DISABLE_SIGNUP || true)" != "false" ]] ||
    fail "staging must keep invitation-only signup disabled"
}

assert_contract() {
  local rendered services expected service
  rendered="$(compose config --format json)"
  printf '%s\n' "$rendered" | STAGING_PROJECT="$STAGING_PROJECT" STAGING_ROOT="$STAGING_ROOT" python3 -c '
import json
import os
import sys

doc = json.load(sys.stdin)
services = doc.get("services", {})
expected_owner = os.environ["STAGING_PROJECT"]
expected_root = os.environ["STAGING_ROOT"]
expected = {"auth", "backend", "db", "db-init", "frontend", "proxy", "rest"}
actual = set(services)
if actual != expected:
    raise SystemExit(f"unexpected staging services: {sorted(actual)}")
if services["db-init"].get("command") != ["fresh"]:
    raise SystemExit("staging db-init must invoke the explicit fresh path")
if any("migrations" in str(volume) for volume in services["db-init"].get("volumes", [])):
    raise SystemExit("staging db-init must not mount historical migrations")
for name, service in services.items():
    if service.get("labels", {}).get("com.mike.staging.owner") != expected_owner:
        raise SystemExit(f"staging service is missing its owner label: {name}")
    if service.get("labels", {}).get("com.mike.staging.root") != expected_root:
        raise SystemExit(f"staging service is missing its worktree label: {name}")
    ports = service.get("ports") or []
    if name != "proxy" and ports:
        raise SystemExit(f"non-proxy service publishes host ports: {name}")
    if name == "proxy":
        if len(ports) != 1 or ports[0].get("host_ip") != "127.0.0.1":
            raise SystemExit("proxy must have exactly one loopback-only published port")
        if str(ports[0].get("target")) != "8000":
            raise SystemExit("proxy must publish its port to container port 8000")
    if service.get("restart") not in ("no", "none"):
        raise SystemExit(f"staging service must not restart outside the project: {name}")
networks = doc.get("networks", {})
if networks.get("default", {}).get("internal") is not True:
    raise SystemExit("staging default network must be internal")
if "edge" not in networks or networks["edge"].get("internal") is True:
    raise SystemExit("staging edge network must be non-internal for the loopback proxy")
for name, service in services.items():
    attached = set(service.get("networks") or {})
    expected_networks = {"default", "edge"} if name == "proxy" else {"default"}
    if attached != expected_networks:
        raise SystemExit(
            f"unexpected staging networks for {name}: {sorted(attached)} "
            f"(expected {sorted(expected_networks)})"
        )
for section in ("volumes", "networks"):
    for name, resource in doc.get(section, {}).items():
        if resource.get("labels", {}).get("com.mike.staging.owner") != expected_owner:
            raise SystemExit(f"staging {section[:-1]} is missing its owner label: {name}")
        if resource.get("labels", {}).get("com.mike.staging.root") != expected_root:
            raise SystemExit(f"staging {section[:-1]} is missing its worktree label: {name}")
for forbidden in ("mailpit", "rustfs", "storage", "ollama", "studio", "realtime", "analytics"):
    if forbidden in actual:
        raise SystemExit(f"forbidden local-dev service present: {forbidden}")
for name in ("db", "auth", "rest", "proxy"):
    image = services[name].get("image", "")
    if not image or image.endswith(":latest"):
        raise SystemExit(f"{name} must use a pinned image tag")
' || fail "staging Compose contract failed"
}
