import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  sseCustomerHeaders,
  storageSecurityConfigurationError,
  validateStorageEndpoint,
} from "./storageSse";

const originalNodeEnv = process.env.NODE_ENV;
const originalKey = process.env.R2_SSE_CUSTOMER_KEY;
const originalRequired = process.env.R2_SSE_CUSTOMER_KEY_REQUIRED;
const originalAllowlist = process.env.R2_ENDPOINT_ALLOWLIST;

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalKey === undefined) delete process.env.R2_SSE_CUSTOMER_KEY;
  else process.env.R2_SSE_CUSTOMER_KEY = originalKey;
  if (originalRequired === undefined) delete process.env.R2_SSE_CUSTOMER_KEY_REQUIRED;
  else process.env.R2_SSE_CUSTOMER_KEY_REQUIRED = originalRequired;
  if (originalAllowlist === undefined) delete process.env.R2_ENDPOINT_ALLOWLIST;
  else process.env.R2_ENDPOINT_ALLOWLIST = originalAllowlist;
});

describe("S3 SSE-C storage headers", () => {
  it("returns AES256 headers and the MD5 of the decoded 32-byte key", () => {
    const decoded = Buffer.alloc(32, 7);
    process.env.R2_SSE_CUSTOMER_KEY = decoded.toString("base64");
    process.env.R2_SSE_CUSTOMER_KEY_REQUIRED = "true";

    expect(sseCustomerHeaders()).toEqual({
      SSECustomerAlgorithm: "AES256",
      SSECustomerKey: decoded.toString("base64"),
      SSECustomerKeyMD5: createHash("md5").update(decoded).digest("base64"),
    });
  });

  it("rejects a customer key that is not exactly 256 bits", () => {
    process.env.R2_SSE_CUSTOMER_KEY = Buffer.alloc(31, 4).toString("base64");
    process.env.R2_SSE_CUSTOMER_KEY_REQUIRED = "true";

    expect(() => sseCustomerHeaders()).toThrow(/32-byte/i);
  });

  it("fails closed when production SSE-C is required but missing", () => {
    delete process.env.R2_SSE_CUSTOMER_KEY;
    process.env.R2_SSE_CUSTOMER_KEY_REQUIRED = "true";

    expect(() => sseCustomerHeaders()).toThrow(storageSecurityConfigurationError);
  });

  it("allows the local RustFS stack to omit SSE-C", () => {
    delete process.env.R2_SSE_CUSTOMER_KEY;
    process.env.NODE_ENV = "production";
    process.env.R2_SSE_CUSTOMER_KEY_REQUIRED = "false";

    expect(sseCustomerHeaders()).toBeUndefined();
  });

  it("requires HTTPS and an explicit endpoint host when production SSE-C is on", () => {
    process.env.R2_SSE_CUSTOMER_KEY_REQUIRED = "true";
    process.env.R2_ENDPOINT_ALLOWLIST = "objects.example.invalid";
    expect(() => validateStorageEndpoint("http://objects.example.invalid")).toThrow(/HTTPS/);
    expect(() => validateStorageEndpoint("https://other.example.invalid")).toThrow(/allowlist/i);
    expect(() => validateStorageEndpoint("https://objects.example.invalid")).not.toThrow();
  });
});
