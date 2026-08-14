import { describe, expect, it, vi } from "vitest";
import {
    normalizeApiKeyProvider,
    resolveUserLlmCredential,
    saveUserApiKey,
} from "../userApiKeys";

describe("governed BYOK credential references", () => {
    it("recognizes the new LLM providers without adding aliases", () => {
        expect(normalizeApiKeyProvider("deepseek")).toBe("deepseek");
        expect(normalizeApiKeyProvider("opencode-zen")).toBe("opencode-zen");
        expect(normalizeApiKeyProvider("opencode-go")).toBe("opencode-go");
    });

    it("leaves credential version allocation to the database and never writes plaintext", async () => {
        process.env.USER_API_KEYS_ENCRYPTION_SECRET = "test-encryption-secret";
        const query: Record<string, ReturnType<typeof vi.fn>> = {};
        query.select = vi.fn(() => {
            throw new Error("save must not read the current credential version");
        });
        query.upsert = vi.fn(async () => ({ error: null }));
        const db = { from: vi.fn(() => query) } as never;

        const secret = "«redacted:sk-…»";
        await saveUserApiKey("user-1", "deepseek", secret, db);

        expect(query.select).not.toHaveBeenCalled();
        const payload = query.upsert.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(payload).not.toHaveProperty("version");
        expect(payload).not.toHaveProperty("credential_ref");
        expect(JSON.stringify(payload)).not.toContain(secret);
    });

    it("resolves only the exact current reference and fails closed for an old one", async () => {
        process.env.USER_API_KEYS_ENCRYPTION_SECRET = "test-encryption-secret";
        const row = {
            provider: "deepseek",
            credential_ref: "deepseek:v2",
            version: 2,
            encrypted_key: "",
            iv: "",
            auth_tag: "",
        };
        const writeQuery: Record<string, ReturnType<typeof vi.fn>> = {};
        writeQuery.select = vi.fn(() => writeQuery);
        writeQuery.eq = vi.fn(() => writeQuery);
        writeQuery.maybeSingle = vi.fn(async () => ({ data: row, error: null }));
        writeQuery.upsert = vi.fn(async (payload: Record<string, unknown>) => {
            Object.assign(row, payload);
            return { error: null };
        });
        const db = { from: vi.fn(() => writeQuery) } as never;
        await saveUserApiKey("user-1", "deepseek", "sk-current", db);

        expect(
            await resolveUserLlmCredential(
                "user-1",
                "deepseek",
                "deepseek:v1",
                db,
            ),
        ).toBeNull();
    });

    it("keeps a deletion tombstone so the pinned reference stays unavailable", async () => {
        process.env.USER_API_KEYS_ENCRYPTION_SECRET = "test-encryption-secret";
        const row = {
            provider: "deepseek",
            credential_ref: "deepseek:v1",
            version: 1,
            enabled: true,
            encrypted_key: "",
            iv: "",
            auth_tag: "",
        };
        const query: Record<string, ReturnType<typeof vi.fn>> = {};
        query.select = vi.fn(() => query);
        query.eq = vi.fn(() => query);
        query.maybeSingle = vi.fn(async () => ({ data: row, error: null }));
        query.update = vi.fn((payload: Record<string, unknown>) => {
            Object.assign(row, payload);
            return query;
        });
        query.upsert = vi.fn(async (payload: Record<string, unknown>) => {
            Object.assign(row, payload);
            return { error: null };
        });
        const db = { from: vi.fn(() => query) } as never;

        await saveUserApiKey("user-1", "deepseek", null, db);

        expect(row.enabled).toBe(false);
        expect(
            await resolveUserLlmCredential(
                "user-1",
                "deepseek",
                "deepseek:v1",
                db,
            ),
        ).toBeNull();
    });
});
