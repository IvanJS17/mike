import { readFileSync } from "node:fs";
import type { NextFunction, Request, Response } from "express";

export function isBackupFresh(): boolean {
  if (process.env.BACKUP_FRESHNESS_REQUIRED !== "true") return true;
  const path = process.env.BACKUP_FRESHNESS_FILE;
  if (!path) return false;
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as {
      backup_freshness_ok?: boolean;
    };
    return state.backup_freshness_ok === true;
  } catch {
    return false;
  }
}

export function enforceBackupFreshness(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    next();
    return;
  }
  if (!isBackupFresh()) {
    res.status(503).json({ detail: "Recovery coverage is stale" });
    return;
  }
  next();
}
