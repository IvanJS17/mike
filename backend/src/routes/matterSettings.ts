import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth";
import { checkMatterAccess } from "../lib/aiAccess";
import { createServerSupabase } from "../lib/supabase";

export const matterSettingsRouter = Router({ mergeParams: true });

const DRIVE_FOLDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

type MatterRow = {
  id: string;
  project_id: string | null;
  drive_folder_id: string | null;
};

type MatterFolderAccess = {
  matter: MatterRow;
  role: string;
  canEdit: boolean;
};

function bodyOf(req: Request): Record<string, unknown> {
  return req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? (req.body as Record<string, unknown>)
    : {};
}

function publicMatterFolder({ matter, role, canEdit }: MatterFolderAccess) {
  return {
    matter_id: matter.id,
    project_id: matter.project_id,
    drive_folder_id: matter.drive_folder_id?.trim() || null,
    role,
    can_edit: canEdit,
  };
}

async function loadMatterFolderAccess(
  req: Request,
  intent: "read" = "read",
): Promise<
  | { ok: true; db: ReturnType<typeof createServerSupabase>; access: MatterFolderAccess }
  | { ok: false }
> {
  const userId = String(req.res?.locals.userId ?? "");
  const projectId = req.params.projectId;
  const matterId = req.params.matterId;
  if (!userId || !projectId || !matterId) return { ok: false };

  const db = createServerSupabase();
  const matterAccess = await checkMatterAccess(matterId, userId, db, intent);
  if (!matterAccess.ok || matterAccess.projectId !== projectId) return { ok: false };

  const { data: matter, error } = await db
    .from("matters")
    .select("id, project_id, drive_folder_id")
    .eq("id", matterId)
    .eq("project_id", projectId)
    .maybeSingle();
  if (error || !matter) return { ok: false };

  const row = matter as MatterRow;
  return {
    ok: true,
    db,
    access: {
      matter: row,
      role: matterAccess.role ?? "unknown",
      canEdit: matterAccess.role === "matter_owner",
    },
  };
}

function invalidFolderResponse(res: Response) {
  return void res.status(400).json({
    code: "invalid_drive_folder_id",
    detail: "Shared Drive folder ID is invalid",
  });
}

matterSettingsRouter.get("/:matterId/drive-folder", requireAuth, async (req, res) => {
  const loaded = await loadMatterFolderAccess(req);
  if (!loaded.ok) return void res.status(404).json({ detail: "Matter not found" });
  return void res.json(publicMatterFolder(loaded.access));
});

matterSettingsRouter.patch(
  "/:matterId/drive-folder",
  requireAuth,
  async (req, res) => {
    const loaded = await loadMatterFolderAccess(req);
    if (!loaded.ok) return void res.status(404).json({ detail: "Matter not found" });
    if (!loaded.access.canEdit) {
      return void res.status(403).json({
        code: "matter_owner_required",
        detail: "Only the matter owner can change the Shared Drive folder",
      });
    }

    const body = bodyOf(req);
    if (!("drive_folder_id" in body)) return invalidFolderResponse(res);
    const value = body.drive_folder_id;
    if (value !== null && typeof value !== "string") {
      return invalidFolderResponse(res);
    }
    const driveFolderId = typeof value === "string" ? value.trim() : null;
    if (driveFolderId && !DRIVE_FOLDER_ID_PATTERN.test(driveFolderId)) {
      return invalidFolderResponse(res);
    }

    const { data: updated, error } = await loaded.db
      .from("matters")
      .update({
        drive_folder_id: driveFolderId || null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", loaded.access.matter.id)
      .eq("project_id", req.params.projectId)
      .select("id, project_id, drive_folder_id")
      .single();
    if (error || !updated) {
      return void res.status(404).json({ detail: "Matter not found" });
    }

    return void res.json(
      publicMatterFolder({
        matter: updated as MatterRow,
        role: loaded.access.role,
        canEdit: loaded.access.canEdit,
      }),
    );
  },
);
