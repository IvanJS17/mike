import { Router } from "express";
import { createServerSupabase } from "../lib/supabase";
import { requireAuth } from "../middleware/auth";

export const syntheticLoadRouter = Router();

type SyntheticBatchBody = {
  load_run?: unknown;
  synthetic?: unknown;
  documents?: unknown;
  pages?: unknown;
};

export function isSyntheticLoadDisabled() {
  return process.env.NODE_ENV === "production" || process.env.SYNTHETIC_LOAD_ENABLED !== "true";
}

export function validateSyntheticBatch(body: SyntheticBatchBody) {
  return (
    typeof body.load_run === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(body.load_run) &&
    body.synthetic === true && Number(body.documents) === 100 && Number(body.pages) === 1000
  );
}

export function buildSyntheticWorkflowBody(loadRun: string) {
  return { metadata: { title: `WS2 synthetic workflow ${loadRun}`, type: "assistant" } };
}

function userId(res: Parameters<typeof requireAuth>[1]) {
  return typeof res.locals.userId === "string" ? res.locals.userId : "";
}

function invalidLoadTarget(res: Parameters<typeof requireAuth>[1]) {
  res.status(404).json({ detail: "Synthetic load seam is disabled" });
}

syntheticLoadRouter.use((req, res, next) => {
  if (isSyntheticLoadDisabled()) {
    invalidLoadTarget(res);
    return;
  }
  requireAuth(req, res, next).catch(next);
});

syntheticLoadRouter.post("/workspaces", async (req, res) => {
  const owner = userId(res);
  const run = typeof req.body?.load_run === "string" ? req.body.load_run : "";
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!owner || req.body?.synthetic !== true || !/^[A-Za-z0-9._-]{1,80}$/.test(run) || !name) {
    res.status(400).json({ detail: "Invalid synthetic workspace" });
    return;
  }
  try {
    const db = createServerSupabase();
    const { data: organization, error: organizationError } = await db
      .from("organizations")
      .insert({ name: `WS2 synthetic ${run}`, created_by: owner })
      .select("id")
      .single();
    if (organizationError || !organization) throw organizationError ?? new Error("organization insert failed");
    await db.from("organization_memberships").insert({
      organization_id: organization.id,
      user_id: owner,
      role: "org_owner",
    });
    const { data: workspace, error } = await db
      .from("workspaces")
      .insert({ organization_id: organization.id, name, created_by: owner })
      .select("id, organization_id")
      .single();
    if (error || !workspace) {
      await db.from("organizations").delete().eq("id", organization.id).eq("created_by", owner);
      throw error ?? new Error("workspace insert failed");
    }
    await db.from("workspace_memberships").insert({
      workspace_id: workspace.id,
      user_id: owner,
      role: "workspace_admin",
    });
    res.status(201).json(workspace);
  } catch (error) {
    res.status(500).json({ detail: error instanceof Error ? error.message : "Synthetic workspace failed" });
  }
});

syntheticLoadRouter.get("/workspaces", async (_req, res) => {
  try {
    const db = createServerSupabase();
    const { data, error } = await db
      .from("workspaces")
      .select("id, organization_id, name, created_at")
      .eq("created_by", userId(res));
    if (error) throw error;
    res.json(data ?? []);
  } catch (error) {
    res.status(500).json({ detail: error instanceof Error ? error.message : "Synthetic workspace listing failed" });
  }
});

syntheticLoadRouter.post("/matters", async (req, res) => {
  const owner = userId(res);
  const workspaceId = typeof req.body?.workspace_id === "string" ? req.body.workspace_id : "";
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!owner || req.body?.synthetic !== true || !workspaceId || !name) {
    res.status(400).json({ detail: "Invalid synthetic matter" });
    return;
  }
  try {
    const db = createServerSupabase();
    const { data: workspace, error: workspaceError } = await db
      .from("workspaces")
      .select("id")
      .eq("id", workspaceId)
      .eq("created_by", owner)
      .single();
    if (workspaceError || !workspace) {
      res.status(404).json({ detail: "Synthetic workspace not found" });
      return;
    }
    const { data: matter, error } = await db
      .from("matters")
      .insert({ workspace_id: workspace.id, name, created_by: owner, practice: "synthetic" })
      .select("id, workspace_id")
      .single();
    if (error || !matter) throw error ?? new Error("matter insert failed");
    await db.from("matter_memberships").insert({
      matter_id: matter.id,
      user_id: owner,
      role: "matter_owner",
    });
    res.status(201).json(matter);
  } catch (error) {
    res.status(500).json({ detail: error instanceof Error ? error.message : "Synthetic matter failed" });
  }
});

syntheticLoadRouter.get("/matters", async (_req, res) => {
  try {
    const db = createServerSupabase();
    const { data, error } = await db
      .from("matters")
      .select("id, workspace_id, name, created_at")
      .eq("created_by", userId(res));
    if (error) throw error;
    res.json(data ?? []);
  } catch (error) {
    res.status(500).json({ detail: error instanceof Error ? error.message : "Synthetic matter listing failed" });
  }
});

syntheticLoadRouter.delete("/workspaces/:workspaceId", async (req, res) => {
  try {
    const db = createServerSupabase();
    const owner = userId(res);
    const { data: workspace } = await db
      .from("workspaces")
      .select("organization_id")
      .eq("id", req.params.workspaceId)
      .eq("created_by", owner)
      .single();
    if (!workspace) {
      res.status(404).json({ detail: "Synthetic workspace not found" });
      return;
    }
    const { error } = await db.from("workspaces").delete().eq("id", req.params.workspaceId).eq("created_by", owner);
    if (error) throw error;
    await db.from("organizations").delete().eq("id", workspace.organization_id).eq("created_by", owner);
    res.status(204).end();
  } catch (error) {
    res.status(500).json({ detail: error instanceof Error ? error.message : "Synthetic workspace cleanup failed" });
  }
});

syntheticLoadRouter.delete("/matters/:matterId", async (req, res) => {
  try {
    const db = createServerSupabase();
    const { error } = await db
      .from("matters")
      .delete()
      .eq("id", req.params.matterId)
      .eq("created_by", userId(res));
    if (error) throw error;
    res.status(204).end();
  } catch (error) {
    res.status(500).json({ detail: error instanceof Error ? error.message : "Synthetic matter cleanup failed" });
  }
});

syntheticLoadRouter.post("/batch", async (req, res) => {
  if (!validateSyntheticBatch(req.body)) {
    res.status(400).json({ detail: "Invalid synthetic load batch" });
    return;
  }
  const run = req.body.load_run as string;
  const inducedFailure = Number(req.query.induced_failure);
  try {
    const db = createServerSupabase();
    const owner = userId(res);
    const { error: insertError } = await db.from("synthetic_load_runs").upsert({
      user_id: owner,
      load_run: run,
      documents: 100,
      pages: 1000,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id,load_run", ignoreDuplicates: true });
    if (insertError) throw insertError;
    if (Number.isInteger(inducedFailure) && inducedFailure >= 0 && inducedFailure < 10) {
      const { data: current, error: readError } = await db
        .from("synthetic_load_runs")
        .select("induced_failures")
        .eq("user_id", owner)
        .eq("load_run", run)
        .single();
      if (readError || !current) throw readError ?? new Error("synthetic run missing");
      const inducedFailures = Math.max(Number(current.induced_failures), inducedFailure + 1);
      const { error } = await db.from("synthetic_load_runs").update({
        induced_failures: inducedFailures,
        updated_at: new Date().toISOString(),
      }).eq("user_id", owner).eq("load_run", run);
      if (error) throw error;
      res.status(503).json({ detail: "Deterministic synthetic failure", failure: inducedFailure });
      return;
    }
    res.status(201).json({ load_run: run, accepted: true, documents: 100, pages: 1000 });
  } catch (error) {
    res.status(500).json({ detail: error instanceof Error ? error.message : "Synthetic batch failed" });
  }
});

syntheticLoadRouter.post("/batch/resume", async (req, res) => {
  const run = typeof req.body?.load_run === "string" ? req.body.load_run : "";
  if (!run || req.body?.synthetic !== true) {
    res.status(400).json({ detail: "Invalid synthetic resume" });
    return;
  }
  try {
    const db = createServerSupabase();
    const owner = userId(res);
    const { data: current, error: readError } = await db
      .from("synthetic_load_runs")
      .select("induced_failures, status, resumed_count")
      .eq("user_id", owner)
      .eq("load_run", run)
      .single();
    if (readError || !current) {
      res.status(404).json({ detail: "Synthetic batch not found" });
      return;
    }
    if (Number(current.induced_failures) < 10) {
      res.status(409).json({ detail: "Synthetic batch has not recorded ten failures" });
      return;
    }
    const duplicate = current.status === "completed";
    if (!duplicate) {
      const { error } = await db.from("synthetic_load_runs").update({
        status: "completed",
        resumed_count: Number(current.resumed_count) + 1,
        updated_at: new Date().toISOString(),
      }).eq("user_id", owner).eq("load_run", run).eq("status", "pending");
      if (error) throw error;
    }
    res.json({ load_run: run, resumed: true, duplicate, duplicates: duplicate ? 1 : 0 });
  } catch (error) {
    res.status(500).json({ detail: error instanceof Error ? error.message : "Synthetic resume failed" });
  }
});

syntheticLoadRouter.delete("/batch/:run", async (req, res) => {
  try {
    const { error } = await createServerSupabase()
      .from("synthetic_load_runs")
      .delete()
      .eq("user_id", userId(res))
      .eq("load_run", req.params.run);
    if (error) throw error;
    res.status(204).end();
  } catch (error) {
    res.status(500).json({ detail: error instanceof Error ? error.message : "Synthetic batch cleanup failed" });
  }
});
