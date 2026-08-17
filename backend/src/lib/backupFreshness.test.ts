import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isBackupFresh } from "./backupFreshness";

const originalFile = process.env.BACKUP_FRESHNESS_FILE;
const originalRequired = process.env.BACKUP_FRESHNESS_REQUIRED;
const temp = mkdtempSync("/tmp/litt-freshness-");

afterEach(() => {
  if (originalFile === undefined) delete process.env.BACKUP_FRESHNESS_FILE;
  else process.env.BACKUP_FRESHNESS_FILE = originalFile;
  if (originalRequired === undefined) delete process.env.BACKUP_FRESHNESS_REQUIRED;
  else process.env.BACKUP_FRESHNESS_REQUIRED = originalRequired;
  rmSync(temp, { recursive: true, force: true });
});

describe("backup freshness gate", () => {
  it("requires a successful recent set when production gate is enabled", () => {
    const file = join(temp, "freshness.json");
    process.env.BACKUP_FRESHNESS_FILE = file;
    process.env.BACKUP_FRESHNESS_REQUIRED = "true";
    writeFileSync(file, JSON.stringify({
      backup_freshness_ok: true,
      status: "healthy",
      latest_completed_at: new Date().toISOString(),
    }));
    expect(isBackupFresh()).toBe(true);
    writeFileSync(file, JSON.stringify({
      backup_freshness_ok: true,
      status: "healthy",
      latest_completed_at: "2000-01-01T00:00:00Z",
    }));
    expect(isBackupFresh()).toBe(false);
  });

  it("does not enable the gate for the local demo", () => {
    delete process.env.BACKUP_FRESHNESS_FILE;
    process.env.BACKUP_FRESHNESS_REQUIRED = "false";
    expect(isBackupFresh()).toBe(true);
  });
});
