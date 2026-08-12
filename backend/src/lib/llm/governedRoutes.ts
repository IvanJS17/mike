import { createServerSupabase } from "../supabase";
import {
    resolveUserLlmCredential,
    type LlmApiKeyProvider,
} from "../userApiKeys";
import {
    parseModelRoute,
    validateModelRoute,
    type ModelRoute,
} from "./routes";

type Db = ReturnType<typeof createServerSupabase>;

export type RouteResolution =
    | {
          ok: true;
          route: ModelRoute;
          credentialSecret: string;
      }
    | {
          ok: false;
          code: "invalid_route" | "unsupported_model" | "credential_unavailable";
          detail: string;
      };

export async function resolveModelRouteForUser(
    userId: string,
    route: ModelRoute,
    db: Db = createServerSupabase(),
): Promise<RouteResolution> {
    const validation = validateModelRoute(route);
    if (!validation.ok) {
        return {
            ok: false,
            code: "unsupported_model",
            detail: validation.detail,
        };
    }

    const credential = await resolveUserLlmCredential(
        userId,
        route.provider as LlmApiKeyProvider,
        route.credential_ref,
        db,
    );
    if (!credential) {
        return {
            ok: false,
            code: "credential_unavailable",
            detail: "The pinned model credential is unavailable",
        };
    }
    return {
        ok: true,
        route,
        credentialSecret: credential.secret,
    };
}

export function pinnedRouteFromChatRow(
    row: Record<string, unknown>,
): ModelRoute | null {
    const parsed = parseModelRoute({
        provider: row.model_provider,
        model: row.model,
        credential_ref: row.credential_ref,
    });
    if (!parsed.ok) return null;
    return validateModelRoute(parsed.value).ok ? parsed.value : null;
}
