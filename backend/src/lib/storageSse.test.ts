import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  sseCustomerHeaders,
  storageSecurityConfigurationError,
} from "./storageSse";

const originalNodeEnv = process.env.NODE_ENV;
const originalKey = process.env.R2_SSE_CUSTOMER_KEY;

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalKey === undefined) delete process.env.R2_SSE_CUSTOMER_KEY;
  else process.env.R2_SSE_CUSTOMER_KEY = originalKey;
});

describe("S3 SSE-C storage headers", () => {
  it("returns AES256 headers and the MD5 of the decoded 32-byte key", () => {
    const decoded = Buffer.alloc(32, 7);
    process.env.R2_SSE_CUSTOMER_KEY = decoded.toString("base64");
    process.env.NODE_ENV = "production";

    expect(sseCustomerHeaders()).toEqual({
      SSECustomerAlgorithm: "AES256",
      SSECustomerKey: decoded.toString("base64"),
      SSECustomerKeyMD5: createHash("md5").update(decoded).digest("base64"),
    });
  });

  it("rejects a customer key that is not exactly 256 bits", () => {
    process.env.R2_SSE_CUSTOMER_KEY = Buffer.alloc(31, 4).toString("base64");
    process.env.NODE_ENV = "production";

    expect(() => sseCustomerHeaders()).toThrow(/32-byte/i);
  });

  it("fails closed in production when SSE-C is not configured", () => {
    delete process.env.R2_SSE_CUSTOMER_KEY;
    process.env.NODE_ENV = "production";

    expect(() => sseCustomerHeaders()).toThrow(storageSecurityConfigurationError);
  });

  it("allows the local test stack to omit SSE-C", () => {
    delete process.env.R2_SSE_CUSTOMER_KEY;
    process.env.NODE_ENV = "test";

    expect(sseCustomerHeaders()).toBeUndefined();
  });
});
