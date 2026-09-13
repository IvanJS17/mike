import { describe, expect, it } from "vitest";
import {
    checkProjectAccess,
    checkWorkflowAccess,
    creatorScopedAllowed,
    ensureChatAccess,
    ensureDocAccess,
    ensureReviewAccess,
    filterAccessibleDocumentIds,
    getOrgRole,
    isOrgAdmin,
    isOrgRole,
    listAccessibleProjectIds,
    resolveContentOrgId,
} from "../access";

type Row = Record<string, unknown>;

function makeDb(
    tables: Record<string, Row[]>,
    options: { selectErrors?: Record<string, string> } = {},
) {
    return {
        from(table: string) {
            let rows = [...(tables[table] ?? [])];
            const failure = options.selectErrors?.[table]
                ? { message: options.selectErrors[table] }
                : null;
            const query = {
                select: () => query,
                order: () => query,
                limit: (n: number) => {
                    rows = rows.slice(0, n);
                    return query;
                },
                eq: (column: string, value: unknown) => {
                    rows = rows.filter((row) => row[column] === value);
                    return query;
                },
                is: (column: string, value: unknown) => {
                    rows = rows.filter((row) => row[column] === value);
                    return query;
                },
                neq: (column: string, value: unknown) => {
                    rows = rows.filter((row) => row[column] !== value);
                    return query;
                },
                in: (column: string, values: unknown[]) => {
                    rows = rows.filter((row) => values.includes(row[column]));
                    return query;
                },
                filter: (column: string, operator: string, value: string) => {
                    if (operator !== "cs") return query;
                    const expected = JSON.parse(value) as string[];
                    rows = rows.filter((row) => {
                        const actual = row[column];
                        return (
                            Array.isArray(actual) &&
                            expected.every((item) => actual.includes(item))
                        );
                    });
                    return query;
                },
                single: async () =>
                    failure
                        ? { data: null, error: failure }
                        : { data: rows[0] ?? null, error: null },
                maybeSingle: async () =>
                    failure
                        ? { data: null, error: failure }
                        : { data: rows[0] ?? null, error: null },
                then: (
                    resolve: (value: {
                        data: Row[] | null;
                        error: { message: string } | null;
                    }) => unknown,
                    reject?: (reason: unknown) => unknown,
                ) =>
                    Promise.resolve(
                        failure
                            ? { data: null, error: failure }
                            : { data: rows, error: null },
                    ).then(resolve, reject),
            };
            return query;
        },
    } as any;
}

describe("access helpers", () => {
    const db = makeDb({
        projects: [
            { id: "own-project", user_id: "owner", org_id: null },
            { id: "granted-project", user_id: "other-owner", org_id: null },
            { id: "private-project", user_id: "other-owner", org_id: null },
        ],
        project_access_grants: [
            {
                project_id: "granted-project",
                email: "reviewer@example.com",
                role: "editor",
            },
        ],
        documents: [
            { id: "own-doc", user_id: "owner", project_id: null },
            {
                id: "granted-doc",
                user_id: "other-owner",
                project_id: "granted-project",
            },
            {
                id: "private-doc",
                user_id: "other-owner",
                project_id: "private-project",
            },
        ],
        workflow_shares: [
            {
                workflow_id: "shared-workflow",
                shared_with_email: "reviewer@example.com",
                role: "viewer",
            },
            {
                workflow_id: "editable-workflow",
                shared_with_email: "reviewer@example.com",
                role: "editor",
            },
        ],
        workflows: [
            {
                id: "shared-workflow",
                user_id: "other-owner",
                org_id: null,
            },
            {
                id: "editable-workflow",
                user_id: "other-owner",
                org_id: null,
            },
        ],
        tabular_review_access_grants: [
            {
                tabular_review_id: "review-direct",
                email: "reviewer@example.com",
                role: "editor",
            },
        ],
        matters: [],
        matter_memberships: [],
    });

    it("makes the project's creator an owner", async () => {
        const access = await checkProjectAccess(
            "own-project",
            "owner",
            "owner@example.com",
            db,
        );
        expect(access).toMatchObject({
            ok: true,
            isCreator: true,
            projectRole: "owner",
        });
    });

    it("gives a direct grantee exactly the role they were granted", async () => {
        const access = await checkProjectAccess(
            "granted-project",
            "reviewer",
            "reviewer@example.com",
            db,
        );
        expect(access).toMatchObject({
            ok: true,
            isCreator: false,
            projectRole: "editor",
        });
    });

    it("matches grant emails case-insensitively", async () => {
        const access = await checkProjectAccess(
            "granted-project",
            "reviewer",
            "  Reviewer@Example.com ",
            db,
        );
        expect(access.ok).toBe(true);
    });

    it("denies a project the caller has no route into", async () => {
        await expect(
            checkProjectAccess(
                "private-project",
                "reviewer",
                "reviewer@example.com",
                db,
            ),
        ).resolves.toEqual({ ok: false });
    });

    it("allows document creators and readers of the containing project", async () => {
        await expect(
            ensureDocAccess(
                { user_id: "owner", project_id: null },
                "owner",
                "owner@example.com",
                db,
            ),
        ).resolves.toMatchObject({ ok: true, projectRole: "owner" });
        await expect(
            ensureDocAccess(
                { user_id: "other-owner", project_id: "granted-project" },
                "reviewer",
                "reviewer@example.com",
                db,
            ),
        ).resolves.toMatchObject({ ok: true, projectRole: "editor" });
        await expect(
            ensureDocAccess(
                { user_id: "other-owner", project_id: "private-project" },
                "reviewer",
                "reviewer@example.com",
                db,
            ),
        ).resolves.toEqual({ ok: false });
    });

    it("resolves workflow access through direct shares only", async () => {
        await expect(
            checkWorkflowAccess(
                "shared-workflow",
                "reviewer",
                " REVIEWER@EXAMPLE.COM ",
                db,
            ),
        ).resolves.toMatchObject({ ok: true, projectRole: "viewer" });
        await expect(
            checkWorkflowAccess(
                "editable-workflow",
                "reviewer",
                "reviewer@example.com",
                db,
            ),
        ).resolves.toMatchObject({ ok: true, projectRole: "editor" });
        await expect(
            checkWorkflowAccess(
                "shared-workflow",
                "stranger",
                "stranger@example.com",
                db,
            ),
        ).resolves.toEqual({ ok: false });
    });

    it("allows direct review sharing without project access", async () => {
        await expect(
            ensureReviewAccess(
                {
                    id: "review-direct",
                    user_id: "other-owner",
                    project_id: null,
                },
                "reviewer",
                "reviewer@example.com",
                db,
            ),
        ).resolves.toMatchObject({ ok: true, projectRole: "editor" });
    });

    it("does not grant organization access to a standalone review", async () => {
        const orgDb = makeDb({
            organization_memberships: [
                {
                    organization_id: "org-1",
                    user_id: "reviewer",
                    role: "org_owner",
                    status: "active",
                },
            ],
            tabular_review_access_grants: [],
        });
        await expect(
            ensureReviewAccess(
                {
                    id: "legacy-org-review",
                    user_id: "other-owner",
                    project_id: null,
                    org_id: "org-1",
                },
                "reviewer",
                "reviewer@example.com",
                orgDb,
            ),
        ).resolves.toEqual({ ok: false });
    });

    it("lists projects reached by creation and by grant", async () => {
        await expect(
            listAccessibleProjectIds("owner", "owner@example.com", db),
        ).resolves.toEqual(["own-project"]);
        await expect(
            listAccessibleProjectIds("reviewer", "reviewer@example.com", db),
        ).resolves.toEqual(["granted-project"]);
    });

    it("filters user-supplied document IDs to accessible documents only", async () => {
        await expect(
            filterAccessibleDocumentIds(
                ["own-doc", "granted-doc", "private-doc"],
                "reviewer",
                "reviewer@example.com",
                db,
            ),
        ).resolves.toEqual(["granted-doc"]);
    });
});

// ---------------------------------------------------------------------------
// Organization scope — explicit overrides only (LiTT tenancy)
// ---------------------------------------------------------------------------

describe("organization scope (no implicit content grants)", () => {
    const db = makeDb({
        projects: [
            { id: "org-project", user_id: "founder", org_id: "org-1" },
            { id: "other-org-project", user_id: "stranger", org_id: "org-2" },
            { id: "personal-project", user_id: "founder", org_id: null },
        ],
        organization_memberships: [
            {
                organization_id: "org-1",
                user_id: "founder",
                role: "org_owner",
                status: "active",
            },
            {
                organization_id: "org-1",
                user_id: "boss",
                role: "workspace_admin",
                status: "active",
            },
            {
                organization_id: "org-1",
                user_id: "staffer",
                role: "editor",
                status: "active",
            },
            {
                organization_id: "org-1",
                user_id: "gone",
                role: "editor",
                status: "revoked",
            },
            {
                organization_id: "org-2",
                user_id: "outsider",
                role: "org_owner",
                status: "active",
            },
        ],
        project_access_grants: [
            // Legacy direct grants on org content must not grant anything.
            { project_id: "org-project", email: "boss@firm.example", role: "viewer" },
            {
                project_id: "org-project",
                email: "staffer@firm.example",
                role: "viewer",
            },
            {
                project_id: "org-project",
                email: "counsel@outside.example",
                role: "owner",
            },
        ],
        documents: [],
    });

    it("makes the creator Owner even inside an organization", async () => {
        await expect(
            checkProjectAccess("org-project", "founder", "founder@firm.example", db),
        ).resolves.toMatchObject({
            ok: true,
            isCreator: true,
            orgRole: "org_owner",
            projectRole: "owner",
        });
    });

    it("does not inherit any content role from membership alone", async () => {
        // workspace_admin without an override: no implicit owner.
        await expect(
            checkProjectAccess("org-project", "boss", "boss@firm.example", db),
        ).resolves.toEqual({ ok: false });
        // plain member (even org role "editor"): no implicit editor.
        await expect(
            checkProjectAccess("org-project", "staffer", "staffer@firm.example", db),
        ).resolves.toEqual({ ok: false });
    });

    it("denies a revoked membership outright", async () => {
        await expect(
            checkProjectAccess("org-project", "gone", "gone@firm.example", db),
        ).resolves.toEqual({ ok: false });
    });

    it("applies explicit overrides for every member tier", async () => {
        const overrideDb = makeDb({
            projects: [
                { id: "overridden", user_id: "founder", org_id: "org-1" },
            ],
            organization_memberships: [
                {
                    organization_id: "org-1",
                    user_id: "founder",
                    role: "org_owner",
                    status: "active",
                },
                {
                    organization_id: "org-1",
                    user_id: "admin-editor",
                    role: "workspace_admin",
                    status: "active",
                },
                {
                    organization_id: "org-1",
                    user_id: "member-viewer",
                    role: "editor",
                    status: "active",
                },
                {
                    organization_id: "org-1",
                    user_id: "member-denied",
                    role: "editor",
                    status: "active",
                },
            ],
            project_org_access_overrides: [
                {
                    project_id: "overridden",
                    org_id: "org-1",
                    user_id: "admin-editor",
                    role: "editor",
                },
                {
                    project_id: "overridden",
                    org_id: "org-1",
                    user_id: "member-viewer",
                    role: "viewer",
                },
                {
                    project_id: "overridden",
                    org_id: "org-1",
                    user_id: "member-denied",
                    role: "deny",
                },
            ],
            workflows: [
                { id: "workflow-overridden", user_id: "founder", org_id: "org-1" },
            ],
            workflow_org_access_overrides: [
                {
                    workflow_id: "workflow-overridden",
                    org_id: "org-1",
                    user_id: "admin-editor",
                    role: "editor",
                },
            ],
        });
        // An admin-tier member with an explicit override gets exactly that
        // role — there is no admin exemption.
        await expect(
            checkProjectAccess("overridden", "admin-editor", null, overrideDb),
        ).resolves.toMatchObject({
            ok: true,
            orgRole: "workspace_admin",
            projectRole: "editor",
        });
        await expect(
            checkWorkflowAccess(
                "workflow-overridden",
                "admin-editor",
                null,
                overrideDb,
            ),
        ).resolves.toMatchObject({
            ok: true,
            orgRole: "workspace_admin",
            projectRole: "editor",
        });
        await expect(
            checkProjectAccess("overridden", "member-viewer", null, overrideDb),
        ).resolves.toMatchObject({ ok: true, projectRole: "viewer" });
        await expect(
            checkProjectAccess("overridden", "member-denied", null, overrideDb),
        ).resolves.toEqual({ ok: false });
        // No override row at all: nothing to inherit.
        await expect(
            checkProjectAccess("overridden", "founder", null, overrideDb),
        ).resolves.toMatchObject({ ok: true, isCreator: true, projectRole: "owner" });
    });

    it("ignores direct grants for organization projects", async () => {
        await expect(
            checkProjectAccess(
                "org-project",
                "outside-counsel",
                "counsel@outside.example",
                db,
            ),
        ).resolves.toEqual({ ok: false });
        await expect(
            checkProjectAccess("org-project", "staffer", "counsel@outside.example", db),
        ).resolves.toEqual({ ok: false });
    });

    it("isolates users across orgs (cross-tenant denial)", async () => {
        await expect(
            checkProjectAccess(
                "org-project",
                "outsider",
                "outsider@elsewhere.example",
                db,
            ),
        ).resolves.toEqual({ ok: false });
    });

    it("keeps personal projects out of every org's reach", async () => {
        await expect(
            checkProjectAccess(
                "personal-project",
                "boss",
                "boss@firm.example",
                db,
            ),
        ).resolves.toEqual({ ok: false });
        await expect(
            checkProjectAccess(
                "personal-project",
                "founder",
                "founder@firm.example",
                db,
            ),
        ).resolves.toMatchObject({ ok: true, isCreator: true, projectRole: "owner" });
    });

    it("inherits only the project verdict when a document belongs to a project", async () => {
        const crossDb = makeDb({
            projects: [
                { id: "p", user_id: "someone", org_id: "org-2" },
            ],
            organization_memberships: [
                {
                    organization_id: "org-2",
                    user_id: "u",
                    role: "editor",
                    status: "active",
                },
            ],
            project_org_access_overrides: [
                { project_id: "p", org_id: "org-2", user_id: "u", role: "viewer" },
            ],
            project_access_grants: [],
        });
        await expect(
            ensureDocAccess(
                { user_id: "someone", project_id: "p", org_id: "org-1" },
                "u",
                "u@firm.example",
                crossDb,
            ),
        ).resolves.toMatchObject({ projectRole: "viewer", orgRole: "editor" });
    });

    it("inherits the project role for a review", async () => {
        const reviewDb = makeDb({
            projects: [
                { id: "p", user_id: "someone", org_id: "org-1" },
            ],
            organization_memberships: [
                {
                    organization_id: "org-1",
                    user_id: "boss",
                    role: "workspace_admin",
                    status: "active",
                },
            ],
            project_org_access_overrides: [
                { project_id: "p", org_id: "org-1", user_id: "boss", role: "owner" },
            ],
        });
        await expect(
            ensureReviewAccess(
                {
                    id: "admin-review",
                    user_id: "someone-else",
                    project_id: "p",
                },
                "boss",
                "boss@firm.example",
                reviewDb,
            ),
        ).resolves.toMatchObject({ projectRole: "owner" });
    });
});

// ---------------------------------------------------------------------------
// Private-matter belt: grants never widen matter privacy
// ---------------------------------------------------------------------------

describe("private matter gate", () => {
    const db = makeDb({
        projects: [
            { id: "matter-project", user_id: "founder", org_id: "org-1" },
            { id: "public-matter-project", user_id: "founder", org_id: "org-1" },
        ],
        organization_memberships: [
            {
                organization_id: "org-1",
                user_id: "founder",
                role: "org_owner",
                status: "active",
            },
            {
                organization_id: "org-1",
                user_id: "member",
                role: "editor",
                status: "active",
            },
            {
                organization_id: "org-1",
                user_id: "staffer",
                role: "editor",
                status: "active",
            },
        ],
        matters: [
            { id: "matter-1", project_id: "matter-project", visibility: "private" },
            {
                id: "matter-2",
                project_id: "public-matter-project",
                visibility: "public",
            },
        ],
        matter_memberships: [
            { matter_id: "matter-1", user_id: "member", status: "active" },
        ],
        project_org_access_overrides: [
            { project_id: "matter-project", org_id: "org-1", user_id: "member", role: "editor" },
            { project_id: "matter-project", org_id: "org-1", user_id: "staffer", role: "editor" },
        ],
    });

    it("denies the creator of a private-matter project without an active matter membership", async () => {
        await expect(
            checkProjectAccess("matter-project", "founder", "founder@firm.example", db),
        ).resolves.toEqual({ ok: false });
    });

    it("allows an override holder with an active matter membership", async () => {
        await expect(
            checkProjectAccess("matter-project", "member", "member@firm.example", db),
        ).resolves.toMatchObject({ ok: true, projectRole: "editor" });
    });

    it("denies an override holder without a matter membership", async () => {
        await expect(
            checkProjectAccess("matter-project", "staffer", "staffer@firm.example", db),
        ).resolves.toEqual({ ok: false });
    });

    it("does not gate public matters", async () => {
        await expect(
            checkProjectAccess(
                "public-matter-project",
                "founder",
                "founder@firm.example",
                db,
            ),
        ).resolves.toMatchObject({ ok: true, projectRole: "owner" });
    });

    it("excludes private-matter projects from the accessible list", async () => {
        await expect(
            listAccessibleProjectIds("founder", "founder@firm.example", db),
        ).resolves.toEqual(["public-matter-project"]);
        await expect(
            listAccessibleProjectIds("member", "member@firm.example", db),
        ).resolves.toEqual(["matter-project"]);
    });
});

// ---------------------------------------------------------------------------
// Personal content carries no organization
// ---------------------------------------------------------------------------

describe("content org resolution", () => {
    const db = makeDb({
        projects: [
            { id: "org-project", user_id: "u", org_id: "org-1" },
            { id: "personal-project", user_id: "u", org_id: null },
        ],
    });

    it("inherits the project's organization for content inside it", async () => {
        await expect(
            resolveContentOrgId(db, { projectId: "org-project" }),
        ).resolves.toEqual({ ok: true, orgId: "org-1" });
    });

    it("leaves content with no organization when there is none to inherit", async () => {
        // No hidden personal org to fall back on: org_id IS NULL *is* personal.
        await expect(
            resolveContentOrgId(db, { projectId: "personal-project" }),
        ).resolves.toEqual({ ok: true, orgId: null });
        await expect(
            resolveContentOrgId(db, { projectId: null }),
        ).resolves.toEqual({ ok: true, orgId: null });
    });

    it("refuses to answer when the lookup fails, instead of guessing personal", async () => {
        // ok:false and orgId:null must be distinguishable: null is the
        // encoding of personal content, and personal content is what account
        // deletion destroys. A failed read that presented as null filed a
        // firm's upload as its uploader's private property.
        const failing = makeDb(
            { projects: [] },
            { selectErrors: { projects: "connection reset" } },
        );
        await expect(
            resolveContentOrgId(failing, { projectId: "org-project" }),
        ).resolves.toMatchObject({ ok: false });
    });
});

describe("creator-scoped operations", () => {
    // A handful of operations — replacing or deleting one version of a
    // document, moving a review between projects — belong to whoever made the
    // row rather than to a tier.
    it("lets the creator act", () => {
        expect(
            creatorScopedAllowed({ isCreator: true, projectRole: "viewer" }, "u1"),
        ).toBe(true);
    });

    it("still refuses an Owner while the creator exists", () => {
        // The rule is about authorship, not rank: an Owner does not get to
        // reach into a colleague's versions just for outranking them.
        expect(
            creatorScopedAllowed({ isCreator: false, projectRole: "owner" }, "u2"),
        ).toBe(false);
    });

    it("hands a creator-less row to the container's Owners", () => {
        expect(
            creatorScopedAllowed({ isCreator: false, projectRole: "owner" }, null),
        ).toBe(true);
    });

    it("does not hand a creator-less row to Editors or Viewers", () => {
        for (const role of ["editor", "viewer"] as const) {
            expect(
                creatorScopedAllowed({ isCreator: false, projectRole: role }, null),
            ).toBe(false);
        }
    });
});

// ---------------------------------------------------------------------------
// Organization roles (closed vocabulary; active memberships only)
// ---------------------------------------------------------------------------

describe("organization roles", () => {
    it("reads only active memberships and the closed vocabulary", async () => {
        const db = makeDb({
            organization_memberships: [
                {
                    organization_id: "org-1",
                    user_id: "a",
                    role: "org_owner",
                    status: "active",
                },
                {
                    organization_id: "org-1",
                    user_id: "b",
                    role: "workspace_admin",
                    status: "inactive",
                },
            ],
        });
        await expect(getOrgRole("a", "org-1", db)).resolves.toBe("org_owner");
        await expect(getOrgRole("b", "org-1", db)).resolves.toBeNull();
        await expect(getOrgRole("a", null, db)).resolves.toBeNull();
    });

    it("keeps the admin tier at org_owner | workspace_admin", () => {
        expect(isOrgAdmin("org_owner")).toBe(true);
        expect(isOrgAdmin("workspace_admin")).toBe(true);
        expect(isOrgAdmin("editor")).toBe(false);
        expect(isOrgAdmin(null)).toBe(false);
        expect(isOrgRole("technical_operator")).toBe(true);
        expect(isOrgRole("admin")).toBe(false);
        expect(isOrgRole("member")).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Chats share the same role-aware direct-grant model. These cases pin each
// exclusive scope and project inheritance under LiTT semantics.
// ---------------------------------------------------------------------------
describe("ensureChatAccess", () => {
    // alice created proj-a inside org-a and is its org_owner; dave is a
    // workspace_admin, carol a plain member with an explicit Editor override,
    // erin an outside collaborator holding a viewer *direct* grant on proj-a
    // (which org scope ignores). bob belongs to org-b only (other tenant).
    const db = makeDb({
        organization_memberships: [
            {
                organization_id: "org-a",
                user_id: "alice",
                role: "org_owner",
                status: "active",
            },
            {
                organization_id: "org-a",
                user_id: "carol",
                role: "editor",
                status: "active",
            },
            {
                organization_id: "org-a",
                user_id: "dave",
                role: "workspace_admin",
                status: "active",
            },
            {
                organization_id: "org-b",
                user_id: "bob",
                role: "org_owner",
                status: "active",
            },
        ],
        projects: [
            { id: "proj-a", user_id: "alice", org_id: "org-a" },
        ],
        project_access_grants: [
            { project_id: "proj-a", email: "erin@example.com", role: "viewer" },
        ],
        project_org_access_overrides: [
            { project_id: "proj-a", org_id: "org-a", user_id: "carol", role: "editor" },
        ],
        chat_access_grants: [
            { chat_id: "direct-chat", email: "carol@example.com", role: "editor" },
            { chat_id: "promoted-chat", email: "erin@example.com", role: "editor" },
            { chat_id: "admin-chat", email: "alice@example.com", role: "editor" },
        ],
    });

    it("makes a standalone chat's creator its Owner", async () => {
        await expect(
            ensureChatAccess(
                {
                    id: "creator-chat",
                    user_id: "carol",
                    project_id: null,
                    org_id: null,
                },
                "carol",
                "carol@example.com",
                db,
            ),
        ).resolves.toMatchObject({
            ok: true,
            isCreator: true,
            orgRole: null,
            projectRole: "owner",
        });
    });

    it("gives a directly shared email Editor access, case-insensitively", async () => {
        // A standalone chat (no project, no org) is shareable through a
        // direct grant.
        await expect(
            ensureChatAccess(
                {
                    id: "direct-chat",
                    user_id: "alice",
                    project_id: null,
                    org_id: null,
                },
                "carol",
                " CAROL@example.com ",
                db,
            ),
        ).resolves.toMatchObject({
            ok: true,
            isCreator: false,
            orgRole: null,
            projectRole: "editor",
        });
    });

    it("inherits the project verdict for a chat inside a project", async () => {
        // frank's chat lives in alice's project: everyone with explicit
        // standing on proj-a gets that same standing on the chat.
        const chat = {
            id: "project-chat",
            user_id: "frank",
            project_id: "proj-a",
            org_id: "org-a",
        };
        await expect(
            ensureChatAccess(chat, "alice", "alice@example.com", db),
        ).resolves.toMatchObject({
            ok: true,
            isCreator: false,
            projectRole: "owner",
        });
        // workspace_admin without an override: no implicit content role.
        await expect(
            ensureChatAccess(chat, "dave", "dave@example.com", db),
        ).resolves.toEqual({ ok: false });
        await expect(
            ensureChatAccess(chat, "carol", "carol@example.com", db),
        ).resolves.toMatchObject({
            ok: true,
            orgRole: "editor",
            projectRole: "editor",
        });
        // A direct project grant cannot cross into an organization scope.
        await expect(
            ensureChatAccess(chat, "erin", "erin@example.com", db),
        ).resolves.toEqual({ ok: false });
    });

    it("does not grant organization access to a standalone chat", async () => {
        const chat = {
            id: "org-chat",
            user_id: "alice",
            project_id: null,
            org_id: "org-a",
        };
        await expect(
            ensureChatAccess(chat, "carol", "carol@example.com", db),
        ).resolves.toEqual({ ok: false });
        await expect(
            ensureChatAccess(chat, "dave", "dave@example.com", db),
        ).resolves.toEqual({ ok: false });
    });

    it("ignores a child chat grant and enforces project access", async () => {
        await expect(
            ensureChatAccess(
                {
                    id: "promoted-chat",
                    user_id: "frank",
                    project_id: "proj-a",
                    org_id: "org-a",
                },
                "erin",
                "erin@example.com",
                db,
            ),
        ).resolves.toEqual({ ok: false });
    });

    it("inherits the project Owner role and ignores a child chat grant", async () => {
        await expect(
            ensureChatAccess(
                {
                    id: "admin-chat",
                    user_id: "frank",
                    project_id: "proj-a",
                    org_id: "org-a",
                },
                "alice",
                "alice@example.com",
                db,
            ),
        ).resolves.toMatchObject({
            ok: true,
            isCreator: false,
            projectRole: "owner",
        });
    });

    it("denies another tenant's user and an unshared standalone chat", async () => {
        await expect(
            ensureChatAccess(
                {
                    id: "tenant-chat",
                    user_id: "alice",
                    project_id: "proj-a",
                    org_id: "org-a",
                },
                "bob",
                "bob@example.com",
                db,
            ),
        ).resolves.toEqual({ ok: false });

        await expect(
            ensureChatAccess(
                {
                    id: "private-chat",
                    user_id: "alice",
                    project_id: null,
                    org_id: null,
                },
                "carol",
                "carol@example.com",
                db,
            ),
        ).resolves.toEqual({ ok: false });
    });

    it("fails closed when the caller has no email to match a share against", async () => {
        await expect(
            ensureChatAccess(
                {
                    id: "direct-chat",
                    user_id: "alice",
                    project_id: null,
                    org_id: null,
                },
                "carol",
                null,
                db,
            ),
        ).resolves.toEqual({ ok: false });
    });
});
