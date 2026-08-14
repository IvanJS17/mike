import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const databaseUrl = process.env.POSTGRES_BYOK_TEST_URL;
const maybeDescribe = databaseUrl ? describe : describe.skip;
const migrationPath = fileURLToPath(
    new URL(
        "../../../migrations/20260812_01_governed_byok_foundation.sql",
        import.meta.url,
    ),
);

async function psql(sql: string): Promise<string> {
    const { stdout } = await execFileAsync(
        "psql",
        [databaseUrl!, "-v", "ON_ERROR_STOP=1", "-At", "-c", sql],
        { maxBuffer: 1024 * 1024 },
    );
    return stdout.trim();
}

maybeDescribe("governed BYOK credential allocation in PostgreSQL", () => {
    beforeAll(async () => {
        await psql(`
            DROP TABLE IF EXISTS public.chats CASCADE;
            DROP TABLE IF EXISTS public.user_api_keys CASCADE;
            CREATE TABLE public.user_api_keys (
                user_id text NOT NULL,
                provider text NOT NULL,
                encrypted_key text NOT NULL,
                iv text NOT NULL,
                auth_tag text NOT NULL,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now(),
                CONSTRAINT user_api_keys_provider_check
                    CHECK (provider IN ('claude', 'gemini', 'openai', 'openrouter')),
                CONSTRAINT user_api_keys_user_provider_key UNIQUE (user_id, provider)
            );
            CREATE TABLE public.chats (id text PRIMARY KEY);
        `);
        await execFileAsync(
            "psql",
            [databaseUrl!, "-v", "ON_ERROR_STOP=1", "-f", migrationPath],
            { maxBuffer: 1024 * 1024 },
        );
    });

    it("assigns one monotonic credential reference per concurrent replacement", async () => {
        const replace = (index: number) =>
            psql(`
                INSERT INTO public.user_api_keys (
                    user_id, provider, encrypted_key, iv, auth_tag, enabled
                ) VALUES (
                    'user-1', 'deepseek', 'cipher-${index}', 'iv-${index}', 'tag-${index}', true
                )
                ON CONFLICT (user_id, provider) DO UPDATE SET
                    encrypted_key = excluded.encrypted_key,
                    iv = excluded.iv,
                    auth_tag = excluded.auth_tag,
                    enabled = true,
                    updated_at = now();
            `);

        await replace(0);
        await Promise.all(Array.from({ length: 10 }, (_, index) => replace(index + 1)));

        await expect(
            psql(`
                SELECT version::text || '|' || credential_ref
                FROM public.user_api_keys
                WHERE user_id = 'user-1' AND provider = 'deepseek';
            `),
        ).resolves.toBe("11|deepseek:v11");
    });
});
