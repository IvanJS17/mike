import { describe, it, expect } from "vitest";
import {
  deriveDailyKey,
  encryptAuditJsonl,
  decryptAuditJsonl,
  expiredExportKeys,
} from "../auditExport";

const MASTER = Buffer.from("master-key-for-tests-0123456789abcdef", "utf8");

describe("deriveDailyKey (W1.14)", () => {
  it("derives a deterministic 32-byte key per date", () => {
    const a = deriveDailyKey(MASTER, "2026-08-12");
    const b = deriveDailyKey(MASTER, "2026-08-12");
    expect(a).toEqual(b);
    expect(a).toHaveLength(32);
  });

  it("derives different keys for different dates (daily rotation)", () => {
    const a = deriveDailyKey(MASTER, "2026-08-12");
    const b = deriveDailyKey(MASTER, "2026-08-13");
    expect(a).not.toEqual(b);
  });

  it("requires a master key of at least 32 bytes", () => {
    expect(() => deriveDailyKey(Buffer.from("short", "utf8"), "2026-08-12")).toThrow(
      /at least 32 bytes/,
    );
  });
});

describe("encryptAuditJsonl / decryptAuditJsonl (W1.14)", () => {
  it("round-trips JSONL through AES-256-GCM", () => {
    const key = deriveDailyKey(MASTER, "2026-08-12");
    const rows = [
      { id: 1, event_type: "user.invited", detail: { email: "a@b.c" } },
      { id: 2, event_type: "document.downloaded", detail: { document_id: "x" } },
    ];
    const encrypted = encryptAuditJsonl(
      rows.map((r) => JSON.stringify(r)).join("\n"),
      key,
    );
    expect(encrypted.iv).toHaveLength(12);
    expect(encrypted.ciphertext.length).toBeGreaterThan(0);

    const decrypted = decryptAuditJsonl(encrypted, key);
    expect(decrypted).toContain('"user.invited"');
    expect(decrypted).toContain('"document.downloaded"');
  });

  it("fails to decrypt with the wrong day's key (rotation integrity)", () => {
    const key = deriveDailyKey(MASTER, "2026-08-12");
    const wrongKey = deriveDailyKey(MASTER, "2026-08-13");
    const encrypted = encryptAuditJsonl("hello", key);
    expect(() => decryptAuditJsonl(encrypted, wrongKey)).toThrow();
  });
});

describe("expiredExportKeys (W1.14)", () => {
  it("keeps exports within the retention window and drops older ones", () => {
    const keys = [
      "daily/2026-08-10.jsonl.enc", // 35 days before 2026-09-14
      "daily/2026-08-14.jsonl.enc", // 31 days before
      "daily/2026-08-15.jsonl.enc", // 30 days before — boundary kept
      "daily/2026-09-01.jsonl.enc",
      "other/keep.txt",
    ];
    const expired = expiredExportKeys(keys, new Date("2026-09-14T00:00:00Z"), 30);
    expect(expired).toEqual(["daily/2026-08-10.jsonl.enc", "daily/2026-08-14.jsonl.enc"]);
  });
});
