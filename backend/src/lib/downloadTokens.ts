import crypto from "crypto";

/**
 * HMAC-signed, non-expiring download tokens.
 *
 * The token encodes the R2 storage path + filename; the backend route
 * `/download/:token` validates the signature and streams the file. This
 * gives persistent links safe to store in chat history without signed-URL
 * expiry or R2 CORS headaches.
 */

function getSecret(): string {
    const secret = process.env.DOWNLOAD_SIGNING_SECRET;
    if (!secret) {
        throw new Error(
            "DOWNLOAD_SIGNING_SECRET must be set. " +
                "Generate a strong random value (e.g. `openssl rand -hex 32`) and set it in the environment.",
        );
    }
    return secret;
}

function b64urlEncode(buf: Buffer): string {
    return buf
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}

function b64urlDecode(s: string): Buffer {
    let t = s.replace(/-/g, "+").replace(/_/g, "/");
    while (t.length % 4) t += "=";
    return Buffer.from(t, "base64");
}

function timingSafeEqStr(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function signDownload(path: string, filename: string): string {
    const payload = JSON.stringify({ p: path, f: filename });
    const enc = b64urlEncode(Buffer.from(payload, "utf8"));
    const sig = crypto
        .createHmac("sha256", getSecret())
        .update(enc)
        .digest();
    return `${enc}.${b64urlEncode(sig)}`;
}

export function verifyDownload(
    token: string,
): { path: string; filename: string } | null {
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [enc, sigEnc] = parts;
    const expected = crypto
        .createHmac("sha256", getSecret())
        .update(enc)
        .digest();
    if (!timingSafeEqStr(sigEnc, b64urlEncode(expected))) return null;
    try {
        const parsed = JSON.parse(b64urlDecode(enc).toString("utf8")) as {
            p: string;
            f: string;
        };
        if (!parsed?.p || !parsed?.f) return null;
        return { path: parsed.p, filename: parsed.f };
    } catch {
        return null;
    }
}

export function signUserDownload(
    path: string,
    filename: string,
    userId: string,
    ttlSeconds = 300,
): string {
    const payload = JSON.stringify({ p: path, f: filename, u: userId, e: Math.floor(Date.now() / 1000) + ttlSeconds });
    const enc = b64urlEncode(Buffer.from(payload, "utf8"));
    const sig = crypto.createHmac("sha256", getSecret()).update(enc).digest();
    return `${enc}.${b64urlEncode(sig)}`;
}

export function verifyUserDownload(
    token: string,
): { path: string; filename: string; userId: string } | null {
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [enc, sigEnc] = parts;
    const expected = crypto.createHmac("sha256", getSecret()).update(enc).digest();
    if (!timingSafeEqStr(sigEnc, b64urlEncode(expected))) return null;
    try {
        const parsed = JSON.parse(b64urlDecode(enc).toString("utf8")) as {
            p?: string; f?: string; u?: string; e?: number;
        };
        const expiry = parsed.e;
        if (!parsed.p || !parsed.f || !parsed.u || typeof expiry !== "number" || !Number.isInteger(expiry) || expiry < Math.floor(Date.now() / 1000)) return null;
        return { path: parsed.p, filename: parsed.f, userId: parsed.u };
    } catch {
        return null;
    }
}

export function buildUserDownloadUrl(path: string, filename: string, userId: string): string {
    const base = (process.env.PUBLIC_API_BASE_URL ?? process.env.FRONTEND_URL ?? "").replace(/\/$/, "");
    return `${base}/download-user/${signUserDownload(path, filename, userId)}`;
}

/**
 * Returns a relative download URL for existing server-authenticated flows.
 */
export function buildDownloadUrl(path: string, filename: string): string {
    return `/download/${signDownload(path, filename)}`;
}
