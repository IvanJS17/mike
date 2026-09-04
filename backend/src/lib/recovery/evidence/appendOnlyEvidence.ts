import { createHash } from "node:crypto";

import type { AuthenticatedIdentity } from "../identity/authStateMatrix";
import {
  makeBlockedOperation,
  type BlockedOperation,
  type ExecutionProvenance,
} from "../sharedContracts";
import type { AuthorizationScope } from "../authorization/evaluateAccess";
import {
  recheckFreshAccessViaPort,
  type TenancyReadPort,
} from "../authorization/tenancyReadPort";
import { verifyCitationBatch, type VerifiedCitation } from "./citationEvidence";
import { buildExecutionProvenance } from "./executionEvidence";

export type EvidencePage = {
  document_id: string;
  document_version_id: string;
  page: number;
  text: string;
  text_sha256: string;
};
export type EvidenceOutput = {
  execution_id: string;
  output_text: string;
  output_sha256: string;
};
export type EvidenceAppendCounts = {
  pages: number;
  outputs: 1;
  citations: number;
};
export type CanonicalEvidenceReceipt = {
  receipt_version: "evidence-v1";
  canonical_json: string;
  receipt_sha256: string;
};
export type FrozenEvidenceBatch = {
  idempotency_key: string;
  execution: { execution_id: string; provenance: ExecutionProvenance };
  pages: readonly EvidencePage[];
  output: EvidenceOutput;
  citations: readonly VerifiedCitation[];
  receipt: CanonicalEvidenceReceipt;
};
export type AtomicEvidenceAppendReceipt = {
  disposition: "applied" | "replayed";
  idempotency_key: string;
  execution_id: string;
  receipt_sha256: string;
  counts: EvidenceAppendCounts;
};

export interface AtomicEvidenceAppendPort {
  append(batch: FrozenEvidenceBatch): Promise<unknown>;
}

export type EvidenceAppendFailure = {
  ok: false;
  error_class:
    | "invalid_evidence_append"
    | "evidence_authorization_failed"
    | "authorization_dependency_failed"
    | "evidence_append_failed";
};

const SHA256_RE = /^[0-9a-f]{64}$/;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const RECEIPT_KEYS = [
  "disposition",
  "idempotency_key",
  "execution_id",
  "receipt_sha256",
  "counts",
] as const;
const COUNT_KEYS = ["pages", "outputs", "citations"] as const;
const EVIDENCE_KEYS = [
  "execution_id",
  "provenance",
  "pages",
  "output",
  "citation_candidates",
] as const;
const PAGE_KEYS = [
  "document_id",
  "document_version_id",
  "page",
  "text",
  "text_sha256",
] as const;
const OUTPUT_KEYS = ["execution_id", "output_text", "output_sha256"] as const;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}
function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => codeUnitCompare(left, right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`);
  return `{${entries.join(",")}}`;
}
function failure(
  error_class: EvidenceAppendFailure["error_class"],
): EvidenceAppendFailure {
  return Object.freeze({ ok: false as const, error_class });
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value as Record<string, unknown>))
      deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}
function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort(codeUnitCompare);
  const b = [...right].sort(codeUnitCompare);
  return a.every((value, index) => value === b[index]);
}

export function buildCanonicalEvidenceReceipt(input: {
  execution_id: string;
  idempotency_key: string;
  provenance: ExecutionProvenance;
  pages: readonly EvidencePage[];
  output: EvidenceOutput;
  citations: readonly VerifiedCitation[];
}): { ok: true; receipt: CanonicalEvidenceReceipt } | EvidenceAppendFailure {
  try {
    const body = {
      receipt_version: "evidence-v1",
      idempotency_key: input.idempotency_key,
      execution_id: input.execution_id,
      tenant_scope: input.provenance.tenant_scope,
      route: input.provenance.route,
      workflow: input.provenance.workflow,
      status: input.provenance.status,
      input_hashes: [...input.provenance.input_hashes].sort(codeUnitCompare),
      page_hashes: [...input.pages]
        .sort((left, right) => left.page - right.page)
        .map(({ document_id, document_version_id, page, text_sha256 }) => ({
          document_id,
          document_version_id,
          page,
          text_sha256,
        })),
      output_hash: input.output.output_sha256,
      citation_hashes: [...input.citations]
        .sort((left, right) =>
          codeUnitCompare(left.citation_id, right.citation_id),
        )
        .map(
          ({
            citation_id,
            document_id,
            document_version_id,
            page,
            span,
            quote_sha256,
          }) => ({
            citation_id,
            document_id,
            document_version_id,
            page,
            span,
            quote_sha256,
          }),
        ),
    };
    const canonical_json = canonicalize(body);
    return deepFreeze({
      ok: true as const,
      receipt: {
        receipt_version: "evidence-v1" as const,
        canonical_json,
        receipt_sha256: sha256(canonical_json),
      },
    });
  } catch {
    return failure("invalid_evidence_append");
  }
}

function prepare(input: { idempotency_key: unknown; evidence: unknown }):
  | {
      ok: true;
      batch: Omit<FrozenEvidenceBatch, "receipt">;
      receipt: CanonicalEvidenceReceipt;
    }
  | EvidenceAppendFailure {
  try {
    if (
      typeof input.idempotency_key !== "string" ||
      !IDEMPOTENCY_KEY_RE.test(input.idempotency_key) ||
      !record(input.evidence)
    )
      return failure("invalid_evidence_append");
    const evidence = input.evidence;
    if (
      !exact(evidence, EVIDENCE_KEYS) ||
      typeof evidence.execution_id !== "string" ||
      !evidence.execution_id ||
      !Array.isArray(evidence.pages) ||
      !record(evidence.output) ||
      !exact(evidence.output, OUTPUT_KEYS) ||
      !Array.isArray(evidence.citation_candidates)
    )
      return failure("invalid_evidence_append");
    const parsedProvenance = buildExecutionProvenance(evidence.provenance);
    if (
      !parsedProvenance.ok ||
      parsedProvenance.provenance.status !== "completed"
    )
      return failure("invalid_evidence_append");
    const provenance = parsedProvenance.provenance;
    const output = evidence.output;
    if (
      output.execution_id !== evidence.execution_id ||
      typeof output.output_text !== "string" ||
      typeof output.output_sha256 !== "string" ||
      !SHA256_RE.test(output.output_sha256) ||
      sha256(output.output_text) !== output.output_sha256 ||
      !sameStrings(provenance.output_hashes, [output.output_sha256])
    )
      return failure("invalid_evidence_append");

    const pages: EvidencePage[] = [];
    const pageNumbers = new Set<number>();
    for (const item of evidence.pages) {
      if (
        !record(item) ||
        !exact(item, PAGE_KEYS) ||
        typeof item.document_id !== "string" ||
        !item.document_id ||
        item.document_version_id !==
          provenance.tenant_scope.document_version_id ||
        !Number.isInteger(item.page) ||
        (item.page as number) < 1 ||
        pageNumbers.has(item.page as number) ||
        typeof item.text !== "string" ||
        typeof item.text_sha256 !== "string" ||
        !SHA256_RE.test(item.text_sha256) ||
        sha256(item.text) !== item.text_sha256
      )
        return failure("invalid_evidence_append");
      pageNumbers.add(item.page as number);
      pages.push({
        document_id: item.document_id,
        document_version_id: item.document_version_id as string,
        page: item.page as number,
        text: item.text,
        text_sha256: item.text_sha256,
      });
    }
    if (pages.length === 0) return failure("invalid_evidence_append");
    pages.sort((left, right) => left.page - right.page);
    const documentId = pages[0].document_id;
    if (pages.some((page) => page.document_id !== documentId))
      return failure("invalid_evidence_append");
    const citations = verifyCitationBatch(evidence.citation_candidates, {
      document_id: documentId,
      document_version_id: provenance.tenant_scope.document_version_id,
      page_count: pages[pages.length - 1].page,
      pages: pages.map(({ page, text, text_sha256 }) => ({
        page,
        text,
        text_sha256,
      })),
    });
    if (
      !citations.ok ||
      !sameStrings(
        provenance.citation_hashes,
        citations.citations.map((citation) => citation.quote_sha256),
      )
    )
      return failure("invalid_evidence_append");
    const normalizedOutput: EvidenceOutput = {
      execution_id: evidence.execution_id,
      output_text: output.output_text,
      output_sha256: output.output_sha256,
    };
    const receipt = buildCanonicalEvidenceReceipt({
      execution_id: evidence.execution_id,
      idempotency_key: input.idempotency_key,
      provenance,
      pages,
      output: normalizedOutput,
      citations: citations.citations,
    });
    if (!receipt.ok) return receipt;
    return {
      ok: true,
      batch: {
        idempotency_key: input.idempotency_key,
        execution: { execution_id: evidence.execution_id, provenance },
        pages,
        output: normalizedOutput,
        citations: citations.citations,
      },
      receipt: receipt.receipt,
    };
  } catch {
    return failure("invalid_evidence_append");
  }
}

function validPortReceipt(
  value: unknown,
  batch: FrozenEvidenceBatch,
): value is AtomicEvidenceAppendReceipt {
  if (
    !record(value) ||
    !exact(value, RECEIPT_KEYS) ||
    (value.disposition !== "applied" && value.disposition !== "replayed") ||
    value.idempotency_key !== batch.idempotency_key ||
    value.execution_id !== batch.execution.execution_id ||
    value.receipt_sha256 !== batch.receipt.receipt_sha256 ||
    !record(value.counts) ||
    !exact(value.counts, COUNT_KEYS)
  )
    return false;
  return (
    value.counts.pages === batch.pages.length &&
    value.counts.outputs === 1 &&
    value.counts.citations === batch.citations.length
  );
}

export async function appendEvidenceAtomically(input: {
  identity: AuthenticatedIdentity;
  granted_scope: AuthorizationScope;
  tenancy_port: TenancyReadPort;
  requires_mfa: boolean;
  idempotency_key: string;
  evidence: unknown;
  append_port: AtomicEvidenceAppendPort;
}): Promise<
  | { ok: true; receipt: Readonly<AtomicEvidenceAppendReceipt> }
  | EvidenceAppendFailure
> {
  const prepared = prepare(input);
  if (!prepared.ok) return prepared;
  if (
    prepared.batch.execution.provenance.tenant_scope.organization_id !==
      input.granted_scope.organization_id ||
    prepared.batch.execution.provenance.tenant_scope.matter_id !==
      input.granted_scope.matter_id ||
    !input.append_port ||
    typeof input.append_port.append !== "function"
  )
    return failure("invalid_evidence_append");
  let fresh;
  try {
    fresh = await recheckFreshAccessViaPort(input.tenancy_port, {
      scope: input.granted_scope,
      identity: input.identity,
      requiresMfa: input.requires_mfa,
    });
  } catch {
    return failure("authorization_dependency_failed");
  }
  if (fresh.kind === "authorization_dependency_failed")
    return failure("authorization_dependency_failed");
  if (!fresh.result.fresh) return failure("evidence_authorization_failed");
  const batch = deepFreeze({ ...prepared.batch, receipt: prepared.receipt });
  let portReceipt: unknown;
  try {
    portReceipt = await input.append_port.append(batch);
  } catch {
    return failure("evidence_append_failed");
  }
  if (!validPortReceipt(portReceipt, batch))
    return failure("evidence_append_failed");
  return deepFreeze({
    ok: true as const,
    receipt: { ...portReceipt, counts: { ...portReceipt.counts } },
  });
}

export function requestEvidenceDeletion(): BlockedOperation<"evidence_deletion"> {
  return makeBlockedOperation(
    "evidence_deletion",
    "append-only AI evidence deletion requires an approved retention decision",
  );
}
