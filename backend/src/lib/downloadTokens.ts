import crypto from "node:crypto";
import type { createServerSupabase } from "./supabase";

type Db = ReturnType<typeof createServerSupabase>;

export const DOWNLOAD_GRANT_TTL_SECONDS = 5 * 60;

export interface DownloadGrant {
  document_id: string;
  document_version_id: string;
  storage_path: string;
  filename: string;
  issued_to_user: string;
  expires_at: string;
  consumed_at: string | null;
}

function encodeToken(bytes: Buffer): string {
  return bytes
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function hashDownloadToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

export async function createDownloadUrl(
  db: Db,
  input: {
    documentId: string;
    versionId: string;
    storagePath: string;
    filename: string;
    userId: string;
    expiresInSeconds?: number;
  },
): Promise<string> {
  const token = encodeToken(crypto.randomBytes(32));
  const expiresInSeconds =
    input.expiresInSeconds ?? DOWNLOAD_GRANT_TTL_SECONDS;
  if (!Number.isInteger(expiresInSeconds) || expiresInSeconds <= 0) {
    throw new Error("Download grant expiration must be a positive integer");
  }
  const expiresAt = new Date(
    Date.now() + expiresInSeconds * 1000,
  ).toISOString();

  const { error } = await db.from("document_download_grants").insert({
    token_hash: hashDownloadToken(token),
    document_id: input.documentId,
    document_version_id: input.versionId,
    storage_path: input.storagePath,
    filename: input.filename,
    issued_to_user: input.userId,
    expires_at: expiresAt,
    consumed_at: null,
  });
  if (error) throw new Error(`Failed to create download grant: ${error.message}`);

  return `/download/${token}`;
}

export async function consumeDownloadGrant(
  db: Db,
  token: string,
  userId: string,
  now = new Date(),
): Promise<DownloadGrant | null> {
  if (!token || !userId) return null;
  const { data, error } = await db
    .from("document_download_grants")
    .update({ consumed_at: now.toISOString() })
    .eq("token_hash", hashDownloadToken(token))
    .eq("issued_to_user", userId)
    .is("consumed_at", null)
    .gt("expires_at", now.toISOString())
    .select(
      "document_id, document_version_id, storage_path, filename, issued_to_user, expires_at, consumed_at",
    )
    .maybeSingle();
  if (error || !data) return null;
  return data as DownloadGrant;
}
