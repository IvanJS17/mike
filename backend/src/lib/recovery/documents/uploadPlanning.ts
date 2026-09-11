/**
 * Slice B — pure folder conflict, upload batch and cursor planning.
 *
 * Pure planning only. No persistence, network, storage client, promises, or
 * destructive lifecycle behavior lives here. Callers execute returned plans.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { isSafePathSegment } from "./documentStoragePolicy";

export const FOLDER_CONFLICT_RESOLUTIONS = [
  "error",
  "reuse",
  "rename",
] as const;
export type FolderConflictResolution =
  (typeof FOLDER_CONFLICT_RESOLUTIONS)[number];

export const MAX_UPLOAD_BATCH_ITEMS = 100;
export const MAX_UPLOAD_CONCURRENCY = 8;
export const MAX_PAGE_CURSOR_OFFSET = 1_000_000;

export type DocumentScope = {
  organization_id: string;
  matter_id?: string;
  project_id: string;
};

export type ExistingFolder = {
  id: string;
  name: string;
  organization_id: string;
  matter_id?: string | null;
  project_id: string;
};

export function normalizeFolderConflictResolution(
  value: unknown,
): FolderConflictResolution {
  return value === "reuse" || value === "rename" ? value : "error";
}

function isScope(value: unknown): value is DocumentScope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const scope = value as Record<string, unknown>;
  return (
    isSafePathSegment(scope.organization_id) &&
    isSafePathSegment(scope.project_id) &&
    (scope.matter_id === undefined || isSafePathSegment(scope.matter_id))
  );
}

function isExistingFolder(value: unknown): value is ExistingFolder {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const folder = value as Record<string, unknown>;
  return (
    isSafePathSegment(folder.id) &&
    isSafePathSegment(folder.name) &&
    isSafePathSegment(folder.organization_id) &&
    isSafePathSegment(folder.project_id) &&
    (folder.matter_id === undefined ||
      folder.matter_id === null ||
      isSafePathSegment(folder.matter_id))
  );
}

function sameScope(folder: ExistingFolder, scope: DocumentScope): boolean {
  return (
    folder.organization_id === scope.organization_id &&
    (folder.matter_id ?? null) === (scope.matter_id ?? null) &&
    folder.project_id === scope.project_id
  );
}

export type FolderConflictResult =
  | { ok: true; disposition: "created"; folderName: string }
  | {
      ok: true;
      disposition: "reused";
      folderId: string;
      folderName: string;
    }
  | { ok: true; disposition: "renamed"; suggestedName: string }
  | {
      ok: false;
      error:
        | { kind: "invalid_folder_request" }
        | { kind: "folder_conflict"; folderName: string }
        | { kind: "not_found" };
    };

function renamedFolderName(
  requestedName: string,
  sameScopeNames: ReadonlySet<string>,
): string | null {
  for (let suffix = 1; suffix <= 10_000; suffix += 1) {
    const ending = ` (${suffix})`;
    const stem = requestedName.slice(0, 255 - ending.length).trimEnd();
    const candidate = `${stem}${ending}`;
    if (isSafePathSegment(candidate) && !sameScopeNames.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function resolveFolderConflict(input: {
  requestedName: string;
  conflictResolution?: unknown;
  existingFolders: ExistingFolder[];
  scope: DocumentScope;
}): FolderConflictResult {
  if (
    !input ||
    typeof input !== "object" ||
    !isSafePathSegment(input.requestedName) ||
    !isScope(input.scope) ||
    !Array.isArray(input.existingFolders) ||
    !input.existingFolders.every(isExistingFolder)
  ) {
    return { ok: false, error: { kind: "invalid_folder_request" } };
  }

  const resolution = normalizeFolderConflictResolution(
    input.conflictResolution,
  );
  const named = input.existingFolders.filter(
    (folder) =>
      folder &&
      typeof folder === "object" &&
      folder.name === input.requestedName,
  );
  const same = named.filter((folder) => sameScope(folder, input.scope));

  if (same.length === 0) {
    if (resolution === "reuse" && named.length > 0) {
      return { ok: false, error: { kind: "not_found" } };
    }
    return {
      ok: true,
      disposition: "created",
      folderName: input.requestedName,
    };
  }

  if (resolution === "error") {
    return {
      ok: false,
      error: { kind: "folder_conflict", folderName: input.requestedName },
    };
  }
  if (resolution === "reuse") {
    const folder = same[0];
    if (!isSafePathSegment(folder.id)) {
      return { ok: false, error: { kind: "not_found" } };
    }
    return {
      ok: true,
      disposition: "reused",
      folderId: folder.id,
      folderName: folder.name,
    };
  }

  const names = new Set(
    input.existingFolders
      .filter((folder) => folder && sameScope(folder, input.scope))
      .map((folder) => folder.name),
  );
  const suggestedName = renamedFolderName(input.requestedName, names);
  return suggestedName
    ? { ok: true, disposition: "renamed", suggestedName }
    : {
        ok: false,
        error: { kind: "folder_conflict", folderName: input.requestedName },
      };
}

export type UploadBatchItem = {
  clientItemId: string;
  filename: string;
};

export type UploadBatchResult =
  | {
      ok: true;
      concurrencyLimit: number;
      items: Array<UploadBatchItem & { index: number }>;
      scope: DocumentScope;
    }
  | {
      ok: false;
      error:
        | { kind: "invalid_concurrency_limit" }
        | { kind: "empty_batch" }
        | { kind: "batch_too_large"; max: number }
        | { kind: "duplicate_client_item_id"; clientItemId: string }
        | { kind: "invalid_item" }
        | { kind: "invalid_scope" };
    };

export function planUploadBatch(input: {
  items: UploadBatchItem[];
  concurrencyLimit: number;
  scope: DocumentScope;
}): UploadBatchResult {
  if (!isScope(input?.scope)) {
    return { ok: false, error: { kind: "invalid_scope" } };
  }
  if (
    !Number.isInteger(input.concurrencyLimit) ||
    input.concurrencyLimit <= 0 ||
    input.concurrencyLimit > MAX_UPLOAD_CONCURRENCY
  ) {
    return { ok: false, error: { kind: "invalid_concurrency_limit" } };
  }
  if (!Array.isArray(input.items) || input.items.length === 0) {
    return { ok: false, error: { kind: "empty_batch" } };
  }
  if (input.items.length > MAX_UPLOAD_BATCH_ITEMS) {
    return {
      ok: false,
      error: { kind: "batch_too_large", max: MAX_UPLOAD_BATCH_ITEMS },
    };
  }

  const seen = new Set<string>();
  const items: Array<UploadBatchItem & { index: number }> = [];
  for (const [index, item] of input.items.entries()) {
    if (
      !item ||
      typeof item !== "object" ||
      !isSafePathSegment(item.clientItemId) ||
      !isSafePathSegment(item.filename)
    ) {
      return { ok: false, error: { kind: "invalid_item" } };
    }
    if (seen.has(item.clientItemId)) {
      return {
        ok: false,
        error: {
          kind: "duplicate_client_item_id",
          clientItemId: item.clientItemId,
        },
      };
    }
    seen.add(item.clientItemId);
    items.push({
      clientItemId: item.clientItemId,
      filename: item.filename,
      index,
    });
  }

  return {
    ok: true,
    concurrencyLimit: input.concurrencyLimit,
    items,
    scope: { ...input.scope },
  };
}

function scopeDigest(scope: DocumentScope): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        scope.organization_id,
        scope.matter_id ?? null,
        scope.project_id,
      ]),
      "utf8",
    )
    .digest("hex");
}

function isValidCursorMacKey(value: unknown): value is string {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") >= 32;
}

function cursorIntegrity(
  input: { v: 1; o: number; s: string },
  macKey: string,
): string {
  return createHmac("sha256", macKey)
    .update(JSON.stringify(input), "utf8")
    .digest("hex");
}

export function encodePageCursor(
  input: {
    scope: DocumentScope;
    offset: number;
  },
  macKey: string,
): string {
  if (
    !isScope(input?.scope) ||
    !Number.isInteger(input.offset) ||
    input.offset < 0 ||
    input.offset > MAX_PAGE_CURSOR_OFFSET ||
    !isValidCursorMacKey(macKey)
  ) {
    throw new Error("invalid page cursor input");
  }
  const payload = {
    v: 1 as const,
    o: input.offset,
    s: scopeDigest(input.scope),
  };
  return Buffer.from(
    JSON.stringify({ ...payload, i: cursorIntegrity(payload, macKey) }),
    "utf8",
  ).toString("base64url");
}

export type DecodePageCursorResult =
  | { ok: true; offset: number }
  | { ok: false; error: { kind: "invalid_cursor" | "not_found" } };

export function decodePageCursor(
  cursor: unknown,
  scope: DocumentScope,
  macKey: string,
): DecodePageCursorResult {
  if (
    typeof cursor !== "string" ||
    cursor.length === 0 ||
    !isScope(scope) ||
    !isValidCursorMacKey(macKey)
  ) {
    return { ok: false, error: { kind: "invalid_cursor" } };
  }
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) {
    return { ok: false, error: { kind: "invalid_cursor" } };
  }
  let parsed: unknown;
  try {
    const decoded = Buffer.from(cursor, "base64url");
    if (decoded.toString("base64url") !== cursor) {
      return { ok: false, error: { kind: "invalid_cursor" } };
    }
    parsed = JSON.parse(decoded.toString("utf8"));
  } catch {
    return { ok: false, error: { kind: "invalid_cursor" } };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: { kind: "invalid_cursor" } };
  }
  const value = parsed as Record<string, unknown>;
  if (
    Object.keys(value).sort().join(",") !== "i,o,s,v" ||
    value.v !== 1 ||
    !Number.isInteger(value.o) ||
    (value.o as number) < 0 ||
    (value.o as number) > MAX_PAGE_CURSOR_OFFSET ||
    typeof value.s !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.s) ||
    typeof value.i !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.i)
  ) {
    return { ok: false, error: { kind: "invalid_cursor" } };
  }
  const expectedIntegrity = cursorIntegrity(
    { v: 1, o: value.o as number, s: value.s },
    macKey,
  );
  const actualMac = Buffer.from(value.i, "hex");
  const expectedMac = Buffer.from(expectedIntegrity, "hex");
  if (
    actualMac.length !== expectedMac.length ||
    !timingSafeEqual(actualMac, expectedMac)
  ) {
    return { ok: false, error: { kind: "invalid_cursor" } };
  }
  if (value.s !== scopeDigest(scope)) {
    return { ok: false, error: { kind: "not_found" } };
  }
  return { ok: true, offset: value.o as number };
}
