import path from "node:path";

import { buildSupportedUpgradeSql } from "../lib/recovery/supportedUpgradeDriver";

function usage(): never {
  throw new Error(
    "usage: recovery-upgrade emit-sql --migrations-dir <path>",
  );
}

function parseMigrationsDir(args: string[]): string {
  if (args[0] !== "emit-sql" || args[1] !== "--migrations-dir" || !args[2]) {
    return usage();
  }
  if (args.length !== 3) return usage();
  return path.resolve(args[2]);
}

try {
  process.stdout.write(
    buildSupportedUpgradeSql({ migrationsDir: parseMigrationsDir(process.argv.slice(2)) }),
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "recovery upgrade failed"}\n`);
  process.exitCode = 1;
}
