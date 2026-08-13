import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

// W1.12 — authorization matrix against real RLS on a local Supabase stack.
// Gated: runs only when the stack envs are present (see scripts/test-stack.sh).
//   SUPABASE_TEST_URL, SUPABASE_TEST_SERVICE_ROLE_KEY, SUPABASE_TEST_ANON_KEY
const url = process.env.SUPABASE_TEST_URL;
const serviceKey = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_TEST_ANON_KEY;

const maybeDescribe = url && serviceKey && anonKey ? describe : describe.skip;

maybeDescribe("W1.12 tenancy RLS authorization matrix", () => {
  it("enforces member visibility, viewer write-block, and owner management", async () => {
    const admin = createClient(url!, serviceKey!, {
      auth: { persistSession: false },
    });
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const orgId = crypto.randomUUID();
    const wsId = crypto.randomUUID();
    const matterId = crypto.randomUUID();

    const pw = `Pw-${Math.random().toString(36).slice(2)}!7x`;

    async function makeUser(email: string) {
      const { data: created, error: createErr } =
        await admin.auth.admin.createUser({
          email: `${email}-${suffix}@test.local`,
          password: pw,
          email_confirm: true,
        });
      if (createErr || !created?.user)
        throw new Error(`createUser failed: ${createErr?.message ?? "?"}`);
      const { error: pwErr } = await admin.auth.admin.updateUserById(
        created.user.id,
        { password: pw },
      );
      if (pwErr) throw new Error(`updateUser failed: ${pwErr.message}`);
      const { data: signIn, error: signInErr } =
        await admin.auth.signInWithPassword({
          email: `${email}-${suffix}@test.local`,
          password: pw,
        });
      if (signInErr || !signIn.session)
        throw new Error(`signIn failed: ${signInErr?.message ?? "?"}`);
      return {
        id: created.user.id,
        session: signIn.session,
      };
    }

    const owner = await makeUser("owner");
    const viewer = await makeUser("viewer");
    const outsider = await makeUser("outsider");

    const userClient = async (session: {
      access_token: string;
      refresh_token: string;
    }) => {
      const client = createClient(url!, anonKey!, {
        auth: { persistSession: false },
      });
      const { error } = await client.auth.setSession({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
      });
      if (error) throw new Error(`setSession failed: ${error.message}`);
      return client;
    };

    try {
      const orgInsert = await admin.from("organizations").insert({
        id: orgId,
        name: `Org ${suffix}`,
        created_by: owner.id,
      });
      if (orgInsert.error) throw new Error(`seed org: ${orgInsert.error.message}`);
      await admin.from("organization_memberships").insert([
        { organization_id: orgId, user_id: owner.id, role: "org_owner" },
        { organization_id: orgId, user_id: viewer.id, role: "viewer" },
      ]);
      await admin.from("workspaces").insert({
        id: wsId,
        organization_id: orgId,
        name: `WS ${suffix}`,
        created_by: owner.id,
      });
      await admin.from("matters").insert({
        id: matterId,
        workspace_id: wsId,
        name: `Asunto ${suffix}`,
        created_by: owner.id,
      });

      // -- viewer: sees own org + matter --
      const viewerDb = await userClient(viewer.session);
      const { data: viewerOrgs, error: vOrgErr } = await viewerDb
        .from("organizations")
        .select("id");
      if (vOrgErr) throw new Error(`viewer orgs: ${vOrgErr.message}`);
      expect(viewerOrgs).toHaveLength(1);

      const { data: viewerMatters, error: vMatErr } = await viewerDb
        .from("matters")
        .select("id");
      if (vMatErr) throw new Error(`viewer matters: ${vMatErr.message}`);
      expect(viewerMatters).toHaveLength(1);

      // -- viewer: cannot add a member (write blocked by policy) --
      const { error: vInsErr } = await viewerDb
        .from("organization_memberships")
        .insert({
          organization_id: orgId,
          user_id: outsider.id,
          role: "viewer",
        });
      expect(vInsErr).not.toBeNull();

      // -- outsider: sees nothing --
      const outsiderDb = await userClient(outsider.session);
      const { data: outsiderOrgs, error: oOrgErr } = await outsiderDb
        .from("organizations")
        .select("id");
      if (oOrgErr) throw new Error(`outsider orgs: ${oOrgErr.message}`);
      expect(outsiderOrgs).toHaveLength(0);

      // -- owner: manages members --
      const ownerDb = await userClient(owner.session);
      const { data: ownerOrgs, error: ownerErr } = await ownerDb
        .from("organizations")
        .select("id");
      if (ownerErr) throw new Error(`owner orgs: ${ownerErr.message}`);
      expect(ownerOrgs).toHaveLength(1);

      const { error: ownerInsErr } = await ownerDb
        .from("organization_memberships")
        .insert({
          organization_id: orgId,
          user_id: outsider.id,
          role: "viewer",
        });
      expect(ownerInsErr).toBeNull();
    } finally {
      for (const u of [owner, viewer, outsider]) {
        await admin.auth.admin.deleteUser(u.id).catch(() => {});
      }
    }
  });
});
