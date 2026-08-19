import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  consumeDownloadGrant,
  createDownloadUrl,
} from "../../lib/downloadTokens";

const url = process.env.SUPABASE_TEST_URL;
const serviceKey = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;
const maybeDescribe = url && serviceKey ? describe : describe.skip;

maybeDescribe("real Supabase download grants", () => {
  const password = "GrantTest1!";
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const emailA = `grant-a-${suffix}@test.local`;
  const emailB = `grant-b-${suffix}@test.local`;
  let admin: SupabaseClient;
  let userA = "";
  let userB = "";
  let documentId = "";
  let versionId = "";

  beforeAll(async () => {
    admin = createClient(url!, serviceKey!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const [a, b] = await Promise.all([
      admin.auth.admin.createUser({ email: emailA, password, email_confirm: true }),
      admin.auth.admin.createUser({ email: emailB, password, email_confirm: true }),
    ]);
    if (a.error || !a.data.user) throw a.error ?? new Error("no user A");
    if (b.error || !b.data.user) throw b.error ?? new Error("no user B");
    userA = a.data.user.id;
    userB = b.data.user.id;

    const doc = await admin
      .from("documents")
      .insert({ user_id: userA, project_id: null, status: "ready" })
      .select("id")
      .single();
    if (doc.error || !doc.data) throw doc.error ?? new Error("no document");
    documentId = doc.data.id;

    const version = await admin
      .from("document_versions")
      .insert({
        document_id: documentId,
        storage_path: `documents/${userA}/${documentId}/source.pdf`,
        source: "upload",
        version_number: 1,
        filename: "contract.pdf",
        file_type: "pdf",
        size_bytes: 4,
      })
      .select("id")
      .single();
    if (version.error || !version.data) throw version.error ?? new Error("no version");
    versionId = version.data.id;
  });

  afterAll(async () => {
    if (documentId) await admin.from("documents").delete().eq("id", documentId);
    if (userA) await admin.auth.admin.deleteUser(userA);
    if (userB) await admin.auth.admin.deleteUser(userB);
  });

  it("binds the grant to its user and consumes it only once", async () => {
    const urlValue = await createDownloadUrl(admin as never, {
      documentId,
      versionId,
      storagePath: `documents/${userA}/${documentId}/source.pdf`,
      filename: "contract.pdf",
      userId: userA,
    });
    const token = urlValue.replace("/download/", "");

    expect(await consumeDownloadGrant(admin as never, token, userB)).toBeNull();
    expect(await consumeDownloadGrant(admin as never, token, userA)).toMatchObject({
      document_id: documentId,
      document_version_id: versionId,
      issued_to_user: userA,
    });
    expect(await consumeDownloadGrant(admin as never, token, userA)).toBeNull();
  });

  it("rejects an expired grant without waiting in real time", async () => {
    const urlValue = await createDownloadUrl(admin as never, {
      documentId,
      versionId,
      storagePath: `documents/${userA}/${documentId}/source.pdf`,
      filename: "contract.pdf",
      userId: userA,
      expiresInSeconds: 1,
    });
    const token = urlValue.replace("/download/", "");
    const afterExpiry = new Date(Date.now() + 2_000);

    expect(
      await consumeDownloadGrant(admin as never, token, userA, afterExpiry),
    ).toBeNull();
  });
});
