/**
 * Parse model-proposed edits out of a streamed completion so they can be
 * applied to the document as tracked changes.
 *
 * The Proofread and Anonymise prompts instruct the model to report each issue
 * as an ORIGINAL / REPLACEMENT / REASON block. That format is deliberately
 * dual-purpose: it stays readable while it streams into the result box, and
 * once the stream finishes it parses into exact string edits that
 * `applyTrackedEdits` can locate in the document with Word's search API.
 */

// Shared contract for edits Mike must be able to apply automatically: the
// parser below and the Word search in applyTrackedEdits both depend on
// ORIGINAL being a verbatim, single-paragraph snippet.
export const REDLINE_FORMAT = `Report each item in exactly this format, with one blank line between items:

ORIGINAL: <text copied character-for-character from the document — a contiguous snippet from a single paragraph, under 200 characters>
REPLACEMENT: <the new text>
REASON: <one short sentence>

Copy ORIGINAL exactly (including capitalisation and punctuation) so the change can be applied to the document automatically.`;

export interface RedlineEdit {
  /** Exact text to locate in the document (verbatim, case-sensitive). */
  original: string;
  /** Text to put in its place. */
  replacement: string;
  /** Model's one-line justification; display-only. */
  reason?: string;
}

type FieldName = "original" | "replacement" | "reason";

// Tolerates list numbering ("1. ORIGINAL:") and Markdown bold ("**ORIGINAL:**")
// in case the model decorates the mandated format.
const FIELD_LINE = /^\s*(?:\d+[.)]\s*)?\*{0,2}(ORIGINAL|REPLACEMENT|REASON)\*{0,2}\s*:\s*(.*)$/;

/**
 * Remove the ORIGINAL / REPLACEMENT / REASON blocks from a completion,
 * leaving only the surrounding prose. Used once a message's edits render
 * as EditCards, so the same content isn't shown twice (matching the web
 * app, which never shows the raw edit blocks inline).
 */
export function stripRedlineBlocks(text: string): string {
  const kept: string[] = [];
  let lastField: FieldName | null = null;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(FIELD_LINE);
    if (match) {
      lastField = match[1].toLowerCase() as FieldName;
      continue;
    }
    if (!line.trim()) {
      lastField = null;
      kept.push(line);
      continue;
    }
    // Continuation of a multi-line field value — part of the block.
    if (lastField) continue;
    kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function parseRedlineEdits(text: string): RedlineEdit[] {
  const edits: RedlineEdit[] = [];
  const seenOriginals = new Set<string>();
  let current: Partial<Record<FieldName, string>> | null = null;
  let lastField: FieldName | null = null;

  const flush = (): void => {
    const original = current?.original?.trim();
    const replacement = current?.replacement;
    // A block is only actionable once both sides exist. Re-applying a repeated
    // ORIGINAL would fail its search after the first replacement, so dedupe.
    if (original && replacement !== undefined && !seenOriginals.has(original)) {
      seenOriginals.add(original);
      const reason = current?.reason?.trim();
      edits.push({
        original,
        replacement: replacement.trim(),
        ...(reason ? { reason } : {}),
      });
    }
    current = null;
    lastField = null;
  };

  for (const line of text.split(/\r?\n/)) {
    const match = line.match(FIELD_LINE);
    if (match) {
      const field = match[1].toLowerCase() as FieldName;
      if (field === "original") flush();
      current ??= {};
      current[field] = match[2];
      lastField = field;
    } else if (!line.trim()) {
      // Blank line ends any multi-line field value.
      lastField = null;
    } else if (current && lastField) {
      // Continuation of a multi-line field value.
      current[lastField] = `${current[lastField] ?? ""}\n${line.trim()}`;
    }
  }
  flush();

  return edits;
}

export type RedlineBundleAction = {
  action_id: string;
  item_id: string;
  review_item_id: string;
  citation_id: string;
  source_document_version_id: string;
  page: number;
  start: number;
  end: number;
  before_text_sha256: string;
  replacement_text: string;
  reviewer_user_id: string;
  timestamp: string;
  /** Present only in defensive fixtures; the server bundle omits rejected items. */
  status?: "accepted" | "edited" | "rejected";
  /** Optional future-proof field; beta bundles carry only its hash. */
  before_text?: string;
};

export type AiRedlineBundleJson = {
  bundle_version: "beta-0.1";
  revision: number;
  matter_id: string;
  review_id: string;
  execution_id: string;
  source_document_version_id: string;
  source_document_sha256: string;
  receipt_id: string;
  receipt_version: string;
  receipt_sha256: string;
  actions: RedlineBundleAction[];
};

export type ApprovedRedlineBundle = {
  id: string;
  bundle_version: "beta-0.1";
  revision: number;
  review_id: string;
  execution_id: string;
  matter_id: string;
  project_id: string;
  source_document_version_id: string;
  source_document_sha256: string;
  receipt_id: string;
  receipt_sha256: string;
  actions_count: number;
  bundle_sha256: string;
  canonical_json: AiRedlineBundleJson;
  actor_user_id: string;
  created_at: string;
  download_url?: string;
};

export type RedlineExecutionScope = {
  id: string;
  project_id: string;
  matter_id: string | null;
  document_id: string;
  document_version_id: string;
  document_content_sha256: string;
};

export type PreparedRedlineAction = RedlineBundleAction & {
  original: string;
  replacement: string;
};

export type RedlineBundleValidationCode =
  | "tampered"
  | "scope-mismatch"
  | "source-mismatch"
  | "span-mismatch"
  | "no-actions";

export class RedlineBundleValidationError extends Error {
  readonly code: RedlineBundleValidationCode;

  constructor(code: RedlineBundleValidationCode, message: string) {
    super(message);
    this.name = "RedlineBundleValidationError";
    this.code = code;
  }
}

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_WORD_SEARCH_CHARS = 255;

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalValue(record[key])])
    );
  }
  return value;
}

/** The same sorted-key JSON representation used by the backend bundle hash. */
export function canonicalRedlineJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value)) ?? "null";
}

/** SHA-256 for bundle JSON and the binary document opened in Word. */
export async function sha256Hex(
  value: string | ArrayBuffer | Uint8Array
): Promise<string> {
  const bytes =
    typeof value === "string"
      ? new TextEncoder().encode(value)
      : value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : value;
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    bytes as unknown as BufferSource
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function invalidBundle(code: RedlineBundleValidationCode, message: string): never {
  throw new RedlineBundleValidationError(code, message);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/**
 * Resolve the exact text represented by an action's hash/span without trusting
 * model text or applying a guessed replacement. The direct span is the normal
 * path; the bounded hash search covers page-local offsets when Word exposes a
 * flattened body without page markers. Multiple matches fail closed.
 */
async function resolveBeforeText(
  documentText: string,
  action: RedlineBundleAction
): Promise<string> {
  const length = action.end - action.start;
  if (
    !integer(action.start) ||
    !integer(action.end) ||
    action.start < 0 ||
    length <= 0 ||
    length > MAX_WORD_SEARCH_CHARS
  ) {
    invalidBundle(
      "span-mismatch",
      "An approved redline contains an unsupported document span."
    );
  }

  const direct = documentText.slice(action.start, action.end);
  if (await sha256Hex(direct) === action.before_text_sha256) {
    // A hash match is still ambiguous if the same exact text occurs elsewhere.
    const firstOccurrence = documentText.indexOf(direct);
    if (firstOccurrence !== action.start || documentText.indexOf(direct, firstOccurrence + 1) !== -1) {
      invalidBundle(
        "span-mismatch",
        "An approved redline span is ambiguous in the current document."
      );
    }
    return direct;
  }

  // A beta action has no plaintext before_text by design. Scan only when the
  // source-local span did not line up with Word's flattened body text.
  if (documentText.length > 100_000) {
    invalidBundle(
      "span-mismatch",
      "The approved redline span could not be verified in this document."
    );
  }

  let match: string | null = null;
  for (let offset = 0; offset <= documentText.length - length; offset++) {
    const candidate = documentText.slice(offset, offset + length);
    if (await sha256Hex(candidate) !== action.before_text_sha256) continue;
    if (match !== null) {
      invalidBundle(
        "span-mismatch",
        "An approved redline span is ambiguous in the current document."
      );
    }
    match = candidate;
  }
  if (match === null) {
    invalidBundle(
      "span-mismatch",
      "The approved redline span could not be verified in the current document."
    );
  }
  return match;
}

/**
 * Verify an immutable approved bundle and every action before the first Word
 * write. A single mismatch rejects the complete bundle, so partial redlines
 * cannot be left in the document.
 */
export async function prepareApprovedRedlineBundle(input: {
  bundle: ApprovedRedlineBundle;
  execution: RedlineExecutionScope;
  documentText: string;
  documentSha256: string;
}): Promise<{
  bundle: ApprovedRedlineBundle;
  actions: PreparedRedlineAction[];
}> {
  const { bundle, execution } = input;
  const canonical = bundle.canonical_json;
  if (!canonical || typeof canonical !== "object" || !Array.isArray(canonical.actions)) {
    invalidBundle("tampered", "The approved redline bundle is not valid JSON.");
  }
  if (
    bundle.bundle_version !== "beta-0.1" ||
    canonical.bundle_version !== bundle.bundle_version ||
    canonical.revision !== bundle.revision ||
    canonical.review_id !== bundle.review_id ||
    canonical.execution_id !== bundle.execution_id ||
    canonical.matter_id !== bundle.matter_id ||
    canonical.source_document_version_id !== bundle.source_document_version_id ||
    canonical.source_document_sha256 !== bundle.source_document_sha256 ||
    canonical.receipt_id !== bundle.receipt_id ||
    canonical.receipt_sha256 !== bundle.receipt_sha256 ||
    bundle.actions_count !== canonical.actions.length ||
    !SHA256.test(bundle.bundle_sha256) ||
    !SHA256.test(bundle.source_document_sha256) ||
    !SHA256.test(bundle.receipt_sha256)
  ) {
    invalidBundle("tampered", "The approved redline bundle failed integrity verification.");
  }

  const calculatedBundleSha256 = await sha256Hex(canonicalRedlineJson(canonical));
  if (calculatedBundleSha256 !== bundle.bundle_sha256) {
    invalidBundle("tampered", "The approved redline bundle failed integrity verification.");
  }

  if (
    !execution.matter_id ||
    execution.id !== bundle.execution_id ||
    execution.project_id !== bundle.project_id ||
    execution.matter_id !== bundle.matter_id ||
    execution.document_version_id !== bundle.source_document_version_id ||
    execution.document_content_sha256 !== bundle.source_document_sha256 ||
    input.documentSha256 !== bundle.source_document_sha256
  ) {
    invalidBundle(
      "source-mismatch",
      "The approved redline belongs to a different document version."
    );
  }

  const actionIds = new Set<string>();
  const actions: PreparedRedlineAction[] = [];
  for (const rawAction of canonical.actions) {
    if (!rawAction || typeof rawAction !== "object" || Array.isArray(rawAction)) {
      invalidBundle("tampered", "The approved redline contains an invalid action.");
    }
    if (rawAction.status === "rejected") continue;
    if (
      rawAction.status !== undefined &&
      rawAction.status !== "accepted" &&
      rawAction.status !== "edited"
    ) {
      invalidBundle("tampered", "The approved redline contains an unsupported action.");
    }
    if (
      !nonEmpty(rawAction.action_id) ||
      actionIds.has(rawAction.action_id) ||
      !nonEmpty(rawAction.item_id) ||
      !nonEmpty(rawAction.review_item_id) ||
      !nonEmpty(rawAction.citation_id) ||
      rawAction.source_document_version_id !== bundle.source_document_version_id ||
      !integer(rawAction.page) ||
      rawAction.page < 1 ||
      !SHA256.test(rawAction.before_text_sha256) ||
      !nonEmpty(rawAction.replacement_text) ||
      !nonEmpty(rawAction.reviewer_user_id) ||
      !nonEmpty(rawAction.timestamp)
    ) {
      invalidBundle("tampered", "The approved redline contains an invalid action.");
    }
    actionIds.add(rawAction.action_id);

    if (rawAction.before_text !== undefined) {
      if (
        !nonEmpty(rawAction.before_text) ||
        await sha256Hex(rawAction.before_text) !== rawAction.before_text_sha256
      ) {
        invalidBundle("span-mismatch", "The approved redline span could not be verified.");
      }
    }

    const original = await resolveBeforeText(input.documentText, rawAction);
    actions.push({
      ...rawAction,
      original,
      replacement: rawAction.replacement_text,
    });
  }

  if (actions.length === 0) {
    invalidBundle("no-actions", "The approved redline contains no actionable changes.");
  }

  return { bundle, actions };
}
