/**
 * Tiny zero-dependency structured logger. Every call emits one JSON
 * line to stdout/stderr, which is the shape any log aggregator (CW
 * Logs, Loki, Datadog) is happy to ingest. Fields are merged into the
 * top-level object so a query like `{level=error route=/chat err_msg=*}`
 * works without parsing message strings.
 *
 * We didn't pull in pino because we only need ~30 lines, and adding a
 * dep + a bunch of transport configuration is overkill for the current
 * single-process backend. If the project grows into multi-process or
 * async transports, replace the body of this file with pino — the
 * call sites won't have to change.
 */

import { safeErrorLog, redactSensitiveText } from "./safeError";

type LogLevel = "debug" | "info" | "warn" | "error";

type Fields = Record<string, unknown>;

const LEVEL_RANK: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};

function resolveMinLevel(): LogLevel {
    const raw = (process.env.LOG_LEVEL ?? "").toLowerCase();
    if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error")
        return raw;
    return process.env.NODE_ENV === "production" ? "info" : "debug";
}

// NOTE: the minimum level is resolved lazily on every emit rather than
// frozen at module load. Freezing at import time makes LOG_LEVEL
// untestable (the first `import` in a test process wins forever) and
// prevents runtime reconfiguration; the env lookup is negligible next to
// the JSON.stringify + write we already do per line.

/**
 * Serialize an unknown thrown value into flat log fields. This wraps
 * `safeErrorLog` from ./safeError so that provider API keys and other
 * secrets that routinely appear in upstream error text (e.g.
 * "Incorrect API key provided: sk-ant-…") are redacted before they ever
 * reach the log stream. We must NEVER emit raw `err.message`/`err.stack`.
 *
 * It is also throw-proof: `safeErrorLog` runs user-supplied getters
 * (an Error subclass can override `.message`/`.stack` with a throwing
 * getter) and this function is called from inside `catch` blocks of
 * async handlers, where a throw becomes a process-fatal unhandled
 * rejection. Any failure degrades to a marker rather than propagating.
 */
function serializeError(err: unknown): Fields {
    try {
        const safe = safeErrorLog(err);
        const fields: Fields = {
            err_name: safe.name,
            err_msg: safe.message,
        };
        if (safe.stack !== undefined) fields.err_stack = safe.stack;
        return fields;
    } catch {
        return { err_msg: "[unserializable error]" };
    }
}

/**
 * `JSON.stringify` throws on circular references and on BigInt values.
 * Because `emit` is reached from `catch` blocks in async request
 * handlers, an uncaught throw here becomes an unhandled rejection and
 * can take the process down. We first try a plain stringify, then fall
 * back to a stringify that drops cycles and coerces BigInt, and finally
 * to a static marker so logging can never crash the caller.
 */
function safeStringify(value: unknown): string {
    try {
        return JSON.stringify(value);
    } catch {
        // fall through to the cycle-safe path
    }
    try {
        const seen = new WeakSet<object>();
        return JSON.stringify(value, (_key, val) => {
            if (typeof val === "bigint") return `${val.toString()}n`;
            if (typeof val === "object" && val !== null) {
                if (seen.has(val)) return "[circular]";
                seen.add(val);
            }
            return val;
        });
    } catch {
        return '{"level":"error","msg":"[unserializable log line]"}';
    }
}

function emit(level: LogLevel, fields: Fields, msg?: string) {
    if (LEVEL_RANK[level] < LEVEL_RANK[resolveMinLevel()]) return;
    const merged: Fields = {
        ts: new Date().toISOString(),
        level,
        ...fields,
    };
    if (msg !== undefined) merged.msg = msg;
    const line = safeStringify(merged);
    if (level === "error" || level === "warn") {
        process.stderr.write(line + "\n");
    } else {
        process.stdout.write(line + "\n");
    }
}

export type Logger = {
    debug(fields: Fields, msg?: string): void;
    info(fields: Fields, msg?: string): void;
    warn(fields: Fields, msg?: string): void;
    error(fields: Fields, msg?: string): void;
    /** Returns a child logger that prefixes every event with `fields`. */
    child(fields: Fields): Logger;
};

function make(baseFields: Fields): Logger {
    return {
        debug: (fields, msg) => emit("debug", { ...baseFields, ...fields }, msg),
        info: (fields, msg) => emit("info", { ...baseFields, ...fields }, msg),
        warn: (fields, msg) => emit("warn", { ...baseFields, ...fields }, msg),
        error: (fields, msg) => emit("error", { ...baseFields, ...fields }, msg),
        child: (fields) => make({ ...baseFields, ...fields }),
    };
}

export const logger: Logger = make({});

/**
 * Helper for `catch (err)` blocks. Returns redacted, throw-proof fields
 * (see `serializeError`). Exported for use at call sites that build
 * their own field object, e.g.
 * `log.error({ route: "chat/stream", ...errFields(err) }, "stream error")`.
 */
export function errFields(err: unknown): Fields {
    return serializeError(err);
}

/** Re-exported for callers/tests that want the raw redaction primitive. */
export { redactSensitiveText };
