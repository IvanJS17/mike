#!/usr/bin/env bash
# Collect one sanitized sample for the approved disposable WS2 load target.
set -Eeuo pipefail
umask 077
: "${LOAD_DOCKER_CONTEXT:?set LOAD_DOCKER_CONTEXT to the versioned disposable context}"
: "${LOAD_COMPOSE_FILE:?set LOAD_COMPOSE_FILE to compose.prod.yml}"
: "${LOAD_COMPOSE_ENV_FILE:?set LOAD_COMPOSE_ENV_FILE to the disposable mode-600 env file}"
: "${LOAD_PROJECT_NAME:?set LOAD_PROJECT_NAME to the versioned disposable project}"
: "${LOAD_DATA_ROOT:?set LOAD_DATA_ROOT to the encrypted disposable data root}"
: "${LOAD_TARGET_ID:?set LOAD_TARGET_ID to the versioned load target}"
: "${LOAD_BASE_URL:?set LOAD_BASE_URL to the versioned load URL}"
: "${LOAD_ALLOWED_HOST:?set LOAD_ALLOWED_HOST to the versioned load host}"
: "${LITT_APP_ROOT:?set LITT_APP_ROOT to the reviewed checkout}"
root=$(realpath -e "$LITT_APP_ROOT")
target_manifest="$root/infra/production/disposable-targets.json"
jq -e --arg id "$LOAD_TARGET_ID" --arg context "$LOAD_DOCKER_CONTEXT" --arg project "$LOAD_PROJECT_NAME" --arg root "$LOAD_DATA_ROOT" --arg url "$LOAD_BASE_URL" --arg host "$LOAD_ALLOWED_HOST" \
  '(.load.target_id == $id) and (.load.docker_context == $context) and (.load.project == $project) and (.load.data_root == $root) and (.load.base_url == $url) and (.load.host == $host)' "$target_manifest" >/dev/null || { printf 'Disposable metrics target is not versioned.\n' >&2; exit 1; }
[[ "$(realpath -e "$LOAD_COMPOSE_FILE")" == "$root/compose.prod.yml" && "$(realpath -e "$LOAD_COMPOSE_ENV_FILE")" == "$(realpath -e "$LOAD_DATA_ROOT")/secrets/compose.env" ]] || { printf 'Disposable metrics Compose paths are not canonical.\n' >&2; exit 1; }
[[ "$(stat -c '%a' "$LOAD_COMPOSE_ENV_FILE")" == "600" ]] || { printf 'Disposable metrics Compose env must be mode 600.\n' >&2; exit 1; }
[[ "$LOAD_BASE_URL" == https://* && "${LOAD_BASE_URL#https://}" == "$LOAD_ALLOWED_HOST" ]] || { printf 'Disposable metrics URL is not the approved HTTPS host.\n' >&2; exit 1; }
docker_prefix=(docker --context "$LOAD_DOCKER_CONTEXT")
compose=("${docker_prefix[@]}" compose --env-file "$LOAD_COMPOSE_ENV_FILE" -f "$LOAD_COMPOSE_FILE" -p "$LOAD_PROJECT_NAME")
ram_total=$(awk '/^MemTotal:/ {print $2 * 1024}' /proc/meminfo)
ram_available=$(awk '/^MemAvailable:/ {print $2 * 1024}' /proc/meminfo)
ram_percent=$(awk -v total="$ram_total" -v available="$ram_available" 'BEGIN {printf "%.4f", (total-available)*100/total}')
disk_percent=$(df -P "$LOAD_DATA_ROOT" | awk 'NR == 2 {gsub(/%/, "", $5); print $5}')
swap_total=$(awk '/^SwapTotal:/ {print $2}' /proc/meminfo)
swap_free=$(awk '/^SwapFree:/ {print $2}' /proc/meminfo)
swap_minutes=0
if [[ "$swap_total" -gt 0 && "$swap_free" -lt "$swap_total" ]]; then swap_minutes=6; fi
mapfile -t container_ids < <("${compose[@]}" ps -q)
oom_events=0
for container_id in "${container_ids[@]}"; do
  [[ -n "$container_id" ]] || continue
  oom=$("${docker_prefix[@]}" inspect --format '{{if .State.OOMKilled}}1{{else}}0{{end}}' "$container_id")
  oom_events=$((oom_events + oom))
done
readiness=$("${compose[@]}" exec -T backend node -e 'fetch("http://127.0.0.1:3001/ready").then(async r => { const b=await r.json(); process.stdout.write(r.ok && b.ok === true ? "1" : "0"); }).catch(() => process.stdout.write("0"));' | tr -d '[:space:]')
metrics=$("${compose[@]}" exec -T backend node -e 'fetch("http://127.0.0.1:3001/metrics").then(async r => { if(!r.ok) process.exit(1); process.stdout.write(await r.text()); }).catch(() => process.exit(1));')
metric_value() { awk -v name="$1" '$1 == name {print $2; found=1} END {if (!found) print 0}' <<<"$metrics"; }
queue_resume_failures=$(metric_value litt_queue_retries_total)
queue_depth=$(metric_value litt_queue_depth)
p95_ms=$(metric_value litt_http_request_duration_ms_p95)
five_xx=$(metric_value litt_http_5xx_total)
request_count=$(metric_value litt_http_requests_total)
jq -n \
  --arg target_id "$LOAD_TARGET_ID" --arg target_url "$LOAD_BASE_URL" --arg collected_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson ram_percent "$ram_percent" --argjson oom_events "$oom_events" --argjson swap_minutes "$swap_minutes" --argjson disk_percent "$disk_percent" \
  --argjson queue_resume_failures "$queue_resume_failures" --argjson queue_depth "$queue_depth" --argjson p95_ms "$p95_ms" --argjson five_xx "$five_xx" --argjson requests "$request_count" --argjson readiness "${readiness:-0}" \
  '{target_id:$target_id,target_url:$target_url,collected_at:$collected_at,ram_percent:$ram_percent,oom_events:$oom_events,swap_minutes:$swap_minutes,disk_percent:$disk_percent,queue_resume_failures:$queue_resume_failures,queue_depth:$queue_depth,p95_ms:$p95_ms,five_xx:$five_xx,requests:$requests,readiness:$readiness}'
