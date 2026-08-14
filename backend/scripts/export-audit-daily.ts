/**
 * Daily audit export job (W1.14).
 *
 * Exports yesterday's audit_events as AES-256-GCM encrypted JSONLines into
 * the `audit-exports` bucket under daily/<yyyy-mm-dd>.jsonl.enc and deletes
 * exports older than the retention window (30 days).
 *
 * The encryption key rotates daily: derived from AUDIT_EXPORT_MASTER_KEY and
 * the UTC date (see lib/auditExport.ts), so no key-management service is
 * needed and yesterday's file stays decryptable with the same master key.
 *
 * Cron (UTC):  0 3 * * *  cd <repo>/backend && npm run export:audit
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (via lib/supabase),
 *      R2_* storage envs (via lib/storage), AUDIT_EXPORT_MASTER_KEY (>=32B,
 *      base64 or raw UTF-8), AUDIT_EXPORT_BUCKET (default audit-exports).
 */

import { createServerSupabase } from "../src/lib/supabase";
import {
  deriveDailyKey,
  encryptAuditJsonl,
  expiredExportKeys,
  utcDateStr,
  AUDIT_EXPORT_PREFIX,
  AUDIT_EXPORT_SUFFIX,
  AUDIT_EXPORT_RETENTION_DAYS,
} from "../src/lib/auditExport";
import {
  uploadFileToBucket,
  deleteFileFromBucket,
  listFiles,
} from "../src/lib/storage";

async function main() {
  const db = createServerSupabase();
  const masterRaw = process.env.AUDIT_EXPORT_MASTER_KEY ?? "";
  if (masterRaw.length < 32) {
    throw new Error("AUDIT_EXPORT_MASTER_KEY must be set (>= 32 bytes)");
  }
  const master = Buffer.from(masterRaw, "utf8");
  const bucket = process.env.AUDIT_EXPORT_BUCKET ?? "audit-exports";

  // Yesterday's window in UTC.
  const now = new Date();
  const today = utcDateStr(now);
  const yesterday = utcDateStr(new Date(now.getTime() - 86_400_000));
  const start = `${yesterday}T00:00:00Z`;
  const end = `${today}T00:00:00Z`;

  const { data: rows, error } = await db
    .from("audit_events")
    .select("id, actor_user_id, organization_id, event_type, event_detail, created_at")
    .gte("created_at", start)
    .lt("created_at", end)
    .order("id", { ascending: true });

  if (error) throw new Error(`audit_events read failed: ${error.message}`);

  if (!rows || rows.length === 0) {
    console.log(`[audit-export] no events for ${yesterday}; nothing to export`);
    return;
  }

  const jsonl = rows
    .map((r) => JSON.stringify(r))
    .join("\n");
  const key = deriveDailyKey(master, yesterday);
  const { iv, ciphertext } = encryptAuditJsonl(jsonl, key);

  const objectKey = `${AUDIT_EXPORT_PREFIX}/${yesterday}${AUDIT_EXPORT_SUFFIX}`;
  const payload = Buffer.concat([
    Buffer.from("AUDIT1"), // magic version marker
    iv,
    ciphertext,
  ]);
  await uploadFileToBucket(bucket, objectKey, payload, "application/octet-stream");

  // Retention: drop exports older than the window.
  const existing = await listFiles(`${AUDIT_EXPORT_PREFIX}/`).catch(() => [] as string[]);
  const expired = expiredExportKeys(existing, now, AUDIT_EXPORT_RETENTION_DAYS);
  for (const k of expired) {
    await deleteFileFromBucket(bucket, k).catch(() => {});
  }

  console.log(
    `[audit-export] ${rows.length} events for ${yesterday} -> ${bucket}/${objectKey} (${payload.length} bytes; ${expired.length} expired removed)`,
  );
}

main().catch((err) => {
  console.error("[audit-export] FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
