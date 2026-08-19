import { describe, expect, it } from "vitest";
import {
  assertAiExecutionTransition,
  canReadAiExecution,
  canStartAiExecution,
  type AiExecutionStatus,
} from "../aiExecutions";

describe("AI execution state machine", () => {
  it.each([
    ["pending", "running"],
    ["pending", "failed"],
    ["running", "succeeded"],
    ["running", "failed"],
  ] as [AiExecutionStatus, AiExecutionStatus][]) (
    "allows %s -> %s",
    (from, to) => {
      expect(() => assertAiExecutionTransition(from, to)).not.toThrow();
    },
  );

  it.each([
    ["pending", "succeeded"],
    ["succeeded", "running"],
    ["succeeded", "failed"],
    ["failed", "running"],
    ["failed", "succeeded"],
  ] as [AiExecutionStatus, AiExecutionStatus][]) (
    "rejects %s -> %s",
    (from, to) => {
      expect(() => assertAiExecutionTransition(from, to)).toThrow(
        "Invalid AI execution status transition",
      );
    },
  );

  it("allows only matter editors to start and every matter member to read", () => {
    expect(canStartAiExecution("matter_owner")).toBe(true);
    expect(canStartAiExecution("editor")).toBe(true);
    expect(canStartAiExecution("technical_operator")).toBe(true);
    expect(canStartAiExecution("viewer")).toBe(false);
    expect(canStartAiExecution(null)).toBe(false);

    expect(canReadAiExecution("viewer")).toBe(true);
    expect(canReadAiExecution("technical_operator")).toBe(true);
    expect(canReadAiExecution(null)).toBe(false);
  });
});
