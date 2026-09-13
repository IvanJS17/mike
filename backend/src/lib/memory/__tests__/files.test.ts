/**
 * LiTT (S5b): scoped memory files are opt-in.
 *
 * `ensureMemoryFile` is the one TS-side creation point for `memory_files`
 * rows (routes, `writeMemoryFile` and the curator all go through it). A row
 * materialized by a first read must start disabled — the migration
 * 20260910_06 header and S5A §3.8 keep every upstream `true` default off so
 * no learning happens until the owner enables the scope explicitly.
 */
import { describe, expect, it } from "vitest";

import { ensureMemoryFile } from "../files";

/**
 * dbq stub: the first read misses, then `upsert(...).select().maybeSingle()`
 * echoes back a row built from the exact payload the code inserted, so the
 * returned row is the one the code asked the database to persist.
 */
function fakeDb() {
  let inserted: Record<string, unknown> | null = null;
  let reads = 0;
  const builder = {
    select: () => builder,
    eq: () => builder,
    upsert: (payload: Record<string, unknown>) => {
      inserted = payload;
      return builder;
    },
    maybeSingle: async () => {
      reads += 1;
      return { data: reads === 1 ? null : inserted, error: null };
    },
  };
  return {
    db: { from: () => builder } as never,
    created: () => inserted,
  };
}

describe("ensureMemoryFile materializes rows disabled (LiTT opt-in)", () => {
  it("creates a missing project memory file with enabled=false", async () => {
    const { db, created } = fakeDb();

    const file = await ensureMemoryFile(db, "project", "project-1");

    expect(created()).toEqual({
      scope: "project",
      project_id: "project-1",
      enabled: false,
    });
    expect(file.enabled).toBe(false);
  });

  it("creates a missing user memory file with enabled=false", async () => {
    const { db, created } = fakeDb();

    const file = await ensureMemoryFile(db, "user", "user-1");

    expect(created()).toEqual({
      scope: "user",
      user_id: "user-1",
      enabled: false,
    });
    expect(file.enabled).toBe(false);
  });
});
