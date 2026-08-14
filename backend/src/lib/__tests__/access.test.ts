import { describe, expect, it } from "vitest";
import {
    checkProjectAccess,
    ensureDocAccess,
    ensureReviewAccess,
    filterAccessibleDocumentIds,
    listAccessibleProjectIds,
} from "../access";

type Row = Record<string, unknown>;

function makeDb(tables: Record<string, Row[]>) {
    return {
        from(table: string) {
            let rows = [...(tables[table] ?? [])];
            const query = {
                select: () => query,
                eq: (column: string, value: unknown) => {
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
                    const expected = (JSON.parse(value) as string[]).map((item) =>
                        item.toLowerCase(),
                    );
                    rows = rows.filter((row) => {
                        const actual = row[column];
                        const normalizedActual = Array.isArray(actual)
                            ? actual.map((item) => String(item).toLowerCase())
                            : [];
                        return (
                            Array.isArray(actual) &&
                            expected.every((item) => normalizedActual.includes(item))
                        );
                    });
                    return query;
                },
                single: async () => ({ data: rows[0] ?? null, error: null }),
                then: (
                    resolve: (value: { data: Row[]; error: null }) => unknown,
                    reject?: (reason: unknown) => unknown,
                ) => Promise.resolve({ data: rows, error: null }).then(resolve, reject),
            };
            return query;
        },
    } as any;
}

describe("access helpers", () => {
    const db = makeDb({
        projects: [
            { id: "own-project", user_id: "owner" },
            { id: "private-project", user_id: "other-owner" },
        ],
        documents: [
            { id: "own-doc", user_id: "owner", project_id: null },
            {
                id: "private-doc",
                user_id: "other-owner",
                project_id: "private-project",
            },
        ],
    });

    it("allows project owners", async () => {
        await expect(
            checkProjectAccess("own-project", "owner", db),
        ).resolves.toMatchObject({ ok: true, isOwner: true });
    });

    it("denies non-owner project access", async () => {
        await expect(
            checkProjectAccess("private-project", "reviewer", db),
        ).resolves.toEqual({ ok: false });
    });

    it("allows document owners only", async () => {
        await expect(
            ensureDocAccess(
                { user_id: "owner", project_id: null },
                "owner",
                db,
            ),
        ).resolves.toMatchObject({ ok: true, isOwner: true });

        await expect(
            ensureDocAccess({ user_id: "other-owner", project_id: null }, "reviewer", db),
        ).resolves.toEqual({ ok: false });
    });

    it("filters user-supplied document IDs to owned documents only", async () => {
        await expect(
            filterAccessibleDocumentIds(
                ["own-doc", "private-doc", "missing-doc"],
                "owner",
                db,
            ),
        ).resolves.toEqual(["own-doc"]);
    });

    it("lists owned projects", async () => {
        await expect(listAccessibleProjectIds("owner", db)).resolves.toEqual([
            "own-project",
        ]);
    });

    it("allows review owners only", async () => {
        await expect(
            ensureReviewAccess(
                {
                    user_id: "owner",
                    project_id: null,
                },
                "owner",
                db,
            ),
        ).resolves.toMatchObject({ ok: true, isOwner: true });

        await expect(
            ensureReviewAccess(
                { user_id: "other-owner", project_id: null },
                "reviewer",
                db,
            ),
        ).resolves.toEqual({ ok: false });
    });
});
