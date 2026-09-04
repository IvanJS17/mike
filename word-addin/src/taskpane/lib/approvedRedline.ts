/** The coordinator-owned, write-free approved redline boundary. */

export type ApprovedRedlineValidationCode =
  | "tampered"
  | "scope-mismatch"
  | "source-mismatch"
  | "document-identity"
  | "superseded"
  | "span-mismatch"
  | "ambiguous"
  | "overlap"
  | "no-actions";

export class ApprovedRedlineValidationError extends Error {
  readonly code: ApprovedRedlineValidationCode;

  constructor(code: ApprovedRedlineValidationCode) {
    super(code);
    this.name = "ApprovedRedlineValidationError";
    this.code = code;
  }
}

type IdentityAction = {
  action_id: string;
  review_item_id: string;
  citation_id: string;
  document_id: string;
  document_version_id: string;
  page: number;
  start: number;
  end: number;
  page_content_sha256: string;
  before_text_sha256: string;
  replacement_text_sha256: string;
};

type FullAction = IdentityAction & {
  replacement_text: string;
};

type Bundle = {
  bundle_version: "approved-redline-v1";
  revision: number;
  review_id: string;
  review_revision: number;
  execution_id: string;
  organization_id: string;
  matter_id: string;
  project_id: string;
  document_id: string;
  document_version_id: string;
  source_document_sha256: string;
  evidence_receipt_version: "evidence-v1";
  evidence_receipt_sha256: string;
  reviewer_user_id: string;
  actions: readonly FullAction[];
  canonical_json: string;
  bundle_sha256: string;
};

export type PreparedApprovedRedlineAction = Readonly<
  FullAction & {
    original: string;
    replacement: string;
  }
>;

export type PreparedApprovedRedline = Readonly<{
  bundle: Readonly<Bundle>;
  actions: readonly PreparedApprovedRedlineAction[];
}>;

const SHA256 = /^[0-9a-f]{64}$/;
const MAX_SPAN_LENGTH = 255;
const MAX_DOCUMENT_LENGTH = 100_000;
const BUNDLE_KEYS = [
  "bundle_version",
  "revision",
  "review_id",
  "review_revision",
  "execution_id",
  "organization_id",
  "matter_id",
  "project_id",
  "document_id",
  "document_version_id",
  "source_document_sha256",
  "evidence_receipt_version",
  "evidence_receipt_sha256",
  "reviewer_user_id",
  "actions",
  "canonical_json",
  "bundle_sha256",
] as const;
const CANONICAL_KEYS = BUNDLE_KEYS.filter(
  (key) => key !== "canonical_json" && key !== "bundle_sha256",
);
const ACTION_KEYS = [
  "action_id",
  "review_item_id",
  "citation_id",
  "document_id",
  "document_version_id",
  "page",
  "start",
  "end",
  "page_content_sha256",
  "before_text_sha256",
  "replacement_text_sha256",
] as const;
const FULL_ACTION_KEYS = [...ACTION_KEYS, "replacement_text"] as const;

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: RecordValue, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function snapshot(value: unknown, ancestors = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value)) throw new Error("cyclic boundary");
  ancestors.add(value);
  try {
    if (Array.isArray(value))
      return Array.from(value, (item) => snapshot(item, ancestors));
    const result: RecordValue = Object.create(null);
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record))
      result[key] = snapshot(record[key], ancestors);
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as RecordValue)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function fail(code: ApprovedRedlineValidationCode): never {
  throw new ApprovedRedlineValidationError(code);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as RecordValue)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

export function canonicalApprovedRedlineJson(value: unknown): string {
  return canonical(value);
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function stringField(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function canonicalIdentity(value: unknown): value is string {
  return stringField(value) && value.trim() === value;
}

function sameIdentity(left: RecordValue, right: RecordValue): boolean {
  return ACTION_KEYS.every((key) => left[key] === right[key]);
}

function validIdentityAction(value: RecordValue): boolean {
  return (
    canonicalIdentity(value.action_id) &&
    canonicalIdentity(value.review_item_id) &&
    canonicalIdentity(value.citation_id) &&
    canonicalIdentity(value.document_id) &&
    canonicalIdentity(value.document_version_id) &&
    Number.isInteger(value.page) &&
    (value.page as number) >= 1 &&
    typeof value.page_content_sha256 === "string" &&
    SHA256.test(value.page_content_sha256) &&
    typeof value.before_text_sha256 === "string" &&
    SHA256.test(value.before_text_sha256) &&
    typeof value.replacement_text_sha256 === "string" &&
    SHA256.test(value.replacement_text_sha256)
  );
}

type PreparedInput = {
  bundle: unknown;
  expected: RecordValue;
  current: RecordValue;
};

async function prepareSnapshot(
  input: unknown,
): Promise<PreparedApprovedRedline> {
  if (!isRecord(input)) fail("tampered");
  let raw: PreparedInput;
  try {
    raw = snapshot(input) as PreparedInput;
  } catch {
    fail("tampered");
  }
  if (
    !isRecord(raw.bundle) ||
    !isRecord(raw.expected) ||
    !isRecord(raw.current)
  )
    fail("tampered");
  const bundle = raw.bundle;
  if (
    !hasExactKeys(bundle, BUNDLE_KEYS) ||
    bundle.bundle_version !== "approved-redline-v1" ||
    !Number.isSafeInteger(bundle.revision) ||
    (bundle.revision as number) < 1 ||
    !Number.isSafeInteger(bundle.review_revision) ||
    (bundle.review_revision as number) < 1 ||
    !canonicalIdentity(bundle.review_id) ||
    !canonicalIdentity(bundle.execution_id) ||
    !canonicalIdentity(bundle.organization_id) ||
    !canonicalIdentity(bundle.matter_id) ||
    !canonicalIdentity(bundle.project_id) ||
    !canonicalIdentity(bundle.document_id) ||
    !canonicalIdentity(bundle.document_version_id) ||
    !canonicalIdentity(bundle.reviewer_user_id) ||
    typeof bundle.source_document_sha256 !== "string" ||
    !SHA256.test(bundle.source_document_sha256) ||
    bundle.evidence_receipt_version !== "evidence-v1" ||
    typeof bundle.evidence_receipt_sha256 !== "string" ||
    !SHA256.test(bundle.evidence_receipt_sha256) ||
    !stringField(bundle.canonical_json) ||
    !SHA256.test(String(bundle.bundle_sha256)) ||
    !Array.isArray(bundle.actions)
  )
    fail("tampered");

  let canonicalBody: RecordValue;
  try {
    const parsed = JSON.parse(bundle.canonical_json as string) as unknown;
    if (!isRecord(parsed)) fail("tampered");
    canonicalBody = parsed;
  } catch {
    fail("tampered");
  }
  if (
    !hasExactKeys(canonicalBody, CANONICAL_KEYS) ||
    canonical(canonicalBody) !== bundle.canonical_json ||
    (await sha256(bundle.canonical_json as string)) !== bundle.bundle_sha256
  )
    fail("tampered");
  for (const key of CANONICAL_KEYS.filter((item) => item !== "actions")) {
    if (bundle[key] !== canonicalBody[key]) fail("tampered");
  }
  const canonicalActions = canonicalBody.actions;
  if (!Array.isArray(canonicalActions) || canonicalActions.length === 0)
    fail("no-actions");
  if (bundle.actions.length !== canonicalActions.length) fail("tampered");

  const canonicalById = new Map<string, RecordValue>();
  const canonicalRank = new Map<string, number>();
  for (const [index, item] of canonicalActions.entries()) {
    if (
      !isRecord(item) ||
      !hasExactKeys(item, ACTION_KEYS) ||
      !validIdentityAction(item) ||
      canonicalById.has(String(item.action_id))
    )
      fail("tampered");
    canonicalById.set(item.action_id as string, item);
    canonicalRank.set(item.action_id as string, index);
  }
  const seen = new Set<string>();
  const bound: FullAction[] = [];
  for (const item of bundle.actions) {
    const full = item;
    const identity = isRecord(full)
      ? canonicalById.get(String(full.action_id))
      : undefined;
    if (
      !isRecord(full) ||
      !isRecord(identity) ||
      !hasExactKeys(full, FULL_ACTION_KEYS) ||
      seen.has(String(full.action_id)) ||
      !validIdentityAction(full) ||
      !stringField(full.replacement_text) ||
      !SHA256.test(String(full.replacement_text_sha256)) ||
      (await sha256(full.replacement_text as string)) !==
        full.replacement_text_sha256 ||
      !sameIdentity(full, identity)
    )
      fail("tampered");
    seen.add(full.action_id as string);
    bound.push(full as unknown as FullAction);
  }
  bound.sort(
    (left, right) =>
      (canonicalRank.get(left.action_id) ?? Number.MAX_SAFE_INTEGER) -
      (canonicalRank.get(right.action_id) ?? Number.MAX_SAFE_INTEGER),
  );

  const expected = raw.expected;
  const current = raw.current;
  const scopeKeys = ["organization_id", "matter_id", "project_id"];
  if (scopeKeys.some((key) => expected[key] !== bundle[key]))
    fail("scope-mismatch");
  if (
    expected.execution_id !== bundle.execution_id ||
    expected.review_id !== bundle.review_id
  )
    fail("scope-mismatch");
  if (expected.review_revision !== bundle.review_revision) fail("superseded");
  if (
    expected.document_id !== bundle.document_id ||
    expected.document_version_id !== bundle.document_version_id ||
    expected.source_document_sha256 !== bundle.source_document_sha256
  )
    fail("source-mismatch");
  if (
    !canonicalIdentity(expected.document_identity) ||
    !canonicalIdentity(current.document_identity) ||
    current.document_identity !== expected.document_identity
  )
    fail("document-identity");
  if (
    current.document_id !== bundle.document_id ||
    current.document_version_id !== bundle.document_version_id
  )
    fail("source-mismatch");
  if (current.document_sha256 !== bundle.source_document_sha256)
    fail("source-mismatch");
  if (
    typeof current.text !== "string" ||
    current.text.length > MAX_DOCUMENT_LENGTH
  )
    fail("source-mismatch");

  const resolved: PreparedApprovedRedlineAction[] = [];
  for (const action of bound) {
    if (
      !Number.isSafeInteger(action.start) ||
      !Number.isSafeInteger(action.end) ||
      action.start < 0 ||
      action.end <= action.start ||
      action.end - action.start > MAX_SPAN_LENGTH ||
      action.end > current.text.length ||
      !Number.isInteger(action.page) ||
      action.page < 1 ||
      !SHA256.test(action.before_text_sha256)
    )
      fail("span-mismatch");
    const length = action.end - action.start;
    const direct = current.text.slice(action.start, action.end);
    let start: number;
    if ((await sha256(direct)) === action.before_text_sha256) {
      const firstOccurrence = current.text.indexOf(direct);
      if (
        firstOccurrence !== action.start ||
        current.text.indexOf(direct, firstOccurrence + 1) !== -1
      )
        fail("ambiguous");
      start = action.start;
    } else {
      const matches: number[] = [];
      for (
        let offset = 0;
        offset <= current.text.length - length;
        offset += 1
      ) {
        if (
          (await sha256(current.text.slice(offset, offset + length))) ===
          action.before_text_sha256
        )
          matches.push(offset);
      }
      if (matches.length === 0) fail("span-mismatch");
      if (matches.length > 1) fail("ambiguous");
      const resolvedStart = matches[0];
      if (resolvedStart === undefined) fail("span-mismatch");
      start = resolvedStart;
    }
    const original = current.text.slice(start, start + length);
    resolved.push({
      ...action,
      start,
      end: start + length,
      original,
      replacement: action.replacement_text,
    });
  }
  const ordered = [...resolved].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const next = ordered[index];
    if (
      previous !== undefined &&
      next !== undefined &&
      previous.end > next.start
    )
      fail("overlap");
  }
  return deepFreeze({
    bundle: bundle as unknown as Bundle,
    actions: resolved,
  });
}

export async function prepareApprovedRedline(
  input: unknown,
): Promise<PreparedApprovedRedline> {
  try {
    return await prepareSnapshot(input);
  } catch (error) {
    if (error instanceof ApprovedRedlineValidationError) throw error;
    fail("tampered");
  }
}
