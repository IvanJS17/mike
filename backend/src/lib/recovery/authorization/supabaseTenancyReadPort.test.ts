import { describe, expect, it } from "vitest";

import type { OrganizationMembership } from "../tenancy/tenancyModel";
import * as adapterModule from "./supabaseTenancyReadPort";
import { createSupabaseTenancyReadPort } from "./supabaseTenancyReadPort";
import {
  evaluateInitialAccess,
  recheckFreshAccessViaPort,
} from "./tenancyReadPort";
import type { AuthorizationScope } from "./evaluateAccess";

const ORG = "org-1";
const USER = "user-1";
const MATTER = "m-1";
const WS = "ws-1";

const REDACTED_ERROR = /authorization read adapter failed/i;

/** One recorded query against one table, for exact query-matrix assertions. */
type RecordedQuery = {
  table: string;
  columns: string;
  filters: Array<{ column: string; op: string; value: unknown }>;
  terminal: string;
};

type ClientState = {
  queries: RecordedQuery[];
  /** Rows returned by the terminal step, keyed per query in call order. */
  results: Array<Record<string, unknown> | null>;
  /** Inject a Supabase error on the Nth terminal resolution. */
  errors?: Array<{ message: string; code?: string } | null>;
  /** Any builder/client member accessed outside the read-only surface. */
  prohibited?: string[];
};

const READ_ONLY_BUILDER_METHODS = new Set([
  "select",
  "eq",
  "maybeSingle",
  "single",
  "then",
]);

/**
 * Deterministic fake query builder (no Supabase package, no network):
 * records `.from(table).select(columns)` then chained `.eq(column, value)`
 * filters and finally `.maybeSingle()`/`.single()`, returning the next
 * scripted `{ data, error }` result.
 */
function fakeDb(state: ClientState): any {
  let queryIndex = 0;
  const recordProhibited = (member: string) => {
    state.prohibited?.push(member);
  };
  return {
    from(table: string) {
      const q: RecordedQuery = {
        table,
        columns: "",
        filters: [],
        terminal: "",
      };
      const index = state.queries.length;
      state.queries.push(q);
      const builder: Record<string, unknown> = new Proxy(
        {},
        {
          get(target: Record<string, unknown>, member: string) {
            if (!READ_ONLY_BUILDER_METHODS.has(member)) {
              recordProhibited(member);
            }
            if (member === "select") {
              return (columns: string) => {
                q.columns = columns;
                return builder;
              };
            }
            if (member === "eq") {
              return (column: string, value: unknown) => {
                q.filters.push({ column, op: "eq", value });
                return builder;
              };
            }
            if (member === "maybeSingle" || member === "single") {
              return () => {
                q.terminal = member;
                return {
                  then(resolve: (v: unknown) => void) {
                    const i = queryIndex++;
                    const error = state.errors?.[i] ?? null;
                    resolve({
                      data: error ? null : (state.results[i] ?? null),
                      error,
                    });
                  },
                };
              };
            }
            if (member === "then") {
              return (resolve: (v: unknown) => void) => resolve(undefined);
            }
            return () => builder;
          },
        },
      );
      void index;
      return builder;
    },
  };
}

function query(state: ClientState, i: number): RecordedQuery {
  const q = state.queries[i];
  if (!q) throw new Error(`test setup: query ${i} not recorded`);
  return q;
}

// -- valid synthetic rows ----------------------------------------------------

function orgRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    user_id: USER,
    organization_id: ORG,
    role: "editor",
    status: "active",
    organizations: { authorization_epoch: 7 },
    ...overrides,
  };
}

describe("getMatter — exact query contract", () => {
  function matterRow(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      id: MATTER,
      workspace_id: WS,
      visibility: "public",
      workspaces: { organization_id: ORG },
      ...overrides,
    };
  }

  it("reads matters filtered by exact matter_id with an explicit inner organization relation and no select star", async () => {
    const state: ClientState = { queries: [], results: [matterRow()] };
    const port = createSupabaseTenancyReadPort(fakeDb(state));

    const matter = await port.getMatter({ matter_id: MATTER });

    expect(state.queries.length).toBe(1);
    const q = query(state, 0);
    expect(q.table).toBe("matters");
    expect(q.columns).toBe(
      "id, workspace_id, visibility, workspaces!inner(organization_id)",
    );
    expect(q.columns).not.toMatch(/\*/);
    expect(q.filters).toEqual([{ column: "id", op: "eq", value: MATTER }]);
    expect(q.terminal).toBe("maybeSingle");

    expect(matter).toEqual({
      matter_id: MATTER,
      workspace_id: WS,
      organization_id: ORG,
      visibility: "public",
    });
  });

  it("accepts the one-element-array workspace relation form identically", async () => {
    const state: ClientState = {
      queries: [],
      results: [matterRow({ workspaces: [{ organization_id: ORG }] })],
    };
    const port = createSupabaseTenancyReadPort(fakeDb(state));
    expect(await port.getMatter({ matter_id: MATTER })).toEqual({
      matter_id: MATTER,
      workspace_id: WS,
      organization_id: ORG,
      visibility: "public",
    });
  });

  it("returns null when the matter does not exist (null data, no error)", async () => {
    const state: ClientState = { queries: [], results: [null] };
    const port = createSupabaseTenancyReadPort(fakeDb(state));
    expect(await port.getMatter({ matter_id: MATTER })).toBeNull();
  });

  it("rejects malformed workspace relations and fields with the constant redacted error", async () => {
    for (const broken of [
      {}, // relation missing
      { workspaces: null },
      { workspaces: [] },
      { workspaces: [{ organization_id: ORG }, { organization_id: ORG }] },
      matterRow({ workspaces: {} }), // missing organization_id key
      matterRow({ workspaces: { organization_id: 9 } }), // non-string org id
      matterRow({ id: "" }),
      matterRow({ workspace_id: null }),
      matterRow({ visibility: "internal" }),
      matterRow({ visibility: undefined }),
    ]) {
      const state: ClientState = { queries: [], results: [broken] };
      const port = createSupabaseTenancyReadPort(fakeDb(state));
      await expect(port.getMatter({ matter_id: MATTER })).rejects.toThrow(
        REDACTED_ERROR,
      );
    }
  });

  it("rejects a Supabase error with the constant redacted error and no provider detail", async () => {
    const RAW = "permission denied for table matters";
    const state: ClientState = {
      queries: [],
      results: [null],
      errors: [{ message: RAW, code: "42501" }],
    };
    const port = createSupabaseTenancyReadPort(fakeDb(state));
    const thrown = await port
      .getMatter({ matter_id: MATTER })
      .catch((e: unknown) => e);
    const message = (thrown as Error).message;
    expect(message).toMatch(REDACTED_ERROR);
    expect(message).not.toContain(RAW);
    expect(message).not.toContain("42501");
    expect(message).not.toContain(MATTER);
    expect((thrown as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it("redacts malformed Supabase response envelopes instead of leaking a TypeError", async () => {
    for (const envelope of [null, undefined, "not-a-response"]) {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () => Promise.resolve(envelope),
      };
      const malformedDb = {
        from: () => chain,
      } as unknown as Parameters<typeof createSupabaseTenancyReadPort>[0];
      const port = createSupabaseTenancyReadPort(malformedDb);

      await expect(port.getMatter({ matter_id: MATTER })).rejects.toThrow(
        REDACTED_ERROR,
      );
    }
  });
});

describe("getMatterMembership — exact query contract", () => {
  function matterMembershipRow(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      user_id: USER,
      matter_id: MATTER,
      role: "viewer",
      status: "active",
      ...overrides,
    };
  }

  it("reads matter_memberships filtered by both user_id and matter_id with no join and no select star", async () => {
    const state: ClientState = {
      queries: [],
      results: [matterMembershipRow()],
    };
    const port = createSupabaseTenancyReadPort(fakeDb(state));

    const membership = await port.getMatterMembership({
      user_id: USER,
      matter_id: MATTER,
    });

    expect(state.queries.length).toBe(1);
    const q = query(state, 0);
    expect(q.table).toBe("matter_memberships");
    expect(q.columns).toBe("user_id, matter_id, role, status");
    expect(q.columns).not.toMatch(/\*/);
    expect(q.columns).not.toMatch(/!inner/);
    expect(q.filters).toEqual([
      { column: "user_id", op: "eq", value: USER },
      { column: "matter_id", op: "eq", value: MATTER },
    ]);
    expect(q.terminal).toBe("maybeSingle");

    expect(membership).toEqual({
      user_id: USER,
      matter_id: MATTER,
      role: "viewer",
      status: "active",
    });
  });

  it("returns null when no row matches (null data, no error)", async () => {
    const state: ClientState = { queries: [], results: [null] };
    const port = createSupabaseTenancyReadPort(fakeDb(state));
    expect(
      await port.getMatterMembership({ user_id: USER, matter_id: MATTER }),
    ).toBeNull();
  });

  it("rejects malformed fields with the constant redacted error and no defaults", async () => {
    for (const broken of [
      matterMembershipRow({ user_id: null }),
      matterMembershipRow({ user_id: 7 }),
      matterMembershipRow({ user_id: "" }),
      matterMembershipRow({ matter_id: undefined }),
      matterMembershipRow({ role: "owner" }),
      matterMembershipRow({ role: [] }),
      matterMembershipRow({ status: "pending" }),
      matterMembershipRow({ status: true }),
    ]) {
      const state: ClientState = { queries: [], results: [broken] };
      const port = createSupabaseTenancyReadPort(fakeDb(state));
      await expect(
        port.getMatterMembership({ user_id: USER, matter_id: MATTER }),
      ).rejects.toThrow(REDACTED_ERROR);
    }
  });

  it("rejects a non-error Supabase failure payload the same way", async () => {
    const state: ClientState = {
      queries: [],
      results: [null],
      errors: [{ weirdest: "payload" }] as never,
    };
    const port = createSupabaseTenancyReadPort(fakeDb(state));
    await expect(
      port.getMatterMembership({ user_id: USER, matter_id: MATTER }),
    ).rejects.toThrow(REDACTED_ERROR);
  });
});

describe("getOrganizationMembership — exact query contract", () => {
  it("reads organization_memberships filtered by both user_id and organization_id with an explicit inner epoch relation and no select star", async () => {
    const state: ClientState = { queries: [], results: [orgRow()] };
    const port = createSupabaseTenancyReadPort(fakeDb(state));

    const membership = await port.getOrganizationMembership({
      user_id: USER,
      organization_id: ORG,
    });

    expect(state.queries.length).toBe(1);
    const q = query(state, 0);
    expect(q.table).toBe("organization_memberships");
    expect(q.columns).toBe(
      "user_id, organization_id, role, status, organizations!inner(authorization_epoch)",
    );
    expect(q.columns).not.toMatch(/\*/);
    expect(q.filters).toEqual([
      { column: "user_id", op: "eq", value: USER },
      { column: "organization_id", op: "eq", value: ORG },
    ]);
    expect(q.terminal).toBe("maybeSingle");

    expect(membership).toEqual({
      user_id: USER,
      organization_id: ORG,
      role: "editor",
      status: "active",
      authorization_epoch: 7,
    });
  });

  it("accepts the one-element-array relation form identically", async () => {
    const state: ClientState = {
      queries: [],
      results: [orgRow({ organizations: [{ authorization_epoch: 7 }] })],
    };
    const port = createSupabaseTenancyReadPort(fakeDb(state));
    const membership = await port.getOrganizationMembership({
      user_id: USER,
      organization_id: ORG,
    });
    expect(membership).toEqual({
      user_id: USER,
      organization_id: ORG,
      role: "editor",
      status: "active",
      authorization_epoch: 7,
    });
  });

  it("returns null when no row matches (null data, no error)", async () => {
    const state: ClientState = { queries: [], results: [null] };
    const port = createSupabaseTenancyReadPort(fakeDb(state));
    const membership = await port.getOrganizationMembership({
      user_id: USER,
      organization_id: ORG,
    });
    expect(membership).toBeNull();
  });
});

describe("fail-closed normalization — org membership", () => {
  it("rejects malformed relation shapes with the constant redacted error", async () => {
    for (const broken of [
      {}, // relation missing
      { organizations: {} }, // missing key inside relation
      { organizations: null }, // relation null
      { organizations: [] }, // empty array
      {
        organizations: [{ authorization_epoch: 7 }, { authorization_epoch: 7 }],
      }, // multiple
      { organizations: 5 }, // non-object, non-array
      orgRow({ organizations: { authorization_epoch: null } }), // epoch not integer
      orgRow({ organizations: { authorization_epoch: -1 } }), // negative
      orgRow({ organizations: { authorization_epoch: 1.5 } }), // non-integer
      orgRow({ organizations: { authorization_epoch: "7" } }), // string epoch
    ]) {
      const state: ClientState = { queries: [], results: [broken] };
      const port = createSupabaseTenancyReadPort(fakeDb(state));
      await expect(
        port.getOrganizationMembership({ user_id: USER, organization_id: ORG }),
      ).rejects.toThrow(REDACTED_ERROR);
    }
  });

  it("rejects malformed membership fields with the same constant error and no defaults", async () => {
    for (const broken of [
      orgRow({ user_id: null }),
      orgRow({ user_id: 123 }),
      orgRow({ user_id: "" }),
      orgRow({ organization_id: undefined }),
      orgRow({ role: "admin" }),
      orgRow({ role: null }),
      orgRow({ status: "pending" }),
      orgRow({ status: 42 }),
    ]) {
      const state: ClientState = { queries: [], results: [broken] };
      const port = createSupabaseTenancyReadPort(fakeDb(state));
      await expect(
        port.getOrganizationMembership({ user_id: USER, organization_id: ORG }),
      ).rejects.toThrow(REDACTED_ERROR);
    }
  });

  it("rejects a Supabase error with the constant redacted error and no provider detail", async () => {
    const RAW = 'relation "organization_memberships" does not exist';
    const state: ClientState = {
      queries: [],
      results: [null],
      errors: [{ message: RAW, code: "42P01" }],
    };
    const port = createSupabaseTenancyReadPort(fakeDb(state));
    const thrown = await port
      .getOrganizationMembership({ user_id: USER, organization_id: ORG })
      .catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toMatch(REDACTED_ERROR);
    expect(message).not.toContain(RAW);
    expect(message).not.toContain("42P01");
    expect(message).not.toContain(ORG);
    expect(message).not.toContain(USER);
    expect((thrown as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it("rejects a non-error Supabase failure payload the same way", async () => {
    const state: ClientState = {
      queries: [],
      results: [null],
      errors: ["weird failure payload"] as never,
    };
    const port = createSupabaseTenancyReadPort(fakeDb(state));
    await expect(
      port.getOrganizationMembership({ user_id: USER, organization_id: ORG }),
    ).rejects.toThrow(REDACTED_ERROR);
  });

  it("never returns an invented default for malformed rows", async () => {
    const state: ClientState = {
      queries: [],
      results: [orgRow({ role: "admin" })],
    };
    const port = createSupabaseTenancyReadPort(fakeDb(state));
    await expect(
      port.getOrganizationMembership({ user_id: USER, organization_id: ORG }),
    ).rejects.toThrow(REDACTED_ERROR);
  });

  it("propagates the typed membership shape with valid closed-vocabulary values", async () => {
    const state: ClientState = {
      queries: [],
      results: [orgRow({ role: "org_owner", status: "revoked" })],
    };
    const port = createSupabaseTenancyReadPort(fakeDb(state));
    const membership: OrganizationMembership | null =
      await port.getOrganizationMembership({
        user_id: USER,
        organization_id: ORG,
      });
    expect(membership).toEqual({
      user_id: USER,
      organization_id: ORG,
      role: "org_owner",
      status: "revoked",
      authorization_epoch: 7,
    });
  });
});

describe("integration — adapter-backed orchestration", () => {
  function identity() {
    return {
      user_id: USER,
      transport: { kind: "web_session" } as const,
      mfa_satisfied: true,
    };
  }

  function matterRow(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      id: MATTER,
      workspace_id: WS,
      visibility: "public",
      workspaces: { organization_id: ORG },
      ...overrides,
    };
  }

  function matterMembershipRow(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      user_id: USER,
      matter_id: MATTER,
      role: "matter_owner",
      status: "active",
      ...overrides,
    };
  }

  async function grantPublicScope(): Promise<AuthorizationScope> {
    const state: ClientState = {
      queries: [],
      results: [orgRow(), matterRow()],
    };
    const port = createSupabaseTenancyReadPort(fakeDb(state));
    const granted = await evaluateInitialAccess(port, {
      identity: identity(),
      organization_id: ORG,
      matter_id: MATTER,
      requiresMfa: false,
    });
    if (granted.kind !== "decision" || granted.decision.outcome !== "allow") {
      throw new Error("test setup: expected initial allow");
    }
    return granted.decision.scope;
  }

  it("allows an active member on a public matter: exactly two reads and the epoch carried into the scope", async () => {
    const state: ClientState = {
      queries: [],
      results: [orgRow(), matterRow()],
    };
    const port = createSupabaseTenancyReadPort(fakeDb(state));
    const result = await evaluateInitialAccess(port, {
      identity: identity(),
      organization_id: ORG,
      matter_id: MATTER,
      requiresMfa: false,
    });
    expect(state.queries.length).toBe(2);
    expect(state.queries.map((q) => q.table)).toEqual([
      "organization_memberships",
      "matters",
    ]);
    expect(result).toMatchObject({
      kind: "decision",
      decision: {
        outcome: "allow",
        scope: {
          user_id: USER,
          organization_id: ORG,
          workspace_id: WS,
          matter_id: MATTER,
          membership_role: "editor",
          authorization_epoch: 7,
          requires_explicit_matter_membership: false,
        },
      },
    });
  });

  it("reads matter membership only for private matters and allows a matching active row", async () => {
    const state: ClientState = {
      queries: [],
      results: [
        orgRow(),
        matterRow({ visibility: "private" }),
        matterMembershipRow(),
      ],
    };
    const port = createSupabaseTenancyReadPort(fakeDb(state));
    const result = await evaluateInitialAccess(port, {
      identity: identity(),
      organization_id: ORG,
      matter_id: MATTER,
      requiresMfa: false,
    });
    expect(state.queries.length).toBe(3);
    expect(state.queries[2]?.table).toBe("matter_memberships");
    expect(result).toMatchObject({
      kind: "decision",
      decision: {
        outcome: "allow",
        scope: {
          membership_role: "matter_owner",
          requires_explicit_matter_membership: true,
        },
      },
    });
  });

  it("yields opaque not_found without reading the matter when the org membership is missing", async () => {
    const state: ClientState = { queries: [], results: [null, null] };
    const port = createSupabaseTenancyReadPort(fakeDb(state));
    const result = await evaluateInitialAccess(port, {
      identity: identity(),
      organization_id: ORG,
      matter_id: MATTER,
      requiresMfa: false,
    });
    expect(state.queries.length).toBe(1);
    expect(result).toEqual({
      kind: "decision",
      decision: { outcome: "not_found" },
    });
  });

  it("yields opaque not_found when the matter belongs to a different organization", async () => {
    const state: ClientState = {
      queries: [],
      results: [
        orgRow(),
        matterRow({ workspaces: { organization_id: "org-other" } }),
      ],
    };
    const port = createSupabaseTenancyReadPort(fakeDb(state));
    const result = await evaluateInitialAccess(port, {
      identity: identity(),
      organization_id: ORG,
      matter_id: MATTER,
      requiresMfa: false,
    });
    expect(state.queries.length).toBe(2);
    expect(result).toEqual({
      kind: "decision",
      decision: { outcome: "not_found" },
    });
  });

  it("keeps a private matter without a matching active membership row opaque", async () => {
    const state: ClientState = {
      queries: [],
      results: [
        orgRow(),
        matterRow({ visibility: "private" }),
        matterMembershipRow({ status: "revoked" }),
      ],
    };
    const port = createSupabaseTenancyReadPort(fakeDb(state));
    const result = await evaluateInitialAccess(port, {
      identity: identity(),
      organization_id: ORG,
      matter_id: MATTER,
      requiresMfa: false,
    });
    expect(result).toEqual({
      kind: "decision",
      decision: { outcome: "not_found" },
    });
  });

  it("converts an adapter throw into the typed authorization_dependency_failed at initial access", async () => {
    const state: ClientState = {
      queries: [],
      results: [null],
      errors: [{ message: "connection refused", code: "XX000" }],
    };
    const port = createSupabaseTenancyReadPort(fakeDb(state));
    const result = await evaluateInitialAccess(port, {
      identity: identity(),
      organization_id: ORG,
      matter_id: MATTER,
      requiresMfa: false,
    });
    expect(result).toEqual({ kind: "authorization_dependency_failed" });
    expect(JSON.stringify(result)).not.toContain("connection refused");
    expect(JSON.stringify(result)).not.toContain("XX000");
  });

  it("stays fresh when the recheck reloads identical state through the adapter", async () => {
    const scope = await grantPublicScope();
    const recheckState: ClientState = {
      queries: [],
      results: [orgRow(), matterRow()],
    };
    const recheckPort = createSupabaseTenancyReadPort(fakeDb(recheckState));
    const result = await recheckFreshAccessViaPort(recheckPort, {
      scope,
      identity: identity(),
      requiresMfa: false,
    });
    expect(result).toEqual({ kind: "recheck", result: { fresh: true } });
  });

  it("marks the recheck stale when the organization epoch advanced", async () => {
    const scope = await grantPublicScope();
    const recheckState: ClientState = {
      queries: [],
      results: [
        orgRow({ organizations: { authorization_epoch: 8 } }),
        matterRow(),
      ],
    };
    const recheckPort = createSupabaseTenancyReadPort(fakeDb(recheckState));
    const result = await recheckFreshAccessViaPort(recheckPort, {
      scope,
      identity: identity(),
      requiresMfa: false,
    });
    expect(result).toMatchObject({
      kind: "recheck",
      result: { fresh: false, code: "stale_authorization_epoch" },
    });
  });

  it("marks the recheck stale when the matter moved workspace after grant", async () => {
    const scope = await grantPublicScope();
    const recheckState: ClientState = {
      queries: [],
      results: [orgRow(), matterRow({ workspace_id: "ws-other" })],
    };
    const recheckPort = createSupabaseTenancyReadPort(fakeDb(recheckState));
    const result = await recheckFreshAccessViaPort(recheckPort, {
      scope,
      identity: identity(),
      requiresMfa: false,
    });
    expect(result).toMatchObject({
      kind: "recheck",
      result: { fresh: false, code: "matter_scope_mismatch" },
    });
  });

  it("keeps the typed dependency failure when a recheck read throws through the adapter", async () => {
    const scope = await grantPublicScope();
    const recheckState: ClientState = {
      queries: [],
      results: [orgRow(), null],
      errors: [null, { message: "matter read down", code: "XX000" }],
    };
    const recheckPort = createSupabaseTenancyReadPort(fakeDb(recheckState));
    const result = await recheckFreshAccessViaPort(recheckPort, {
      scope,
      identity: identity(),
      requiresMfa: false,
    });
    expect(result).toEqual({ kind: "authorization_dependency_failed" });
    expect(JSON.stringify(result)).not.toContain("matter read down");
  });
});

describe("read-only adapter surface lock", () => {
  it("exports exactly the adapter factory at runtime", () => {
    expect(Object.keys(adapterModule).sort()).toEqual([
      "createSupabaseTenancyReadPort",
    ]);
  });

  it("the factory does not touch the client until a read method is called", () => {
    let touched = false;
    const inertDb = new Proxy(
      {},
      {
        get() {
          touched = true;
          throw new Error("test setup: client must not be touched");
        },
      },
    ) as unknown as Parameters<typeof createSupabaseTenancyReadPort>[0];
    expect(() => createSupabaseTenancyReadPort(inertDb)).not.toThrow();
    expect(touched).toBe(false);
  });

  it("every read stays on the read-only builder surface (no mutation/auth/storage/rpc)", async () => {
    const state: ClientState = {
      queries: [],
      results: [
        orgRow(),
        {
          id: MATTER,
          workspace_id: WS,
          visibility: "public",
          workspaces: { organization_id: ORG },
        },
        { user_id: USER, matter_id: MATTER, role: "viewer", status: "active" },
      ],
      prohibited: [],
    };
    const port = createSupabaseTenancyReadPort(fakeDb(state));
    await port.getOrganizationMembership({
      user_id: USER,
      organization_id: ORG,
    });
    await port.getMatter({ matter_id: MATTER });
    await port.getMatterMembership({ user_id: USER, matter_id: MATTER });
    expect(state.prohibited).toEqual([]);
  });
});
