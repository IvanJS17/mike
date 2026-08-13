/**
 * Project / document access helpers.
 *
 * Access helpers now enforce owner-only access for projects, documents,
 * and tabular reviews.
 */

import type { createServerSupabase } from "./supabase";

type Db = ReturnType<typeof createServerSupabase>;

export type ProjectAccess =
    | {
          ok: true;
          isOwner: boolean;
          project: {
              id: string;
              user_id: string;
          };
      }
    | { ok: false };

export async function checkProjectAccess(
    projectId: string,
    userId: string,
    db: Db,
): Promise<ProjectAccess> {
    const { data: project } = await db
        .from("projects")
        .select("id, user_id")
        .eq("id", projectId)
        .single();
    if (!project) return { ok: false };
    const proj = project as { id: string; user_id: string };
    if (proj.user_id === userId) {
        return { ok: true, isOwner: true, project: proj };
    }
    return { ok: false };
}

/**
 * Check whether the current user can access a document the caller has
 * already loaded (saves a round-trip vs. having the helper re-fetch).
 * Owner-of-doc passes immediately; otherwise owner-of-project access is
 * checked.
 */
export async function ensureDocAccess(
    doc: { user_id: string; project_id: string | null },
    userId: string,
    db: Db,
): Promise<{ ok: true; isOwner: boolean } | { ok: false }> {
    if (doc.user_id === userId) return { ok: true, isOwner: true };
    return { ok: false };
}

/**
 * Same shape as `ensureDocAccess`, for tabular_reviews.
 * Reviews are now owner-only, with project-owned reviews falling under
 * the owning project's access check.
 */
export async function ensureReviewAccess(
    review: {
        user_id: string;
        project_id: string | null;
    },
    userId: string,
    db: Db,
): Promise<{ ok: true; isOwner: boolean } | { ok: false }> {
    if (review.user_id === userId) return { ok: true, isOwner: true };
    return { ok: false };
}

/**
 * Filter user-supplied document IDs down to documents the caller can read.
 *
 * Tabular review routes accept document IDs from request bodies. Without this
 * check, a caller with access to any review could attach arbitrary document
 * UUIDs and later cause /generate or /regenerate-cell to extract those bytes.
 */
export async function filterAccessibleDocumentIds(
    documentIds: string[],
    userId: string,
    db: Db,
): Promise<string[]> {
    if (documentIds.length === 0) return [];
    const { data: docs } = await db
        .from("documents")
        .select("id, user_id, project_id")
        .in("id", documentIds);
    const rows = (docs ?? []) as {
        id: string;
        user_id: string;
        project_id: string | null;
    }[];
    if (rows.length === 0) return [];

    const accessibleProjectIds = new Set(await listAccessibleProjectIds(userId, db));
    const allowed: string[] = [];
    for (const doc of rows) {
        if (doc.user_id === userId) {
            allowed.push(doc.id);
        } else if (
            doc.project_id &&
            accessibleProjectIds.has(doc.project_id)
        ) {
            allowed.push(doc.id);
        }
    }
    return allowed;
}

/**
 * Returns the set of project IDs the user can access — own projects plus
 * owned projects only. Used to scope chat
 * lists and similar collection queries.
 */
export async function listAccessibleProjectIds(
    userId: string,
    db: Db,
): Promise<string[]> {
    const { data: own } = await db.from("projects").select("id").eq("user_id", userId);
    const ids = new Set<string>();
    for (const p of (own ?? []) as { id: string }[]) ids.add(p.id);
    return [...ids];
}
