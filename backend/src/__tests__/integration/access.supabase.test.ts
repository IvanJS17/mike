import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import {
    filterAccessibleDocumentIds,
    listAccessibleProjectIds,
} from "../../lib/access";

// Gated: runs only against a real (local) Supabase stack.
//   supabase start, then export:
//     SUPABASE_TEST_URL, SUPABASE_TEST_SERVICE_ROLE_KEY
// or use scripts/test-stack.sh which reads them from `supabase status`.
const url = process.env.SUPABASE_TEST_URL;
const serviceKey = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;

const maybeDescribe = url && serviceKey ? describe : describe.skip;

maybeDescribe("Supabase access integration", () => {
    it("proves tabular document filtering drops foreign document IDs", async () => {
        const admin = createClient(url!, serviceKey!, {
            auth: { persistSession: false },
        });
        const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const ownerId = crypto.randomUUID();
        const reviewerId = crypto.randomUUID();
        const ownerProjectId = crypto.randomUUID();
        const otherProjectId = crypto.randomUUID();
        const ownerDocId = crypto.randomUUID();
        const otherDocId = crypto.randomUUID();

        try {
            const projectsInsert = await admin.from("projects").insert([
                {
                    id: ownerProjectId,
                    user_id: ownerId,
                    name: `owner-${suffix}`,
                },
                {
                    id: otherProjectId,
                    user_id: ownerId,
                    name: `other-${suffix}`,
                },
            ]);
            if (projectsInsert.error) {
                throw new Error(
                    `Could not seed projects: ${projectsInsert.error.message}`,
                    { cause: projectsInsert.error },
                );
            }

            // filename/file_type live on document_versions in this schema —
            // the documents rows only need identity + ownership columns.
            const documentsInsert = await admin.from("documents").insert([
                {
                    id: ownerDocId,
                    user_id: ownerId,
                    project_id: ownerProjectId,
                },
                {
                    id: otherDocId,
                    user_id: ownerId,
                    project_id: otherProjectId,
                },
            ]);
            if (documentsInsert.error) {
                throw new Error(
                    `Could not seed documents: ${documentsInsert.error.message}`,
                    { cause: documentsInsert.error },
                );
            }

            await expect(
                listAccessibleProjectIds(
                    reviewerId,
                    admin as any,
                ),
            ).resolves.toEqual([]);

            await expect(
                filterAccessibleDocumentIds(
                    [ownerDocId, otherDocId],
                    reviewerId,
                    admin as any,
                ),
            ).resolves.toEqual([]);
        } finally {
            await admin.from("documents").delete().in("id", [ownerDocId, otherDocId]);
            await admin
                .from("projects")
                .delete()
                .in("id", [ownerProjectId, otherProjectId]);
        }
    });
});
