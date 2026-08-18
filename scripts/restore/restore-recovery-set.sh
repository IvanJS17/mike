#!/usr/bin/env bash
# Restore one complete recovery set into a disposable Compose project.
# It never targets the live project and never runs `down -v`.
set -Eeuo pipefail
umask 077
started_epoch=$(date -u +%s)
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
base_compose="$repo_root/compose.prod.yml"
restore_override="$repo_root/infra/production/compose.restore.yml"

: "${RECOVERY_SET_PATH:?set RECOVERY_SET_PATH to the age-encrypted recovery archive}"
: "${RECOVERY_SUCCESS_PATH:?set RECOVERY_SUCCESS_PATH to the separately downloaded SUCCESS.json}"
: "${AGE_IDENTITY_FILE:?set AGE_IDENTITY_FILE to the Socium-custodied age identity}"
: "${RESTORE_ROOT:?set RESTORE_ROOT to an isolated disposable-host path}"
: "${RESTORE_COMPOSE_FILE:?set RESTORE_COMPOSE_FILE to compose.restore.yml}"
: "${RESTORE_ENV_FILE:?set RESTORE_ENV_FILE to RESTORE_ROOT/compose.env}"
: "${RESTORE_PROJECT_NAME:?set RESTORE_PROJECT_NAME to litt-restore-*}"
: "${RESTORE_FAILURE_AT:?set RESTORE_FAILURE_AT to the declared failure timestamp}"
: "${RESTORE_OBJECT_ENDPOINT:?set RESTORE_OBJECT_ENDPOINT to the disposable object endpoint}"
: "${RESTORE_OBJECT_BUCKET:?set RESTORE_OBJECT_BUCKET to a litt-restore-* bucket}"
: "${RESTORE_OBJECT_ACCESS_KEY_ID:?set RESTORE_OBJECT_ACCESS_KEY_ID to the disposable credential}"
: "${RESTORE_OBJECT_SECRET_ACCESS_KEY:?set RESTORE_OBJECT_SECRET_ACCESS_KEY to the disposable credential}"
: "${RESTORE_OBJECT_SSE_CUSTOMER_KEY_FILE:?set RESTORE_OBJECT_SSE_CUSTOMER_KEY_FILE to the mode-600 disposable SSE-C key}"
: "${RESTORE_EXPECTED_COUNTS_FILE:?set RESTORE_EXPECTED_COUNTS_FILE to the mandatory qualification counts}"
: "${RESTORE_DESIGNATED_USERS_FILE:?set RESTORE_DESIGNATED_USERS_FILE to the two-user mode-600 fixture}"
: "${RESTORE_PUBLIC_BASE_URL:?set RESTORE_PUBLIC_BASE_URL to the disposable HTTPS URL}"
: "${RESTORE_PUBLIC_ALLOWED_HOST:?set RESTORE_PUBLIC_ALLOWED_HOST to the disposable host}"
: "${RESTORE_TARGET_ID:?set RESTORE_TARGET_ID to the versioned disposable target}"
: "${RESTORE_DOCKER_CONTEXT:?set RESTORE_DOCKER_CONTEXT to the isolated litt-restore-* Docker context}"
: "${RESTORE_OBJECT_ALLOWED_HOST:?set RESTORE_OBJECT_ALLOWED_HOST to the disposable object host}"
: "${RESTORE_AUTHENTICATED_PATH:?set RESTORE_AUTHENTICATED_PATH to the protected disposable route}"
: "${RESTORE_CA_CERT_FILE:?set RESTORE_CA_CERT_FILE to the disposable TLS CA certificate}"
: "${RESTORE_CA_CERT_SHA256:?set RESTORE_CA_CERT_SHA256 to the target-bound CA fingerprint}"

target_manifest="$repo_root/infra/production/disposable-targets.json"
jq -e --arg id "$RESTORE_TARGET_ID" --arg root "/srv/litt-restore" --arg context "$RESTORE_DOCKER_CONTEXT" --arg project "$RESTORE_PROJECT_NAME" --arg bucket "$RESTORE_OBJECT_BUCKET" --arg auth "$RESTORE_AUTHENTICATED_PATH" --arg ca "$RESTORE_CA_CERT_SHA256" --arg public "$RESTORE_PUBLIC_BASE_URL" --arg public_host "$RESTORE_PUBLIC_ALLOWED_HOST" --arg object "$RESTORE_OBJECT_ENDPOINT" --arg object_host "$RESTORE_OBJECT_ALLOWED_HOST" \
  '(.restore.target_id == $id) and (.restore.root == $root) and (.restore.docker_context == $context) and (.restore.project == $project) and (.restore.bucket == $bucket) and (.restore.authenticated_path == $auth) and (.restore.ca_sha256 == $ca) and (.restore.public_base_url == $public) and (.restore.public_host == $public_host) and (.restore.object_endpoint == $object) and (.restore.object_host == $object_host)' "$target_manifest" >/dev/null || { printf 'Restore target is not the versioned disposable target.\n' >&2; exit 1; }
restore_root_real=$(realpath -e "$RESTORE_ROOT")
[[ "$restore_root_real" == "/srv/litt-restore" && ! -L "$RESTORE_ROOT" ]] || { printf 'Restore root is not the versioned disposable root.\n' >&2; exit 1; }
[[ "$RESTORE_PUBLIC_BASE_URL" =~ ^https:// ]] || { printf 'Restore public URL must use HTTPS.\n' >&2; exit 1; }
public_host=${RESTORE_PUBLIC_BASE_URL#https://}; public_host=${public_host%%/*}
object_host=${RESTORE_OBJECT_ENDPOINT#https://}; object_host=${object_host%%/*}
[[ "$public_host" == "$RESTORE_PUBLIC_ALLOWED_HOST" ]] || { printf 'Restore public host is not approved.\n' >&2; exit 1; }
[[ "$object_host" == "$RESTORE_OBJECT_ALLOWED_HOST" && "$RESTORE_OBJECT_ENDPOINT" =~ ^https:// ]] || { printf 'Restore object endpoint is not the approved HTTPS target.\n' >&2; exit 1; }
[[ "$public_host" != localhost && "$public_host" != 127.0.0.1 && "$public_host" != *production* && "$public_host" != *prod* ]] || { printf 'Restore public target resembles a live/local host.\n' >&2; exit 1; }
[[ "$object_host" != localhost && "$object_host" != 127.0.0.1 && "$object_host" != *production* && "$object_host" != *prod* ]] || { printf 'Restore object target resembles a live/local host.\n' >&2; exit 1; }
[[ "$RESTORE_DOCKER_CONTEXT" =~ ^litt-restore-[a-z0-9-]+$ ]] || { printf 'Restore Docker context is not disposable.\n' >&2; exit 1; }
auth_path_pattern='^/api/[A-Za-z0-9._/?=&-]+$'
[[ "$RESTORE_AUTHENTICATED_PATH" =~ $auth_path_pattern && "$RESTORE_AUTHENTICATED_PATH" != *..* ]] || { printf 'Restore authenticated route is unsafe.\n' >&2; exit 1; }
[[ "$(docker context show)" == "$RESTORE_DOCKER_CONTEXT" ]] || { printf 'Restore is not running on its isolated Docker context.\n' >&2; exit 1; }

[[ "$(realpath -e "$RESTORE_COMPOSE_FILE")" == "$restore_override" ]] || { printf 'Restore must use the reviewed compose.restore.yml.\n' >&2; exit 1; }
[[ "$(realpath -e "$RESTORE_ENV_FILE")" == "$restore_root_real/compose.env" ]] || { printf 'Restore env must be inside RESTORE_ROOT.\n' >&2; exit 1; }
[[ "$RESTORE_PROJECT_NAME" =~ ^litt-restore-[a-z0-9-]{1,40}$ ]] || { printf 'Restore project is not disposable.\n' >&2; exit 1; }
[[ "$RESTORE_OBJECT_BUCKET" =~ ^litt-restore-[a-z0-9-]{1,50}$ ]] || { printf 'Restore bucket is not disposable.\n' >&2; exit 1; }
[[ -f "$RESTORE_CA_CERT_FILE" && ! -L "$RESTORE_CA_CERT_FILE" && "$(stat -c '%a' "$RESTORE_CA_CERT_FILE")" =~ ^(600|644)$ ]] || { printf 'Restore TLS CA certificate must be regular mode 600 or 644.\n' >&2; exit 1; }
[[ "$(sha256sum "$RESTORE_CA_CERT_FILE" | cut -d' ' -f1)" == "$RESTORE_CA_CERT_SHA256" ]] || { printf 'Restore TLS CA fingerprint does not match target.\n' >&2; exit 1; }
for secret_file in "$AGE_IDENTITY_FILE" "$RESTORE_ENV_FILE" "$RESTORE_OBJECT_SSE_CUSTOMER_KEY_FILE" "$RESTORE_DESIGNATED_USERS_FILE"; do
  [[ -f "$secret_file" && ! -L "$secret_file" && "$(stat -c '%a' "$secret_file")" == "600" ]] || { printf 'Restore secret fixture must be regular mode 600.\n' >&2; exit 1; }
done
restore_data_root=$(awk -F= '$1 == "LITT_DATA_ROOT" {print substr($0, index($0,"=")+1); exit}' "$RESTORE_ENV_FILE")
restore_secrets_root=$(awk -F= '$1 == "LITT_SECRETS_ROOT" {print substr($0, index($0,"=")+1); exit}' "$RESTORE_ENV_FILE")
[[ -n "$restore_data_root" && -n "$restore_secrets_root" ]] || { printf 'Restore env must define data and secret roots.\n' >&2; exit 1; }
restore_data_real=$(realpath -m "$restore_data_root")
restore_secrets_real=$(realpath -m "$restore_secrets_root")
[[ "$restore_data_real" == "$restore_root_real"/* && "$restore_secrets_real" == "$restore_root_real"/* ]] || { printf 'Restore data/secrets roots must be inside RESTORE_ROOT.\n' >&2; exit 1; }
[[ -f "$RECOVERY_SET_PATH" && -f "$RECOVERY_SUCCESS_PATH" && -f "$RESTORE_EXPECTED_COUNTS_FILE" ]] || { printf 'Recovery input is incomplete.\n' >&2; exit 1; }
jq -e '
  length >= 10
  and any(.[]; .table == "user_profiles" and .count >= 4)
  and any(.[]; .table == "workspaces" and .count >= 2)
  and any(.[]; .table == "matters" and .count >= 6)
  and any(.[]; .table == "documents" and .count >= 100)
  and (map(.table) as $tables | ["workspace_memberships","matter_memberships","chats","workflows","document_versions","audit_events"] as $required | all($required[]; . as $name | ($tables | index($name)) != null))
' "$RESTORE_EXPECTED_COUNTS_FILE" >/dev/null || { printf 'Restore qualification counts do not meet the mandatory dataset minimum.\n' >&2; exit 1; }

runtime_dir=""
compose_started=0
object_mutated=0
cleanup() {
  local status=$?
  if (( compose_started == 1 )); then
    "${compose[@]}" down --remove-orphans >/dev/null 2>&1 || status=1
    [[ -z "$("${docker_prefix[@]}" ps -aq --filter "label=com.docker.compose.project=$RESTORE_PROJECT_NAME")" ]] || status=1
  fi
  if (( object_mutated == 1 )); then
    bucket_cleanup || status=1
  fi
  [[ -z "$runtime_dir" ]] || rm -rf "$runtime_dir"
  trap - EXIT
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

docker_prefix=(docker --context "$RESTORE_DOCKER_CONTEXT")
compose=("${docker_prefix[@]}" compose --env-file "$RESTORE_ENV_FILE" -f "$base_compose" -f "$restore_override" -p "$RESTORE_PROJECT_NAME")
compose_config=$("${compose[@]}" config --format json)
[[ -z "$("${docker_prefix[@]}" ps -aq --filter "label=com.docker.compose.project=$RESTORE_PROJECT_NAME")" ]] || { printf 'Restore project already exists.\n' >&2; exit 1; }
[[ -z "$("${docker_prefix[@]}" volume ls -q --filter "label=com.docker.compose.project=$RESTORE_PROJECT_NAME")" ]] || { printf 'Restore project has existing volumes.\n' >&2; exit 1; }
while IFS= read -r source; do
  case "$source" in
    "$restore_root_real"/*|"$repo_root"/*) ;;
    *) printf 'Restore Compose source is outside disposable/repository roots.\n' >&2; exit 1 ;;
  esac
done < <(jq -r '.services[].volumes[]?.source // empty' <<<"$compose_config")
[[ -z "$(jq -r '.services[].ports[]? // empty' <<<"$compose_config")" ]] || { printf 'Restore topology must not publish host ports.\n' >&2; exit 1; }

runtime_dir=$(mktemp -d "$restore_root_real/restore.XXXXXX")
archive="$runtime_dir/recovery.tar.gz"
set_dir="$runtime_dir/set"
mkdir -p "$set_dir" "$restore_root_real/restore-receipts"

age --decrypt --identity "$AGE_IDENTITY_FILE" --output "$archive" "$RECOVERY_SET_PATH"
python3 - "$archive" <<'PY'
import sys, tarfile
from pathlib import PurePosixPath
with tarfile.open(sys.argv[1], 'r:gz') as archive:
    seen = set()
    total_size = 0
    allowed_roots = {'postgres.dump', 'postgres.restore.list', 'objects', 'config', 'audit', 'publication', 'release-manifest.json', 'inventory.json', 'SHA256SUMS'}
    for member in archive.getmembers():
        path = PurePosixPath(member.name)
        if path.is_absolute() or '..' in path.parts or member.issym() or member.islnk() or not (member.isdir() or member.isfile()):
            raise SystemExit(f'unsafe archive member: {member.name}')
        canonical_name = "/".join(path.parts)
        raw_name = member.name[:-1] if member.isdir() and member.name.endswith("/") else member.name
        if raw_name != canonical_name:
            raise SystemExit(f'non-canonical archive member: {member.name}')
        if not path.parts or path.parts[0] not in allowed_roots or canonical_name in seen:
            raise SystemExit(f'unallowlisted or duplicate archive member: {member.name}')
        seen.add(canonical_name)
        total_size += member.size
        if total_size > 5 * 1024 * 1024 * 1024:
            raise SystemExit('archive expands beyond the 5 GiB restore bound')
PY
tar -xzf "$archive" --no-same-owner --no-same-permissions -C "$set_dir"
(cd "$set_dir" && sha256sum -c SHA256SUMS)

jq -e '.status == "success"' "$RECOVERY_SUCCESS_PATH" >/dev/null
set_id=$(jq -er '.set_id' "$set_dir/inventory.json")
[[ "$set_id" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || { printf 'Unsafe recovery set ID.\n' >&2; exit 1; }
marker_sha=$(jq -er '.encrypted_sha256' "$RECOVERY_SUCCESS_PATH")
actual_archive_sha=$(sha256sum "$RECOVERY_SET_PATH" | cut -d' ' -f1)
[[ "$marker_sha" == "$actual_archive_sha" ]] || { printf 'Recovery archive checksum does not match SUCCESS marker.\n' >&2; exit 1; }
[[ "$(jq -er '.set_id' "$RECOVERY_SUCCESS_PATH")" == "$set_id" ]] || {
  printf 'Archive and SUCCESS marker refer to different set IDs.\n' >&2
  exit 1
}
release_manifest="$set_dir/release-manifest.json"
release_sha=$(jq -er '.release_sha | select(type == "string" and test("^[0-9a-f]{40}$"))' "$release_manifest")
[[ "$(git -C "$repo_root" rev-parse HEAD)" == "$release_sha" && -z "$(git -C "$repo_root" status --porcelain --untracked-files=all)" ]] || { printf 'Restore checkout is not the archived release.\n' >&2; exit 1; }
restore_caddy_sha=$(sha256sum "$repo_root/infra/production/Caddyfile.restore" | cut -d' ' -f1)
jq -e --arg caddy "$restore_caddy_sha" '.restore_caddy_config_sha256 == $caddy' "$release_manifest" >/dev/null || { printf 'Restore Caddyfile does not match archived release.\n' >&2; exit 1; }
compose_release_config=$("${compose[@]}" config --format json)
jq -e --arg endpoint "$RESTORE_OBJECT_ENDPOINT" --arg bucket "$RESTORE_OBJECT_BUCKET" \
  '(.services.backend.environment.R2_ENDPOINT_URL == $endpoint) and (.services.backend.environment.R2_BUCKET_NAME == $bucket) and (.services.backend.environment.R2_SSE_CUSTOMER_KEY_REQUIRED == "true")' <<<"$compose_release_config" >/dev/null || { printf 'Restore backend storage config is not bound to the disposable target.\n' >&2; exit 1; }
jq -e \
  --arg source "$(jq -er '.services.caddy.environment.SOURCE_OFFER_URL' <<<"$compose_release_config")" \
  --arg backend "$(jq -er '.services.backend.image' <<<"$compose_release_config")" \
  --arg frontend "$(jq -er '.services.frontend.image' <<<"$compose_release_config")" \
  --arg caddy "$(jq -er '.services.caddy.image' <<<"$compose_release_config")" \
  --arg db "$(jq -er '.services.db.image' <<<"$compose_release_config")" \
  --arg auth "$(jq -er '.services.auth.image' <<<"$compose_release_config")" \
  --arg rest "$(jq -er '.services.rest.image' <<<"$compose_release_config")" \
  '(.source_offer == $source) and (.images.backend == $backend) and (.images.frontend == $frontend) and (.images.caddy == $caddy) and (.images.postgres == $db) and (.images.auth == $auth) and (.images.rest == $rest)' "$release_manifest" >/dev/null || { printf 'Restore Compose images/source do not match archived release.\n' >&2; exit 1; }
created_at=$(jq -er '.created_at' "$set_dir/inventory.json")
created_epoch=$(date -u -d "$created_at" +%s)
failure_epoch=$(date -u -d "$RESTORE_FAILURE_AT" +%s)
rpo_seconds=$((failure_epoch - created_epoch))
if (( rpo_seconds < 0 || rpo_seconds > 86400 )); then
  printf 'RPO objective failed: %s seconds.\n' "$rpo_seconds" >&2
  exit 1
fi

# Keep the validated base+override Compose array for every lifecycle operation.
compose_started=1
"${compose[@]}" up -d db
for attempt in $(seq 1 60); do
  if "${compose[@]}" exec -T db pg_isready -U postgres -d postgres >/dev/null 2>&1; then
    break
  fi
  [[ "$attempt" == 60 ]] && { printf 'Disposable PostgreSQL did not become ready.\n' >&2; exit 1; }
  sleep 2
done

"${compose[@]}" exec -T db pg_restore \
  --clean --if-exists --no-owner --no-acl \
  --username "${PGUSER:-postgres}" --dbname "${PGDATABASE:-postgres}" \
  <"$set_dir/postgres.dump"
"${compose[@]}" up -d caddy auth rest backend frontend
jq -e 'length == 2 and ([.[].id] | unique | length == 2) and ([.[].email] | unique | length == 2) and all(.[]; .id | test("^[A-Za-z0-9._-]+$"))' "$RESTORE_DESIGNATED_USERS_FILE" >/dev/null || { printf 'Exactly two distinct safe designated restore users are required.\n' >&2; exit 1; }
while IFS= read -r user_record; do
  user_payload=$(jq -c '{email,password}' <<<"$user_record")
  auth_response=$(printf '%s' "$user_payload" | curl --silent --show-error --fail --cacert "$RESTORE_CA_CERT_FILE" \
    -H 'Content-Type: application/json' --data-binary @- \
    "$RESTORE_PUBLIC_BASE_URL/supabase/auth/v1/token?grant_type=password")
  access_token=$(jq -er '.access_token | select(type == "string" and length > 0)' <<<"$auth_response")
  curl --silent --show-error --fail --cacert "$RESTORE_CA_CERT_FILE" \
    --config <( {
      printf 'header = "Authorization: '
      printf 'Bear'
      printf 'er '
      printf '%s' "$access_token"
      printf '"\n'
    } ) \
    "$RESTORE_PUBLIC_BASE_URL$RESTORE_AUTHENTICATED_PATH" >/dev/null
done < <(jq -c '.[]' "$RESTORE_DESIGNATED_USERS_FILE")

restore_aws() {
  AWS_ACCESS_KEY_ID="$RESTORE_OBJECT_ACCESS_KEY_ID" \
  AWS_SECRET_ACCESS_KEY="$RESTORE_OBJECT_SECRET_ACCESS_KEY" \
  AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}" \
    aws --endpoint-url "$RESTORE_OBJECT_ENDPOINT" "$@"
}
bucket_cleanup() {
  local key_marker="" version_marker="" listing truncated next_key next_version
  while :; do
    args=(s3api list-object-versions --bucket "$RESTORE_OBJECT_BUCKET" --output json)
    [[ -n "$key_marker" ]] && args+=(--key-marker "$key_marker")
    [[ -n "$version_marker" ]] && args+=(--version-id-marker "$version_marker")
    listing=$(restore_aws "${args[@]}")
    while IFS= read -r version; do
      restore_aws s3api delete-object --bucket "$RESTORE_OBJECT_BUCKET" --key "$(jq -r '.Key' <<<"$version")" --version-id "$(jq -r '.VersionId' <<<"$version")" >/dev/null
    done < <(jq -c '.Versions[]?' <<<"$listing")
    while IFS= read -r marker; do
      restore_aws s3api delete-object --bucket "$RESTORE_OBJECT_BUCKET" --key "$(jq -r '.Key' <<<"$marker")" --version-id "$(jq -r '.VersionId' <<<"$marker")" >/dev/null
    done < <(jq -c '.DeleteMarkers[]?' <<<"$listing")
    truncated=$(jq -er 'if has("IsTruncated") and (.IsTruncated | type == "boolean") then .IsTruncated else error("missing boolean IsTruncated") end' <<<"$listing")
    [[ "$truncated" == "true" ]] || break
    next_key=$(jq -er '.NextKeyMarker | select(type == "string" and length > 0)' <<<"$listing")
    next_version=$(jq -er '.NextVersionIdMarker | select(type == "string" and length > 0)' <<<"$listing")
    [[ "$next_key" != "$key_marker" || "$next_version" != "$version_marker" ]] || return 1
    key_marker="$next_key"
    version_marker="$next_version"
  done
  residue=$(restore_aws s3api list-object-versions --bucket "$RESTORE_OBJECT_BUCKET" --output json)
  [[ "$(jq '[.Versions[]?, .DeleteMarkers[]?] | length' <<<"$residue")" == "0" ]]
}
versioning=$(restore_aws s3api get-bucket-versioning --bucket "$RESTORE_OBJECT_BUCKET" --output json)
[[ "$(jq -r '.Status // empty' <<<"$versioning")" == "Enabled" ]] || { printf 'Restore bucket versioning is not enabled.\n' >&2; exit 1; }
initial_objects=$(restore_aws s3api list-object-versions --bucket "$RESTORE_OBJECT_BUCKET" --output json)
[[ "$(jq '[.Versions[]?, .DeleteMarkers[]?] | length' <<<"$initial_objects")" == "0" ]] || { printf 'Restore bucket must be empty before mutation.\n' >&2; exit 1; }

: >"$runtime_dir/object-restore-map.ndjson"
while IFS= read -r record; do
  kind=$(jq -er '.kind' <<<"$record")
  key=$(jq -er '.key' <<<"$record")
  if [[ "$kind" == "version" ]]; then
    file=$(jq -er '.file' <<<"$record")
    [[ "$file" =~ ^[0-9a-f]{64}\.object$ ]] || { printf 'Unsafe object member name.\n' >&2; exit 1; }
    source_path="$set_dir/objects/data/$file"
    [[ -f "$source_path" ]] || { printf 'Missing object payload: %s\n' "$file" >&2; exit 1; }
    expected_sha=$(jq -er '.sha256' <<<"$record")
    actual_sha=$(sha256sum "$source_path" | cut -d' ' -f1)
    [[ "$expected_sha" == "$actual_sha" ]] || { printf 'Object checksum mismatch: %s\n' "$key" >&2; exit 1; }
    object_mutated=1
    result=$(restore_aws s3api put-object --bucket "$RESTORE_OBJECT_BUCKET" --key "$key" --body "$source_path" \
      --sse-customer-algorithm AES256 --sse-customer-key "fileb://$RESTORE_OBJECT_SSE_CUSTOMER_KEY_FILE")
    restored_version=$(jq -er '.VersionId | select(type == "string" and length > 0)' <<<"$result")
    jq -cn --arg key "$key" --arg source_version "$(jq -r '.version_id' <<<"$record")" \
      --arg restored_version "$restored_version" --arg sha256 "$actual_sha" --arg file "$file" \
      '{kind:"version",key:$key,source_version_id:$source_version,restored_version_id:$restored_version,sha256:$sha256,file:$file}' \
      >>"$runtime_dir/object-restore-map.ndjson"
  else
    object_mutated=1
    result=$(restore_aws s3api delete-object --bucket "$RESTORE_OBJECT_BUCKET" --key "$key")
    restored_marker=$(jq -er '.VersionId | select(type == "string" and length > 0)' <<<"$result")
    jq -cn --arg key "$key" --arg source_version "$(jq -r '.version_id' <<<"$record")" \
      --arg restored_version "$restored_marker" \
      '{kind:"delete_marker",key:$key,source_version_id:$source_version,restored_version_id:$restored_version}' \
      >>"$runtime_dir/object-restore-map.ndjson"
  fi
done < <(jq -c -s 'sort_by(.key, .last_modified)[]' "$set_dir/objects/index.ndjson")

expected_objects=$(jq -s '[.[] | select(.kind == "version")] | length' "$set_dir/objects/index.ndjson")
expected_markers=$(jq -s '[.[] | select(.kind == "delete_marker")] | length' "$set_dir/objects/index.ndjson")
restored_objects=$(jq -s '[.[] | select(.kind == "version")] | length' "$runtime_dir/object-restore-map.ndjson")
restored_markers=$(jq -s '[.[] | select(.kind == "delete_marker")] | length' "$runtime_dir/object-restore-map.ndjson")
[[ "$expected_objects" == "$restored_objects" && "$expected_markers" == "$restored_markers" ]] || { printf 'Object/version marker count mismatch.\n' >&2; exit 1; }

# Readiness is checked from inside the restored backend network, not by trusting
# a process status. The endpoint must report DB, storage, and Auth checks green.
"${compose[@]}" exec -T backend node -e '
fetch("http://127.0.0.1:3001/ready").then(async (r) => {
  const body = await r.json();
  if (!r.ok || body.ok !== true) { console.error(JSON.stringify(body)); process.exit(1); }
}).catch((error) => { console.error(error.message); process.exit(1); });
'

while IFS= read -r row; do
  table=$(jq -er '.table' <<<"$row")
  expected=$(jq -er '.count' <<<"$row")
  [[ "$table" =~ ^[a-z_][a-z0-9_]*$ ]] || { printf 'Unsafe restore count table.\n' >&2; exit 1; }
  actual=$("${compose[@]}" exec -T db psql -At -U "${PGUSER:-postgres}" -d "${PGDATABASE:-postgres}" -c "select count(*) from public.\"$table\"" | tr -d '[:space:]')
  [[ "$actual" == "$expected" ]] || { printf 'Count mismatch for %s.\n' "$table" >&2; exit 1; }
done < <(jq -c '.[]' "$RESTORE_EXPECTED_COUNTS_FILE")

finished_epoch=$(date -u +%s)
rto_seconds=$((finished_epoch - started_epoch))
if (( rto_seconds > 14400 )); then
  printf 'RTO objective failed: %s seconds.\n' "$rto_seconds" >&2
  exit 1
fi
if (( object_mutated == 1 )); then
  bucket_cleanup
  object_mutated=0
fi
if (( compose_started == 1 )); then
  "${compose[@]}" down --remove-orphans >/dev/null
  [[ -z "$("${docker_prefix[@]}" ps -aq --filter "label=com.docker.compose.project=$RESTORE_PROJECT_NAME")" ]]
  compose_started=0
fi
receipt="$RESTORE_ROOT/restore-receipts/$set_id-$(date -u +%Y%m%dT%H%M%SZ).json"
release_sha=$(jq -er '.release_sha' "$release_manifest")
migration_version=$(jq -er '.migration_version' "$release_manifest")
jq -n \
  --arg set_id "$set_id" \
  --arg release_sha "$release_sha" \
  --arg migration_version "$migration_version" \
  --arg restored_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg project "$RESTORE_PROJECT_NAME" \
  --argjson rpo_seconds "$rpo_seconds" \
  --argjson rto_seconds "$rto_seconds" \
  --argjson object_count "$restored_objects" \
  --argjson marker_count "$restored_markers" \
  '{status:"success",set_id:$set_id,release_sha:$release_sha,migration_version:$migration_version,restored_at:$restored_at,disposable_project:$project,rpo_seconds:$rpo_seconds,rto_seconds:$rto_seconds,restored_object_count:$object_count,restored_delete_marker_count:$marker_count,readiness:"green",secrets_included:false}' \
  >"$receipt"
chmod 0600 "$receipt"
printf 'Restore completed on disposable project %s: RPO=%ss RTO=%ss.\n' "$RESTORE_PROJECT_NAME" "$rpo_seconds" "$rto_seconds"
