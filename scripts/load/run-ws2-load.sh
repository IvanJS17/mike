#!/usr/bin/env bash
# WS2 Gate B load profile. It intentionally requires an explicit approval flag
# and external user/token files before generating traffic.
set -Eeuo pipefail
umask 077

: "${LOAD_APPROVAL:?set LOAD_APPROVAL=YES only for the approved synthetic run}"
: "${LOAD_BASE_URL:?set LOAD_BASE_URL to the private staging URL}"
: "${LOAD_USERS_FILE:?set LOAD_USERS_FILE to the mode-600 four-user fixture}"
: "${LOAD_REPORT_PATH:?set LOAD_REPORT_PATH to the evidence JSON path}"
: "${LOAD_METRICS_FILE:?set LOAD_METRICS_FILE to the sanitized host metrics JSON}"
: "${LOAD_UPLOAD_PATH:?set LOAD_UPLOAD_PATH to the authorized 10 MB upload route}"
: "${LOAD_BATCH_ENDPOINT:?set LOAD_BATCH_ENDPOINT to the CI batch route}"
: "${LOAD_INTERACTIVE_PATHS:?set LOAD_INTERACTIVE_PATHS to exactly three chat/workflow routes}"

[[ "$LOAD_APPROVAL" == "YES" ]] || { printf 'Synthetic load approval is required.\n' >&2; exit 2; }
[[ "$(stat -c '%a' "$LOAD_USERS_FILE")" == "600" ]] || { printf 'User fixture must be mode 600.\n' >&2; exit 1; }
[[ "$(stat -c '%a' "$LOAD_METRICS_FILE")" == "600" ]] || { printf 'Metrics fixture must be mode 600.\n' >&2; exit 1; }
duration=${LOAD_DURATION_SECONDS:-1800}
[[ "$duration" == "1800" ]] || { printf 'WS2 profile must run for exactly 1800 seconds (30 minutes).\n' >&2; exit 1; }
user_count=$(jq -er 'length' "$LOAD_USERS_FILE")
[[ "$user_count" == "4" ]] || { printf 'WS2 profile requires exactly 4 accounts.\n' >&2; exit 1; }
IFS=',' read -r -a interactive_paths <<<"$LOAD_INTERACTIVE_PATHS"
[[ "${#interactive_paths[@]}" == "3" ]] || { printf 'WS2 profile requires three chat/workflow paths.\n' >&2; exit 1; }

runtime_dir=$(mktemp -d)
requests_csv="$runtime_dir/requests.csv"
upload_body="$runtime_dir/upload-10mb.bin"
trap 'rm -rf "$runtime_dir"' EXIT
printf 'timestamp,user,operation,status,time_seconds\n' >"$requests_csv"
dd if=/dev/zero of="$upload_body" bs=1M count=10 status=none

request() {
  local token=$1 user=$2 operation=$3 method=$4 path=$5 body=${6:-}
  local curl_config response meta status elapsed
  curl_config=$(mktemp "$runtime_dir/curl.XXXXXX")
  response=$(mktemp "$runtime_dir/response.XXXXXX")
  chmod 0600 "$curl_config"
  {
    printf 'header = "Authorization: Bearer '
    echo -n "$token"
    printf '"\n'
  } >"$curl_config"
  if [[ "$operation" == "upload-10mb" ]]; then
    meta=$(curl --silent --show-error --config "$curl_config" --output "$response" \
      --write-out '%{http_code} %{time_total}' -X "$method" \
      --form "file=@$body" "$LOAD_BASE_URL$path" || printf '000 0')
  elif [[ -n "$body" ]]; then
    meta=$(curl --silent --show-error --config "$curl_config" --output "$response" \
      --write-out '%{http_code} %{time_total}' -X "$method" \
      -H 'Content-Type: application/json' --data "$body" "$LOAD_BASE_URL$path" || printf '000 0')
  else
    meta=$(curl --silent --show-error --config "$curl_config" --output "$response" \
      --write-out '%{http_code} %{time_total}' -X "$method" "$LOAD_BASE_URL$path" || printf '000 0')
  fi
  status=${meta%% *}
  elapsed=${meta#* }
  printf '%s,%s,%s,%s,%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$user" "$operation" "$status" "$elapsed" >>"$requests_csv"
  rm -f "$curl_config" "$response"
}

start=$(date -u +%s)
deadline=$((start + duration))
while (( $(date -u +%s) < deadline )); do
  while IFS= read -r user_record; do
    user=$(jq -er '.id' <<<"$user_record")
    token=$(jq -er '.token' <<<"$user_record")
    request "$token" "$user" "list-workspaces" GET "${LOAD_WORKSPACE_PATH:-/projects}"
    request "$token" "$user" "open-matter" GET "${LOAD_MATTER_PATH:-/projects}"
    request "$token" "$user" "upload-10mb" POST "$LOAD_UPLOAD_PATH" "$upload_body"
    for path in "${interactive_paths[@]}"; do
      request "$token" "$user" "interactive-${path##*/}" GET "$path"
    done
  done < <(jq -c '.[]' "$LOAD_USERS_FILE")
  sleep "${LOAD_INTERVAL_SECONDS:-30}"
done

# One synthetic 100-document/1,000-page batch with ten induced failures and an
# idempotent resume signal. The endpoint implementation records duplicate-free
# completion in the report; this runner only sends synthetic metadata.
batch_body=$(jq -cn '{documents:100,pages:1000,induced_failures:10,resume:true,idempotency_key:("ws2-" + (now|tostring))}')
first_user=$(jq -er '.[0]' "$LOAD_USERS_FILE")
request "$(jq -er '.token' <<<"$first_user")" "$(jq -er '.id' <<<"$first_user")" "batch-100-documents" POST "$LOAD_BATCH_ENDPOINT" "$batch_body"

metrics_json=$(cat "$LOAD_METRICS_FILE")
ram_percent=$(jq -er '.ram_percent' <<<"$metrics_json")
oom_events=$(jq -er '.oom_events' <<<"$metrics_json")
swap_minutes=$(jq -er '.swap_minutes' <<<"$metrics_json")
disk_percent=$(jq -er '.disk_percent' <<<"$metrics_json")
queue_resume_failures=$(jq -er '.queue_resume_failures' <<<"$metrics_json")
readiness=$(jq -er '.readiness' <<<"$metrics_json")

observed=$(python3 -c 'import csv,sys,statistics,json; rows=list(csv.DictReader(open(sys.argv[1]))); times=sorted(float(r["time_seconds"])*1000 for r in rows); errors=sum(1 for r in rows if int(r["status"])>=500); p95=times[max(0, int(len(times)*.95)-1)] if times else 0; print(json.dumps({"requests":len(rows),"five_xx_percent":(errors*100/len(rows)) if rows else 100,"p95_ms":p95}))' "$requests_csv")
five_xx_percent=$(jq -er '.five_xx_percent' <<<"$observed")
p95_ms=$(jq -er '.p95_ms' <<<"$observed")
# The report includes the own-service 5xx rate and p95 timing.
# A failed profile recommends the documented CX23 -> 8 GB resize decision.
status=pass
decision=keep_cx23
if (( $(awk "BEGIN {print ($ram_percent >= 75 || $oom_events > 0 || $swap_minutes > 5 || $disk_percent >= 70 || $five_xx_percent >= 1 || $p95_ms >= 2000 || $queue_resume_failures > 0 || $readiness != 1)}") )); then
  status=fail
  decision=resize_to_8gb_and_repeat_profile
fi
mkdir -p "$(dirname "$LOAD_REPORT_PATH")"
jq -n \
  --arg status "$status" \
  --arg decision "$decision" \
  --argjson duration_seconds "$duration" \
  --argjson users "$user_count" \
  --argjson observed "$observed" \
  --argjson ram_percent "$ram_percent" \
  --argjson oom_events "$oom_events" \
  --argjson swap_minutes "$swap_minutes" \
  --argjson disk_percent "$disk_percent" \
  --argjson queue_resume_failures "$queue_resume_failures" \
  --argjson readiness "$readiness" \
  '{status:$status,profile:{duration_seconds:$duration_seconds,accounts:$users,upload_mb:10,batch_documents:100,batch_pages:1000,induced_failures:10},observed:$observed,host:{ram_percent:$ram_percent,oom_events:$oom_events,swap_minutes:$swap_minutes,disk_percent:$disk_percent,queue_resume_failures:$queue_resume_failures,readiness:$readiness},thresholds:{ram_percent_lt:75,oom_events:0,swap_minutes_lte:5,disk_percent_lt:70,five_xx_percent_lt:1,p95_ms_lt:2000,queue_resume_failures:0},decision:$decision}' \
  >"$LOAD_REPORT_PATH"
chmod 0600 "$LOAD_REPORT_PATH"
cat "$LOAD_REPORT_PATH"
[[ "$status" == "pass" ]] || exit 1
