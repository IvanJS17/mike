/**
 * Slice D — governed Civil/Mercantile MX triage content.
 *
 * This is a faithful, bounded port of R4, R6 and R9 plus the explicit
 * abstention and authority limits from the immutable LiTT source baseline.
 */

import { createHash } from "node:crypto";
import type { GovernedWorkflowCatalogRow } from "./governedWorkflowCatalog";

const SOURCE_COMMIT = "d9fa8380e63837b6441cef169cf5ef80dfb55e54";
const SOURCE_PATH = "docs/playbooks/PLAYBOOK_CIVIL_MERCANTIL_MX_v0.1.md";

export const MX_CIVIL_COMMERCIAL_PLAYBOOK = Object.freeze({
  id: "civil-commercial-mx-triage",
  version: "0.1.0",
  jurisdiction: "MX",
  purpose: "documented triage, not legal advice for a real matter",
  source_path: SOURCE_PATH,
  source_baseline: SOURCE_COMMIT,
  source_status: "Beta read-only specification",
  legal_validation: "pending",
  operation: Object.freeze({
    finding_rule:
      "Each finding is a verifiable observation, not an absolute legal conclusion.",
    evidence_rule:
      "Preserve a source-document quote and a separate normative quote whenever external law is invoked.",
    abstention_rule:
      "Return abstain when the text or minimum context is insufficient; do not infer or complete from general knowledge.",
    labels: Object.freeze(["heuristic", "law"] as const),
  }),
  authority_limits: Object.freeze([
    Object.freeze({
      label: "law",
      statement:
        "Do not automatically apply the Federal Civil Code to a contract governed by a local civil code; escalate that selection to human review.",
    }),
    Object.freeze({
      label: "law",
      statement:
        "SCJN record 19880 concerns article 1743 of the Civil Code of Nuevo León and must not be presented as a general Federal Civil Code rule.",
    }),
    Object.freeze({
      label: "law",
      statement:
        "SCJN record 21028 concerns commercial contracts and partial breach; verify its text and scope before use.",
    }),
    Object.freeze({
      label: "heuristic",
      statement:
        "Do not determine definitive validity, applicable jurisprudence, tax treatment, unstated facts, or litigation strategy.",
    }),
  ] as const),
  risks: Object.freeze([
    Object.freeze({
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
    }),
    Object.freeze({
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
    }),
    Object.freeze({
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
    }),
  ] as const),
});

export const MX_CIVIL_COMMERCIAL_CONTENT_HASH = createHash("sha256")
  .update(JSON.stringify(MX_CIVIL_COMMERCIAL_PLAYBOOK))
  .digest("hex");

export const MX_CIVIL_COMMERCIAL_CATALOG_ROW = Object.freeze({
  workflow_key: MX_CIVIL_COMMERCIAL_PLAYBOOK.id,
  version: MX_CIVIL_COMMERCIAL_PLAYBOOK.version,
  content_hash: MX_CIVIL_COMMERCIAL_CONTENT_HASH,
  source_commit: SOURCE_COMMIT,
  distribution: "addon",
  type: "assistant",
  active: true,
  source: SOURCE_PATH,
  approval_provenance:
    "Beta read-only specification; later legal validation remains pending",
} satisfies GovernedWorkflowCatalogRow);
