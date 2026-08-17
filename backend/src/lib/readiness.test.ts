import { describe, expect, it } from "vitest";
import { evaluateReadiness, type ReadinessDependencies } from "./readiness";

const healthy: ReadinessDependencies = {
  database: async () => undefined,
  storage: async () => undefined,
  auth: async () => undefined,
};

describe("evaluateReadiness", () => {
  it("is green only when database, storage, and Auth all respond", async () => {
    const result = await evaluateReadiness(healthy);

    expect(result.ok).toBe(true);
    expect(result.checks).toEqual({
      database: { ok: true, duration_ms: expect.any(Number) },
      storage: { ok: true, duration_ms: expect.any(Number) },
      auth: { ok: true, duration_ms: expect.any(Number) },
    });
  });

  it("returns 503-safe state when one dependency fails without exposing its error", async () => {
    const result = await evaluateReadiness({
      ...healthy,
      storage: async () => {
        throw new Error("bucket credential must never be returned");
      },
    });

    expect(result.ok).toBe(false);
    expect(result.checks.storage.ok).toBe(false);
    expect(result).not.toHaveProperty("error");
    expect(JSON.stringify(result)).not.toContain("bucket credential");
  });
});
