#!/usr/bin/env bash
# Emit sanitized host/container metrics and the backend's internal Prometheus
# metrics. It emits only aggregate resource and timing values; no request bodies or private values are collected.
set -Eeuo pipefail

: "${COMPOSE_FILE:?set COMPOSE_FILE to compose.prod.yml}"
: "${COMPOSE_ENV_FILE:?set COMPOSE_ENV_FILE to the external mode-600 env file}"
: "${LITT_DATA_ROOT:?set LITT_DATA_ROOT to the encrypted mount}"

[[ "$(basename "$COMPOSE_FILE")" == "compose.prod.yml" ]] || {
  printf 'Refusing to collect production metrics from the local Compose file.\n' >&2
  exit 1
}
compose=(docker compose --env-file "$COMPOSE_ENV_FILE" -f "$COMPOSE_FILE")
now=$(date -u +%s)

cpu_total=$(awk '/^cpu / {print $2+$3+$4+$5+$6+$7+$8+$9}' /proc/stat)
ram_total=$(awk '/^MemTotal:/ {print $2 * 1024}' /proc/meminfo)
ram_available=$(awk '/^MemAvailable:/ {print $2 * 1024}' /proc/meminfo)
disk_used_percent=$(df -P "$LITT_DATA_ROOT" | awk 'NR == 2 {gsub(/%/, "", $5); print $5}')

printf '# TYPE litt_host_cpu_jiffies counter\nlitt_host_cpu_jiffies %s\n' "$cpu_total"
printf '# TYPE litt_host_memory_bytes gauge\nlitt_host_memory_bytes{state="total"} %s\nlitt_host_memory_bytes{state="available"} %s\n' "$ram_total" "$ram_available"
printf '# TYPE litt_host_disk_used_percent gauge\nlitt_host_disk_used_percent %s\n' "$disk_used_percent"
printf '# TYPE litt_metrics_timestamp_seconds gauge\nlitt_metrics_timestamp_seconds %s\n' "$now"

# Docker's sanitized resource summary contains only names and resource totals.
docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemPerc}}' | \
  awk -F '\t' 'BEGIN {print "# TYPE litt_container_cpu_percent gauge"; print "# TYPE litt_container_memory_percent gauge"} {gsub(/%/, "", $2); gsub(/%/, "", $3); printf "litt_container_cpu_percent{name=\"%s\"} %s\nlitt_container_memory_percent{name=\"%s\"} %s\n", $1, $2, $1, $3}'

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
