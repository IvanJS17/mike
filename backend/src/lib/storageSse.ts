import { createHash } from "node:crypto";

export const storageSecurityConfigurationError =
  "R2_SSE_CUSTOMER_KEY must be a base64-encoded 32-byte key when production SSE-C is required";

export type SseCustomerHeaders = {
  SSECustomerAlgorithm: "AES256";
  SSECustomerKey: string;
  SSECustomerKeyMD5: string;
};

function required(): boolean {
  return process.env.R2_SSE_CUSTOMER_KEY_REQUIRED === "true";
}

export function validateStorageEndpoint(endpoint = process.env.R2_ENDPOINT_URL): void {
  if (!required()) return;
  if (!endpoint) throw new Error("R2_ENDPOINT_URL is required");
  const parsed = new URL(endpoint);
  if (parsed.protocol !== "https:") throw new Error("R2_ENDPOINT_URL must use HTTPS");
  const allowlist = (process.env.R2_ENDPOINT_ALLOWLIST ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  if (allowlist.length === 0 || !allowlist.includes(parsed.hostname.toLowerCase())) {
    throw new Error("R2_ENDPOINT_URL host is not in R2_ENDPOINT_ALLOWLIST");
  }
}

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

export function sseCustomerHeaders(): SseCustomerHeaders | undefined {
  if (!required()) return undefined;
  const encoded = process.env.R2_SSE_CUSTOMER_KEY?.trim();
  if (!encoded) {
    if (required()) throw new Error(storageSecurityConfigurationError);
    return undefined;
  }
  const decoded = decodeCustomerKey(encoded);
  return {
    SSECustomerAlgorithm: "AES256",
    SSECustomerKey: encoded,
    SSECustomerKeyMD5: createHash("md5").update(decoded).digest("base64"),
  };
}
