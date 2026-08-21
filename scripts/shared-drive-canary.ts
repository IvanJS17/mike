#!/usr/bin/env node

const { createHash, randomUUID } = require("node:crypto");
const { lstatSync, readFileSync } = require("node:fs");
const { isAbsolute } = require("node:path");

const ACKNOWLEDGEMENT = "synthetic-disposable-folder";
const DOCX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DEFAULT_API_BASE_URL = "https://www.googleapis.com/drive/v3";
const DEFAULT_UPLOAD_BASE_URL = "https://www.googleapis.com/upload/drive/v3";
const REQUEST_TIMEOUT_MS = 10_000;
const FILE_FIELDS =
  "id,name,mimeType,size,parents,appProperties,md5Checksum";

// Fixed, synthetic, minimal OOXML package. It contains no user or matter data.
const SYNTHETIC_DOCX_BYTES = Buffer.from(
  "UEsDBBQAAAAAAAAAIQB5bjPXrQEAAK0BAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz48VHlwZXMgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9wYWNrYWdlLzIwMDYvY29udGVudC10eXBlcyI+PERlZmF1bHQgRXh0ZW5zaW9uPSJyZWxzIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24vdm5kLm9wZW54bWxmb3JtYXRzLXBhY2thZ2UucmVsYXRpb25zaGlwcyt4bWwiLz48RGVmYXVsdCBFeHRlbnNpb249InhtbCIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3htbCIvPjxPdmVycmlkZSBQYXJ0TmFtZT0iL3dvcmQvZG9jdW1lbnQueG1sIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24vdm5kLm9wZW54bWxmb3JtYXRzLW9mZmljZWRvY3VtZW50LndvcmRwcm9jZXNzaW5nbWwuZG9jdW1lbnQubWFpbit4bWwiLz48L1R5cGVzPlBLAwQUAAAAAAAAACEAm/036ikBAAApAQAACwAAAF9yZWxzLy5yZWxzPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/PjxSZWxhdGlvbnNoaXBzIHhtbG5zPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvcGFja2FnZS8yMDA2L3JlbGF0aW9uc2hpcHMiPjxSZWxhdGlvbnNoaXAgSWQ9InJJZDEiIFR5cGU9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9vZmZpY2VEb2N1bWVudC8yMDA2L3JlbGF0aW9uc2hpcHMvb2ZmaWNlRG9jdW1lbnQiIFRhcmdldD0id29yZC9kb2N1bWVudC54bWwiLz48L1JlbGF0aW9uc2hpcHM+UEsDBBQAAAAAAAAAIQDQf+5X8AAAAPAAAAARAAAAd29yZC9kb2N1bWVudC54bWw8P3htbCB2ZXJzaW9uPSIxLjAiIGVuY29kaW5nPSJVVEYtOCIgc3RhbmRhbG9uZT0ieWVzIj8+PHc6ZG9jdW1lbnQgeG1sbnM6dz0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3dvcmRwcm9jZXNzaW5nbWwvMjAwNi9tYWluIj48dzpib2R5Pjx3OnA+PHc6cj48dzp0PlN5bnRoZXRpYyBNaWtlIERyaXZlIGNhbmFyeS48L3c6dD48L3c6cj48L3c6cD48dzpzZWN0UHIvPjwvdzpib2R5Pjwvdzpkb2N1bWVudD5QSwECFAMUAAAAAAAAACEAeW4z160BAACtAQAAEwAAAAAAAAAAAAAAgAEAAAAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLAQIUAxQAAAAAAAAAIQCb/TfqKQEAACkBAAALAAAAAAAAAAAAAACAAd4BAABfcmVscy8ucmVsc1BLAQIUAxQAAAAAAAAAIQDQf+5X8AAAAPAAAAARAAAAAAAAAAAAAACAATADAAB3b3JkL2RvY3VtZW50LnhtbFBLBQYAAAAAAwADALkAAABPBAAAAAA=",
  "base64",
);

type HttpInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer;
};

type HttpResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  arrayBuffer: () => Promise<ArrayBuffer>;
};

type DriveFile = {
  id: string;
  name?: string;
  mimeType?: string;
  size: string;
  parents: string[];
  appProperties: Record<string, string>;
};

type CanaryConfig = {
  token: string;
  folderId: string;
  apiBaseUrl: string;
  uploadBaseUrl: string;
};

type CanaryContext = {
  api: DriveApi;
  folderId: string;
  canaryId: string;
  bytes: Buffer;
  expectedSha256: string;
  appProperties: Record<string, string>;
  knownFileIds: Set<string>;
};

class CanaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanaryError";
  }
}

class DriveHttpError extends CanaryError {
  readonly status: number;

  constructor(operation: string, status: number) {
    super(`Drive ${operation} failed with HTTP ${status}`);
    this.name = "DriveHttpError";
    this.status = status;
  }
}

function fail(message: string): never {
  throw new CanaryError(message);
}

function sanitizedPrefix(value: string): string {
  return value.slice(0, 8);
}

function safeErrorMessage(error: unknown): string {
  return error instanceof CanaryError ? error.message : "operation failed";
}

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) fail(`${name} is required`);
  return value;
}

function readEndpoint(name: string, fallback: string): string {
  const value = process.env[name] || fallback;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${name} is invalid`);
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    fail(`${name} is invalid`);
  }
  return value.replace(/\/+$/, "");
}

function readAccessToken(): string {
  if (process.env.GOOGLE_DRIVE_ACCESS_TOKEN !== undefined) {
    fail("GOOGLE_DRIVE_ACCESS_TOKEN is not accepted; use the token file");
  }
  const tokenFile = readRequiredEnv("GOOGLE_DRIVE_ACCESS_TOKEN_FILE");
  if (!isAbsolute(tokenFile)) {
    fail("GOOGLE_DRIVE_ACCESS_TOKEN_FILE must be an absolute path");
  }

  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(tokenFile);
  } catch {
    fail("Google Drive token file is unavailable");
  }
  const mode = stat.mode & 0o777;
  if (!stat.isFile() || (mode !== 0o400 && mode !== 0o600)) {
    fail("Google Drive token file must be a regular 0400/0600 file");
  }

  let token: string;
  try {
    token = readFileSync(tokenFile, "utf8").trim();
  } catch {
    fail("Google Drive token file is unreadable");
  }
  if (!token) fail("Google Drive token file is empty");
  return token;
}

function loadConfig(): CanaryConfig {
  if (process.argv.length > 2) {
    fail("command-line arguments are not accepted");
  }
  if (process.env.MIKE_DRIVE_CANARY_ACK !== ACKNOWLEDGEMENT) {
    fail(`MIKE_DRIVE_CANARY_ACK must equal ${ACKNOWLEDGEMENT}`);
  }
  const folderId = readRequiredEnv("MIKE_DRIVE_CANARY_FOLDER_ID");
  if (folderId.trim() !== folderId || /\s/.test(folderId)) {
    fail("MIKE_DRIVE_CANARY_FOLDER_ID must be an explicit non-whitespace id");
  }
  return {
    token: readAccessToken(),
    folderId,
    apiBaseUrl: readEndpoint(
      "MIKE_DRIVE_CANARY_API_BASE_URL",
      DEFAULT_API_BASE_URL,
    ),
    uploadBaseUrl: readEndpoint(
      "MIKE_DRIVE_CANARY_UPLOAD_BASE_URL",
      DEFAULT_UPLOAD_BASE_URL,
    ),
  };
}

function escapeDriveQuery(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

async function request(
  url: string,
  init: HttpInit,
  operation: string,
): Promise<HttpResponse> {
  try {
    return (await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    } as RequestInit)) as HttpResponse;
  } catch {
    throw new CanaryError(`Drive ${operation} request failed`);
  }
}

function authHeaders(
  token: string,
  contentType?: string,
): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (contentType) headers["Content-Type"] = contentType;
  return headers;
}

async function parseJson(
  response: HttpResponse,
  operation: string,
): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    fail(`Drive ${operation} returned invalid JSON`);
  }
}

function parseFile(value: unknown, operation: string): DriveFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`Drive ${operation} returned invalid file metadata`);
  }
  const row = value as Record<string, unknown>;
  const parents = Array.isArray(row.parents)
    ? row.parents.filter(
        (parent: unknown): parent is string => typeof parent === "string",
      )
    : [];
  const appProperties =
    row.appProperties &&
    typeof row.appProperties === "object" &&
    !Array.isArray(row.appProperties)
      ? Object.fromEntries(
          Object.entries(row.appProperties).filter(
            ([key, property]) =>
              typeof key === "string" && typeof property === "string",
          ),
        )
      : {};
  const size =
    typeof row.size === "string"
      ? row.size
      : typeof row.size === "number" && Number.isSafeInteger(row.size)
        ? String(row.size)
        : "";
  if (typeof row.id !== "string" || !row.id || !size) {
    fail(`Drive ${operation} returned incomplete file metadata`);
  }
  return {
    id: row.id,
    name: typeof row.name === "string" ? row.name : undefined,
    mimeType: typeof row.mimeType === "string" ? row.mimeType : undefined,
    size,
    parents,
    appProperties,
  };
}

class DriveApi {
  private readonly token: string;
  private readonly apiBaseUrl: string;
  private readonly uploadBaseUrl: string;

  constructor(token: string, apiBaseUrl: string, uploadBaseUrl: string) {
    this.token = token;
    this.apiBaseUrl = apiBaseUrl;
    this.uploadBaseUrl = uploadBaseUrl;
  }

  async listMatches(folderId: string, canaryId: string): Promise<DriveFile[]> {
    const matches: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(`${this.apiBaseUrl}/files`);
      url.searchParams.set(
        "q",
        `trashed = false and '${escapeDriveQuery(folderId)}' in parents and appProperties has { key='mike_canary_id' and value='${escapeDriveQuery(canaryId)}' }`,
      );
      url.searchParams.set("spaces", "drive");
      url.searchParams.set("pageSize", "100");
      url.searchParams.set("supportsAllDrives", "true");
      url.searchParams.set("includeItemsFromAllDrives", "true");
      url.searchParams.set("fields", `files(${FILE_FIELDS}),nextPageToken`);
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const response = await request(
        url.toString(),
        { headers: authHeaders(this.token) },
        "lookup",
      );
      if (!response.ok) throw new DriveHttpError("lookup", response.status);
      const payload = await parseJson(response, "lookup");
      if (
        !payload ||
        typeof payload !== "object" ||
        !Array.isArray((payload as Record<string, unknown>).files)
      ) {
        fail("Drive lookup returned invalid file list");
      }
      const payloadRecord = payload as Record<string, unknown>;
      for (const file of payloadRecord.files as unknown[]) {
        matches.push(parseFile(file, "lookup"));
      }
      pageToken =
        typeof payloadRecord.nextPageToken === "string" &&
        payloadRecord.nextPageToken
          ? payloadRecord.nextPageToken
          : undefined;
    } while (pageToken);
    return matches;
  }

  async upload(
    folderId: string,
    canaryId: string,
    appProperties: Record<string, string>,
    bytes: Buffer,
  ): Promise<DriveFile> {
    const boundary = `mike-canary-${randomUUID()}`;
    const metadata = JSON.stringify({
      name: `mike-shared-drive-canary-${canaryId}.docx`,
      mimeType: DOCX_MIME_TYPE,
      parents: [folderId],
      appProperties,
    });
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
        "utf8",
      ),
      Buffer.from(
        `--${boundary}\r\nContent-Type: ${DOCX_MIME_TYPE}\r\n\r\n`,
        "utf8",
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
    ]);
    const url = new URL(`${this.uploadBaseUrl}/files`);
    url.searchParams.set("uploadType", "multipart");
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("fields", FILE_FIELDS);
    const response = await request(
      url.toString(),
      {
        method: "POST",
        headers: authHeaders(
          this.token,
          `multipart/related; boundary=${boundary}`,
        ),
        body,
      },
      "upload",
    );
    if (!response.ok) throw new DriveHttpError("upload", response.status);
    return parseFile(await parseJson(response, "upload"), "upload");
  }

  async getMetadata(fileId: string): Promise<DriveFile> {
    const url = new URL(
      `${this.apiBaseUrl}/files/${encodeURIComponent(fileId)}`,
    );
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("fields", FILE_FIELDS);
    const response = await request(
      url.toString(),
      { headers: authHeaders(this.token) },
      "metadata verification",
    );
    if (!response.ok) {
      throw new DriveHttpError("metadata verification", response.status);
    }
    return parseFile(
      await parseJson(response, "metadata verification"),
      "metadata verification",
    );
  }

  async download(fileId: string): Promise<Buffer> {
    const url = new URL(
      `${this.apiBaseUrl}/files/${encodeURIComponent(fileId)}`,
    );
    url.searchParams.set("alt", "media");
    url.searchParams.set("supportsAllDrives", "true");
    const response = await request(
      url.toString(),
      { headers: authHeaders(this.token) },
      "download",
    );
    if (!response.ok) throw new DriveHttpError("download", response.status);
    try {
      return Buffer.from(await response.arrayBuffer());
    } catch {
      fail("Drive download returned unreadable bytes");
    }
  }

  async delete(fileId: string): Promise<void> {
    const url = new URL(
      `${this.apiBaseUrl}/files/${encodeURIComponent(fileId)}`,
    );
    url.searchParams.set("supportsAllDrives", "true");
    const response = await request(
      url.toString(),
      { method: "DELETE", headers: authHeaders(this.token) },
      "delete",
    );
    if (!response.ok && response.status !== 404) {
      throw new DriveHttpError("delete", response.status);
    }
  }
}

function rememberFile(context: CanaryContext, file: DriveFile): void {
  context.knownFileIds.add(file.id);
}

function rememberFiles(context: CanaryContext, files: DriveFile[]): void {
  for (const file of files) rememberFile(context, file);
}

async function lookupOne(context: CanaryContext): Promise<DriveFile | undefined> {
  const files = await context.api.listMatches(
    context.folderId,
    context.canaryId,
  );
  rememberFiles(context, files);
  if (files.length > 1) {
    fail("lookup found multiple canary matches");
  }
  return files[0];
}

async function ensureCanary(context: CanaryContext): Promise<DriveFile> {
  const existing = await lookupOne(context);
  if (existing) return existing;

  try {
    const created = await context.api.upload(
      context.folderId,
      context.canaryId,
      context.appProperties,
      context.bytes,
    );
    rememberFile(context, created);
  } catch {
    // A lost/ambiguous create response is resolved by lookup before another
    // ensure can ever issue a create request.
    let recovered: DriveFile[];
    try {
      recovered = await context.api.listMatches(
        context.folderId,
        context.canaryId,
      );
    } catch {
      fail("upload outcome is unknown and recovery lookup failed");
    }
    rememberFiles(context, recovered);
    if (recovered.length > 1) fail("lookup found multiple canary matches");
    if (recovered.length === 0) {
      fail("upload outcome is unknown and canary was not found");
    }
    return recovered[0];
  }

  const visible = await lookupOne(context);
  if (!visible) fail("uploaded canary was not found during lookup");
  return visible;
}

function hasExactProperties(
  actual: Record<string, string>,
  expected: Record<string, string>,
): boolean {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index]) &&
    expectedKeys.every((key) => actual[key] === expected[key])
  );
}

function verifyMetadata(
  file: DriveFile,
  context: CanaryContext,
  expectedFileId: string,
): void {
  if (
    file.id !== expectedFileId ||
    file.mimeType !== DOCX_MIME_TYPE ||
    file.parents.length !== 1 ||
    file.parents[0] !== context.folderId ||
    file.size !== String(context.bytes.byteLength) ||
    !hasExactProperties(file.appProperties, context.appProperties)
  ) {
    fail("canary metadata mismatch");
  }
}

async function assertGone(
  context: CanaryContext,
  fileIds: Set<string>,
): Promise<boolean> {
  for (const fileId of fileIds) {
    try {
      await context.api.getMetadata(fileId);
      return false;
    } catch (error) {
      if (!(error instanceof DriveHttpError) || error.status !== 404) {
        return false;
      }
    }
  }
  return true;
}

async function cleanup(context: CanaryContext): Promise<void> {
  let initialLookup: DriveFile[] = [];
  try {
    initialLookup = await context.api.listMatches(
      context.folderId,
      context.canaryId,
    );
    rememberFiles(context, initialLookup);
  } catch {
    // Continue with known IDs, then require a later lookup to prove zero.
  }

  const targetIds = new Set(context.knownFileIds);
  for (const file of initialLookup) targetIds.add(file.id);
  for (const fileId of targetIds) {
    try {
      await context.api.delete(fileId);
    } catch {
      // Final GET and lookup below decide whether cleanup is actually confirmed.
    }
  }

  let gone = await assertGone(context, targetIds);
  let remaining: DriveFile[];
  try {
    remaining = await context.api.listMatches(
      context.folderId,
      context.canaryId,
    );
  } catch {
    fail("cleanup could not confirm zero residue");
  }
  rememberFiles(context, remaining);

  if (remaining.length > 0) {
    for (const file of remaining) {
      try {
        await context.api.delete(file.id);
      } catch {
        // The final zero-residue lookup remains authoritative and fail-closed.
      }
    }
    gone = (await assertGone(context, context.knownFileIds)) && gone;
    try {
      remaining = await context.api.listMatches(
        context.folderId,
        context.canaryId,
      );
    } catch {
      fail("cleanup could not confirm zero residue");
    }
    rememberFiles(context, remaining);
  }

  if (!gone || remaining.length !== 0) {
    fail("cleanup could not confirm zero residue");
  }
}

async function run(): Promise<void> {
  const config = loadConfig();
  const canaryId = randomUUID();
  const expectedSha256 = createHash("sha256")
    .update(SYNTHETIC_DOCX_BYTES)
    .digest("hex");
  const context: CanaryContext = {
    api: new DriveApi(
      config.token,
      config.apiBaseUrl,
      config.uploadBaseUrl,
    ),
    folderId: config.folderId,
    canaryId,
    bytes: SYNTHETIC_DOCX_BYTES,
    expectedSha256,
    appProperties: {
      mike_canary_id: canaryId,
      mike_canary_sha256: expectedSha256,
      mike_canary_type: ACKNOWLEDGEMENT,
    },
    knownFileIds: new Set<string>(),
  };

  let operationError: unknown;
  try {
    const first = await ensureCanary(context);
    const second = await ensureCanary(context);
    if (first.id !== second.id) fail("ensure did not return the same file id");

    const metadata = await context.api.getMetadata(second.id);
    verifyMetadata(metadata, context, second.id);
    const downloaded = await context.api.download(second.id);
    const downloadedSha256 = createHash("sha256").update(downloaded).digest("hex");
    if (
      downloaded.byteLength !== context.bytes.byteLength ||
      downloadedSha256 !== context.expectedSha256
    ) {
      fail("downloaded canary bytes hash or size mismatch");
    }
  } catch (error) {
    operationError = error;
  }

  let cleanupError: unknown;
  try {
    await cleanup(context);
  } catch (error) {
    cleanupError = error;
  }

  if (operationError) {
    if (cleanupError) {
      fail(`${safeErrorMessage(operationError)}; cleanup not confirmed`);
    }
    throw operationError;
  }
  if (cleanupError) throw cleanupError;

  console.log(
    `shared-drive-canary: PASS (canary=${sanitizedPrefix(canaryId)}, sha256=${sanitizedPrefix(expectedSha256)})`,
  );
}

if (require.main === module) {
  run().catch((error) => {
    console.error(`shared-drive-canary: FAIL: ${safeErrorMessage(error)}`);
    process.exitCode = 1;
  });
}
