import { createHash } from "node:crypto";

export const storageSecurityConfigurationError =
  "R2_SSE_CUSTOMER_KEY must be a base64-encoded 32-byte key in production";

export type SseCustomerHeaders = {
  SSECustomerAlgorithm: "AES256";
  SSECustomerKey: string;
  SSECustomerKeyMD5: string;
};

function decodeCustomerKey(encoded: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    throw new Error(storageSecurityConfigurationError);
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== encoded) {
    throw new Error(storageSecurityConfigurationError);
  }
  return decoded;
}

/**
 * Return the S3 SSE-C headers for object PUT/GET commands.
 *
 * Production requires a 256-bit base64 key. Local tests may omit it because
 * the local RustFS stack is intentionally not a production data boundary.
 */
export function sseCustomerHeaders(): SseCustomerHeaders | undefined {
  const encoded = process.env.R2_SSE_CUSTOMER_KEY?.trim();
  if (!encoded) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(storageSecurityConfigurationError);
    }
    return undefined;
  }

  const decoded = decodeCustomerKey(encoded);
  return {
    SSECustomerAlgorithm: "AES256",
    SSECustomerKey: encoded,
    SSECustomerKeyMD5: createHash("md5").update(decoded).digest("base64"),
  };
}
