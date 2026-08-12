import crypto from "crypto";
import { createServerSupabase } from "./supabase";
import type { UserApiKeys } from "./llm";

type Db = ReturnType<typeof createServerSupabase>;
export type ApiKeyProvider =
    | LlmApiKeyProvider
    | "courtlistener";
export type LlmApiKeyProvider =
    | "claude"
    | "gemini"
    | "openai"
    | "openrouter"
    | "deepseek"
    | "opencode-zen"
    | "opencode-go";
export type ApiKeySource = "user" | "env" | null;
export type ApiKeyStatus = Record<ApiKeyProvider, boolean> & {
    sources: Record<ApiKeyProvider, ApiKeySource>;
};

export const LLM_API_KEY_PROVIDERS: LlmApiKeyProvider[] = [
    "claude",
    "gemini",
    "openai",
    "openrouter",
    "deepseek",
    "opencode-zen",
    "opencode-go",
];

export function environmentCredentialReference(provider: string): string {
    return `${provider}:env`;
}

type EncryptedKeyRow = {
    provider: ApiKeyProvider;
    encrypted_key: string;
    iv: string;
    auth_tag: string;
    credential_ref?: string | null;
    version?: number | null;
    enabled?: boolean | null;
};

const PROVIDERS: ApiKeyProvider[] = [
    ...LLM_API_KEY_PROVIDERS,
    "courtlistener",
];

function envApiKey(provider: ApiKeyProvider): string | null {
    switch (provider) {
        case "claude":
            return (
                process.env.ANTHROPIC_API_KEY?.trim() ||
                process.env.CLAUDE_API_KEY?.trim() ||
                null
            );
        case "gemini":
            return process.env.GEMINI_API_KEY?.trim() || null;
        case "openai":
            return process.env.OPENAI_API_KEY?.trim() || null;
        case "openrouter":
            return process.env.OPENROUTER_API_KEY?.trim() || null;
        case "deepseek":
            return process.env.DEEPSEEK_API_KEY?.trim() || null;
        case "opencode-zen":
            return process.env.OPENCODE_ZEN_API_KEY?.trim() || null;
        case "opencode-go":
            return process.env.OPENCODE_GO_API_KEY?.trim() || null;
        case "courtlistener":
            return process.env.COURTLISTENER_API_TOKEN?.trim() || null;
        default:
            return null;
    }
}

export function hasEnvApiKey(provider: ApiKeyProvider): boolean {
    return !!envApiKey(provider);
}

function encryptionKey(): Buffer {
    const secret = process.env.USER_API_KEYS_ENCRYPTION_SECRET;
    if (!secret) {
        throw new Error("USER_API_KEYS_ENCRYPTION_SECRET is not configured");
    }
    return crypto.scryptSync(secret, "mike-user-api-keys-v1", 32);
}

function encrypt(value: string): Omit<EncryptedKeyRow, "provider"> {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
    const encrypted = Buffer.concat([
        cipher.update(value, "utf8"),
        cipher.final(),
    ]);
    return {
        encrypted_key: encrypted.toString("base64"),
        iv: iv.toString("base64"),
        auth_tag: cipher.getAuthTag().toString("base64"),
    };
}

function decrypt(row: EncryptedKeyRow): string | null {
    try {
        const decipher = crypto.createDecipheriv(
            "aes-256-gcm",
            encryptionKey(),
            Buffer.from(row.iv, "base64"),
        );
        decipher.setAuthTag(Buffer.from(row.auth_tag, "base64"));
        const decrypted = Buffer.concat([
            decipher.update(Buffer.from(row.encrypted_key, "base64")),
            decipher.final(),
        ]);
        return decrypted.toString("utf8");
    } catch (err) {
        console.error("[user-api-keys] failed to decrypt stored key", {
            provider: row.provider,
            error: err instanceof Error ? err.message : String(err),
        });
        return null;
    }
}

function isProvider(value: string): value is ApiKeyProvider {
    return (PROVIDERS as string[]).includes(value);
}

export function normalizeApiKeyProvider(value: string): ApiKeyProvider | null {
    return isProvider(value) ? value : null;
}

export type ResolvedUserLlmCredential = {
    provider: LlmApiKeyProvider;
    credential_ref: string;
    secret: string;
};

function isLlmApiKeyProvider(
    provider: ApiKeyProvider,
): provider is LlmApiKeyProvider {
    return provider !== "courtlistener";
}

export async function resolveUserLlmCredential(
    userId: string,
    provider: LlmApiKeyProvider,
    credentialRef: string,
    db: Db = createServerSupabase(),
): Promise<ResolvedUserLlmCredential | null> {
    const environmentSecret = envApiKey(provider);
    if (
        environmentSecret &&
        credentialRef === environmentCredentialReference(provider)
    ) {
        return {
            provider,
            credential_ref: credentialRef,
            secret: environmentSecret,
        };
    }

    const { data, error } = await db
        .from("user_api_keys")
        .select("provider, credential_ref, encrypted_key, iv, auth_tag, enabled")
        .eq("user_id", userId)
        .eq("provider", provider)
        .eq("credential_ref", credentialRef)
        .maybeSingle();
    if (error) throw error;

    const row = data as EncryptedKeyRow | null;
    if (
        !row ||
        row.provider !== provider ||
        row.credential_ref !== credentialRef ||
        row.enabled === false
    ) {
        return null;
    }
    const secret = decrypt(row);
    if (!secret?.trim()) return null;
    return { provider, credential_ref: credentialRef, secret };
}

export async function listUserLlmCredentials(
    userId: string,
    db: Db = createServerSupabase(),
): Promise<ResolvedUserLlmCredential[]> {
    const credentials: ResolvedUserLlmCredential[] = [];
    const seen = new Set<string>();
    const add = (credential: ResolvedUserLlmCredential) => {
        const key = `${credential.provider}:${credential.credential_ref}`;
        if (seen.has(key)) return;
        seen.add(key);
        credentials.push(credential);
    };

    for (const provider of LLM_API_KEY_PROVIDERS) {
        const secret = envApiKey(provider);
        if (secret) {
            add({
                provider,
                credential_ref: environmentCredentialReference(provider),
                secret,
            });
        }
    }

    const { data, error } = await db
        .from("user_api_keys")
        .select(
            "provider, credential_ref, encrypted_key, iv, auth_tag, enabled",
        )
        .eq("user_id", userId);
    if (error) throw error;

    for (const row of (data ?? []) as EncryptedKeyRow[]) {
        const provider = normalizeApiKeyProvider(String(row.provider));
        if (!provider || !isLlmApiKeyProvider(provider)) continue;
        const credentialRef = row.credential_ref?.trim();
        if (!credentialRef || row.enabled === false) continue;
        const secret = decrypt(row);
        if (!secret?.trim()) continue;
        add({ provider, credential_ref: credentialRef, secret });
    }

    return credentials;
}

export async function getUserApiKeyStatus(
    userId: string,
    db: Db = createServerSupabase(),
): Promise<ApiKeyStatus> {
    const status: ApiKeyStatus = {
        claude: false,
        gemini: false,
        openai: false,
        openrouter: false,
        deepseek: false,
        "opencode-zen": false,
        "opencode-go": false,
        courtlistener: false,
        sources: {
            claude: null,
            gemini: null,
            openai: null,
            openrouter: null,
            deepseek: null,
            "opencode-zen": null,
            "opencode-go": null,
            courtlistener: null,
        },
    };

    for (const provider of PROVIDERS) {
        if (hasEnvApiKey(provider)) {
            status[provider] = true;
            status.sources[provider] = "env";
        }
    }

    const { data, error } = await db
        .from("user_api_keys")
        .select("provider, enabled")
        .eq("user_id", userId);
    if (error) throw error;

    for (const row of data ?? []) {
        if ((row as { enabled?: boolean | null }).enabled === false) continue;
        const provider = normalizeApiKeyProvider(String(row.provider));
        if (provider && !status[provider]) {
            status[provider] = true;
            status.sources[provider] = "user";
        }
    }

    return status;
}

export async function getUserApiKeys(
    userId: string,
    db: Db = createServerSupabase(),
): Promise<UserApiKeys> {
    const apiKeys: UserApiKeys = {
        claude: envApiKey("claude"),
        gemini: envApiKey("gemini"),
        openai: envApiKey("openai"),
        openrouter: envApiKey("openrouter"),
        deepseek: envApiKey("deepseek"),
        "opencode-zen": envApiKey("opencode-zen"),
        "opencode-go": envApiKey("opencode-go"),
        courtlistener: envApiKey("courtlistener"),
    };

    const { data, error } = await db
        .from("user_api_keys")
        .select("provider, encrypted_key, iv, auth_tag, enabled")
        .eq("user_id", userId);
    if (error) throw error;

    for (const row of (data ?? []) as EncryptedKeyRow[]) {
        const provider = normalizeApiKeyProvider(row.provider);
        if (!provider) continue;
        if (row.enabled === false) continue;
        if (apiKeys[provider]?.trim()) continue;
        apiKeys[provider] = decrypt(row);
    }

    return apiKeys;
}

export async function saveUserApiKey(
    userId: string,
    provider: ApiKeyProvider,
    value: string | null,
    db: Db = createServerSupabase(),
): Promise<void> {
    const normalized = value?.trim() || null;

    if (!normalized) {
        const { error } = await db
            .from("user_api_keys")
            .update({
                ...encrypt(`revoked:${crypto.randomUUID()}`),
                enabled: false,
                updated_at: new Date().toISOString(),
            })
            .eq("user_id", userId)
            .eq("provider", provider);
        if (error) throw error;
        return;
    }

    const { error } = await db.from("user_api_keys").upsert(
        {
            user_id: userId,
            provider,
            enabled: true,
            ...encrypt(normalized),
            updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,provider" },
    );
    if (error) throw error;
}
