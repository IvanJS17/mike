import { describe, expect, it, vi } from "vitest";
import request from "supertest";

vi.mock("../../lib/readiness", () => ({
  evaluateReadiness: vi.fn(),
}));

import { evaluateReadiness } from "../../lib/readiness";
import { app } from "../../app";

const mockedReadiness = vi.mocked(evaluateReadiness);

describe("GET /ready", () => {
  it("returns 200 only for a fully green dependency set", async () => {
    mockedReadiness.mockResolvedValueOnce({
      ok: true,
      checks: {
        database: { ok: true, duration_ms: 2 },
        storage: { ok: true, duration_ms: 3 },
        auth: { ok: true, duration_ms: 4 },
      },
    });

    const response = await request(app).get("/ready");

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });

  it("returns 503 without exposing dependency errors", async () => {
    mockedReadiness.mockResolvedValueOnce({
      ok: false,
      checks: {
        database: { ok: true, duration_ms: 2 },
        storage: { ok: false, duration_ms: 3 },
        auth: { ok: true, duration_ms: 4 },
      },
    });

    const response = await request(app).get("/ready");

    expect(response.status).toBe(503);
    expect(response.body.ok).toBe(false);
    expect(response.text).not.toMatch(/password|secret|token|credential/i);
  });
});
