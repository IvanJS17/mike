import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { authHeaders } from "../lib/llm/ollama";
import { buildModelCatalog } from "../lib/llm/catalog";
import { listUserLlmCredentials } from "../lib/userApiKeys";

export const modelsRouter = Router();

// Authenticated catalog of routes backed by this user's current credentials.
// Catalog presence is informational only; a route is not marked as exercised
// until a substantive call succeeds.
modelsRouter.get("/catalog", requireAuth, async (_req, res) => {
    const userId = res.locals.userId as string;
    try {
        const credentials = await listUserLlmCredentials(userId);
        res.json(await buildModelCatalog(credentials));
    } catch {
        console.error("[models/catalog] failed");
        res.status(500).json({ detail: "Failed to load model catalog" });
    }
});

// Live list of locally installed Ollama models, shaped like the frontend's
// ModelOption. Returns [] when Ollama is unreachable so the app still works.
modelsRouter.get("/ollama", requireAuth, async (_req, res) => {
    const base = (
        process.env.OLLAMA_BASE_URL?.trim() || "http://localhost:11434/v1"
    ).replace(/\/$/, "");
    try {
        const r = await fetch(`${base}/models`, { headers: authHeaders() });
        if (!r.ok) return void res.json({ models: [] });
        const data = (await r.json()) as { data?: { id: string }[] };
        const models = (data.data ?? []).map((m) => ({
            id: `ollama/${m.id}`,
            label: `${m.id} (local)`,
            group: "Local",
        }));
        res.json({ models });
    } catch {
        res.json({ models: [] });
    }
});
