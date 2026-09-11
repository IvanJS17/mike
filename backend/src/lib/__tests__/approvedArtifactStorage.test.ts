import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send = send;
  },
  PutObjectCommand: class {
    constructor(public input: unknown) {}
  },
  GetObjectCommand: class {
    constructor(public input: unknown) {}
  },
  DeleteObjectCommand: class {
    constructor(public input: unknown) {}
  },
  ListObjectsV2Command: class {
    constructor(public input: unknown) {}
  },
}));

beforeEach(() => {
  vi.resetModules();
  send.mockReset();
  vi.stubEnv("R2_ENDPOINT_URL", "http://127.0.0.1:1");
  vi.stubEnv("R2_ACCESS_KEY_ID", "synthetic-only");
  vi.stubEnv("R2_SECRET_ACCESS_KEY", "synthetic-only");
});
afterEach(() => vi.unstubAllEnvs());

describe("approved artifact object boundary", () => {
  it("requires create-only upload rather than overwriting an object", async () => {
    const storage = await import("../storage");
    expect(storage).toHaveProperty("uploadFileIfAbsent");
    send.mockResolvedValue({});
    await storage.uploadFileIfAbsent(
      "key",
      new Uint8Array([1, 2]),
      "application/test",
    );
    expect(send.mock.calls[0][0].input).toMatchObject({
      Key: "key",
      IfNoneMatch: "*",
      Body: Buffer.from([1, 2]),
    });
  });

  it("returns existing only for a confirmed conditional conflict", async () => {
    const storage = await import("../storage");
    expect(storage).toHaveProperty("uploadFileIfAbsent");
    send.mockRejectedValue({ $metadata: { httpStatusCode: 412 } });
    await expect(
      storage.uploadFileIfAbsent(
        "key",
        new Uint8Array([1]),
        "application/test",
      ),
    ).resolves.toBe("exists");
    send.mockRejectedValue(new Error("private dependency detail"));
    await expect(
      storage.uploadFileIfAbsent(
        "key",
        new Uint8Array([1]),
        "application/test",
      ),
    ).rejects.toThrow("Artifact storage write failed");
  });

  it("distinguishes proven absence from unknown read outcome", async () => {
    const storage = await import("../storage");
    expect(storage).toHaveProperty("downloadFileStrict");
    send.mockRejectedValue({ $metadata: { httpStatusCode: 404 } });
    await expect(storage.downloadFileStrict("key")).resolves.toBeNull();
    send.mockRejectedValue(new Error("private dependency detail"));
    await expect(storage.downloadFileStrict("key")).rejects.toThrow(
      "Artifact storage read failed",
    );
  });

  it("returns only the actual byte view, detached from dependency mutation", async () => {
    const storage = await import("../storage");
    expect(storage).toHaveProperty("downloadFileStrict");
    const source = new Uint8Array([9, 1, 2, 9]);
    send.mockResolvedValue({
      Body: { transformToByteArray: async () => source.subarray(1, 3) },
    });
    const bytes = await storage.downloadFileStrict("key");
    source.fill(0);
    expect(bytes).toEqual(new Uint8Array([1, 2]));
  });
});
