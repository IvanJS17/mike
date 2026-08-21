import { describe, expect, it } from "vitest";
import { sha256Hex } from "../aiReceipts";
import {
  CIVIL_MERCANTIL_MX_PLAYBOOK,
  CIVIL_MERCANTIL_MX_PLAYBOOK_ID,
  CIVIL_MERCANTIL_MX_PLAYBOOK_PROMPT,
  CIVIL_MERCANTIL_MX_PLAYBOOK_SHA256,
  CIVIL_MERCANTIL_MX_PLAYBOOK_VERSION,
} from "../civilMercantilePlaybook";

describe("Civil/Mercantil MX v0.1 canonical playbook", () => {
  it("exposes a stable identity and hashes the exact canonical prompt", () => {
    expect(CIVIL_MERCANTIL_MX_PLAYBOOK_ID).toBe("civil-mercantil-mx-v0.1");
    expect(CIVIL_MERCANTIL_MX_PLAYBOOK_VERSION).toBe("v0.1");
    expect(CIVIL_MERCANTIL_MX_PLAYBOOK).toEqual({
      id: CIVIL_MERCANTIL_MX_PLAYBOOK_ID,
      version: CIVIL_MERCANTIL_MX_PLAYBOOK_VERSION,
      prompt: CIVIL_MERCANTIL_MX_PLAYBOOK_PROMPT,
      sha256: CIVIL_MERCANTIL_MX_PLAYBOOK_SHA256,
    });
    expect(CIVIL_MERCANTIL_MX_PLAYBOOK_SHA256).toBe(
      "74e27b82faeb9a76c620d4551105e5db0144f1e60c8b2b560b6f0e04dc74485b",
    );
    expect(CIVIL_MERCANTIL_MX_PLAYBOOK_SHA256).toBe(
      sha256Hex(CIVIL_MERCANTIL_MX_PLAYBOOK_PROMPT),
    );
  });

  it("contains the governed risk taxonomy and evidence rules", () => {
    for (const riskId of [
      "R1",
      "R2",
      "R3",
      "R4",
      "R5",
      "R6",
      "R7",
      "R8",
      "R9",
      "R10",
    ]) {
      expect(CIVIL_MERCANTIL_MX_PLAYBOOK_PROMPT).toMatch(
        new RegExp(`\\b${riskId}\\b`),
      );
    }
    expect(CIVIL_MERCANTIL_MX_PLAYBOOK_PROMPT).toMatch(/law/);
    expect(CIVIL_MERCANTIL_MX_PLAYBOOK_PROMPT).toMatch(/heuristic/);
    expect(CIVIL_MERCANTIL_MX_PLAYBOOK_PROMPT).toMatch(/abstain/);
    expect(CIVIL_MERCANTIL_MX_PLAYBOOK_PROMPT).toMatch(
      /texto o el contexto mínimo no permitan verificar un riesgo/i,
    );
    expect(CIVIL_MERCANTIL_MX_PLAYBOOK_PROMPT).toMatch(/exclu/i);
    for (const field of [
      "citation_id",
      "finding_text",
      "quote",
      "quote_sha256",
    ]) {
      expect(CIVIL_MERCANTIL_MX_PLAYBOOK_PROMPT).toContain(field);
    }
    expect(CIVIL_MERCANTIL_MX_PLAYBOOK_PROMPT).toMatch(
      /exact.*quote|quote.*exact/i,
    );
  });
});
