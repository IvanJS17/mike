import { afterEach, describe, expect, it } from "vitest";
import {
  buildSyntheticWorkflowBody,
  isSyntheticLoadDisabled,
  validateSyntheticBatch,
} from "./syntheticLoad";

afterEach(() => {
  delete process.env.NODE_ENV;
  delete process.env.SYNTHETIC_LOAD_ENABLED;
});

describe("synthetic load seam", () => {
  it("is denied in production even when the feature flag is true", () => {
    process.env.NODE_ENV = "production";
    process.env.SYNTHETIC_LOAD_ENABLED = "true";
    expect(isSyntheticLoadDisabled()).toBe(true);
  });

  it("accepts only the exact 100-document and 1000-page batch contract", () => {
    expect(validateSyntheticBatch({
      load_run: "ws2-1",
      synthetic: true,
      documents: 100,
      pages: 1000,
    })).toBe(true);
    expect(validateSyntheticBatch({
      load_run: "ws2-1",
      synthetic: true,
      documents: 99,
      pages: 1000,
    })).toBe(false);
  });

  it("builds a workflow payload accepted by the real workflow route", () => {
    expect(buildSyntheticWorkflowBody("ws2-1")).toEqual({
      metadata: { title: "WS2 synthetic workflow ws2-1", type: "assistant" },
    });
  });
});
