import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  MX_CIVIL_COMMERCIAL_CATALOG_ROW,
  MX_CIVIL_COMMERCIAL_CONTENT_HASH,
  MX_CIVIL_COMMERCIAL_PLAYBOOK,
} from "./mxCivilCommercialPlaybook";

const SOURCE_COMMIT = "d9fa8380e63837b6441cef169cf5ef80dfb55e54";
const SOURCE_PATH = "docs/playbooks/PLAYBOOK_CIVIL_MERCANTIL_MX_v0.1.md";
const APPROVAL =
  "Beta read-only specification; later legal validation remains pending";

const EXPECTED_PLAYBOOK = {
  id: "civil-commercial-mx-triage",
  version: "0.1.0",
  jurisdiction: "MX",
  purpose: "documented triage, not legal advice for a real matter",
  source_path: SOURCE_PATH,
  source_baseline: SOURCE_COMMIT,
  source_status: "Beta read-only specification",
  legal_validation: "pending",
  operation: {
    finding_rule:
      "Each finding is a verifiable observation, not an absolute legal conclusion.",
    evidence_rule:
      "Preserve a source-document quote and a separate normative quote whenever external law is invoked.",
    abstention_rule:
      "Return abstain when the text or minimum context is insufficient; do not infer or complete from general knowledge.",
    labels: ["heuristic", "law"],
  },
  authority_limits: [
    {
      label: "law",
      statement:
        "Do not automatically apply the Federal Civil Code to a contract governed by a local civil code; escalate that selection to human review.",
    },
    {
      label: "law",
      statement:
        "SCJN record 19880 concerns article 1743 of the Civil Code of Nuevo León and must not be presented as a general Federal Civil Code rule.",
    },
    {
      label: "law",
      statement:
        "SCJN record 21028 concerns commercial contracts and partial breach; verify its text and scope before use.",
    },
    {
      label: "heuristic",
      statement:
        "Do not determine definitive validity, applicable jurisprudence, tax treatment, unstated facts, or litigation strategy.",
    },
  ],
  risks: [
    {
      id: "R4",
      risk: "Contraprestación",
      label: "heuristic",
      trigger:
        "Precio, moneda, impuestos, facturación, vencimiento, reajuste o condición de pago falta o contradice otra cláusula",
      evidence: "Precio/fees, órdenes, facturas, impuestos y pago",
      severity: "high",
      expected:
        "Señalar variable no determinada o conflicto; no calcular monto",
      abstain: "No asumir IVA, moneda, interés o fórmula no escrita",
    },
    {
      id: "R6",
      risk: "Incumplimiento/pena",
      label: "heuristic",
      trigger:
        "Incumplimiento no definido, pena sin evento/monto/límite, o remedios acumulados ambiguos",
      evidence:
        "Default, cure, penalty/liquidated damages, intereses y remedios",
      severity: "high",
      expected:
        "Distinguir incumplimiento total, mora y cumplimiento defectuoso; advertir doble recuperación como riesgo a revisar",
      abstain:
        "No afirmar exigibilidad ni compatibilidad de remedios sin texto y ley aplicable",
    },
    {
      id: "R9",
      risk: "Ley/jurisdicción",
      label: "heuristic",
      trigger:
        "Governing law, foro, arbitraje, sede, idioma o notificaciones faltan o son incompatibles",
      evidence:
        "Governing law, dispute resolution, venue, arbitration y notices",
      severity: "high",
      expected:
        "Reportar foro/ley textuales y conflicto; escalar elección local/federal",
      abstain:
        "No decir que un foro es válido, exclusivo o ejecutable sin revisión humana",
    },
  ],
} as const;

describe("Civil/Mercantile MX governed content", () => {
  it("ports exactly R4, R6 and R9 with authoritative triage fields", () => {
    expect(MX_CIVIL_COMMERCIAL_PLAYBOOK).toEqual(EXPECTED_PLAYBOOK);
    expect(MX_CIVIL_COMMERCIAL_PLAYBOOK.risks.map((risk) => risk.id)).toEqual([
      "R4",
      "R6",
      "R9",
    ]);
    for (const risk of MX_CIVIL_COMMERCIAL_PLAYBOOK.risks) {
      expect(Object.keys(risk).sort()).toEqual(
        [
          "abstain",
          "evidence",
          "expected",
          "id",
          "label",
          "risk",
          "severity",
          "trigger",
        ].sort(),
      );
      expect(risk.label).toBe("heuristic");
      expect(risk.severity).toBe("high");
    }
  });

  it("has a deterministic lowercase SHA-256 over exact governed content", () => {
    const independentlyComputed = createHash("sha256")
      .update(JSON.stringify(EXPECTED_PLAYBOOK))
      .digest("hex");
    expect(MX_CIVIL_COMMERCIAL_CONTENT_HASH).toBe(independentlyComputed);
    expect(MX_CIVIL_COMMERCIAL_CONTENT_HASH).toMatch(/^[0-9a-f]{64}$/);
  });

  it("builds an executable catalog row with truthful pending provenance", () => {
    expect(MX_CIVIL_COMMERCIAL_CATALOG_ROW).toEqual({
      workflow_key: "civil-commercial-mx-triage",
      version: "0.1.0",
      content_hash: MX_CIVIL_COMMERCIAL_CONTENT_HASH,
      source_commit: SOURCE_COMMIT,
      distribution: "addon",
      type: "assistant",
      active: true,
      source: SOURCE_PATH,
      approval_provenance: APPROVAL,
    });
    expect(MX_CIVIL_COMMERCIAL_CATALOG_ROW.active).toBe(true);
    expect(MX_CIVIL_COMMERCIAL_CATALOG_ROW.approval_provenance).toContain(
      "pending",
    );
    expect(Object.isFrozen(MX_CIVIL_COMMERCIAL_CATALOG_ROW)).toBe(true);
  });

  it("preserves abstention and conditioned-authority limits", () => {
    const serialized = JSON.stringify(MX_CIVIL_COMMERCIAL_PLAYBOOK);
    expect(serialized).toContain("Return abstain");
    expect(serialized).toContain("must not be presented as a general");
    expect(serialized).toContain("verify its text and scope before use");
    expect(serialized).toContain("not legal advice");
    expect(serialized).toContain('"label":"heuristic"');
    expect(serialized).toContain('"label":"law"');
  });

  it("does not invent approval or forbidden general authority claims", () => {
    const serialized = JSON.stringify({
      playbook: MX_CIVIL_COMMERCIAL_PLAYBOOK,
      catalog: MX_CIVIL_COMMERCIAL_CATALOG_ROW,
    }).toLowerCase();
    for (const forbidden of [
      "legal validation complete",
      "legally approved",
      "asesoría jurídica para un caso real",
      "regla general del código civil federal",
      "foro válido y ejecutable",
      "jurisprudencia aplicable determinada",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe("runtime export and import lock", () => {
  it("exports only immutable governed MX content", async () => {
    const mod = await import("./mxCivilCommercialPlaybook");
    expect(Object.keys(mod).sort()).toEqual(
      [
        "MX_CIVIL_COMMERCIAL_CATALOG_ROW",
        "MX_CIVIL_COMMERCIAL_CONTENT_HASH",
        "MX_CIVIL_COMMERCIAL_PLAYBOOK",
      ].sort(),
    );
  });

  it("has no legacy catalog, storage, database, route or network import", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(
      join(here, "mxCivilCommercialPlaybook.ts"),
      "utf8",
    );
    expect(source).toContain("governedWorkflowCatalog");
    for (const banned of [
      "systemWorkflows",
      "workflowCatalogSource",
      "workflowCatalogSync",
      "storage",
      "supabase",
      "routes/",
      "fetch(",
      "node:http",
      "undici",
    ]) {
      expect(source).not.toContain(banned);
    }
  });
});
