import { randomUUID } from "node:crypto";
import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { recordAuditEvent } from "../lib/audit";
import { buildContentDisposition, downloadFile } from "../lib/storage";
import { consumeDownloadGrant } from "../lib/downloadTokens";
import { ensureDocAccess } from "../lib/access";
import { contentTypeForDocumentType } from "../lib/documentTypes";

export const downloadsRouter = Router();

function contentTypeFor(filename: string): string {
  const suffix = filename.includes(".")
    ? filename.split(".").pop()?.toLowerCase()
    : "";
  return contentTypeForDocumentType(suffix);
}

// GET /download/:token
// The token is an authenticated, short-lived, single-use grant. It does not
// contain a storage path and is bound to the user who requested it.
downloadsRouter.get("/:token", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  const grant = await consumeDownloadGrant(db, req.params.token, userId);
  if (!grant) return void res.status(404).json({ detail: "Invalid link" });

  const { data: doc } = await db
    .from("documents")
    .select("id, user_id, project_id")
    .eq("id", grant.document_id)
    .single();
  if (!doc) return void res.status(404).json({ detail: "File not found" });

  const access = await ensureDocAccess(doc, userId, db);
  if (!access.ok) return void res.status(404).json({ detail: "File not found" });

  const { data: version } = await db
    .from("document_versions")
    .select("id, document_id, storage_path, file_type, deleted_at")
    .eq("id", grant.document_version_id)
    .eq("document_id", grant.document_id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!version || version.storage_path !== grant.storage_path) {
    return void res.status(404).json({ detail: "File not found" });
  }

  const raw = await downloadFile(grant.storage_path);
  if (!raw) return void res.status(404).json({ detail: "File not found" });

  res.setHeader("Content-Type", contentTypeFor(grant.filename));
  res.setHeader(
    "Content-Disposition",
    buildContentDisposition("attachment", grant.filename),
  );
  await recordAuditEvent(db, {
    actorUserId: userId,
    organizationId: null,
    eventType: "document.downloaded",
    eventDetail: {
      project_id: doc.project_id ?? null,
      document_id: grant.document_id,
      document_version_id: grant.document_version_id,
      result: "success",
      correlation_id: randomUUID(),
    },
  });
  res.send(Buffer.from(raw));
});
