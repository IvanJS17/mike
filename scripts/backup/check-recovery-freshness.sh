#!/usr/bin/env bash
# Validate the latest complete recovery set and publish a runtime freshness
# decision. This is backup_freshness_ok, not Gate E authorization.
set -Eeuo pipefail
umask 077

: "${BACKUP_BUCKET:?set BACKUP_BUCKET}"
: "${BACKUP_ENDPOINT:?set BACKUP_ENDPOINT}"
: "${BACKUP_ACCESS_KEY_ID:?set BACKUP_ACCESS_KEY_ID}"
: "${BACKUP_SECRET_ACCESS_KEY:?set BACKUP_SECRET_ACCESS_KEY}"
: "${BACKUP_FRESHNESS_FILE:?set BACKUP_FRESHNESS_FILE on the encrypted volume}"
: "${LITT_DATA_ROOT:?set LITT_DATA_ROOT=/srv/litt-data}"
: "${LITT_APP_ROOT:?set LITT_APP_ROOT to the deployed checkout}"
: "${BACKUP_ALERT_WEBHOOK:?set BACKUP_ALERT_WEBHOOK}"
: "${BACKUP_ALLOWED_HOST:?set BACKUP_ALLOWED_HOST to the versioned backup host}"
root=$(realpath -e "$LITT_APP_ROOT")
target_manifest="$root/infra/production/disposable-targets.json"
jq -e --arg host "$BACKUP_ALLOWED_HOST" --arg endpoint "$BACKUP_ENDPOINT" --arg bucket "$BACKUP_BUCKET" '(.backup.host == $host) and (.backup.endpoint == $endpoint) and (.backup.bucket == $bucket)' "$target_manifest" >/dev/null || { printf 'Freshness backup target is not the versioned target.\n' >&2; exit 1; }
[[ -z "$(git -C "$root" status --porcelain --untracked-files=all)" ]] || { printf 'Freshness target checkout is not clean.\n' >&2; exit 1; }
python3 -c 'from urllib.parse import urlparse; import sys; u=urlparse(sys.argv[1]); raise SystemExit(0 if u.scheme == "https" and u.hostname == sys.argv[2] else 1)' "$BACKUP_ENDPOINT" "$BACKUP_ALLOWED_HOST" || { printf 'Freshness backup endpoint must be HTTPS and allowlisted.\n' >&2; exit 1; }
[[ "$(realpath -m "$LITT_DATA_ROOT")" == "/srv/litt-data" && "$(realpath -m "$BACKUP_FRESHNESS_FILE")" == "/srv/litt-data/state/backup-freshness.json" ]] || { printf 'Freshness state path is not canonical.\n' >&2; exit 1; }
state_file="$LITT_DATA_ROOT/state/backup-freshness.json"
readonly max_age_seconds=86400
mkdir -p "$(dirname "$BACKUP_FRESHNESS_FILE")" "$(dirname "$state_file")"

backup_aws() {
  AWS_ACCESS_KEY_ID="$BACKUP_ACCESS_KEY_ID" \
  AWS_SECRET_ACCESS_KEY="$BACKUP_SECRET_ACCESS_KEY" \
  AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}" \
    aws --endpoint-url "$BACKUP_ENDPOINT" "$@"
}
notify_failure() {
  local reason=$1
  curl -fsS --max-time 10 -X POST -H 'Content-Type: application/json' \
    --data "$(jq -cn --arg reason "$reason" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '{event:"recovery_freshness_failed",reason:$reason,occurred_at:$at}')" \
    "$BACKUP_ALERT_WEBHOOK" >/dev/null 2>&1 || true
}
write_state() {
  local ok=$1 status=$2 completed_at=${3:-null} set_id=${4:-null}
  local tmp
  tmp=$(mktemp "${BACKUP_FRESHNESS_FILE}.XXXXXX")
  jq -n --argjson ok "$ok" --arg status "$status" \
    --arg checked_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg completed_at "$completed_at" --arg set_id "$set_id" \
    '{backup_freshness_ok:$ok,status:$status,checked_at:$checked_at,latest_completed_at:$completed_at,set_id:$set_id}' \
    >"$tmp"
  chmod 0600 "$tmp"
  mv -f "$tmp" "$BACKUP_FRESHNESS_FILE"
}
fail_closed() {
  local reason=$1
  local previous
  previous=$(jq -r '.status // "unknown"' "$state_file" 2>/dev/null || printf 'unknown')
  write_state false failed
  [[ "$previous" == "failed" ]] || notify_failure "$reason"
  printf '%s\n' "$reason" >&2
  exit 2
}

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
backup_aws s3api get-object --bucket "$BACKUP_BUCKET" --key recovery/latest-success.json "$tmp" >/dev/null 2>&1 || fail_closed "latest-success marker is missing"
jq -e '
  .status == "success"
  and (.set_id | type == "string" and length > 0)
  and (.completed_at | type == "string")
  and (.object_key | test("^recovery/[^/]+/recovery-set\\.tar\\.gz\\.age$"))
  and (.encrypted_sha256 | test("^[0-9a-f]{64}$"))
' "$tmp" >/dev/null 2>&1 || fail_closed "latest-success marker is incomplete"
set_id=$(jq -r '.set_id' "$tmp")
object_key=$(jq -r '.object_key' "$tmp")
expected_sha=$(jq -r '.encrypted_sha256' "$tmp")
completed_at=$(jq -r '.completed_at' "$tmp")
completed_epoch=$(date -u -d "$completed_at" +%s 2>/dev/null) || fail_closed "latest-success timestamp is invalid"
now_epoch=$(date -u +%s)
age_seconds=$((now_epoch - completed_epoch))
(( age_seconds >= 0 && age_seconds <= max_age_seconds )) || fail_closed "latest recovery set is older than 24 hours"
remote=$(backup_aws s3api head-object --bucket "$BACKUP_BUCKET" --key "$object_key" --output json 2>/dev/null) || fail_closed "latest recovery archive is missing"
[[ "$(jq -r '.Metadata.sha256 // ""' <<<"$remote")" == "$expected_sha" ]] || fail_closed "latest recovery archive checksum does not match marker"
write_state true healthy "$completed_at" "$set_id"
printf 'Latest complete recovery set %s is fresh.\n' "$set_id"
