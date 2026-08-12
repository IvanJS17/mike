"use client";

import { useEffect, useMemo, useState } from "react";
import {
    getModelCatalog,
    type CatalogRoute,
    type ModelRoute,
} from "@/app/lib/mikeApi";

const PROVIDER_LABELS: Record<ModelRoute["provider"], string> = {
    openai: "OpenAI",
    claude: "Anthropic",
    gemini: "Google Gemini",
    openrouter: "OpenRouter",
    deepseek: "DeepSeek",
    "opencode-zen": "OpenCode Zen",
    "opencode-go": "OpenCode Go",
};

function routeKey(route: ModelRoute): string {
    return `${route.provider}|${route.model}|${route.credential_ref}`;
}

function routeLabel(route: ModelRoute): string {
    return `${PROVIDER_LABELS[route.provider]} · ${route.model} · ${route.credential_ref}`;
}

interface Props {
    value: ModelRoute | null;
    onChange: (route: ModelRoute) => void;
    locked: boolean;
    className?: string;
}

export function GovernedModelRouteSelect({
    value,
    onChange,
    locked,
    className = "",
}: Props) {
    const [routes, setRoutes] = useState<CatalogRoute[]>([]);
    const [loading, setLoading] = useState(!locked);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (locked) return;
        const controller = new AbortController();
        getModelCatalog()
            .then((catalog) => {
                if (!controller.signal.aborted) setRoutes(catalog.routes);
            })
            .catch(() => {
                if (!controller.signal.aborted) {
                    setRoutes([]);
                    setError("Could not load connected model routes.");
                }
            })
            .finally(() => {
                if (!controller.signal.aborted) setLoading(false);
            });
        return () => controller.abort();
    }, [locked]);

    const options = useMemo(() => {
        if (locked && value) return [value];
        return routes;
    }, [locked, routes, value]);
    const selectedKey = value ? routeKey(value) : "";

    return (
        <div className={className}>
            <select
                aria-label="Model route"
                value={selectedKey}
                disabled={locked || loading}
                onChange={(event) => {
                    const selected = routes.find(
                        (route) => routeKey(route) === event.target.value,
                    );
                    if (selected) {
                        onChange({
                            provider: selected.provider,
                            model: selected.model,
                            credential_ref: selected.credential_ref,
                        });
                    }
                }}
                className="h-8 max-w-[260px] rounded-full border border-white/70 bg-white/60 px-3 text-xs text-gray-700 shadow-sm outline-none backdrop-blur-xl disabled:cursor-not-allowed disabled:text-gray-500"
                title={
                    locked
                        ? "Fixed for this conversation"
                        : "Choose the provider, model, and credential for this conversation"
                }
            >
                {!value && (
                    <option value="">
                        {loading ? "Loading model routes…" : "Choose model route"}
                    </option>
                )}
                {options.map((route) => (
                    <option key={routeKey(route)} value={routeKey(route)}>
                        {routeLabel(route)}
                    </option>
                ))}
            </select>
            {error && (
                <p role="alert" className="mt-1 text-xs text-red-600">
                    {error} Add a key in Account → API Keys and retry.
                </p>
            )}
            {!loading && !error && !locked && routes.length === 0 && (
                <p className="mt-1 text-xs text-gray-500">
                    No connected model route is available. Add an API key first.
                </p>
            )}
        </div>
    );
}
