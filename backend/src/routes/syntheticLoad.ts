import { Router } from "express";
import { requireAuth } from "../middleware/auth";

export const syntheticLoadRouter = Router();
const resumedRuns = new Set<string>();

syntheticLoadRouter.use((req, res, next) => {
  if (process.env.NODE_ENV === "production" || process.env.SYNTHETIC_LOAD_ENABLED !== "true") {
    res.status(404).json({ detail: "Synthetic load seam is disabled" });
    return;
  }
  void requireAuth(req, res, next);
});

syntheticLoadRouter.post("/batch", (req, res) => {
  const run = typeof req.body?.load_run === "string" ? req.body.load_run : "";
  const documents = Number(req.body?.documents);
  const pages = Number(req.body?.pages);
  const inducedFailure = Number(req.query.induced_failure);
  if (!run || req.body?.synthetic !== true || documents !== 100 || pages !== 1000) {
    res.status(400).json({ detail: "Invalid synthetic load batch" });
    return;
  }
  if (Number.isInteger(inducedFailure) && inducedFailure >= 0 && inducedFailure < 10) {
    res.status(503).json({ detail: "Deterministic synthetic failure", failure: inducedFailure });
    return;
  }
  res.status(201).json({ load_run: run, accepted: true, documents, pages });
});

syntheticLoadRouter.post("/batch/resume", (req, res) => {
  const run = typeof req.body?.load_run === "string" ? req.body.load_run : "";
  if (!run || req.body?.synthetic !== true) {
    res.status(400).json({ detail: "Invalid synthetic resume" });
    return;
  }
  const duplicate = resumedRuns.has(run);
  resumedRuns.add(run);
  res.status(200).json({ load_run: run, resumed: true, duplicate, duplicates: duplicate ? 1 : 0 });
});
