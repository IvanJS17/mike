import { describe, expect, it } from "vitest";
import {
    acceptInvitation,
    createInvitation,
    listMembers,
    listMyOrgs,
    removeMember,
    updateMember,
} from "../orgs";

type Row = Record<string, unknown>;

// Minimal stateful in-memory Supabase fake for the retained LiTT invariants:
// it mutates the seeded tables so revocation / re-activation round-trips can
// be asserted, and it enforces the one constraint the service branches on —
// the organization_memberships composite primary key (a duplicate insert
// fails 23505 like Postgres, which the accept path turns into re-activation).
// The organization_memberships_epoch_bump trigger is NOT simulated: the
// authorization_epoch increment lives in the DB (migration 20260831_01), so
// tests pin the write shapes it fires on instead.
function makeDb(initial: Record<string, Row[]>) {
    const tables: Record<string, Row[]> = {};
    for (const [k, v] of Object.entries(initial)) tables[k] = v.map((r) => ({ ...r }));
    let idCounter = 1;

    function query(table: string) {
        const filters: (
            | { type: "eq"; col: string; val: unknown }
            | { type: "in"; col: string; vals: unknown[] }
        )[] = [];
        let op: "select" | "insert" | "update" = "select";
        let payload: Row | Row[] | null = null;

        const ensure = () => (tables[table] ??= []);
        const matches = (rows: Row[]) =>
            rows.filter((r) =>
                filters.every((f) =>
                    f.type === "eq"
                        ? r[f.col] === f.val
                        : f.vals.includes(r[f.col]),
                ),
            );

        function resolveMany(): Promise<{
            data: Row[] | null;
            error: { code?: string; message: string } | null;
        }> {
            const arr = ensure();
            if (op === "insert") {
                const rows = Array.isArray(payload) ? payload : [payload as Row];
                // The composite primary key (organization_id, user_id).
                if (table === "organization_memberships") {
                    const clash = rows.some((r) =>
                        arr.some(
                            (e) =>
                                e.organization_id === r.organization_id &&
                                e.user_id === r.user_id,
                        ),
                    );
                    if (clash)
                        return Promise.resolve({
                            data: null,
                            error: {
                                code: "23505",
                                message:
                                    'duplicate key value violates unique constraint "organization_memberships_pkey"',
                            },
                        });
                }
                const inserted = rows.map((r) => ({ id: `row-${idCounter++}`, ...r }));
                arr.push(...inserted);
                return Promise.resolve({ data: inserted, error: null });
            }
            const matched = matches(arr);
            if (op === "update") {
                for (const r of matched) Object.assign(r, payload as Row);
                return Promise.resolve({ data: matched, error: null });
            }
            return Promise.resolve({ data: matched, error: null });
        }

        async function resolveSingle() {
            const { data, error } = await resolveMany();
            return { data: data?.[0] ?? null, error };
        }

        const builder: Record<string, unknown> = {
            select: () => builder,
            eq: (col: string, val: unknown) => {
                filters.push({ type: "eq", col, val });
                return builder;
            },
            in: (col: string, vals: unknown[]) => {
                filters.push({ type: "in", col, vals });
                return builder;
            },
            insert: (p: Row | Row[]) => {
                op = "insert";
                payload = p;
                return builder;
            },
            update: (p: Row) => {
                op = "update";
                payload = p;
                return builder;
            },
            single: () => resolveSingle(),
            maybeSingle: () => resolveSingle(),
            then: (
                resolve: (v: {
                    data: Row[] | null;
                    error: { code?: string; message: string } | null;
                }) => unknown,
                reject?: (e: unknown) => unknown,
            ) => resolveMany().then(resolve, reject),
        };
        return builder;
    }

    return {
        from: (t: string) => query(t),
        _tables: tables,
    } as any;
}

// ---------------------------------------------------------------------------
// Role vocabulary and the last-org_owner guard
// ---------------------------------------------------------------------------

describe("orgs.service role invariants", () => {
    const seedPair = () =>
        makeDb({
            organizations: [{ id: "o1", name: "Acme" }],
            organization_memberships: [
                {
                    id: "m1",
                    organization_id: "o1",
                    user_id: "admin1",
                    role: "org_owner",
                    status: "active",
                },
                {
                    id: "m2",
                    organization_id: "o1",
                    user_id: "member1",
                    role: "editor",
                    status: "active",
                },
            ],
        });

    it("grants only the closed LiTT vocabulary, never the retired names", async () => {
        const db = seedPair();
        for (const role of ["workspace_admin", "editor", "viewer", "technical_operator", "org_owner"]) {
            await expect(
                updateMember(db, {
                    actorId: "admin1",
                    orgId: "o1",
                    targetUserId: "member1",
                    role,
                }),
            ).resolves.toMatchObject({ ok: true });
        }
        for (const role of ["owner", "admin", "member"]) {
            await expect(
                updateMember(db, {
                    actorId: "admin1",
                    orgId: "o1",
                    targetUserId: "member1",
                    role,
                }),
            ).resolves.toMatchObject({ ok: false, kind: "validation" });
        }
    });

    it("refuses to demote or revoke the last active org_owner", async () => {
        const db = seedPair();
        await expect(
            updateMember(db, {
                actorId: "admin1",
                orgId: "o1",
                targetUserId: "admin1",
                role: "viewer",
            }),
        ).resolves.toMatchObject({ ok: false, kind: "last_admin" });
        // ...not even by their own hand.
        await expect(
            removeMember(db, {
                actorId: "admin1",
                orgId: "o1",
                targetUserId: "admin1",
            }),
        ).resolves.toMatchObject({ ok: false, kind: "last_admin" });
        expect(
            (db._tables.organization_memberships as Row[]).find(
                (m) => m.user_id === "admin1",
            ),
        ).toMatchObject({ status: "active" });
    });

    it("removal revokes the row instead of deleting it, and a later acceptance re-activates it", async () => {
        const db = seedPair();
        (db._tables.user_profiles ??= []).push(
            { user_id: "admin1", email: "admin@acme.example" },
            { user_id: "member1", email: "member@acme.example" },
        );

        await expect(
            removeMember(db, {
                actorId: "admin1",
                orgId: "o1",
                targetUserId: "member1",
            }),
        ).resolves.toMatchObject({ ok: true });
        const memberships = db._tables.organization_memberships as Row[];
        // The row survives as history.
        expect(memberships).toHaveLength(2);
        expect(memberships.find((m) => m.user_id === "member1")).toMatchObject({
            status: "revoked",
        });

        // Re-invitation: a revoked row is not an existing member, so the
        // invitation is allowed...
        const created = await createInvitation(db, {
            actorId: "admin1",
            actorEmail: "admin@acme.example",
            orgId: "o1",
            email: "member@acme.example",
            role: "workspace_admin",
        });
        expect(created.ok).toBe(true);
        if (!created.ok) return;

        // ...and acceptance must re-activate the row (insert hits the
        // composite PK: 23505 => update role + status together), not leave a
        // revocation behind an "accepted" invitation.
        const accepted = await acceptInvitation(db, {
            userId: "member1",
            userEmail: "member@acme.example",
            invitationId: created.invitation.id as string,
        });
        expect(accepted).toMatchObject({
            ok: true,
            org_id: "o1",
            role: "workspace_admin",
        });
        const rows = (
            db._tables.organization_memberships as Row[]
        ).filter((m) => m.user_id === "member1");
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            role: "workspace_admin",
            status: "active",
        });
        expect((db._tables.org_invitations as Row[])[0].status).toBe("accepted");
    });

    it("accepting records the effective role and never lowers an existing one", async () => {
        const db = makeDb({
            organizations: [{ id: "o1", name: "Acme" }],
            organization_memberships: [
                {
                    id: "m1",
                    organization_id: "o1",
                    user_id: "admin1",
                    role: "org_owner",
                    status: "active",
                },
            ],
            user_profiles: [
                { user_id: "admin1", email: "admin@acme.example" },
            ],
            org_invitations: [],
        });
        const created = await createInvitation(db, {
            actorId: "admin1",
            orgId: "o1",
            email: "newbie@acme.example",
            role: "workspace_admin",
        });
        if (!created.ok) throw new Error("setup failed");
        const accepted = await acceptInvitation(db, {
            userId: "newbie",
            userEmail: "Newbie@Acme.Example",
            invitationId: created.invitation.id as string,
        });
        expect(accepted).toMatchObject({
            ok: true,
            org_id: "o1",
            role: "workspace_admin",
        });
        const newbie = (db._tables.organization_memberships as Row[]).find(
            (m) => m.user_id === "newbie",
        );
        expect(newbie).toMatchObject({ role: "workspace_admin", status: "active" });
        expect((db._tables.org_invitations as Row[])[0].status).toBe("accepted");
        // The fake DB does not run the organization_memberships_epoch_bump
        // trigger (migration 20260831_01), so the authorization_epoch
        // increment cannot be asserted here; what this pins is the write the
        // trigger fires on: explicit role + status on the membership row.

        // Roles are floors: an org_owner accepting a lower invitation keeps
        // the standing they already have.
        (db._tables.org_invitations as Row[]).push({
            id: "inv-weak",
            org_id: "o1",
            email: "admin@acme.example",
            role: "viewer",
            status: "pending",
            invited_by: "admin1",
            expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        });
        const kept = await acceptInvitation(db, {
            userId: "admin1",
            userEmail: "admin@acme.example",
            invitationId: "inv-weak",
        });
        expect(kept).toMatchObject({ ok: true, role: "org_owner" });
        expect(
            (db._tables.organization_memberships as Row[]).find(
                (m) => m.user_id === "admin1",
            ),
        ).toMatchObject({ role: "org_owner" });
    });

    it("counts and lists only active memberships", async () => {
        const db = makeDb({
            organizations: [{ id: "o1", name: "Acme" }],
            organization_memberships: [
                {
                    id: "m1",
                    organization_id: "o1",
                    user_id: "admin1",
                    role: "org_owner",
                    status: "active",
                },
                {
                    id: "m2",
                    organization_id: "o1",
                    user_id: "member1",
                    role: "editor",
                    status: "active",
                },
                {
                    id: "m3",
                    organization_id: "o1",
                    user_id: "gone",
                    role: "viewer",
                    status: "revoked",
                },
            ],
        });
        const roster = await listMembers(db, { userId: "admin1", orgId: "o1" });
        expect(roster).toMatchObject({ ok: true });
        if (!roster.ok) return;
        expect(roster.members).toHaveLength(2);

        const mine = await listMyOrgs(db, "admin1");
        expect(mine).toMatchObject({ ok: true });
        if (!mine.ok) return;
        expect(mine.orgs[0]).toMatchObject({ member_count: 2 });

        // A revoked member no longer sees the organization at all: their
        // membership is not an active one.
        await expect(listMyOrgs(db, "gone")).resolves.toMatchObject({
            ok: true,
            orgs: [],
        });
    });
});
