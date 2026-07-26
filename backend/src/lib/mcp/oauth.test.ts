import { describe, expect, it } from "vitest";
import {
    DbMcpOAuthProvider,
    McpOAuthRequiredError,
    isGoogleOAuthHost,
    providerAuthorizationParams,
} from "./oauth";
import type { ConnectorRow, Db } from "./types";

// The provider methods exercised here only read connector.server_url and the
// mode, and never touch the database, so an empty stub satisfies the type.
const stubDb = {} as Db;

function makeConnector(serverUrl: string): ConnectorRow {
    return {
        id: "00000000-0000-0000-0000-000000000000",
        user_id: "user-1",
        name: "Test connector",
        transport: "streamable_http",
        server_url: serverUrl,
        auth_type: "oauth",
        enabled: true,
        tool_policy: {},
        encrypted_auth_config: null,
        auth_config_iv: null,
        auth_config_tag: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
    };
}

// A representative authorization URL as the MCP SDK would hand it to the
// provider, already carrying the standard OAuth params.
const AUTH_URL =
    "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=abc&code_challenge=xyz";

describe("isGoogleOAuthHost", () => {
    it("matches googleapis.com and its real subdomains", () => {
        expect(
            isGoogleOAuthHost("https://drivemcp.googleapis.com/mcp/v1"),
        ).toBe(true);
        expect(
            isGoogleOAuthHost("https://gmailmcp.googleapis.com/mcp"),
        ).toBe(true);
        expect(isGoogleOAuthHost("https://googleapis.com/x")).toBe(true);
    });

    it("rejects non-Google and look-alike hosts", () => {
        expect(isGoogleOAuthHost("https://mcp.example.com/mcp")).toBe(false);
        // Suffix-only matches must not pass: this is NOT a google host.
        expect(isGoogleOAuthHost("https://notgoogleapis.com/x")).toBe(false);
        // A subdomain of an attacker domain that merely contains the string.
        expect(
            isGoogleOAuthHost("https://googleapis.com.evil.test/mcp"),
        ).toBe(false);
        expect(isGoogleOAuthHost("not a url")).toBe(false);
    });
});

describe("providerAuthorizationParams", () => {
    it("requests offline access + consent for Google hosts", () => {
        expect(
            providerAuthorizationParams(
                "https://drivemcp.googleapis.com/mcp/v1",
            ),
        ).toEqual({ access_type: "offline", prompt: "consent" });
    });

    it("adds nothing for non-Google hosts", () => {
        expect(
            providerAuthorizationParams("https://mcp.example.com/mcp"),
        ).toEqual({});
    });
});

describe("DbMcpOAuthProvider.redirectToAuthorization", () => {
    it("requests offline access + consent for Google hosts when initiating", async () => {
        const provider = new DbMcpOAuthProvider(
            stubDb,
            makeConnector("https://drivemcp.googleapis.com/mcp/v1"),
            "user-1",
            "initiate",
            "https://app.test/callback",
        );

        await provider.redirectToAuthorization(new URL(AUTH_URL));

        const url = provider.lastAuthorizeUrl;
        expect(url).not.toBeNull();
        if (!url) throw new Error("expected an authorization URL");
        // Without these Google never returns a refresh token, so the connector
        // would break as soon as the first access token expires.
        expect(url.searchParams.get("access_type")).toBe("offline");
        expect(url.searchParams.get("prompt")).toBe("consent");
        // The SDK-provided params must be preserved.
        expect(url.searchParams.get("response_type")).toBe("code");
        expect(url.searchParams.get("client_id")).toBe("abc");
    });

    it("leaves non-Google authorization URLs untouched", async () => {
        const provider = new DbMcpOAuthProvider(
            stubDb,
            makeConnector("https://mcp.example.com/mcp"),
            "user-1",
            "initiate",
            "https://app.test/callback",
        );

        await provider.redirectToAuthorization(new URL(AUTH_URL));

        const url = provider.lastAuthorizeUrl;
        expect(url).not.toBeNull();
        if (!url) throw new Error("expected an authorization URL");
        expect(url.searchParams.get("access_type")).toBeNull();
        expect(url.searchParams.get("prompt")).toBeNull();
    });

    it("refuses to redirect (and captures nothing) in 'use' mode", async () => {
        const provider = new DbMcpOAuthProvider(
            stubDb,
            makeConnector("https://drivemcp.googleapis.com/mcp/v1"),
            "user-1",
            "use",
            "https://app.test/callback",
        );

        await expect(
            provider.redirectToAuthorization(new URL(AUTH_URL)),
        ).rejects.toBeInstanceOf(McpOAuthRequiredError);
        expect(provider.lastAuthorizeUrl).toBeNull();
    });
});
