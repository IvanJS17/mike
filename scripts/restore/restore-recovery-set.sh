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

mkdir -p "$RESTORE_ROOT"
restore_root_real=$(realpath -e "$RESTORE_ROOT")
[[ "$restore_root_real" != "/" && "$restore_root_real" == */litt-restore* ]] || { printf 'Restore root is not disposable.\n' >&2; exit 1; }
[[ "$(realpath -e "$RESTORE_COMPOSE_FILE")" == "$restore_override" ]] || { printf 'Restore must use the reviewed compose.restore.yml.\n' >&2; exit 1; }
[[ "$(realpath -e "$RESTORE_ENV_FILE")" == "$restore_root_real/compose.env" ]] || { printf 'Restore env must be inside RESTORE_ROOT.\n' >&2; exit 1; }
[[ "$RESTORE_PROJECT_NAME" =~ ^litt-restore-[a-z0-9-]{1,40}$ ]] || { printf 'Restore project is not disposable.\n' >&2; exit 1; }
[[ "$RESTORE_OBJECT_BUCKET" =~ ^litt-restore-[a-z0-9-]{1,50}$ ]] || { printf 'Restore bucket is not disposable.\n' >&2; exit 1; }
for secret_file in "$AGE_IDENTITY_FILE" "$RESTORE_ENV_FILE" "$RESTORE_OBJECT_SSE_CUSTOMER_KEY_FILE" "$RESTORE_DESIGNATED_USERS_FILE"; do
  [[ -f "$secret_file" && "$(stat -c '%a' "$secret_file")" == "600" ]] || { printf 'Restore secret fixture must be mode 600.\n' >&2; exit 1; }
done
[[ -f "$RECOVERY_SET_PATH" && -f "$RECOVERY_SUCCESS_PATH" && -f "$RESTORE_EXPECTED_COUNTS_FILE" ]] || { printf 'Recovery input is incomplete.\n' >&2; exit 1; }

runtime_dir=""
compose=()
compose_started=0
cleanup() {
  if (( compose_started == 1 )); then "${compose[@]}" down --remove-orphans >/dev/null 2>&1 || true; fi
  [[ -z "$runtime_dir" ]] || rm -rf "$runtime_dir"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

compose=(docker compose --env-file "$RESTORE_ENV_FILE" -f "$base_compose" -f "$restore_override" -p "$RESTORE_PROJECT_NAME")
compose_config=$("${compose[@]}" config --format json)
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
    for member in archive.getmembers():
        path = PurePosixPath(member.name)
        if path.is_absolute() or '..' in path.parts or member.issym() or member.islnk() or not (member.isdir() or member.isfile()):
            raise SystemExit(f'unsafe archive member: {member.name}')
PY
tar -xzf "$archive" --no-same-owner --no-same-permissions -C "$set_dir"
(cd "$set_dir" && sha256sum -c SHA256SUMS)

jq -e '.status == "success"' "$RECOVERY_SUCCESS_PATH" >/dev/null
set_id=$(jq -er '.set_id' "$set_dir/inventory.json")
marker_sha=$(jq -er '.encrypted_sha256' "$RECOVERY_SUCCESS_PATH")
actual_archive_sha=$(sha256sum "$RECOVERY_SET_PATH" | cut -d' ' -f1)
[[ "$marker_sha" == "$actual_archive_sha" ]] || { printf 'Recovery archive checksum does not match SUCCESS marker.\n' >&2; exit 1; }
[[ "$(jq -er '.set_id' "$RECOVERY_SUCCESS_PATH")" == "$set_id" ]] || {
  printf 'Archive and SUCCESS marker refer to different set IDs.\n' >&2
  exit 1
}
created_at=$(jq -er '.created_at' "$set_dir/inventory.json")
created_epoch=$(date -u -d "$created_at" +%s)
failure_epoch=$(date -u -d "$RESTORE_FAILURE_AT" +%s)
rpo_seconds=$((failure_epoch - created_epoch))
if (( rpo_seconds < 0 || rpo_seconds > 86400 )); then
  printf 'RPO objective failed: %s seconds.\n' "$rpo_seconds" >&2
  exit 1
fi

compose=(docker compose --env-file "$RESTORE_ENV_FILE" -f "$RESTORE_COMPOSE_FILE" -p "$RESTORE_PROJECT_NAME")
"${compose[@]}" up -d db
compose_started=1
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
[[ "$(jq -er 'length' "$RESTORE_DESIGNATED_USERS_FILE")" == "2" ]] || { printf 'Exactly two designated restore users are required.\n' >&2; exit 1; }
while IFS= read -r user_record; do
  printf '%s' "$user_record" | "${compose[@]}" exec -T backend node -e '
let input="";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", async () => {
  const user = JSON.parse(input);
  const response = await fetch("http://caddy/supabase/auth/v1/token?grant_type=password", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: user.email, password: user.password }),
  });
  process.exit(response.ok ? 0 : 1);
});
'
done < <(jq -c '.[]' "$RESTORE_DESIGNATED_USERS_FILE")

restore_aws() {
  AWS_ACCESS_KEY_ID="$RESTORE_OBJECT_ACCESS_KEY_ID" \
  AWS_SECRET_ACCESS_KEY="$RESTORE_OBJECT_SECRET_ACCESS_KEY" \
  AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}" \
    aws --endpoint-url "$RESTORE_OBJECT_ENDPOINT" "$@"
}

: >"$runtime_dir/object-restore-map.ndjson"
while IFS= read -r record; do
  file=$(jq -er '.file' <<<"$record")
  key=$(jq -er '.key' <<<"$record")
  source_path="$set_dir/objects/data/$file"
  [[ -f "$source_path" ]] || { printf 'Missing object payload: %s\n' "$file" >&2; exit 1; }
  expected_sha=$(jq -er '.sha256' <<<"$record")
  actual_sha=$(sha256sum "$source_path" | cut -d' ' -f1)
  [[ "$expected_sha" == "$actual_sha" ]] || { printf 'Object checksum mismatch: %s\n' "$key" >&2; exit 1; }
  result=$(restore_aws s3api put-object \
    --bucket "$RESTORE_OBJECT_BUCKET" --key "$key" --body "$source_path" \
    --sse-customer-algorithm AES256 \
    --sse-customer-key "fileb://$RESTORE_OBJECT_SSE_CUSTOMER_KEY_FILE")
  new_version=$(jq -r '.VersionId // "null"' <<<"$result")
  jq -cn --arg key "$key" --arg source_version "$(jq -r '.version_id' <<<"$record")" \
    --arg restored_version "$new_version" --arg sha256 "$actual_sha" \
    '{kind:"version",key:$key,source_version_id:$source_version,restored_version_id:$restored_version,sha256:$sha256}' \
    >>"$runtime_dir/object-restore-map.ndjson"
done < <(jq -c 'select(.kind == "version")' "$set_dir/objects/index.ndjson")

while IFS= read -r record; do
  key=$(jq -er '.key' <<<"$record")
  result=$(restore_aws s3api delete-object --bucket "$RESTORE_OBJECT_BUCKET" --key "$key")
  jq -cn --arg key "$key" --arg source_version "$(jq -r '.version_id' <<<"$record")" \
    --arg restored_version "$(jq -r '.VersionId // "null"' <<<"$result")" \
    '{kind:"delete_marker",key:$key,source_version_id:$source_version,restored_version_id:$restored_version}' \
    >>"$runtime_dir/object-restore-map.ndjson"
done < <(jq -c 'select(.kind == "delete_marker")' "$set_dir/objects/index.ndjson")

expected_objects=$(jq -s '[.[] | select(.kind == "version")] | length' "$set_dir/objects/index.ndjson")
restored_objects=$(jq -s '[.[] | select(.kind == "version")] | length' "$runtime_dir/object-restore-map.ndjson")
[[ "$expected_objects" == "$restored_objects" ]] || { printf 'Object count mismatch.\n' >&2; exit 1; }

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
receipt="$RESTORE_ROOT/restore-receipts/$set_id-$(date -u +%Y%m%dT%H%M%SZ).json"
jq -n \
  --arg set_id "$set_id" \
  --arg restored_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg project "$RESTORE_PROJECT_NAME" \
  --argjson rpo_seconds "$rpo_seconds" \
  --argjson rto_seconds "$rto_seconds" \
  --argjson object_count "$restored_objects" \
  '{status:"success",set_id:$set_id,restored_at:$restored_at,disposable_project:$project,rpo_seconds:$rpo_seconds,rto_seconds:$rto_seconds,restored_object_count:$object_count,readiness:"green",secrets_included:false}' \
  >"$receipt"
chmod 0600 "$receipt"
printf 'Restore completed on disposable project %s: RPO=%ss RTO=%ss.\n' "$RESTORE_PROJECT_NAME" "$rpo_seconds" "$rto_seconds"
