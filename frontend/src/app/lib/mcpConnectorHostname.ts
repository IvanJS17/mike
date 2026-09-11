// Pure hostname classification extracted from the connector settings page.
export function isGoogleMcpServerUrl(serverUrl: string): boolean {
    try {
        const hostname = new URL(serverUrl).hostname.toLowerCase();
        return hostname === "googleapis.com" || hostname.endsWith(".googleapis.com");
    } catch {
        return false;
    }
}
