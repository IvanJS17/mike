import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

// W1.12 — authorization matrix against real RLS on a local Supabase stack.
// Gated: runs only when the stack envs are present (see scripts/test-stack.sh).
//   SUPABASE_TEST_URL, SUPABASE_TEST_SERVICE_ROLE_KEY, SUPABASE_TEST_ANON_KEY
const url = process.env.SUPABASE_TEST_URL;
const serviceKey = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_TEST_ANON_KEY;

const maybeDescribe = url && serviceKey && anonKey ? describe : describe.skip;

type TestUser = {
  id: string;
  session: {
    access_token: string;
    refresh_token: string;
  };
};

maybeDescribe("W1.12 tenancy RLS authorization matrix", () => {
  it("requires an active explicit matter membership for all matter access", async () => {
    const admin = createClient(url!, serviceKey!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const orgId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const matterAId = crypto.randomUUID();
    const matterBId = crypto.randomUUID();
    const password = `Pw-${Math.random().toString(36).slice(2)}!7x`;

    async function makeUser(label: string): Promise<TestUser> {
      const email = `${label}-${suffix}@test.local`;
      const { data: created, error: createError } =
        await admin.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
        });
      if (createError || !created.user) {
        throw new Error(`createUser failed: ${createError?.message ?? "?"}`);
      }

      const userClient = createClient(url!, anonKey!, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data: signIn, error: signInError } =
        await userClient.auth.signInWithPassword({ email, password });
      if (signInError || !signIn.session) {
        throw new Error(`signIn failed: ${signInError?.message ?? "?"}`);
      }

      return { id: created.user.id, session: signIn.session };
    }

    async function asUser(user: TestUser): Promise<SupabaseClient> {
      const client = createClient(url!, anonKey!, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { error } = await client.auth.setSession(user.session);
      if (error) throw new Error(`setSession failed: ${error.message}`);
      return client;
    }

    const orgOwner = await makeUser("org-owner");
    const workspaceAdmin = await makeUser("workspace-admin");
    const orgEditor = await makeUser("org-editor");
    const orgViewer = await makeUser("org-viewer");
    const matterOwner = await makeUser("matter-owner");
    const matterEditor = await makeUser("matter-editor");
    const matterViewer = await makeUser("matter-viewer");
    const outsider = await makeUser("outsider");
    const users = [
      orgOwner,
      workspaceAdmin,
      orgEditor,
      orgViewer,
      matterOwner,
      matterEditor,
      matterViewer,
      outsider,
    ];

    try {
      const orgInsert = await admin.from("organizations").insert({
        id: orgId,
        name: `Org ${suffix}`,
        created_by: orgOwner.id,
      });
      if (orgInsert.error) {
        throw new Error(`seed org: ${orgInsert.error.message}`);
      }

      const orgMembershipInsert = await admin
        .from("organization_memberships")
        .insert([
          { organization_id: orgId, user_id: orgOwner.id, role: "org_owner" },
          {
            organization_id: orgId,
            user_id: workspaceAdmin.id,
            role: "workspace_admin",
          },
          { organization_id: orgId, user_id: orgEditor.id, role: "editor" },
          { organization_id: orgId, user_id: orgViewer.id, role: "viewer" },
          { organization_id: orgId, user_id: matterOwner.id, role: "editor" },
          { organization_id: orgId, user_id: matterEditor.id, role: "editor" },
          { organization_id: orgId, user_id: matterViewer.id, role: "viewer" },
        ]);
      if (orgMembershipInsert.error) {
        throw new Error(
          `seed organization memberships: ${orgMembershipInsert.error.message}`,
        );
      }

      const workspaceInsert = await admin.from("workspaces").insert({
        id: workspaceId,
        organization_id: orgId,
        name: `Workspace ${suffix}`,
        created_by: orgOwner.id,
      });
      if (workspaceInsert.error) {
        throw new Error(`seed workspace: ${workspaceInsert.error.message}`);
      }

      const mattersInsert = await admin.from("matters").insert([
        {
          id: matterAId,
          workspace_id: workspaceId,
          name: `Matter A ${suffix}`,
          created_by: matterOwner.id,
        },
        {
          id: matterBId,
          workspace_id: workspaceId,
          name: `Matter B ${suffix}`,
          created_by: matterOwner.id,
        },
      ]);
      if (mattersInsert.error) {
        throw new Error(`seed matters: ${mattersInsert.error.message}`);
      }

      const matterMembershipInsert = await admin
        .from("matter_memberships")
        .insert([
          {
            matter_id: matterAId,
            user_id: matterOwner.id,
            role: "matter_owner",
          },
          { matter_id: matterAId, user_id: matterEditor.id, role: "editor" },
          { matter_id: matterAId, user_id: matterViewer.id, role: "viewer" },
          {
            matter_id: matterBId,
            user_id: matterOwner.id,
            role: "matter_owner",
          },
        ]);
      if (matterMembershipInsert.error) {
        throw new Error(
          `seed matter memberships: ${matterMembershipInsert.error.message}`,
        );
      }

      const broadRoleUsers = [orgOwner, workspaceAdmin, orgEditor, orgViewer];
      for (const user of broadRoleUsers) {
        const client = await asUser(user);
        const { data: organizations, error: organizationsError } = await client
          .from("organizations")
          .select("id")
          .eq("id", orgId);
        if (organizationsError) {
          throw new Error(
            `organization visibility: ${organizationsError.message}`,
          );
        }
        expect(organizations).toHaveLength(1);

        const { data: workspaces, error: workspacesError } = await client
          .from("workspaces")
          .select("id")
          .eq("id", workspaceId);
        if (workspacesError) {
          throw new Error(`workspace visibility: ${workspacesError.message}`);
        }
        expect(workspaces).toHaveLength(1);

        const { data: matters, error: mattersError } = await client
          .from("matters")
          .select("id")
          .in("id", [matterAId, matterBId]);
        if (mattersError) {
          throw new Error(`private matter visibility: ${mattersError.message}`);
        }
        expect(matters).toEqual([]);

        const { data: memberships, error: membershipsError } = await client
          .from("matter_memberships")
          .select("matter_id, user_id")
          .in("matter_id", [matterAId, matterBId]);
        if (membershipsError) {
          throw new Error(
            `private matter membership visibility: ${membershipsError.message}`,
          );
        }
        expect(memberships).toEqual([]);

        const { data: updates, error: updateError } = await client
          .from("matters")
          .update({ name: `unauthorized-${suffix}` })
          .eq("id", matterAId)
          .select("id");
        if (updateError) {
          throw new Error(`private matter update: ${updateError.message}`);
        }
        expect(updates).toEqual([]);
      }

      const matterEditorDb = await asUser(matterEditor);
      const { data: editorMatters, error: editorMattersError } =
        await matterEditorDb.from("matters").select("id");
      if (editorMattersError) {
        throw new Error(
          `matter editor visibility: ${editorMattersError.message}`,
        );
      }
      expect(editorMatters?.map(({ id }) => id).sort()).toEqual([matterAId]);

      const { data: editorMemberships, error: editorMembershipsError } =
        await matterEditorDb.from("matter_memberships").select("matter_id");
      if (editorMembershipsError) {
        throw new Error(
          `matter editor memberships: ${editorMembershipsError.message}`,
        );
      }
      expect(
        editorMemberships?.map(({ matter_id }) => matter_id).sort(),
      ).toEqual([matterAId, matterAId, matterAId]);

      const matterViewerDb = await asUser(matterViewer);
      const { data: viewerMatters, error: viewerMattersError } =
        await matterViewerDb.from("matters").select("id");
      if (viewerMattersError) {
        throw new Error(
          `matter viewer visibility: ${viewerMattersError.message}`,
        );
      }
      expect(viewerMatters?.map(({ id }) => id)).toEqual([matterAId]);

      const { data: outsiderMatters, error: outsiderMattersError } = await (
        await asUser(outsider)
      )
        .from("matters")
        .select("id");
      if (outsiderMattersError) {
        throw new Error(
          `outsider matter visibility: ${outsiderMattersError.message}`,
        );
      }
      expect(outsiderMatters).toEqual([]);

      // Removing only the organization membership models an active session
      // after administrative revocation; the stale matter row must not grant
      // access to the next RLS query.
      const revoke = await admin
        .from("organization_memberships")
        .delete()
        .eq("organization_id", orgId)
        .eq("user_id", matterEditor.id)
        .select("user_id");
      if (revoke.error) {
        throw new Error(
          `revoke organization membership: ${revoke.error.message}`,
        );
      }
      expect(revoke.data).toHaveLength(1);

      const { data: revokedMatters, error: revokedMattersError } =
        await matterEditorDb.from("matters").select("id").eq("id", matterAId);
      if (revokedMattersError) {
        throw new Error(
          `revoked matter visibility: ${revokedMattersError.message}`,
        );
      }
      expect(revokedMatters).toEqual([]);

      const { data: revokedMemberships, error: revokedMembershipsError } =
        await matterEditorDb
          .from("matter_memberships")
          .select("matter_id, user_id")
          .eq("matter_id", matterAId);
      if (revokedMembershipsError) {
        throw new Error(
          `revoked matter membership visibility: ${revokedMembershipsError.message}`,
        );
      }
      expect(revokedMemberships).toEqual([]);

      const { data: revokedUpdates, error: revokedUpdateError } =
        await matterEditorDb
          .from("matters")
          .update({ name: `revoked-${suffix}` })
          .eq("id", matterAId)
          .select("id");
      if (revokedUpdateError) {
        throw new Error(`revoked matter update: ${revokedUpdateError.message}`);
      }
      expect(revokedUpdates).toEqual([]);
    } finally {
      await admin.from("organizations").delete().eq("id", orgId);
      for (const user of users) {
        await admin.auth.admin.deleteUser(user.id).catch(() => {});
      }
    }
  });
});
