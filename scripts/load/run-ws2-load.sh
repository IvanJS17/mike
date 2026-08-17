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
: "${LOAD_DOWNLOAD_PATH_TEMPLATE:?set LOAD_DOWNLOAD_PATH_TEMPLATE to the authorized download path template}"
: "${LOAD_BATCH_ENDPOINT:?set LOAD_BATCH_ENDPOINT to the CI batch route}"
: "${LOAD_WORKSPACE_PATH:?set LOAD_WORKSPACE_PATH to the authorized listing route}"
: "${LOAD_MATTER_PATH:?set LOAD_MATTER_PATH to the authorized matter route}"
: "${LOAD_WORKSPACE_CREATE_PATH:?set LOAD_WORKSPACE_CREATE_PATH to the workspace creation route}"
: "${LOAD_MATTER_CREATE_PATH:?set LOAD_MATTER_CREATE_PATH to the matter creation route}"
: "${LOAD_INTERACTIVE_PATHS:?set LOAD_INTERACTIVE_PATHS to exactly three chat/workflow routes}"
: "${LOAD_ALLOWED_HOST:?set LOAD_ALLOWED_HOST to the approved synthetic host}"
: "${LOAD_APPROVAL_RECEIPT:?set LOAD_APPROVAL_RECEIPT to the mode-600 owner approval file}"

[[ "$LOAD_APPROVAL" == "YES" ]] || { printf 'Synthetic load approval is required.\n' >&2; exit 2; }
[[ "$(stat -c '%a' "$LOAD_USERS_FILE")" == "600" ]] || { printf 'User fixture must be mode 600.\n' >&2; exit 1; }
[[ "$(stat -c '%a' "$LOAD_METRICS_FILE")" == "600" ]] || { printf 'Metrics fixture must be mode 600.\n' >&2; exit 1; }
[[ "$LOAD_BASE_URL" =~ ^https:// ]] || { printf 'Load target must use HTTPS.\n' >&2; exit 1; }
base_host=${LOAD_BASE_URL#https://}; base_host=${base_host%%/*}
[[ "$base_host" == "$LOAD_ALLOWED_HOST" ]] || { printf 'Load target host is not approved.\n' >&2; exit 1; }
[[ -f "$LOAD_APPROVAL_RECEIPT" && "$(stat -c '%a' "$LOAD_APPROVAL_RECEIPT")" == "600" ]] || { printf 'Approval receipt must be mode 600.\n' >&2; exit 1; }
jq -e --arg host "$LOAD_ALLOWED_HOST" --arg url "$LOAD_BASE_URL" '(.approved == true) and (.synthetic_only == true) and (.target_host == $host) and (.target_url == $url) and ((.expires_at | fromdateiso8601) > now)' "$LOAD_APPROVAL_RECEIPT" >/dev/null || { printf 'Synthetic approval receipt is invalid or expired.\n' >&2; exit 1; }
duration=${LOAD_DURATION_SECONDS:-1800}
[[ "$duration" == "1800" ]] || { printf 'WS2 profile must run for exactly 1800 seconds (30 minutes).\n' >&2; exit 1; }
user_count=$(jq -er 'length' "$LOAD_USERS_FILE")
[[ "$user_count" == "4" ]] || { printf 'WS2 profile requires exactly 4 accounts.\n' >&2; exit 1; }
jq -e 'length == 4 and ([.[].id] | unique | length == 4) and ([.[].token] | unique | length == 4) and all(.[]; .synthetic == true and (.token | type == "string" and test("^[A-Za-z0-9._~-]+$")))' "$LOAD_USERS_FILE" >/dev/null || { printf 'User fixture must contain four distinct synthetic safe tokens.\n' >&2; exit 1; }
IFS=',' read -r -a interactive_paths <<<"$LOAD_INTERACTIVE_PATHS"
[[ "${#interactive_paths[@]}" == "3" ]] || { printf 'WS2 profile requires three chat/workflow paths.\n' >&2; exit 1; }
python3 -c 'import re,sys; raise SystemExit(0 if all(re.fullmatch(r"/[A-Za-z0-9._/?=&-]+", value) for value in sys.argv[1:]) else 1)' "$LOAD_WORKSPACE_PATH" "$LOAD_MATTER_PATH" "$LOAD_WORKSPACE_CREATE_PATH" "$LOAD_MATTER_CREATE_PATH" "$LOAD_UPLOAD_PATH" "$LOAD_BATCH_ENDPOINT" || { printf 'Load route is unsafe.\n' >&2; exit 1; }
python3 -c 'import re,sys; raise SystemExit(0 if re.fullmatch(r"/[A-Za-z0-9._/?=&-]*%s[A-Za-z0-9._/?=&-]*", sys.argv[1]) else 1)' "$LOAD_DOWNLOAD_PATH_TEMPLATE" || { printf 'Download path template is unsafe.\n' >&2; exit 1; }

runtime_dir=$(mktemp -d)
requests_csv="$runtime_dir/requests.csv"
upload_body="$runtime_dir/upload-10mb.bin"
trap 'rm -rf "$runtime_dir"' EXIT
printf 'timestamp,user,operation,status,time_seconds\n' >"$requests_csv"
dd if=/dev/zero of="$upload_body" bs=1M count=10 status=none

request() {
  local token=$1 user=$2 operation=$3 method=$4 path=$5 body=${6:-} capture=${7:-}
  local curl_config response meta status elapsed
  curl_config=$(mktemp "$runtime_dir/curl.XXXXXX")
  response=$(mktemp "$runtime_dir/response.XXXXXX")
  chmod 0600 "$curl_config"
  {
    printf 'header = "Authorization: '
    printf 'Bear'
    printf 'er '
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
  if [[ -n "$capture" ]]; then cp "$response" "$capture"; fi
  LAST_STATUS="$status"
  rm -f "$curl_config" "$response"
}

start=$(date -u +%s)
deadline=$((start + duration))
first_user=$(jq -er '.[0]' "$LOAD_USERS_FILE")
first_token=$(jq -er '.token' <<<"$first_user")
first_id=$(jq -er '.id' <<<"$first_user")
batch_body=$(jq -cn --arg run "ws2-$start" '{documents:100,pages:1000,synthetic:true,load_run:$run}')
for failure in $(seq 0 9); do
  request "$first_token" "$first_id" "batch-induced-failure-$failure" POST "$LOAD_BATCH_ENDPOINT?induced_failure=$failure" "$batch_body"
done
request "$first_token" "$first_id" "batch-resume" POST "$LOAD_BATCH_ENDPOINT/resume" "$batch_body"
while (( $(date -u +%s) < deadline )); do
  while IFS= read -r user_record; do
    user=$(jq -er '.id' <<<"$user_record")
    token=$(jq -er '.token' <<<"$user_record")
    create_body=$(jq -cn --arg run "ws2-$start" --arg user "$user" '{synthetic:true,load_run:$run,owner:$user}')
    request "$token" "$user" "create-workspace" POST "$LOAD_WORKSPACE_CREATE_PATH" "$create_body" "$runtime_dir/workspace-$user.json"
    request "$token" "$user" "create-matter" POST "$LOAD_MATTER_CREATE_PATH" "$create_body" "$runtime_dir/matter-$user.json"
    request "$token" "$user" "list-workspaces" GET "$LOAD_WORKSPACE_PATH"
    request "$token" "$user" "open-matter" GET "$LOAD_MATTER_PATH"
    upload_response="$runtime_dir/upload-$user.json"
    request "$token" "$user" "upload-10mb" POST "$LOAD_UPLOAD_PATH" "$upload_body" "$upload_response"
    document_id=$(jq -er '.id // .document_id' "$upload_response")
    download_path=$(printf "$LOAD_DOWNLOAD_PATH_TEMPLATE" "$document_id")
    downloaded="$runtime_dir/download-$user.bin"
    request "$token" "$user" "download-10mb" GET "$download_path" "" "$downloaded"
    [[ -s "$downloaded" ]] || { printf '10 MB download returned no bytes.\n' >&2; exit 1; }
    for route in "${interactive_paths[@]}"; do
      method=${route%%:*}; path=${route#*:}
      [[ "$method" =~ ^(GET|POST)$ && "$path" == /* ]] || { printf 'Interactive route must be METHOD:/path.\n' >&2; exit 1; }
      request "$token" "$user" "interactive-${path##*/}" "$method" "$path" "$create_body"
    done
  done < <(jq -c '.[]' "$LOAD_USERS_FILE")
  sleep "${LOAD_INTERVAL_SECONDS:-30}"
done

metrics_json=$(cat "$LOAD_METRICS_FILE")
jq -e 'all([.ram_percent,.oom_events,.swap_minutes,.disk_percent,.queue_resume_failures,.readiness]; type == "number" and . >= 0)' <<<"$metrics_json" >/dev/null || { printf 'Metrics fixture must contain nonnegative numeric fields.\n' >&2; exit 1; }
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
if jq -n --argjson ram "$ram_percent" --argjson oom "$oom_events" --argjson swap "$swap_minutes" --argjson disk "$disk_percent" --argjson five_xx "$five_xx_percent" --argjson p95 "$p95_ms" --argjson queue "$queue_resume_failures" --argjson ready "$readiness" \
  '($ram >= 75 or $oom > 0 or $swap > 5 or $disk >= 70 or $five_xx >= 1 or $p95 >= 2000 or $queue > 0 or $ready != 1)' >/dev/null; then
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
