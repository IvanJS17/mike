import {
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";

// validateRemoteMcpUrl resolves non-literal hostnames via dns.lookup to reject
// names that point at private/blocked addresses. Test hostnames like
// auth.example.com don't resolve on the public internet, so stub DNS to a
// fixed PUBLIC address. This keeps validateRemoteMcpUrl's real logic intact
// (HTTPS-only, userinfo/fragment stripping, localhost + literal-private-IP
// rejection all still run) while removing network flakiness — the blocked
// cases in the refresh suite use IP literals / localhost that short-circuit
// before this mock is ever consulted.
vi.mock("dns/promises", () => ({
    default: {
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    },
}));

// A real encryption secret so encryptString/decryptString round-trip for real
// (AES-256-GCM). The module reads this lazily inside encryptionKey(), so
// setting it before importing oauth.ts is enough.
process.env.MCP_CONNECTORS_ENCRYPTION_SECRET = "test-mcp-oauth-secret-key";

import { encryptString, decryptString } from "./client";
import {
    DbMcpOAuthProvider,
    refreshOAuthAccessToken,
} from "./oauth";
import type { ConnectorRow, Db, OAuthTokenRow } from "./types";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

// ---------------------------------------------------------------------------
// Minimal in-memory PostgREST-shaped stub.
//
// Supports the exact chains oauth.ts uses:
//   from(t).select("*").eq(c, v).maybeSingle()
//   from(t).update(row).eq(c, v)[.eq(c, v)]
//   from(t).insert(row)
//   from(t).upsert(row, { onConflict })
//   from(t).delete().eq(c, v)
// The query builder is thenable, so `await from(t).update(row).eq(...)`
// resolves to { error }, while maybeSingle() resolves to { data, error }.
// upsert() mirrors PostgREST on-conflict semantics: INSERT when the conflict
// column is unseen, otherwise MERGE only the payload columns into the row.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

class FakeQuery {
    private op: "select" | "update" | "insert" | "upsert" | "delete" =
        "select";
    private payload: Row | null = null;
    private onConflict: string | null = null;
    private filters: Array<[string, unknown]> = [];

    constructor(private readonly table: Row[]) {}

    select(_cols?: string) {
        this.op = "select";
        return this;
    }
    update(row: Row) {
        this.op = "update";
        this.payload = row;
        return this;
    }
    insert(row: Row) {
        this.op = "insert";
        this.payload = row;
        return this;
    }
    upsert(row: Row, opts?: { onConflict?: string }) {
        this.op = "upsert";
        this.payload = row;
        this.onConflict = opts?.onConflict ?? null;
        return this;
    }
    delete() {
        this.op = "delete";
        return this;
    }
    eq(column: string, value: unknown) {
        this.filters.push([column, value]);
        return this;
    }

    private matches(row: Row) {
        return this.filters.every(([c, v]) => row[c] === v);
    }

    private run(): { data: Row | null; error: unknown } {
        switch (this.op) {
            case "select": {
                const found = this.table.find((r) => this.matches(r)) ?? null;
                return { data: found, error: null };
            }
            case "insert": {
                this.table.push({ ...(this.payload ?? {}) });
                return { data: null, error: null };
            }
            case "upsert": {
                const key = this.onConflict;
                const existing = key
                    ? this.table.find(
                          (r) => r[key] === (this.payload ?? {})[key],
                      )
                    : undefined;
                if (existing) {
                    Object.assign(existing, this.payload);
                } else {
                    this.table.push({ ...(this.payload ?? {}) });
                }
                return { data: null, error: null };
            }
            case "update": {
                for (const row of this.table) {
                    if (this.matches(row)) Object.assign(row, this.payload);
                }
                return { data: null, error: null };
            }
            case "delete": {
                for (let i = this.table.length - 1; i >= 0; i--) {
                    if (this.matches(this.table[i])) this.table.splice(i, 1);
                }
                return { data: null, error: null };
            }
        }
    }

    maybeSingle() {
        return Promise.resolve(this.run());
    }
    // Thenable so `await query` works for update/insert/upsert/delete.
    then(
        resolve: (v: { data: Row | null; error: unknown }) => unknown,
        reject?: (e: unknown) => unknown,
    ) {
        try {
            return Promise.resolve(this.run()).then(resolve, reject);
        } catch (err) {
            return Promise.reject(err).then(resolve, reject);
        }
    }
}

function makeDb() {
    const tables: Record<string, Row[]> = {
        user_mcp_oauth_tokens: [],
        user_mcp_connectors: [],
        user_mcp_oauth_states: [],
    };
    const db = {
        from(table: string) {
            tables[table] ??= [];
            return new FakeQuery(tables[table]);
        },
        __tables: tables,
    };
    return db as unknown as Db & { __tables: Record<string, Row[]> };
}

function tokenRow(db: Db & { __tables: Record<string, Row[]> }) {
    return (db.__tables.user_mcp_oauth_tokens[0] ?? null) as OAuthTokenRow | null;
}

const connector: ConnectorRow = {
    id: "conn-1",
    user_id: "user-1",
    name: "Test",
    transport: "streamable_http",
    server_url: "https://mcp.example.com/sse",
    auth_type: "oauth",
    enabled: true,
    tool_policy: null,
    encrypted_auth_config: null,
    auth_config_iv: null,
    auth_config_tag: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
};

function makeProvider(db: Db) {
    return new DbMcpOAuthProvider(
        db,
        connector,
        connector.user_id,
        "use",
        "https://app.example.com/callback",
    );
}

// Encrypt a value the way the DB row stores each secret triple.
function secretTriple(prefix: string, value: string) {
    const enc = encryptString(value);
    return {
        [`encrypted_${prefix}`]: enc.encrypted,
        [`${prefix}_iv`]: enc.iv,
        [`${prefix}_tag`]: enc.tag,
    };
}

describe("mcp oauth provider — discovery metadata persistence", () => {
    // (a) saveClientInformation persists id/secret without clobbering
    // discovery columns already written by saveDiscoveryState.
    it("persists client id/secret without clobbering discovery columns", async () => {
        const db = makeDb();
        // Pre-seed discovery metadata (as saveDiscoveryState would).
        db.__tables.user_mcp_oauth_tokens.push({
            connector_id: connector.id,
            authorization_server: "https://auth.example.com",
            token_endpoint: "https://auth.example.com/token",
            resource: "https://mcp.example.com/",
        });

        const provider = makeProvider(db);
        await provider.saveClientInformation({
            client_id: "client-123",
            client_secret: "shhh-secret",
        } as never);

        const row = tokenRow(db)!;
        expect(row.client_id).toBe("client-123");
        expect(
            decryptString(
                row.encrypted_client_secret,
                row.client_secret_iv,
                row.client_secret_tag,
            ),
        ).toBe("shhh-secret");
        // Discovery columns must survive the partial upsert.
        expect(row.authorization_server).toBe("https://auth.example.com");
        expect(row.token_endpoint).toBe("https://auth.example.com/token");
        expect(row.resource).toBe("https://mcp.example.com/");
    });

    // (b) saveTokens persists AS/endpoint/resource from lastDiscoveryState,
    // and preserves them from the existing row when lastDiscoveryState is null.
    it("saveTokens persists AS/endpoint/resource from discovery state", async () => {
        const db = makeDb();
        const provider = makeProvider(db);
        const state = {
            authorizationServerUrl: "https://auth.example.com",
            authorizationServerMetadata: {
                token_endpoint: "https://auth.example.com/oauth/token",
            },
            resourceMetadata: { resource: "https://mcp.example.com/" },
        } as unknown as OAuthDiscoveryState;
        await provider.saveDiscoveryState(state);

        await provider.saveTokens({
            access_token: "access-abc",
            token_type: "Bearer",
            refresh_token: "refresh-xyz",
            expires_in: 3600,
        } as OAuthTokens);

        const row = tokenRow(db)!;
        // saveTokens persists the discovery-state authorizationServerUrl
        // verbatim (F6 sanitization is scoped to saveDiscoveryState); the input
        // has no path so no trailing slash is added here.
        expect(row.authorization_server).toBe("https://auth.example.com");
        expect(row.token_endpoint).toBe("https://auth.example.com/oauth/token");
        expect(row.resource).toBe("https://mcp.example.com/");
        expect(
            decryptString(
                row.encrypted_access_token,
                row.access_token_iv,
                row.access_token_tag,
            ),
        ).toBe("access-abc");
    });

    it("saveTokens preserves persisted metadata when discovery state is null", async () => {
        const db = makeDb();
        // Row already holds discovery metadata + a refresh token (fresh
        // provider => lastDiscoveryState is null on this refresh persist).
        db.__tables.user_mcp_oauth_tokens.push({
            connector_id: connector.id,
            authorization_server: "https://auth.example.com/",
            token_endpoint: "https://auth.example.com/token",
            resource: "https://mcp.example.com/",
            ...secretTriple("refresh_token", "old-refresh"),
        });

        const provider = makeProvider(db);
        await provider.saveTokens({
            access_token: "access-2",
            token_type: "Bearer",
            expires_in: 3600,
        } as OAuthTokens);

        const row = tokenRow(db)!;
        expect(row.authorization_server).toBe("https://auth.example.com/");
        expect(row.token_endpoint).toBe("https://auth.example.com/token");
        expect(row.resource).toBe("https://mcp.example.com/");
        // Refresh token preserved because the new response omitted one.
        expect(
            decryptString(
                row.encrypted_refresh_token,
                row.refresh_token_iv,
                row.refresh_token_tag,
            ),
        ).toBe("old-refresh");
    });

    // (f) /token fallback: when the AS metadata omits token_endpoint, the
    // endpoint is derived as `${authorizationServerUrl}/token`.
    it("falls back to <AS>/token when metadata omits token_endpoint", async () => {
        const db = makeDb();
        const provider = makeProvider(db);
        await provider.saveDiscoveryState({
            authorizationServerUrl: "https://auth.example.com",
        } as unknown as OAuthDiscoveryState);

        expect(tokenRow(db)!.token_endpoint).toBe(
            "https://auth.example.com/token",
        );
    });

    // (F6) Sanitized URL is persisted, not the raw input (userinfo stripped).
    it("persists the sanitized authorization server URL (no userinfo)", async () => {
        const db = makeDb();
        const provider = makeProvider(db);
        await provider.saveDiscoveryState({
            authorizationServerUrl: "https://user:pass@auth.example.com",
            authorizationServerMetadata: {
                token_endpoint: "https://user:pass@auth.example.com/token#frag",
            },
        } as unknown as OAuthDiscoveryState);

        const row = tokenRow(db)!;
        expect(row.authorization_server).toBe("https://auth.example.com/");
        expect(row.token_endpoint).toBe("https://auth.example.com/token");
        expect(String(row.token_endpoint)).not.toContain("pass");
        expect(String(row.token_endpoint)).not.toContain("#frag");
    });

    it("rejects a token endpoint whose origin differs from the AS origin", async () => {
        const db = makeDb();
        const provider = makeProvider(db);
        await expect(
            provider.saveDiscoveryState({
                authorizationServerUrl: "https://auth.example.com",
                authorizationServerMetadata: {
                    token_endpoint: "https://evil.example.net/token",
                },
            } as unknown as OAuthDiscoveryState),
        ).rejects.toThrow(/origin/i);
    });

    // (e) The F1 fix: an authorization-server ORIGIN change during
    // re-discovery must invalidate the stored access/refresh/client secrets.
    it("invalidates stored tokens when the AS origin changes on re-discovery", async () => {
        const db = makeDb();
        db.__tables.user_mcp_oauth_tokens.push({
            connector_id: connector.id,
            authorization_server: "https://auth.example.com/",
            token_endpoint: "https://auth.example.com/token",
            client_id: "client-1",
            ...secretTriple("access_token", "live-access"),
            ...secretTriple("refresh_token", "live-refresh"),
            ...secretTriple("client_secret", "live-client-secret"),
            expires_at: "2999-01-01T00:00:00Z",
        });

        const provider = makeProvider(db);
        // Same connector re-discovers a DIFFERENT authorization server.
        await provider.saveDiscoveryState({
            authorizationServerUrl: "https://attacker.example.org",
            authorizationServerMetadata: {
                token_endpoint: "https://attacker.example.org/token",
            },
        } as unknown as OAuthDiscoveryState);

        const row = tokenRow(db)!;
        expect(row.authorization_server).toBe("https://attacker.example.org/");
        // Credentials issued by the OLD server must be wiped (force re-auth).
        expect(row.encrypted_access_token).toBeNull();
        expect(row.encrypted_refresh_token).toBeNull();
        expect(row.encrypted_client_secret).toBeNull();
        expect(row.client_id).toBeNull();
        expect(row.expires_at).toBeNull();
    });

    it("keeps stored tokens when the AS origin is unchanged", async () => {
        const db = makeDb();
        db.__tables.user_mcp_oauth_tokens.push({
            connector_id: connector.id,
            authorization_server: "https://auth.example.com/",
            token_endpoint: "https://auth.example.com/token",
            client_id: "client-1",
            ...secretTriple("refresh_token", "live-refresh"),
        });

        const provider = makeProvider(db);
        await provider.saveDiscoveryState({
            authorizationServerUrl: "https://auth.example.com",
            authorizationServerMetadata: {
                token_endpoint: "https://auth.example.com/token2",
            },
        } as unknown as OAuthDiscoveryState);

        const row = tokenRow(db)!;
        expect(row.token_endpoint).toBe("https://auth.example.com/token2");
        expect(row.client_id).toBe("client-1");
        expect(row.encrypted_refresh_token).not.toBeNull();
    });

    // (F7) invalidateCredentials("discovery") clears the 3 metadata columns.
    it('invalidateCredentials("discovery") clears the metadata columns only', async () => {
        const db = makeDb();
        db.__tables.user_mcp_oauth_tokens.push({
            connector_id: connector.id,
            authorization_server: "https://auth.example.com/",
            token_endpoint: "https://auth.example.com/token",
            resource: "https://mcp.example.com/",
            ...secretTriple("access_token", "live-access"),
        });

        const provider = makeProvider(db);
        await provider.invalidateCredentials("discovery");

        const row = tokenRow(db)!;
        expect(row.authorization_server).toBeNull();
        expect(row.token_endpoint).toBeNull();
        expect(row.resource).toBeNull();
        // Access token untouched — only discovery metadata is cleared.
        expect(row.encrypted_access_token).not.toBeNull();
    });
});

describe("mcp oauth — refresh path", () => {
    const fetchMock = vi.fn();

    beforeAll(() => {
        vi.stubGlobal("fetch", fetchMock);
    });
    beforeEach(() => {
        fetchMock.mockReset();
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.stubGlobal("fetch", fetchMock);
    });

    function seededRefreshRow(tokenEndpoint: string): OAuthTokenRow {
        return {
            id: "tok-1",
            connector_id: connector.id,
            ...secretTriple("access_token", "old-access"),
            ...secretTriple("refresh_token", "the-refresh-token"),
            token_type: "Bearer",
            scope: "read",
            expires_at: "2000-01-01T00:00:00Z",
            authorization_server: "https://8.8.8.8",
            token_endpoint: tokenEndpoint,
            client_id: "client-1",
            ...secretTriple("client_secret", "client-secret"),
            resource: "https://mcp.example.com/",
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
        } as OAuthTokenRow;
    }

    // (c) refresh POSTs to the persisted token_endpoint.
    it("POSTs the refresh grant to the persisted token_endpoint", async () => {
        // 8.8.8.8 is a public IP literal: passes validateRemoteMcpUrl without
        // a DNS round-trip, so the test needs no network.
        const endpoint = "https://8.8.8.8/token";
        fetchMock.mockResolvedValue({
            ok: true,
            json: async () => ({
                access_token: "new-access",
                token_type: "Bearer",
                expires_in: 3600,
            }),
        });

        const db = makeDb();
        db.__tables.user_mcp_oauth_tokens.push(
            seededRefreshRow(endpoint) as unknown as Row,
        );

        await refreshOAuthAccessToken(seededRefreshRow(endpoint), db);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [calledUrl, init] = fetchMock.mock.calls[0];
        expect(String(calledUrl)).toBe(endpoint);
        expect(init.method).toBe("POST");
        // guardedFetch forces redirect:"manual" so a 3xx can't forward the
        // refresh token + client secret to an unvalidated Location.
        expect(init.redirect).toBe("manual");
        const body = String(init.body);
        expect(body).toContain("grant_type=refresh_token");
        expect(body).toContain("the-refresh-token");
    });

    // (d) A malicious persisted endpoint is rejected BEFORE any fetch.
    it.each([
        ["private link-local IP", "https://169.254.169.254/token"],
        ["loopback IP", "https://127.0.0.1/token"],
        ["localhost host", "https://localhost/token"],
        ["plain HTTP", "http://8.8.8.8/token"],
    ])(
        "rejects a poisoned token_endpoint (%s) before any outbound request",
        async (_label, endpoint) => {
            const db = makeDb();
            await expect(
                refreshOAuthAccessToken(seededRefreshRow(endpoint), db),
            ).rejects.toThrow();
            expect(fetchMock).not.toHaveBeenCalled();
        },
    );
});
