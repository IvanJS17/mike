import { describe, expect, it } from "vitest";
import { isGoogleMcpServerUrl } from "./mcpConnectorHostname";

describe("Google MCP hostname classification", () => {
    it.each(["https://googleapis.com/mcp", "https://docs.googleapis.com/mcp"])(
        "recognizes exact Google domain and subdomains: %s", (url) => {
            expect(isGoogleMcpServerUrl(url)).toBe(true);
        },
    );
    it.each([
        "https://evilgoogleapis.com/mcp",
        "https://googleapis.com.attacker.test/mcp",
        "https://googleapis.com@attacker.test/mcp",
        "not a URL",
    ])("rejects unrelated or malformed hosts: %s", (url) => {
        expect(isGoogleMcpServerUrl(url)).toBe(false);
    });
});
