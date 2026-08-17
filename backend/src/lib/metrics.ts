import type { NextFunction, Request, Response } from "express";

let requestCount = 0;
let serverErrorCount = 0;
const durations: number[] = [];
const MAX_SAMPLES = 1000;

export function metricsMiddleware(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  const started = process.hrtime.bigint();
  res.once("finish", () => {
    requestCount += 1;
    if (res.statusCode >= 500) serverErrorCount += 1;
    const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    durations.push(durationMs);
    if (durations.length > MAX_SAMPLES) durations.shift();
  });
  next();
}

function numberEnv(name: string): number {
  const value = Number(process.env[name] ?? 0);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

export function renderMetrics(): string {
  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();
  const p95 = percentile(durations, 0.95);
  return [
    "# TYPE process_resident_memory_bytes gauge",
    `process_resident_memory_bytes ${memory.rss}`,
    "# TYPE process_heap_used_bytes gauge",
    `process_heap_used_bytes ${memory.heapUsed}`,
    "# TYPE process_cpu_user_seconds_total counter",
    `process_cpu_user_seconds_total ${cpu.user / 1_000_000}`,
    "# TYPE process_cpu_system_seconds_total counter",
    `process_cpu_system_seconds_total ${cpu.system / 1_000_000}`,
    "# TYPE process_uptime_seconds gauge",
    `process_uptime_seconds ${process.uptime()}`,
    "# TYPE litt_http_requests_total counter",
    `litt_http_requests_total ${requestCount}`,
    "# TYPE litt_http_5xx_total counter",
    `litt_http_5xx_total ${serverErrorCount}`,
    "# TYPE litt_http_request_duration_ms_p95 gauge",
    `litt_http_request_duration_ms_p95 ${p95}`,
    "# TYPE litt_queue_depth gauge",
    `litt_queue_depth ${numberEnv("LITT_QUEUE_DEPTH")}`,
    "# TYPE litt_queue_retries_total counter",
    `litt_queue_retries_total ${numberEnv("LITT_QUEUE_RETRIES_TOTAL")}`,
    "# TYPE litt_queue_completed_total counter",
    `litt_queue_completed_total ${numberEnv("LITT_QUEUE_COMPLETED_TOTAL")}`,
    "# TYPE litt_publication_failures_total counter",
    `litt_publication_failures_total ${numberEnv("LITT_PUBLICATION_FAILURES_TOTAL")}`,
    "",
  ].join("\n");
}
