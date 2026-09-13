import { describe, expect, it } from "vitest";
import {
    isOrgAccessOverrideRole,
    listOrgAccessPeople,
    setOrgAccessOverride,
} from "../orgAccessOverrides";

type Row = Record<string, unknown>;

function tableDb(tables: Record<string, Row[]>) {
    return {
        from(table: string) {
            let rows = [...(tables[table] ?? [])];
            const q: Record<string, unknown> = {};
            q.select = () => q;
            q.order = () => q;
            q.limit = () => q;
            q.eq = (col: string, val: unknown) => {
                rows = rows.filter((r) => r[col] === val);
                return q;
            };
            q.in = (col: string, vals: unknown[]) => {
                rows = rows.filter((r) => vals.includes(r[col]));
                return q;
            };
            q.maybeSingle = async () => ({ data: rows[0] ?? null, error: null });
            q.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
                Promise.resolve({ data: rows, error: null }).then(resolve, reject);
            return q;
        },
    } as never;
}

describe("organization access overrides", () => {
    it("accepts every explicit role plus Deny", () => {
        for (const role of ["owner", "editor", "viewer", "deny"]) {
            expect(isOrgAccessOverrideRole(role)).toBe(true);
        }
        expect(isOrgAccessOverrideRole("admin")).toBe(false);
        expect(isOrgAccessOverrideRole("member")).toBe(false);
    });

    it("persists an explicit Editor override for an organization Member", async () => {
        let written: Record<string, unknown> | null = null;
        let deleteCalled = false;
        let selectedTable: string | null = null;
        const db = {
            from: (table: string) => {
                selectedTable = table;
                return {
                    delete: () => {
                        deleteCalled = true;
                        return {};
                    },
                    upsert: (payload: Record<string, unknown>) => {
                        written = payload;
                        return {
                            select: () => ({
                                single: async () => ({
                                    data: {
                                        id: "override-1",
                                        user_id: payload.user_id,
                                        role: payload.role,
                                        assigned_by: payload.assigned_by,
                                        created_at: "2026-09-03T00:00:00Z",
                                        updated_at: payload.updated_at,
                                    },
                                    error: null,
                                }),
                            }),
                        };
                    },
                };
            },
        } as never;

        const result = await setOrgAccessOverride(db, {
            kind: "project",
            resourceId: "project-1",
            orgId: "org-1",
            userId: "member-2",
            role: "editor",
            assignedBy: "owner-1",
        });

        expect(deleteCalled).toBe(false);
        expect(written).toMatchObject({
            project_id: "project-1",
            org_id: "org-1",
            user_id: "member-2",
            role: "editor",
            assigned_by: "owner-1",
        });
        expect(result).toMatchObject({
            ok: true,
            override: { role: "editor" },
        });
        expect(selectedTable).toBe("project_org_access_overrides");
    });

    it("lists only active members with explicit-only content roles", async () => {
        const db = tableDb({
            organization_memberships: [
                { organization_id: "org-1", user_id: "creator", role: "org_owner", status: "active" },
                { organization_id: "org-1", user_id: "member", role: "editor", status: "active" },
                { organization_id: "org-1", user_id: "other", role: "editor", status: "active" },
                { organization_id: "org-1", user_id: "gone", role: "editor", status: "revoked" },
            ],
            project_org_access_overrides: [
                { project_id: "project-1", org_id: "org-1", user_id: "member", role: "viewer" },
            ],
            user_profiles: [
                { user_id: "creator", email: "creator@firm.example", display_name: "Cee" },
                { user_id: "member", email: "member@firm.example", display_name: "Mem" },
                { user_id: "other", email: "other@firm.example", display_name: "Oth" },
                { user_id: "gone", email: "gone@firm.example", display_name: "Gon" },
            ],
        });
        const listed = await listOrgAccessPeople(db, {
            kind: "project",
            resourceId: "project-1",
            orgId: "org-1",
            creatorId: "creator",
        });
        expect(listed.ok).toBe(true);
        if (!listed.ok) return;
        // The creator shows as owner; the override holder gets exactly the
        // override role; everyone else has NO content role (deny) — membership
        // alone grants nothing. Revoked members are not listed at all.
        expect(
            listed.people.map((p) => ({
                user_id: p.user_id,
                role: p.role,
                has_override: p.has_override,
            })),
        ).toEqual([
            { user_id: "creator", role: "owner", has_override: false },
            { user_id: "member", role: "viewer", has_override: true },
            { user_id: "other", role: "deny", has_override: false },
        ]);
    });
});
