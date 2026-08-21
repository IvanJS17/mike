import type { AddressInfo } from "node:net";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { createServer } = require("node:http");
const { mkdtemp, chmod, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, dirname } = require("node:path");
const { spawn } = require("node:child_process");
const { test } = require("node:test");

const SCRIPT = join(dirname(__filename), "shared-drive-canary");
const TOKEN = "synthetic-fake-token-that-must-never-be-printed";
const FOLDER_ID = "synthetic-folder-1";
const ACK = "synthetic-disposable-folder";
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

type FakeMode =
  | "happy"
  | "lost-upload"
  | "duplicates"
  | "hash-mismatch"
  | "metadata-mismatch"
  | "delete-fails";

type FakeFile = {
  id: string;
  name: string;
  mimeType: string;
  parentId: string;
  appProperties: Record<string, string>;
  bytes: Buffer;
};

type FakeDrive = {
  baseUrl: string;
  uploadBaseUrl: string;
  files: Map<string, FakeFile>;
  uploadedPayloads: Buffer[];
  requests: string[];
  protocolErrors: string[];
  close: () => Promise<void>;
  uploadCount: () => number;
};

type FakeOptions = {
  mode: FakeMode;
};

function json(response: any, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": payload.byteLength,
  });
  response.end(payload);
}

function bytes(response: any, status: number, body: Buffer): void {
  response.writeHead(status, {
    "content-type": "application/octet-stream",
    "content-length": body.byteLength,
  });
  response.end(body);
}

function readBody(request: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function indexOfBuffer(haystack: Buffer, needle: Buffer, offset = 0): number {
  return haystack.indexOf(needle, offset);
}

function parseMultipart(
  request: any,
  body: Buffer,
): { metadata: Record<string, unknown>; bytes: Buffer } {
  const contentType = String(request.headers["content-type"] ?? "");
  const boundary = contentType.match(/boundary="?([^";]+)"?/i)?.[1];
  assert.ok(boundary, "fake Drive received multipart content type without boundary");
  const separator = Buffer.from(`\r\n--${boundary}`, "utf8");
  const firstHeadersEnd = indexOfBuffer(body, Buffer.from("\r\n\r\n"));
  assert.notEqual(firstHeadersEnd, -1, "fake Drive multipart metadata headers missing");
  const metadataEnd = indexOfBuffer(body, separator, firstHeadersEnd + 4);
  assert.notEqual(metadataEnd, -1, "fake Drive multipart metadata terminator missing");
  const metadata = JSON.parse(
    body.subarray(firstHeadersEnd + 4, metadataEnd).toString("utf8"),
  ) as Record<string, unknown>;
  const secondHeadersEnd = indexOfBuffer(
    body,
    Buffer.from("\r\n\r\n"),
    metadataEnd + separator.byteLength,
  );
  assert.notEqual(secondHeadersEnd, -1, "fake Drive multipart bytes headers missing");
  const closing = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  const bytesEnd = body.lastIndexOf(closing);
  assert.notEqual(bytesEnd, -1, "fake Drive multipart closing boundary missing");
  return {
    metadata,
    bytes: body.subarray(secondHeadersEnd + 4, bytesEnd),
  };
}

function metadataFor(file: FakeFile): Record<string, unknown> {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    size: String(file.bytes.byteLength),
    parents: [file.parentId],
    appProperties: file.appProperties,
    md5Checksum: createHash("md5").update(file.bytes).digest("base64"),
  };
}

async function startFakeDrive(options: FakeOptions): Promise<FakeDrive> {
  const files = new Map<string, FakeFile>();
  const uploadedPayloads: Buffer[] = [];
  const requests: string[] = [];
  const protocolErrors: string[] = [];
  let uploadRequests = 0;
  let nextId = 1;
  let duplicateSeeded = false;

  const server = createServer(async (request: any, response: any) => {
    const method = String(request.method ?? "");
    const parsed = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push(`${method} ${parsed.pathname}${parsed.search}`);

    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      json(response, 401, { error: "unauthorized" });
      return;
    }

    const isList = method === "GET" && parsed.pathname === "/drive/v3/files";
    if (isList) {
      if (
        parsed.searchParams.get("supportsAllDrives") !== "true" ||
        parsed.searchParams.get("includeItemsFromAllDrives") !== "true"
      ) {
        protocolErrors.push("list missing Shared Drive flags");
        json(response, 400, { error: "missing shared drive flags" });
        return;
      }
      const query = parsed.searchParams.get("q") ?? "";
      const folderMatch = query.match(/'([^']+)' in parents/);
      const canaryMatch = query.match(/value='([^']+)'/);
      if (!folderMatch || !canaryMatch) {
        protocolErrors.push("list query missing explicit parent/appProperties filter");
        json(response, 400, { error: "invalid query" });
        return;
      }
      const parentId = folderMatch[1];
      const canaryId = canaryMatch[1];
      if (options.mode === "duplicates" && !duplicateSeeded) {
        duplicateSeeded = true;
        for (const suffix of ["a", "b"]) {
          const file: FakeFile = {
            id: `duplicate-file-${suffix}`,
            name: "synthetic-canary.docx",
            mimeType: DOCX_MIME,
            parentId,
            appProperties: {
              mike_canary_id: canaryId,
              mike_canary_sha256: "not-used-in-duplicate-test",
              mike_canary_type: ACK,
            },
            bytes: Buffer.from("duplicate-synthetic-docx"),
          };
          files.set(file.id, file);
        }
      }
      const matches = [...files.values()]
        .filter(
          (file) =>
            file.parentId === parentId &&
            file.appProperties.mike_canary_id === canaryId,
        )
        .map(metadataFor);
      json(response, 200, { files: matches });
      return;
    }

    const uploadPath = "/upload/drive/v3/files";
    if (method === "POST" && parsed.pathname === uploadPath) {
      uploadRequests += 1;
      const body = await readBody(request);
      const { metadata, bytes: uploadedBytes } = parseMultipart(request, body);
      uploadedPayloads.push(Buffer.from(uploadedBytes));
      const parents = metadata.parents;
      const appProperties = metadata.appProperties;
      if (!Array.isArray(parents)) {
        throw new Error("fake Drive upload parents missing");
      }
      if (
        !appProperties ||
        typeof appProperties !== "object" ||
        Array.isArray(appProperties)
      ) {
        throw new Error("fake Drive upload appProperties missing");
      }
      const file: FakeFile = {
        id: `created-file-${nextId++}`,
        name: String(metadata.name),
        mimeType: String(metadata.mimeType),
        parentId: String(parents[0]),
        appProperties: appProperties as Record<string, string>,
        bytes: Buffer.from(uploadedBytes),
      };
      if (file.mimeType !== DOCX_MIME) protocolErrors.push("upload MIME is not DOCX");
      if (!file.bytes.byteLength) protocolErrors.push("upload has no bytes");
      if (
        file.appProperties.mike_canary_sha256 !==
        createHash("sha256").update(file.bytes).digest("hex")
      ) {
        protocolErrors.push("upload SHA-256 appProperty does not match bytes");
      }
      files.set(file.id, file);
      if (options.mode === "lost-upload" && uploadRequests === 1) {
        response.destroy();
        return;
      }
      json(response, 200, metadataFor(file));
      return;
    }

    const fileMatch = parsed.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (!fileMatch) {
      json(response, 404, { error: "not found" });
      return;
    }
    const fileId = decodeURIComponent(fileMatch[1]);
    const file = files.get(fileId);
    if (method === "GET" && parsed.searchParams.get("alt") === "media") {
      if (!file) {
        json(response, 404, { error: "not found" });
        return;
      }
      let body = file.bytes;
      if (options.mode === "hash-mismatch") {
        body = Buffer.from(file.bytes);
        body[0] = body[0] ^ 1;
      }
      bytes(response, 200, body);
      return;
    }
    if (method === "GET") {
      if (!file) {
        json(response, 404, { error: "not found" });
        return;
      }
      if (parsed.searchParams.get("supportsAllDrives") !== "true") {
        protocolErrors.push("metadata GET missing supportsAllDrives");
      }
      const metadata = metadataFor(file);
      if (options.mode === "metadata-mismatch") {
        metadata.parents = [`${FOLDER_ID}-wrong`];
      }
      json(response, 200, metadata);
      return;
    }
    if (method === "DELETE") {
      if (options.mode === "delete-fails") {
        json(response, 500, { error: "synthetic delete failure" });
        return;
      }
      if (!file) {
        json(response, 404, { error: "not found" });
        return;
      }
      files.delete(fileId);
      response.writeHead(204);
      response.end();
      return;
    }
    json(response, 405, { error: "method not allowed" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl: `${origin}/drive/v3`,
    uploadBaseUrl: `${origin}/upload/drive/v3`,
    files,
    uploadedPayloads,
    requests,
    protocolErrors,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error: Error | undefined) =>
          error ? reject(error) : resolve(),
        );
      }),
    uploadCount: () => uploadRequests,
  };
}

async function runCanary(
  fakeDrive: FakeDrive,
  options: { acknowledge?: string } = {},
): Promise<{ status: number; stdout: string; stderr: string }> {
  const tempDir = await mkdtemp(join(tmpdir(), "mike-drive-canary-test-"));
  const tokenFile = join(tempDir, "drive-token");
  await writeFile(tokenFile, TOKEN, { encoding: "utf8", mode: 0o600 });
  await chmod(tokenFile, 0o600);
  try {
    const child = spawn(
      "/bin/bash",
      [SCRIPT],
      {
        env: {
          ...process.env,
          GOOGLE_DRIVE_ACCESS_TOKEN_FILE: tokenFile,
          MIKE_DRIVE_CANARY_FOLDER_ID: FOLDER_ID,
          MIKE_DRIVE_CANARY_ACK: options.acknowledge ?? ACK,
          MIKE_DRIVE_CANARY_API_BASE_URL: fakeDrive.baseUrl,
          MIKE_DRIVE_CANARY_UPLOAD_BASE_URL: fakeDrive.uploadBaseUrl,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    const status = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code: number | null) => resolve(code ?? 1));
    });
    return { status, stdout, stderr };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function allOutput(result: { stdout: string; stderr: string }): string {
  return `${result.stdout}\n${result.stderr}`;
}

test("happy path is idempotent, verifies bytes, deletes, and hides the token", async () => {
  const fakeDrive = await startFakeDrive({ mode: "happy" });
  try {
    const result = await runCanary(fakeDrive);
    assert.equal(result.status, 0, allOutput(result));
    assert.match(result.stdout, /shared-drive-canary: PASS/);
    assert.equal(fakeDrive.uploadCount(), 1);
    assert.equal(fakeDrive.uploadedPayloads.length, 1);
    assert.equal(fakeDrive.uploadedPayloads[0].subarray(0, 2).toString(), "PK");
    assert.equal(fakeDrive.files.size, 0);
    assert.deepEqual(fakeDrive.protocolErrors, []);
    assert.ok(fakeDrive.requests.filter((entry) => entry.startsWith("GET /drive/v3/files?")).length >= 3);
    assert.doesNotMatch(allOutput(result), new RegExp(TOKEN));
    assert.doesNotMatch(allOutput(result), /created-file-1/);
  } finally {
    await fakeDrive.close();
  }
});

test("recovers a lost upload response by lookup before any second create", async () => {
  const fakeDrive = await startFakeDrive({ mode: "lost-upload" });
  try {
    const result = await runCanary(fakeDrive);
    assert.equal(result.status, 0, allOutput(result));
    assert.match(result.stdout, /shared-drive-canary: PASS/);
    assert.equal(fakeDrive.uploadCount(), 1);
    assert.equal(fakeDrive.files.size, 0);
    const uploadIndex = fakeDrive.requests.findIndex((entry) => entry.startsWith("POST /upload/"));
    assert.notEqual(uploadIndex, -1);
    assert.ok(fakeDrive.requests.slice(uploadIndex + 1).some((entry) => entry.startsWith("GET /drive/v3/files?")));
    assert.equal(fakeDrive.requests.filter((entry) => entry.startsWith("POST /upload/")).length, 1);
  } finally {
    await fakeDrive.close();
  }
});

test("fails closed on duplicate matches and cleans every residue", async () => {
  const fakeDrive = await startFakeDrive({ mode: "duplicates" });
  try {
    const result = await runCanary(fakeDrive);
    assert.notEqual(result.status, 0);
    assert.match(allOutput(result), /shared-drive-canary: FAIL/);
    assert.equal(fakeDrive.uploadCount(), 0);
    assert.equal(fakeDrive.files.size, 0);
    assert.doesNotMatch(allOutput(result), /duplicate-file-[ab]/);
  } finally {
    await fakeDrive.close();
  }
});

test("fails closed on downloaded hash mismatch and leaves zero residue", async () => {
  const fakeDrive = await startFakeDrive({ mode: "hash-mismatch" });
  try {
    const result = await runCanary(fakeDrive);
    assert.notEqual(result.status, 0);
    assert.match(allOutput(result), /shared-drive-canary: FAIL/);
    assert.equal(fakeDrive.uploadCount(), 1);
    assert.equal(fakeDrive.files.size, 0);
  } finally {
    await fakeDrive.close();
  }
});

test("fails closed on metadata mismatch and leaves zero residue", async () => {
  const fakeDrive = await startFakeDrive({ mode: "metadata-mismatch" });
  try {
    const result = await runCanary(fakeDrive);
    assert.notEqual(result.status, 0);
    assert.match(allOutput(result), /shared-drive-canary: FAIL/);
    assert.equal(fakeDrive.uploadCount(), 1);
    assert.equal(fakeDrive.files.size, 0);
  } finally {
    await fakeDrive.close();
  }
});

test("fails when permanent delete cannot be confirmed", async () => {
  const fakeDrive = await startFakeDrive({ mode: "delete-fails" });
  try {
    const result = await runCanary(fakeDrive);
    assert.notEqual(result.status, 0);
    assert.match(allOutput(result), /cleanup/i);
    assert.equal(fakeDrive.files.size, 1);
  } finally {
    await fakeDrive.close();
  }
});

test("fails before any Drive request when acknowledgement is not exact", async () => {
  const fakeDrive = await startFakeDrive({ mode: "happy" });
  try {
    const result = await runCanary(fakeDrive, { acknowledge: "synthetic-disposable-folder\n" });
    assert.notEqual(result.status, 0);
    assert.match(allOutput(result), /acknowledgement|ack/i);
    assert.equal(fakeDrive.requests.length, 0);
  } finally {
    await fakeDrive.close();
  }
});
