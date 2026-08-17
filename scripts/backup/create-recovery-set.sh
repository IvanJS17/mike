#!/usr/bin/env bash
# Build one complete, encrypted recovery set and publish it to the independent
# backup destination. A SUCCESS marker is written only after every component and
# remote checksum has been verified.
set -Eeuo pipefail
umask 077

: "${COMPOSE_FILE:?set COMPOSE_FILE to the reviewed production Compose file}"
: "${COMPOSE_ENV_FILE:?set COMPOSE_ENV_FILE to the external 0600 Compose env file}"
: "${COMPOSE_PROJECT_NAME:?set COMPOSE_PROJECT_NAME=litt-production}"
: "${LITT_APP_ROOT:?set LITT_APP_ROOT to the deployed production checkout}"
: "${LITT_DATA_ROOT:?set LITT_DATA_ROOT to /srv/litt-data}"
: "${LITT_SECRETS_ROOT:?set LITT_SECRETS_ROOT to /srv/litt-data/secrets}"
: "${OBJECT_ALLOWED_HOST:?set OBJECT_ALLOWED_HOST to the approved object host}"
: "${BACKUP_ALLOWED_HOST:?set BACKUP_ALLOWED_HOST to the approved backup host}"
: "${RECOVERY_ROOT:?set RECOVERY_ROOT on the encrypted volume}"
: "${APP_BUCKET:?set APP_BUCKET to the application object bucket}"
: "${OBJECT_ENDPOINT:?set OBJECT_ENDPOINT to the application storage endpoint}"
: "${OBJECT_ACCESS_KEY_ID:?set OBJECT_ACCESS_KEY_ID independently of the backup account}"
: "${OBJECT_SECRET_ACCESS_KEY:?set OBJECT_SECRET_ACCESS_KEY independently of the backup account}"
: "${OBJECT_SSE_CUSTOMER_KEY_FILE:?set OBJECT_SSE_CUSTOMER_KEY_FILE to the mode-600 SSE-C key file}"
: "${BACKUP_BUCKET:?set BACKUP_BUCKET to the separate recovery destination}"
: "${BACKUP_ENDPOINT:?set BACKUP_ENDPOINT to the separate recovery endpoint}"
: "${BACKUP_ACCESS_KEY_ID:?set BACKUP_ACCESS_KEY_ID to the independent backup credential}"
: "${BACKUP_SECRET_ACCESS_KEY:?set BACKUP_SECRET_ACCESS_KEY to the independent backup credential}"
: "${BACKUP_ENCRYPTION_RECIPIENT_FILE:?set BACKUP_ENCRYPTION_RECIPIENT_FILE to an age recipients file}"
: "${BACKUP_ALERT_WEBHOOK:?set BACKUP_ALERT_WEBHOOK to the alert endpoint}"
: "${RECOVERY_CONFIG_DIR:?set RECOVERY_CONFIG_DIR to sanitized production config}"
: "${AUDIT_EXPORT_DIR:?set AUDIT_EXPORT_DIR to the audit export directory}"
: "${PUBLICATION_MANIFEST_DIR:?set PUBLICATION_MANIFEST_DIR to publication manifests}"
: "${RELEASE_MANIFEST_PATH:?set RELEASE_MANIFEST_PATH to the version manifest}"

root=$(realpath -e "$LITT_APP_ROOT")
expected_compose="$root/compose.prod.yml"
data_root=$(realpath -e "$LITT_DATA_ROOT")
secrets_root=$(realpath -e "$LITT_SECRETS_ROOT")
[[ "$data_root" == "/srv/litt-data" && "$secrets_root" == "/srv/litt-data/secrets" ]] || { printf 'Backup data/secrets roots are not canonical.\n' >&2; exit 1; }
[[ "$(realpath -e "$COMPOSE_FILE")" == "$expected_compose" ]] || { printf 'Non-canonical backup Compose path.\n' >&2; exit 1; }
[[ "$COMPOSE_PROJECT_NAME" == "litt-production" ]] || { printf 'Backup project must be litt-production.\n' >&2; exit 1; }
[[ "$(realpath -e "$COMPOSE_ENV_FILE")" == "$secrets_root/compose.env" ]] || { printf 'Backup Compose env is not canonical.\n' >&2; exit 1; }
[[ ! -L "$COMPOSE_ENV_FILE" && -f "$COMPOSE_ENV_FILE" && "$(stat -c '%a' "$COMPOSE_ENV_FILE")" == "600" ]] || { printf 'Compose env file must be regular mode 600.\n' >&2; exit 1; }
[[ "$(realpath -m "$RECOVERY_ROOT")" == "$data_root/recovery" ]] || { printf 'Recovery root is not canonical.\n' >&2; exit 1; }
for source in "$RECOVERY_CONFIG_DIR" "$AUDIT_EXPORT_DIR" "$PUBLICATION_MANIFEST_DIR"; do
  source_real=$(realpath -e "$source")
  [[ "$source_real" == "$data_root"/* ]] || { printf 'Recovery source is outside encrypted data.\n' >&2; exit 1; }
done
[[ "$(realpath -e "$RELEASE_MANIFEST_PATH")" == "$data_root/state/release-manifest.json" ]] || { printf 'Release manifest is not canonical.\n' >&2; exit 1; }
[[ "$(realpath -e "$OBJECT_SSE_CUSTOMER_KEY_FILE")" == "$secrets_root/object-storage-sse-c.key" ]] || { printf 'Object SSE-C key is not canonical.\n' >&2; exit 1; }
[[ -f "$RELEASE_MANIFEST_PATH" && ! -L "$RELEASE_MANIFEST_PATH" && "$(stat -c '%a' "$RELEASE_MANIFEST_PATH")" == "600" ]] || { printf 'Release manifest must be a regular mode-600 file.\n' >&2; exit 1; }
[[ "$(realpath -e "$BACKUP_ENCRYPTION_RECIPIENT_FILE")" == "$secrets_root/backup-recipients.age" ]] || { printf 'Backup recipient file is not canonical.\n' >&2; exit 1; }
python3 -c 'from urllib.parse import urlparse; import sys; [(lambda u,h: (_ for _ in ()).throw(SystemExit(1)) if u.scheme != "https" or u.hostname != h else None)(urlparse(value), host) for value,host in zip(sys.argv[1::2],sys.argv[2::2])]' "$OBJECT_ENDPOINT" "$OBJECT_ALLOWED_HOST" "$BACKUP_ENDPOINT" "$BACKUP_ALLOWED_HOST" || { printf 'Backup endpoints must be HTTPS and allowlisted.\n' >&2; exit 1; }

[[ "${PGUSER:-postgres}" == "postgres" && "${PGDATABASE:-postgres}" == "postgres" ]] || { printf 'Recovery dump must use canonical production postgres database.\n' >&2; exit 1; }

if [[ ! -s "$BACKUP_ENCRYPTION_RECIPIENT_FILE" ]]; then
  printf 'Age recipients file is missing or empty.\n' >&2
  exit 1
fi
if [[ ! -f "$OBJECT_SSE_CUSTOMER_KEY_FILE" || "$(stat -c '%a' "$OBJECT_SSE_CUSTOMER_KEY_FILE")" != "600" ]]; then
  printf 'Object-storage SSE-C key file must exist with mode 600.\n' >&2
  exit 1
fi
for path in "$RECOVERY_CONFIG_DIR" "$AUDIT_EXPORT_DIR" "$PUBLICATION_MANIFEST_DIR" "$RELEASE_MANIFEST_PATH"; do
  [[ -e "$path" && ! -L "$path" ]] || { printf 'Missing or symlinked recovery source: %s\n' "$path" >&2; exit 1; }
done

notify_failure() {
  local reason=$1
  curl -fsS --max-time 10 -X POST \
    -H 'Content-Type: application/json' \
    --data "$(jq -cn --arg reason "$reason" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '{event:"recovery_set_failed",reason:$reason,occurred_at:$at}')" \
    "$BACKUP_ALERT_WEBHOOK" >/dev/null 2>&1 || true
}

on_error() {
  local status=$?
  notify_failure "create-recovery-set failed near line $1"
  exit "$status"
}
trap 'on_error "$LINENO"' ERR

if [[ "$(basename "$COMPOSE_FILE")" != "compose.prod.yml" ]]; then
  printf 'Refusing to back up a non-production Compose file.\n' >&2
  exit 1
fi

stamp=$(date -u +%Y%m%dT%H%M%SZ)
set_dir="$RECOVERY_ROOT/sets/$stamp"
work_dir=$(mktemp -d "$RECOVERY_ROOT/.recovery-$stamp.XXXXXX")
archive="$RECOVERY_ROOT/$stamp.tar.gz"
encrypted="$RECOVERY_ROOT/$stamp.tar.gz.age"
cleanup() {
  rm -rf "$work_dir" "$archive"
}
trap cleanup EXIT
mkdir -p "$set_dir"
mkdir -p "$work_dir/objects/data" "$work_dir/config" "$work_dir/audit" "$work_dir/publication"

compose=(docker compose --env-file "$COMPOSE_ENV_FILE" -f "$expected_compose" -p litt-production)

# PostgreSQL custom-format dump plus an independent restore-list check.
"${compose[@]}" exec -T db pg_dump \
  --username "${PGUSER:-postgres}" \
  --dbname "${PGDATABASE:-postgres}" \
  --format=custom --no-owner --no-acl >"$work_dir/postgres.dump"
[[ -s "$work_dir/postgres.dump" ]]
"${compose[@]}" exec -T db pg_restore --list - \
  <"$work_dir/postgres.dump" >"$work_dir/postgres.restore.list"
[[ -s "$work_dir/postgres.restore.list" ]]

object_aws() {
  AWS_ACCESS_KEY_ID="$OBJECT_ACCESS_KEY_ID" \
  AWS_SECRET_ACCESS_KEY="$OBJECT_SECRET_ACCESS_KEY" \
  AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}" \
    aws --endpoint-url "$OBJECT_ENDPOINT" "$@"
}
backup_aws() {
  AWS_ACCESS_KEY_ID="$BACKUP_ACCESS_KEY_ID" \
  AWS_SECRET_ACCESS_KEY="$BACKUP_SECRET_ACCESS_KEY" \
  AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}" \
    aws --endpoint-url "$BACKUP_ENDPOINT" "$@"
}

if [[ "$OBJECT_ACCESS_KEY_ID" == "$BACKUP_ACCESS_KEY_ID" || "$OBJECT_SECRET_ACCESS_KEY" == "$BACKUP_SECRET_ACCESS_KEY" || "$OBJECT_ENDPOINT" == "$BACKUP_ENDPOINT" || "$APP_BUCKET" == "$BACKUP_BUCKET" ]]; then
  printf 'Application and independent-backup identities/destinations must differ.\n' >&2
  exit 1
fi
assert_sanitized_tree() {
  local path=$1
  [[ -d "$path" && ! -L "$path" ]] || { printf 'Recovery source is not a regular directory.\n' >&2; exit 1; }
  local unsafe special hardlinked
  unsafe=$(find "$path" -type l -print -quit)
  [[ -z "$unsafe" ]] || { printf 'Symlink in recovery source: %s\n' "$unsafe" >&2; exit 1; }
  special=$(find "$path" ! -type d ! -type f -print -quit)
  [[ -z "$special" ]] || { printf 'Special file in recovery source: %s\n' "$special" >&2; exit 1; }
  hardlinked=$(find "$path" -type f -links +1 -print -quit)
  [[ -z "$hardlinked" ]] || { printf 'Hardlink in recovery source: %s\n' "$hardlinked" >&2; exit 1; }
  unsafe=$(find "$path" -type f \( -name '*.env' -o -name '*.key' -o -name '*.pem' -o -name '*.age' -o -iname '*secret*' -o -iname '*password*' \) -print -quit)
  [[ -z "$unsafe" ]] || { printf 'Unsafe recovery source member: %s\n' "$unsafe" >&2; exit 1; }
}
assert_sanitized_tree "$RECOVERY_CONFIG_DIR"
assert_sanitized_tree "$AUDIT_EXPORT_DIR"
assert_sanitized_tree "$PUBLICATION_MANIFEST_DIR"

# Export every object version and delete marker, explicitly following S3 marker
# pagination. Object contents are addressed by a digest of (key, version).
mkdir -p "$work_dir/objects/pages"
: >"$work_dir/objects/versions.ndjson"
key_marker=""
version_marker=""
page=0
while :; do
  page=$((page + 1))
  page_file="$work_dir/objects/pages/page-$page.json"
  args=(s3api list-object-versions --bucket "$APP_BUCKET" --output json)
  [[ -n "$key_marker" ]] && args+=(--key-marker "$key_marker")
  [[ -n "$version_marker" ]] && args+=(--version-id-marker "$version_marker")
  object_aws "${args[@]}" >"$page_file"
  jq -c '.Versions[]? | {kind:"version",Key,VersionId,IsLatest,LastModified,ETag,Size}' "$page_file" >>"$work_dir/objects/versions.ndjson"
  jq -c '.DeleteMarkers[]? | {kind:"delete_marker",Key,VersionId,IsLatest,LastModified}' "$page_file" >>"$work_dir/objects/versions.ndjson"
  truncated=$(jq -er 'if has("IsTruncated") and (.IsTruncated | type == "boolean") then .IsTruncated else error("missing boolean IsTruncated") end' "$page_file")
  [[ "$truncated" == "true" ]] || break
  next_key=$(jq -r '.NextKeyMarker // empty' "$page_file")
  next_version=$(jq -r '.NextVersionIdMarker // empty' "$page_file")
  [[ -n "$next_key" && -n "$next_version" ]] || { printf 'Truncated object listing has no next markers.\n' >&2; exit 1; }
  [[ "$next_key" != "$key_marker" || "$next_version" != "$version_marker" ]] || { printf 'Object listing pagination marker repeated.\n' >&2; exit 1; }
  key_marker="$next_key"
  version_marker="$next_version"
done
: >"$work_dir/objects/index.ndjson"
while IFS= read -r record; do
  key=$(jq -r '.Key' <<<"$record")
  version=$(jq -r '.VersionId' <<<"$record")
  file_id=$(printf '%s\0%s' "$key" "$version" | sha256sum | cut -d' ' -f1)
  object_path="$work_dir/objects/data/$file_id.object"
  object_aws s3api get-object \
    --bucket "$APP_BUCKET" --key "$key" --version-id "$version" \
    --sse-customer-algorithm AES256 \
    --sse-customer-key "fileb://$OBJECT_SSE_CUSTOMER_KEY_FILE" \
    "$object_path" >/dev/null
  digest=$(sha256sum "$object_path" | cut -d' ' -f1)
  jq -cn --arg key "$key" --arg version "$version" --arg file "$file_id.object" \
    --arg sha256 "$digest" --argjson size "$(stat -c '%s' "$object_path")" \
    --argjson is_latest "$(jq -r '.IsLatest // false' <<<"$record")" \
    '{kind:"version",key:$key,version_id:$version,file:$file,sha256:$sha256,size:$size,is_latest:$is_latest}' \
    >>"$work_dir/objects/index.ndjson"
done < <(jq -c 'select(.kind == "version")' "$work_dir/objects/versions.ndjson")
while IFS= read -r record; do
  jq -c '{kind:"delete_marker",key:.Key,version_id:.VersionId,is_latest:.IsLatest,last_modified:.LastModified}' \
    <<<"$record" >>"$work_dir/objects/index.ndjson"
done < <(jq -c 'select(.kind == "delete_marker")' "$work_dir/objects/versions.ndjson")

# Copy only the allowlisted sanitized, symlink-free recovery sources.
cp -a "$RECOVERY_CONFIG_DIR/." "$work_dir/config/"
cp -a "$AUDIT_EXPORT_DIR/." "$work_dir/audit/"
cp -a "$PUBLICATION_MANIFEST_DIR/." "$work_dir/publication/"
cp -a "$RELEASE_MANIFEST_PATH" "$work_dir/release-manifest.json"

object_count=$(jq -s '[.[] | select(.kind == "version")] | length' "$work_dir/objects/index.ndjson")
delete_marker_count=$(jq -s '[.[] | select(.kind == "delete_marker")] | length' "$work_dir/objects/index.ndjson")
pg_sha256=$(sha256sum "$work_dir/postgres.dump" | cut -d' ' -f1)
jq -n \
  --arg set_id "$stamp" \
  --arg created_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg pg_sha256 "$pg_sha256" \
  --argjson object_count "$object_count" \
  --argjson delete_marker_count "$delete_marker_count" \
  '{set_id:$set_id,created_at:$created_at,postgres_dump_sha256:$pg_sha256,object_version_count:$object_count,delete_marker_count:$delete_marker_count,components:["postgres","object_versions","audit","publication_manifests","config","checksums"]}' \
  >"$work_dir/inventory.json"

(cd "$work_dir" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum) >"$work_dir/SHA256SUMS"
tar -C "$work_dir" -czf "$archive" .
archive_sha256=$(sha256sum "$archive" | cut -d' ' -f1)
age --encrypt --recipients-file "$BACKUP_ENCRYPTION_RECIPIENT_FILE" --output "$encrypted" "$archive"
encrypted_sha256=$(sha256sum "$encrypted" | cut -d' ' -f1)

remote_key="recovery/$stamp/recovery-set.tar.gz.age"
backup_aws s3 cp "$encrypted" "s3://$BACKUP_BUCKET/$remote_key" \
  --metadata "sha256=$encrypted_sha256,set-id=$stamp" >/dev/null
remote_metadata=$(backup_aws s3api head-object --bucket "$BACKUP_BUCKET" --key "$remote_key" --output json)
[[ "$(jq -r '.Metadata.sha256 // ""' <<<"$remote_metadata")" == "$encrypted_sha256" ]]

success_file="$work_dir/SUCCESS.json"
jq -n \
  --arg set_id "$stamp" \
  --arg completed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg key "$remote_key" \
  --arg sha256 "$encrypted_sha256" \
  --arg archive_sha256 "$archive_sha256" \
  '{status:"success",set_id:$set_id,completed_at:$completed_at,object_key:$key,encrypted_sha256:$sha256,archive_sha256:$archive_sha256}' \
  >"$success_file"
backup_aws s3 cp "$success_file" "s3://$BACKUP_BUCKET/recovery/$stamp/SUCCESS.json" >/dev/null
backup_aws s3 cp "$success_file" "s3://$BACKUP_BUCKET/recovery/latest-success.json" >/dev/null
cp "$success_file" "$set_dir/SUCCESS.json"
cp "$work_dir/inventory.json" "$set_dir/inventory.json"
cp "$work_dir/SHA256SUMS" "$set_dir/SHA256SUMS"
printf 'Recovery set %s completed and verified at the independent destination.\n' "$stamp"
