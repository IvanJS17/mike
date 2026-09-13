import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// ---------------------------------------------------------------------------
// Organizations over HTTP — the retained LiTT invariants only.
//
// lib/orgs.ts is unit-tested against its own stateful fake; what only the
// router can pin is the failure-kind => status-code mapping (sendOrgFailure)
// and the two endpoints LiTT deliberately does NOT support (they answer a
// fixed 405 without touching the database). The Supabase stub is stateful so
// an invitation created through POST is the row a later accept finds.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

let tables: Record<string, Row[]>;
let idCounter: number;
let currentUser: { id: string; email: string };

function resetState() {
    idCounter = 1;
    currentUser = { id: "admin-1", email: "admin@firm.example" };
    tables = {
        organizations: [
            { id: "org-1", name: "Acme LLP", created_by: "admin-1" },
        ],
        organization_memberships: [
            {
                id: "m-1",
                organization_id: "org-1",
                user_id: "admin-1",
                role: "org_owner",
                status: "active",
                created_at: "t1",
            },
            {
                id: "m-2",
                organization_id: "org-1",
                user_id: "member-1",
                role: "editor",
                status: "active",
                created_at: "t2",
            },
        ],
        org_invitations: [],
    };
}
resetState();

function query(table: string) {
    const filters: { col: string; val: unknown }[] = [];
    let op: "select" | "insert" = "select";
    let payload: Row | Row[] | null = null;

    const ensure = () => (tables[table] ??= []);
    const matches = () =>
        ensure().filter((r) => filters.every((f) => r[f.col] === f.val));

    function resolveMany(): Promise<{ data: Row[] | null; error: null }> {
        if (op === "insert") {
            const rows = Array.isArray(payload) ? payload : [payload as Row];
            const inserted = rows.map((r) => ({
                id: `row-${idCounter++}`,
                created_at: `t${idCounter}`,
                ...r,
            }));
            ensure().push(...inserted);
            return Promise.resolve({ data: inserted, error: null });
        }
        return Promise.resolve({ data: matches(), error: null });
    }

    const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
            filters.push({ col, val });
            return builder;
        },
        insert: (p: Row | Row[]) => {
            op = "insert";
            payload = p;
            return builder;
        },
        single: async () => {
            const { data, error } = await resolveMany();
            return { data: data?.[0] ?? null, error };
        },
        maybeSingle: async () => {
            const { data, error } = await resolveMany();
            return { data: data?.[0] ?? null, error };
        },
        then: (
            resolve: (v: { data: Row[] | null; error: null }) => unknown,
            reject?: (e: unknown) => unknown,
        ) => resolveMany().then(resolve, reject),
    };
    return builder;
}

vi.mock("../../lib/supabase", () => ({
    createServerSupabase: vi.fn(() => ({
        from: (t: string) => query(t),
        rpc: vi.fn(() => Promise.resolve({ data: [], error: null })),
        auth: {
            getUser: () =>
                Promise.resolve({
                    data: { user: { id: currentUser.id } },
                    error: null,
                }),
        },
    })),
}));

vi.mock("../../middleware/auth", () => ({
    requireAuth: (
        _req: unknown,
        res: { locals: Record<string, unknown> },
        next: () => void,
    ) => {
        res.locals.userId = currentUser.id;
        res.locals.userEmail = currentUser.email;
        next();
    },
    requireMfaIfEnrolled: (_req: unknown, _res: unknown, next: () => void) =>
        next(),
}));

import { app } from "../../app";

const AUTH = ["Authorization", "Bearer test"] as const;
const as = (id: string, email: string) => {
    currentUser = { id, email };
};

beforeEach(() => {
    vi.clearAllMocks();
    resetState();
});

// ---------------------------------------------------------------------------
// Invitations: the role is required and the vocabulary is closed
// ---------------------------------------------------------------------------

describe("organization invitations", () => {
    it("400s an omitted role — no default — and writes no invitation row", async () => {
        // Flipped from upstream, which quietly answered 'member'. LiTT has no
        // such tier: an invitation that names no role is refused.
        const res = await request(app)
            .post("/orgs/org-1/invitations")
            .set(...AUTH)
            .send({ email: "new@hire.example" });
        expect(res.status).toBe(400);
        expect(res.body.detail).toBe(
            "Role must be one of: org_owner, workspace_admin, editor, viewer, technical_operator",
        );
        expect(tables.org_invitations).toHaveLength(0);
    });

    it("400s the retired role names rather than quietly downgrading them", async () => {
        // 'admin', 'member' and 'owner' are names this product does not have.
        // A 201 at some other role would tell the caller their choice was
        // honoured when it was replaced.
        for (const role of ["admin", "member", "owner"]) {
            const res = await request(app)
                .post("/orgs/org-1/invitations")
                .set(...AUTH)
                .send({ email: "new@hire.example", role });
            expect(res.status).toBe(400);
        }
        expect(tables.org_invitations).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// sendOrgFailure: the essential kind => status mapping
// ---------------------------------------------------------------------------

describe("sendOrgFailure mapping", () => {
    it("403s a non-admin — organization administration is the admin tier", async () => {
        as("member-1", "member@firm.example");
        const res = await request(app)
            .post("/orgs/org-1/invitations")
            .set(...AUTH)
            .send({ email: "new@hire.example", role: "editor" });
        expect(res.status).toBe(403);
        expect(res.body.detail).toBe(
            "Only an organization owner or workspace admin can do that.",
        );
    });

    it("404s an org the caller does not belong to (hidden, not forbidden)", async () => {
        as("stranger", "stranger@example.com");
        const res = await request(app).get("/orgs/org-1").set(...AUTH);
        expect(res.status).toBe(404);
    });

    it("409s demoting or revoking the last org_owner", async () => {
        const demote = await request(app)
            .patch("/orgs/org-1/members/admin-1")
            .set(...AUTH)
            .send({ role: "viewer" });
        expect(demote.status).toBe(409);
        expect(demote.body.detail).toBe(
            "An organization must keep at least one owner.",
        );

        // ...not even by their own hand.
        const revoke = await request(app)
            .delete("/orgs/org-1/members/admin-1")
            .set(...AUTH);
        expect(revoke.status).toBe(409);
        expect(revoke.body.detail).toBe(
            "An organization must keep at least one owner.",
        );
        expect(
            tables.organization_memberships.find(
                (m) => m.user_id === "admin-1",
            ),
        ).toMatchObject({ status: "active" });
    });

    it("410s an expired invitation, which is not the same as a missing one", async () => {
        const created = await request(app)
            .post("/orgs/org-1/invitations")
            .set(...AUTH)
            .send({ email: "new@hire.example", role: "editor" });
        expect(created.status).toBe(201);
        tables.org_invitations[0].expires_at = new Date(
            Date.now() - 1000,
        ).toISOString();

        as("new-hire", "new@hire.example");
        const res = await request(app)
            .post(`/user/invitations/${created.body.id}/accept`)
            .set(...AUTH);
        expect(res.status).toBe(410);
        expect(res.body.detail).toBe("That invitation has expired.");
    });
});

// ---------------------------------------------------------------------------
// Retired endpoints: teardown and org-scoped resource listing
// ---------------------------------------------------------------------------

describe("unsupported organization endpoints", () => {
    it("405s DELETE /orgs/:orgId and GET /orgs/:orgId/resources without touching the database", async () => {
        // Organization teardown waits on the retention ADR, and the resource
        // listing depends on tables LiTT does not have yet: both answer a
        // fixed 405 {detail:"Not supported"} — for any authenticated caller,
        // without a membership probe or a write.
        const deleted = await request(app).delete("/orgs/org-1").set(...AUTH);
        expect(deleted.status).toBe(405);
        expect(deleted.body.detail).toBe("Not supported");
        expect(tables.organizations).toHaveLength(1);

        const resources = await request(app)
            .get("/orgs/org-1/resources")
            .set(...AUTH);
        expect(resources.status).toBe(405);
        expect(resources.body.detail).toBe("Not supported");
    });
});
