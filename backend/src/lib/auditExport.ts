/**
 * Daily encrypted audit export (W1.14).
 *
 * The export job (scripts/export-audit-daily.ts, cron 03:00 UTC) writes each
 * day's audit_events as AES-256-GCM encrypted JSONLines into the
 * audit-exports bucket. The encryption key rotates daily: it is derived
 * deterministically from a master key (AUDIT_EXPORT_MASTER_KEY) and the date,
 * so yesterday's key still decrypts yesterday's file and today's file uses a
 * fresh key without any key-management service.
 */

import crypto from "crypto";

export const AUDIT_EXPORT_PREFIX = "daily";
export const AUDIT_EXPORT_SUFFIX = ".jsonl.enc";
export const AUDIT_EXPORT_RETENTION_DAYS = 30;

/** Derive the 32-byte AES-256-GCM key for a given UTC date (daily rotation). */
export function deriveDailyKey(masterKey: Buffer, dateStr: string): Buffer {
  if (masterKey.length < 32) {
    throw new Error("AUDIT_EXPORT_MASTER_KEY must be at least 32 bytes");
  }
  return crypto
    .createHmac("sha256", masterKey)
    .update(`audit-export:${dateStr}`)
    .digest();
}

export interface EncryptedPayload {
  iv: Buffer;
  ciphertext: Buffer;
}

/** Encrypt JSONL text with the given key (AES-256-GCM, random 12-byte IV). */
export function encryptAuditJsonl(plaintext: string, key: Buffer): EncryptedPayload {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return { iv, ciphertext };
}

/** Decrypt a payload produced by encryptAuditJsonl. Throws on any tampering. */
export function decryptAuditJsonl(payload: EncryptedPayload, key: Buffer): string {
  const tag = payload.ciphertext.subarray(payload.ciphertext.length - 16);
  const data = payload.ciphertext.subarray(0, payload.ciphertext.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, payload.iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/** Keys older than the retention window (dates before now - retentionDays). */
export function expiredExportKeys(
  keys: string[],
  now: Date,
  retentionDays: number = AUDIT_EXPORT_RETENTION_DAYS,
): string[] {
  const cutoffMs = now.getTime() - retentionDays * 86_400_000;
  return keys.filter((key) => {
    const m = key.match(/^daily\/(\d{4}-\d{2}-\d{2})\.jsonl\.enc$/);
    if (!m) return false;
    const dateMs = Date.parse(`${m[1]}T00:00:00Z`);
    return Number.isFinite(dateMs) && dateMs < cutoffMs;
  });
}

/** UTC date string (yyyy-mm-dd) for a given Date. */
export function utcDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}
