import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { recordAuditEvent } from "../lib/audit";
import { buildContentDisposition, downloadFile } from "../lib/storage";
import { verifyDownload, verifyUserDownload } from "../lib/downloadTokens";
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
downloadsRouter.get("/:token", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const info = verifyDownload(req.params.token);
    if (!info)
        return void res.status(404).json({ detail: "Invalid link" });

    const db = createServerSupabase();
    let version:
        | {
              id: string;
              document_id: string;
          }
        | null = null;

    const { data: byStoragePath } = await db
        .from("document_versions")
        .select("id, document_id")
        .eq("storage_path", info.path)
        .is("deleted_at", null)
        .maybeSingle();
    if (byStoragePath) {
        version = byStoragePath as { id: string; document_id: string };
    }

    if (!version)
        return void res.status(404).json({ detail: "File not found" });

    const { data: doc } = await db
        .from("documents")
        .select("id, user_id, project_id")
        .eq("id", version.document_id)
        .single();
    if (!doc)
        return void res.status(404).json({ detail: "File not found" });

    const access = await ensureDocAccess(doc, userId, db);
    if (!access.ok)
        return void res.status(404).json({ detail: "File not found" });

    const raw = await downloadFile(info.path);
    if (!raw)
        return void res.status(404).json({ detail: "File not found" });

    res.setHeader("Content-Type", contentTypeFor(info.filename));
    res.setHeader(
        "Content-Disposition",
        buildContentDisposition("attachment", info.filename),
    );
    await recordAuditEvent(db, {
        actorUserId: userId,
        organizationId: null,
        eventType: "document.downloaded",
        eventDetail: { document_id: version.document_id, path: info.path },
    });
    res.send(Buffer.from(raw));
});

// Short-lived user-bound download URL used by SSE-C production objects. The
// browser never receives the storage key; access is revalidated against DB.
downloadsRouter.get("/user/:token", async (req, res) => {
    const info = verifyUserDownload(req.params.token);
    if (!info) return void res.status(404).json({ detail: "Invalid link" });
    const db = createServerSupabase();
    const { data: version } = await db
        .from("document_versions")
        .select("id, document_id")
        .eq("storage_path", info.path)
        .is("deleted_at", null)
        .maybeSingle();
    if (!version) return void res.status(404).json({ detail: "File not found" });
    const { data: doc } = await db
        .from("documents")
        .select("id, user_id, project_id")
        .eq("id", version.document_id)
        .single();
    if (!doc || !(await ensureDocAccess(doc, info.userId, db)).ok)
        return void res.status(404).json({ detail: "File not found" });
    const raw = await downloadFile(info.path);
    if (!raw) return void res.status(404).json({ detail: "File not found" });
    res.setHeader("Content-Type", contentTypeFor(info.filename));
    res.setHeader("Content-Disposition", buildContentDisposition("attachment", info.filename));
    await recordAuditEvent(db, {
        actorUserId: info.userId,
        organizationId: null,
        eventType: "document.downloaded",
        eventDetail: { document_id: version.document_id, path: info.path },
    });
    res.send(Buffer.from(raw));
});
