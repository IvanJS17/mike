#!/usr/bin/env bash
# Mark whether the platform may accept new real data based on the latest
# complete recovery set. A stale/missing marker fails closed.
set -Eeuo pipefail
umask 077

: "${BACKUP_BUCKET:?set BACKUP_BUCKET to the independent recovery bucket}"
: "${BACKUP_ENDPOINT:?set BACKUP_ENDPOINT to the independent recovery endpoint}"
: "${BACKUP_ACCESS_KEY_ID:?set BACKUP_ACCESS_KEY_ID to the independent backup credential}"
: "${BACKUP_SECRET_ACCESS_KEY:?set BACKUP_SECRET_ACCESS_KEY to the independent backup credential}"
: "${REAL_DATA_ACCEPTANCE_FILE:?set REAL_DATA_ACCEPTANCE_FILE on the encrypted volume}"
: "${BACKUP_ALERT_WEBHOOK:?set BACKUP_ALERT_WEBHOOK to the alert endpoint}"

state_file=${BACKUP_FRESHNESS_STATE_FILE:-"${REAL_DATA_ACCEPTANCE_FILE}.state"}
max_age_hours=${BACKUP_MAX_AGE_HOURS:-24}
mkdir -p "$(dirname "$REAL_DATA_ACCEPTANCE_FILE")" "$(dirname "$state_file")"

backup_aws() {
  AWS_ACCESS_KEY_ID="$BACKUP_ACCESS_KEY_ID" \
  AWS_SECRET_ACCESS_KEY="$BACKUP_SECRET_ACCESS_KEY" \
  AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}" \
    aws --endpoint-url "$BACKUP_ENDPOINT" "$@"
}
notify_failure() {
  local reason=$1
  curl -fsS --max-time 10 -X POST \
    -H 'Content-Type: application/json' \
    --data "$(jq -cn --arg reason "$reason" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '{event:"recovery_freshness_failed",reason:$reason,occurred_at:$at}')" \
    "$BACKUP_ALERT_WEBHOOK" >/dev/null 2>&1 || true
}
write_state() {
  local allowed=$1 status=$2 completed_at=${3:-null}
  local tmp
  tmp=$(mktemp "${REAL_DATA_ACCEPTANCE_FILE}.XXXXXX")
  jq -n --argjson allowed "$allowed" --arg status "$status" \
    --arg checked_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg completed_at "$completed_at" \
    '{real_data_allowed:$allowed,status:$status,checked_at:$checked_at,latest_completed_at:$completed_at}' \
    >"$tmp"
  chmod 0600 "$tmp"
  mv -f "$tmp" "$REAL_DATA_ACCEPTANCE_FILE"
}

previous_status=$(jq -r '.status // "unknown"' "$state_file" 2>/dev/null || printf 'unknown')
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
if ! backup_aws s3api get-object --bucket "$BACKUP_BUCKET" --key recovery/latest-success.json "$tmp" >/dev/null 2>&1; then
  write_state false failed
  [[ "$previous_status" == "failed" ]] || notify_failure "latest-success marker is missing"
  printf 'No complete recovery set is available; real-data acceptance is disabled.\n' >&2
  cp "$REAL_DATA_ACCEPTANCE_FILE" "$state_file"
  exit 2
fi

completed_at=$(jq -er '.completed_at' "$tmp")
completed_epoch=$(date -u -d "$completed_at" +%s)
now_epoch=$(date -u +%s)
age_seconds=$((now_epoch - completed_epoch))
max_age_seconds=$((max_age_hours * 3600))
if (( age_seconds < 0 || age_seconds > max_age_seconds )); then
  write_state false failed "$completed_at"
  [[ "$previous_status" == "failed" ]] || notify_failure "latest recovery set is older than ${max_age_hours} hours"
  printf 'Latest complete recovery set is stale; real-data acceptance is disabled.\n' >&2
  cp "$REAL_DATA_ACCEPTANCE_FILE" "$state_file"
  exit 2
fi

write_state true healthy "$completed_at"
cp "$REAL_DATA_ACCEPTANCE_FILE" "$state_file"
printf 'Latest recovery set is %s; real-data acceptance remains enabled.\n' "$completed_at"
