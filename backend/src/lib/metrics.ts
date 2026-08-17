import type { NextFunction, Request, Response } from "express";

let requestCount = 0;
let serverErrorCount = 0;
let queueDepth = 0;
let queueRetries = 0;
let queueCompleted = 0;
let publicationFailures = 0;
const durations: number[] = [];
const MAX_SAMPLES = 1000;

type QueueEvent = "reset" | "enqueued" | "completed" | "retry" | "publication_failed";

export function recordQueueEvent(event: QueueEvent): void {
  switch (event) {
    case "reset":
      queueDepth = 0;
      queueRetries = 0;
      queueCompleted = 0;
      publicationFailures = 0;
      break;
    case "enqueued":
      queueDepth += 1;
      break;
    case "completed":
      queueDepth = Math.max(0, queueDepth - 1);
      queueCompleted += 1;
      break;
    case "retry":
      queueDepth = Math.max(0, queueDepth - 1);
      queueRetries += 1;
      break;
    case "publication_failed":
      publicationFailures += 1;
      break;
  }
}

export function metricsMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const started = process.hrtime.bigint();
  const queueRequest = /\/(batches?|workflows|chat)(\/|$)/.test(req.path);
  const publicationRequest = /publication/i.test(req.path);
  if (queueRequest) recordQueueEvent("enqueued");
  res.once("finish", () => {
    requestCount += 1;
    if (res.statusCode >= 500) serverErrorCount += 1;
    if (queueRequest) recordQueueEvent(res.statusCode >= 500 ? "retry" : "completed");
    if (publicationRequest && res.statusCode >= 500) recordQueueEvent("publication_failed");
    const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    durations.push(durationMs);
    if (durations.length > MAX_SAMPLES) durations.shift();
  });
  next();
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
    `litt_queue_depth ${queueDepth}`,
    "# TYPE litt_queue_retries_total counter",
    `litt_queue_retries_total ${queueRetries}`,
    "# TYPE litt_queue_completed_total counter",
    `litt_queue_completed_total ${queueCompleted}`,
    "# TYPE litt_publication_failures_total counter",
    `litt_publication_failures_total ${publicationFailures}`,
    "",
  ].join("\n");
}
