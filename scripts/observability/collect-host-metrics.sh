#!/usr/bin/env bash
# Emit sanitized host/container metrics and the backend's internal Prometheus
# metrics. It emits only aggregate resource and timing values; no request bodies or private values are collected.
set -Eeuo pipefail

: "${COMPOSE_FILE:?set COMPOSE_FILE to compose.prod.yml}"
: "${COMPOSE_ENV_FILE:?set COMPOSE_ENV_FILE to the external mode-600 env file}"
: "${COMPOSE_PROJECT_NAME:?set COMPOSE_PROJECT_NAME=litt-production}"
: "${LITT_APP_ROOT:?set LITT_APP_ROOT to the deployed production checkout}"
: "${LITT_DATA_ROOT:?set LITT_DATA_ROOT to /srv/litt-data}"
: "${LITT_SECRETS_ROOT:?set LITT_SECRETS_ROOT to /srv/litt-data/secrets}"
: "${BACKUP_FRESHNESS_FILE:?set BACKUP_FRESHNESS_FILE to backup-freshness.json}"
: "${RESTORE_RECEIPT_FILE:?set RESTORE_RECEIPT_FILE to the latest restore receipt}"

root=$(realpath -e "$LITT_APP_ROOT")
expected_compose="$root/compose.prod.yml"
data_root=$(realpath -e "$LITT_DATA_ROOT")
secrets_root=$(realpath -e "$LITT_SECRETS_ROOT")
[[ "$data_root" == "/srv/litt-data" && "$secrets_root" == "/srv/litt-data/secrets" ]] || { printf 'Metrics data/secrets roots are not canonical.\n' >&2; exit 1; }
[[ "$(realpath -e "$COMPOSE_FILE")" == "$expected_compose" && "$COMPOSE_PROJECT_NAME" == "litt-production" ]] || {
  printf 'Refusing non-canonical production metrics target.\n' >&2
  exit 1
}
[[ "$(realpath -e "$COMPOSE_ENV_FILE")" == "$secrets_root/compose.env" && "$(stat -c '%a' "$COMPOSE_ENV_FILE")" == "600" ]] || { printf 'Metrics Compose env is not canonical mode 600.\n' >&2; exit 1; }
[[ "$(realpath -m "$BACKUP_FRESHNESS_FILE")" == "$data_root/state/backup-freshness.json" ]] || { printf 'Metrics freshness path is not canonical.\n' >&2; exit 1; }
[[ "$(realpath -m "$RESTORE_RECEIPT_FILE")" == "$data_root/state/restore-receipt.json" ]] || { printf 'Metrics restore receipt path is not canonical.\n' >&2; exit 1; }
compose=(docker compose --env-file "$COMPOSE_ENV_FILE" -f "$expected_compose" -p litt-production)
now=$(date -u +%s)

cpu_total=$(awk '/^cpu / {print $2+$3+$4+$5+$6+$7+$8+$9}' /proc/stat)
ram_total=$(awk '/^MemTotal:/ {print $2 * 1024}' /proc/meminfo)
ram_available=$(awk '/^MemAvailable:/ {print $2 * 1024}' /proc/meminfo)
disk_used_percent=$(df -P "$LITT_DATA_ROOT" | awk 'NR == 2 {gsub(/%/, "", $5); print $5}')

printf '# TYPE litt_host_cpu_jiffies counter\nlitt_host_cpu_jiffies %s\n' "$cpu_total"
printf '# TYPE litt_host_memory_bytes gauge\nlitt_host_memory_bytes{state="total"} %s\nlitt_host_memory_bytes{state="available"} %s\n' "$ram_total" "$ram_available"
printf '# TYPE litt_host_disk_used_percent gauge\nlitt_host_disk_used_percent %s\n' "$disk_used_percent"
printf '# TYPE litt_metrics_timestamp_seconds gauge\nlitt_metrics_timestamp_seconds %s\n' "$now"

# Docker's sanitized resource summary is limited to this Compose project.
mapfile -t container_ids < <("${compose[@]}" ps -q)
if ((${#container_ids[@]} > 0)); then
  docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemPerc}}' "${container_ids[@]}" | \
    awk -F '\t' 'BEGIN {print "# TYPE litt_container_cpu_percent gauge"; print "# TYPE litt_container_memory_percent gauge"} {gsub(/%/, "", $2); gsub(/%/, "", $3); printf "litt_container_cpu_percent{name=\"%s\"} %s\nlitt_container_memory_percent{name=\"%s\"} %s\n", $1, $2, $1, $3}'
fi
printf '# TYPE litt_container_oom_events gauge\n'
while IFS= read -r container_id; do
  [[ -n "$container_id" ]] || continue
  name=$(docker inspect --format '{{.Name}}' "$container_id" | tr -d '/')
  oom=$(docker inspect --format '{{if .State.OOMKilled}}1{{else}}0{{end}}' "$container_id")
  printf 'litt_container_oom_events{name="%s"} %s\n' "$name" "$oom"
done < <("${compose[@]}" ps -q)
printf '# TYPE litt_backup_last_success_timestamp_seconds gauge\n'
backup_time=0
if [[ -f "$BACKUP_FRESHNESS_FILE" ]]; then
  backup_time=$(date -u -d "$(jq -r '.latest_completed_at // empty' "$BACKUP_FRESHNESS_FILE")" +%s 2>/dev/null || printf '0')
fi
printf 'litt_backup_last_success_timestamp_seconds %s\n' "$backup_time"
printf '# TYPE litt_restore_last_success gauge\n'
restore_ok=0
if [[ -f "$RESTORE_RECEIPT_FILE" ]] && jq -e '.status == "success"' "$RESTORE_RECEIPT_FILE" >/dev/null 2>&1; then restore_ok=1; fi
printf 'litt_restore_last_success %s\n' "$restore_ok"

# The backend endpoint includes queue depth/retries and request duration metrics.
readiness=$("${compose[@]}" exec -T backend node -e '
fetch("http://127.0.0.1:3001/ready").then((r) => process.stdout.write(r.ok ? "1\n" : "0\n")).catch(() => process.stdout.write("0\n"));
' || printf '0\n')
printf '# TYPE litt_readiness gauge\nlitt_readiness %s' "$(tr -d '[:space:]' <<<"$readiness")"
printf '\n'
"${compose[@]}" exec -T backend node -e '
fetch("http://127.0.0.1:3001/metrics").then(async (r) => {
  if (!r.ok) process.exit(1);
  process.stdout.write(await r.text());
}).catch(() => process.exit(1));
'
