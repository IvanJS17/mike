import { beforeEach, describe, expect, it } from "vitest";
import { recordQueueEvent, renderMetrics } from "./metrics";

describe("runtime queue metrics", () => {
  beforeEach(() => recordQueueEvent("reset"));

  it("records queue depth, completion, retry, and publication failure events", () => {
    recordQueueEvent("enqueued");
    recordQueueEvent("completed");
    recordQueueEvent("retry");
    recordQueueEvent("publication_failed");
    const metrics = renderMetrics();
    expect(metrics).toContain("litt_queue_depth 0");
    expect(metrics).toContain("litt_queue_completed_total 1");
    expect(metrics).toContain("litt_queue_retries_total 1");
    expect(metrics).toContain("litt_publication_failures_total 1");
  });
});
