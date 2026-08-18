#!/usr/bin/env bash
# WS2 Gate B load profile. It intentionally requires an explicit approval flag
# and external user/token files before generating traffic.
set -Eeuo pipefail
umask 077

: "${LOAD_APPROVAL:?set LOAD_APPROVAL=YES only for the approved synthetic run}"
: "${LOAD_BASE_URL:?set LOAD_BASE_URL to the private staging URL}"
: "${LOAD_USERS_FILE:?set LOAD_USERS_FILE to the mode-600 four-user fixture}"
: "${LOAD_REPORT_PATH:?set LOAD_REPORT_PATH to the evidence JSON path}"
: "${LOAD_COMPOSE_FILE:?set LOAD_COMPOSE_FILE to compose.prod.yml}"
: "${LOAD_COMPOSE_ENV_FILE:?set LOAD_COMPOSE_ENV_FILE to the disposable mode-600 env file}"
: "${LOAD_DOCKER_CONTEXT:?set LOAD_DOCKER_CONTEXT to the versioned disposable context}"
: "${LOAD_PROJECT_NAME:?set LOAD_PROJECT_NAME to the versioned disposable project}"
: "${LOAD_DATA_ROOT:?set LOAD_DATA_ROOT to the encrypted disposable data root}"
: "${LITT_APP_ROOT:?set LITT_APP_ROOT to the reviewed checkout}"
: "${LOAD_UPLOAD_PATH:?set LOAD_UPLOAD_PATH to the authorized 10 MB upload route}"
: "${LOAD_DOWNLOAD_PATH_TEMPLATE:?set LOAD_DOWNLOAD_PATH_TEMPLATE to the authorized download path template}"
: "${LOAD_BATCH_ENDPOINT:?set LOAD_BATCH_ENDPOINT to the CI batch route}"
: "${LOAD_WORKSPACE_PATH:?set LOAD_WORKSPACE_PATH to the authorized listing route}"
: "${LOAD_MATTER_PATH:?set LOAD_MATTER_PATH to the authorized matter route}"
: "${LOAD_WORKSPACE_CREATE_PATH:?set LOAD_WORKSPACE_CREATE_PATH to the workspace creation route}"
: "${LOAD_MATTER_CREATE_PATH:?set LOAD_MATTER_CREATE_PATH to the matter creation route}"
: "${LOAD_INTERACTIVE_PATHS:?set LOAD_INTERACTIVE_PATHS to exactly three chat/workflow routes}"
: "${LOAD_ALLOWED_HOST:?set LOAD_ALLOWED_HOST to the approved synthetic host}"
: "${LOAD_DISPOSABLE_TARGET_ID:?set LOAD_DISPOSABLE_TARGET_ID to the versioned disposable load target}"
: "${LOAD_APPROVAL_RECEIPT:?set LOAD_APPROVAL_RECEIPT to the mode-600 owner approval file}"

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
target_manifest="$repo_root/infra/production/disposable-targets.json"
jq -e --arg id "$LOAD_DISPOSABLE_TARGET_ID" --arg host "$LOAD_ALLOWED_HOST" --arg url "$LOAD_BASE_URL" --arg context "$LOAD_DOCKER_CONTEXT" --arg project "$LOAD_PROJECT_NAME" --arg data_root "$LOAD_DATA_ROOT" \
  '(.load.target_id == $id) and (.load.host == $host) and (.load.base_url == $url) and (.load.docker_context == $context) and (.load.project == $project) and (.load.data_root == $data_root)' "$target_manifest" >/dev/null || { printf 'Load target is not the versioned disposable target.\n' >&2; exit 1; }

[[ "$LOAD_APPROVAL" == "YES" ]] || { printf 'Synthetic load approval is required.\n' >&2; exit 2; }
[[ "$(stat -c '%a' "$LOAD_USERS_FILE")" == "600" ]] || { printf 'User fixture must be mode 600.\n' >&2; exit 1; }
[[ "$(realpath -e "$LOAD_COMPOSE_FILE")" == "$repo_root/compose.prod.yml" && "$(realpath -e "$LOAD_COMPOSE_ENV_FILE")" == "$(realpath -e "$LOAD_DATA_ROOT")/secrets/compose.env" ]] || { printf 'Load Compose paths are not canonical.\n' >&2; exit 1; }
[[ "$(stat -c '%a' "$LOAD_COMPOSE_ENV_FILE")" == "600" ]] || { printf 'Load Compose env must be mode 600.\n' >&2; exit 1; }
[[ "$LOAD_BASE_URL" =~ ^https:// ]] || { printf 'Load target must use HTTPS.\n' >&2; exit 1; }
base_host=${LOAD_BASE_URL#https://}; base_host=${base_host%%/*}
[[ "$base_host" == "$LOAD_ALLOWED_HOST" ]] || { printf 'Load target host is not approved.\n' >&2; exit 1; }
[[ "$base_host" != localhost && "$base_host" != 127.0.0.1 && "$base_host" != *production* && "$base_host" != *prod* ]] || { printf 'Load target resembles a live/local host.\n' >&2; exit 1; }
[[ -f "$LOAD_APPROVAL_RECEIPT" && "$(stat -c '%a' "$LOAD_APPROVAL_RECEIPT")" == "600" ]] || { printf 'Approval receipt must be mode 600.\n' >&2; exit 1; }
jq -e --arg host "$LOAD_ALLOWED_HOST" --arg url "$LOAD_BASE_URL" '(.approved == true) and (.synthetic_only == true) and (.target_host == $host) and (.target_url == $url) and ((.expires_at | fromdateiso8601) > now)' "$LOAD_APPROVAL_RECEIPT" >/dev/null || { printf 'Synthetic approval receipt is invalid or expired.\n' >&2; exit 1; }
duration=${LOAD_DURATION_SECONDS:-1800}
[[ "$duration" == "1800" ]] || { printf 'WS2 profile must run for exactly 1800 seconds (30 minutes).\n' >&2; exit 1; }
user_count=$(jq -er 'length' "$LOAD_USERS_FILE")
[[ "$user_count" == "4" ]] || { printf 'WS2 profile requires exactly 4 accounts.\n' >&2; exit 1; }
jq -e 'length == 4 and ([.[].id] | unique | length == 4) and ([.[].token] | unique | length == 4) and all(.[]; (.id | test("^[A-Za-z0-9._-]+$")) and .synthetic == true and (.token | type == "string" and test("^[A-Za-z0-9._~-]+$")))' "$LOAD_USERS_FILE" >/dev/null || { printf 'User fixture must contain four distinct synthetic safe IDs/tokens.\n' >&2; exit 1; }
IFS=',' read -r -a interactive_paths <<<"$LOAD_INTERACTIVE_PATHS"
[[ "${#interactive_paths[@]}" == "3" ]] || { printf 'WS2 profile requires three chat/workflow paths.\n' >&2; exit 1; }
interactive_json=$(printf '%s\n' "${interactive_paths[@]}" | jq -R . | jq -s .)
jq -e --arg workspace "$LOAD_WORKSPACE_PATH" --arg matter "$LOAD_MATTER_PATH" --arg workspace_create "$LOAD_WORKSPACE_CREATE_PATH" --arg matter_create "$LOAD_MATTER_CREATE_PATH" --arg upload "$LOAD_UPLOAD_PATH" --arg batch "$LOAD_BATCH_ENDPOINT" --argjson interactive "$interactive_json" \
  '(.load.workspace_path == $workspace) and (.load.matter_path == $matter) and (.load.workspace_create_path == $workspace_create) and (.load.matter_create_path == $matter_create) and (.load.upload_path == $upload) and (.load.batch_endpoint == $batch) and (.load.interactive_paths == $interactive)' "$target_manifest" >/dev/null || { printf 'Load routes do not match the versioned target manifest.\n' >&2; exit 1; }
download_prefix=$(jq -er '.load.download_prefix' "$target_manifest")
validate_route() {
  local route=$1
  route_pattern='^/api/[A-Za-z0-9._/?=&%-]+$'
  [[ "$route" =~ $route_pattern && "$route" != *..* ]] || return 1
  case "$route" in
    /api/projects*|/api/test/load/workspaces*|/api/test/load/matters*|/api/single-documents*|/api/chat*|/api/workflows*|/api/download*|/api/test/load*) return 0 ;;
    *) return 1 ;;
  esac
}
for route in "$LOAD_WORKSPACE_PATH" "$LOAD_MATTER_PATH" "$LOAD_WORKSPACE_CREATE_PATH" "$LOAD_MATTER_CREATE_PATH" "$LOAD_UPLOAD_PATH" "$LOAD_BATCH_ENDPOINT"; do
  validate_route "$route" || { printf 'Load route is outside the immutable synthetic allowlist.\n' >&2; exit 1; }
done
python3 -c 'import re,sys; raise SystemExit(0 if re.fullmatch(r"/api/[A-Za-z0-9._/?=&%-]*%s[A-Za-z0-9._/?=&%-]*", sys.argv[1]) else 1)' "$LOAD_DOWNLOAD_PATH_TEMPLATE" || { printf 'Download path template is unsafe.\n' >&2; exit 1; }
[[ "$LOAD_DOWNLOAD_PATH_TEMPLATE" == "$download_prefix"* ]] || { printf 'Download path template is outside the versioned prefix.\n' >&2; exit 1; }

runtime_dir=$(mktemp -d)
requests_csv="$runtime_dir/requests.csv"
upload_body="$runtime_dir/upload-10mb.pdf"
pending_file="$runtime_dir/pending-resources.tsv"
metrics_ndjson="$runtime_dir/metrics.ndjson"
metrics_collector="$repo_root/scripts/load/collect-disposable-metrics.sh"
[[ -x "$metrics_collector" ]] || { printf 'Approved disposable metrics collector is missing.\n' >&2; exit 1; }
printf 'timestamp,user,operation,status,time_seconds\n' >"$requests_csv"
printf '%s\n' '%PDF-1.4' '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj' '2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj' 'trailer << /Root 1 0 R >>' '%%EOF' >"$upload_body"
truncate -s 10485760 "$upload_body"

request() {
  local token=$1 user=$2 operation=$3 method=$4 path=$5 body=${6:-} capture=${7:-} allow_failure=${8:-0}
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
  if [[ "$allow_failure" != "1" && ! "$status" =~ ^2[0-9][0-9]$ ]]; then
    printf 'Load operation %s failed with HTTP/transport status %s.\n' "$operation" "$status" >&2
    return 1
  fi
}

collect_metrics_sample() {
  LOAD_DOCKER_CONTEXT="$LOAD_DOCKER_CONTEXT" \
  LOAD_COMPOSE_FILE="$LOAD_COMPOSE_FILE" \
  LOAD_COMPOSE_ENV_FILE="$LOAD_COMPOSE_ENV_FILE" \
  LOAD_PROJECT_NAME="$LOAD_PROJECT_NAME" \
  LOAD_DATA_ROOT="$LOAD_DATA_ROOT" \
  LOAD_TARGET_ID="$LOAD_DISPOSABLE_TARGET_ID" \
  LOAD_BASE_URL="$LOAD_BASE_URL" \
  LOAD_ALLOWED_HOST="$LOAD_ALLOWED_HOST" \
  LITT_APP_ROOT="$LITT_APP_ROOT" \
    "$metrics_collector" >>"$metrics_ndjson"
}

cleanup_resources() {
  local status=$? user kind resource token
  if [[ -f "$pending_file" ]]; then
    while IFS=$'\t' read -r user kind resource; do
      [[ -n "$user" && -n "$kind" && -n "$resource" ]] || continue
      token=$(jq -er --arg user "$user" '.[] | select(.id == $user) | .token' "$LOAD_USERS_FILE" 2>/dev/null || true)
      [[ -n "$token" ]] || { status=1; continue; }
      case "$kind" in
        workspace) request "$token" "$user" "cleanup-workspace" DELETE "/api/test/load/workspaces/$resource" || status=1 ;;
        matter) request "$token" "$user" "cleanup-matter" DELETE "/api/test/load/matters/$resource" || status=1 ;;
        document) request "$token" "$user" "cleanup-document" DELETE "/api/single-documents/$resource" || status=1 ;;
        *) status=1 ;;
      esac
    done <"$pending_file"
  fi
  if [[ -n "${load_run:-}" ]]; then
    first_record=$(jq -c '.[0]' "$LOAD_USERS_FILE" 2>/dev/null || true)
    first_token=$(jq -er '.token' <<<"$first_record" 2>/dev/null || true)
    first_id=$(jq -er '.id' <<<"$first_record" 2>/dev/null || true)
    if [[ -n "$first_token" && -n "$first_id" ]]; then
      request "$first_token" "$first_id" "cleanup-batch" DELETE "/api/test/load/batch/$load_run" || status=1
    fi
  fi
  rm -rf "$runtime_dir"
  trap - EXIT
  exit "$status"
}
trap cleanup_resources EXIT

start=$(date -u +%s)
load_run="ws2-$start"
deadline=$((start + duration))
first_user=$(jq -er '.[0]' "$LOAD_USERS_FILE")
first_token=$(jq -er '.token' <<<"$first_user")
first_id=$(jq -er '.id' <<<"$first_user")
collect_metrics_sample
batch_body=$(jq -cn --arg run "$load_run" '{documents:100,pages:1000,synthetic:true,load_run:$run}')
for failure in $(seq 0 9); do
  request "$first_token" "$first_id" "batch-induced-failure-$failure" POST "$LOAD_BATCH_ENDPOINT?induced_failure=$failure" "$batch_body" "" 1
  [[ "$LAST_STATUS" =~ ^5[0-9][0-9]$ ]] || { printf 'Induced failure did not produce a server failure.\n' >&2; exit 1; }
done
request "$first_token" "$first_id" "batch-resume" POST "$LOAD_BATCH_ENDPOINT/resume" "$batch_body"
while (( $(date -u +%s) < deadline )); do
  while IFS= read -r user_record; do
    user=$(jq -er '.id' <<<"$user_record")
    token=$(jq -er '.token' <<<"$user_record")
    create_body=$(jq -cn --arg run "$load_run" --arg user "$user" --arg name "WS2 synthetic workspace $user" '{synthetic:true,load_run:$run,owner:$user,name:$name}')
    request "$token" "$user" "create-workspace" POST "$LOAD_WORKSPACE_CREATE_PATH" "$create_body" "$runtime_dir/workspace-$user.json"
    workspace_id=$(jq -er '.id' "$runtime_dir/workspace-$user.json")
    printf '%s\tworkspace\t%s\n' "$user" "$workspace_id" >>"$pending_file"
    matter_body=$(jq -cn --arg run "$load_run" --arg workspace "$workspace_id" --arg name "WS2 synthetic matter $user" '{synthetic:true,load_run:$run,workspace_id:$workspace,name:$name}')
    request "$token" "$user" "create-matter" POST "$LOAD_MATTER_CREATE_PATH" "$matter_body" "$runtime_dir/matter-$user.json"
    matter_id=$(jq -er '.id' "$runtime_dir/matter-$user.json")
    printf '%s\tmatter\t%s\n' "$user" "$matter_id" >>"$pending_file"
    request "$token" "$user" "list-workspaces" GET "$LOAD_WORKSPACE_PATH"
    request "$token" "$user" "open-matter" GET "$LOAD_MATTER_PATH"
    upload_response="$runtime_dir/upload-$user.json"
    request "$token" "$user" "upload-10mb" POST "$LOAD_UPLOAD_PATH" "$upload_body" "$upload_response"
    document_id=$(jq -er '.id // .document_id' "$upload_response")
    printf '%s\tdocument\t%s\n' "$user" "$document_id" >>"$pending_file"
    download_path=$(jq -er '.download_url // .url // empty' "$upload_response" 2>/dev/null || true)
    if [[ -z "$download_path" ]]; then
      download_path=$(printf "$LOAD_DOWNLOAD_PATH_TEMPLATE" "$document_id")
    fi
    validate_route "$download_path" || { printf 'Backend download URL is outside the synthetic allowlist.\n' >&2; exit 1; }
    [[ "$download_path" == "$download_prefix"* ]] || { printf 'Backend download URL is outside the versioned prefix.\n' >&2; exit 1; }
    downloaded="$runtime_dir/download-$user.bin"
    request "$token" "$user" "download-10mb" GET "$download_path" "" "$downloaded"
    [[ "$(stat -c '%s' "$downloaded")" == "$(stat -c '%s' "$upload_body")" ]] || { printf 'Downloaded file size differs from 10 MiB fixture.\n' >&2; exit 1; }
    cmp -s "$upload_body" "$downloaded" || { printf 'Downloaded bytes differ from upload fixture.\n' >&2; exit 1; }
    request "$token" "$user" "delete-document" DELETE "/api/single-documents/$document_id"
    request "$token" "$user" "delete-matter" DELETE "/api/test/load/matters/$matter_id"
    request "$token" "$user" "delete-workspace" DELETE "/api/test/load/workspaces/$workspace_id"
    awk -F '\t' -v user="$user" '$1 != user' "$pending_file" >"$pending_file.next"
    mv -f "$pending_file.next" "$pending_file"
    for route in "${interactive_paths[@]}"; do
      method=${route%%:*}; path=${route#*:}
      [[ "$method" =~ ^(GET|POST)$ && "$path" == /* ]] || { printf 'Interactive route must be METHOD:/path.\n' >&2; exit 1; }
      validate_route "$path" || { printf 'Interactive route is outside the immutable synthetic allowlist.\n' >&2; exit 1; }
      case "$path" in
        /api/chat*) interactive_body=$(jq -cn --arg text "WS2 synthetic chat $start" '{messages:[{role:"user",content:$text}]}') ;;
        /api/workflows*) interactive_body=$(jq -cn --arg title "WS2 synthetic workflow" '{metadata:{title:$title,type:"assistant"}}') ;;
        *) interactive_body="" ;;
      esac
      request "$token" "$user" "interactive-${path##*/}" "$method" "$path" "$interactive_body"
    done
  done < <(jq -c '.[]' "$LOAD_USERS_FILE")
  collect_metrics_sample
  sleep "${LOAD_INTERVAL_SECONDS:-30}"
done

metrics_json=$(python3 -c 'import json,sys; rows=[json.loads(line) for line in open(sys.argv[1]) if line.strip()]; assert rows and len({r["target_id"] for r in rows}) == 1 and len({r["target_url"] for r in rows}) == 1; fields=("ram_percent","oom_events","swap_minutes","disk_percent","queue_resume_failures","p95_ms","five_xx"); print(json.dumps({**{field:max(float(r[field]) for r in rows) for field in fields},"readiness":min(float(r["readiness"]) for r in rows),"samples":len(rows),"target_id":rows[-1]["target_id"],"target_url":rows[-1]["target_url"]}))' "$metrics_ndjson")
jq -e 'all([.ram_percent,.oom_events,.swap_minutes,.disk_percent,.queue_resume_failures,.readiness]; type == "number" and . >= 0) and (.samples | type == "number" and . >= 2) and (.target_id == $id) and (.target_url == $url)' --arg id "$LOAD_DISPOSABLE_TARGET_ID" --arg url "$LOAD_BASE_URL" <<<"$metrics_json" >/dev/null || { printf 'Collected metrics are incomplete or not bound to the load target.\n' >&2; exit 1; }
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
