import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { logger, errFields } from "../logger";

// ---------------------------------------------------------------------------
// Test harness: capture the JSON lines the logger writes to stdout/stderr.
//
// We spy on process.{stdout,stderr}.write instead of resetting modules for
// each case because emit() resolves the minimum level lazily (see logger.ts) —
// so LOG_LEVEL / NODE_ENV set here take effect on the singleton `logger`
// without a fresh import.
// ---------------------------------------------------------------------------

let out: string[];
let err: string[];
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
const savedEnv = { ...process.env };

beforeEach(() => {
    out = [];
    err = [];
    stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk: unknown) => {
            out.push(String(chunk));
            return true;
        });
    stderrSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation((chunk: unknown) => {
            err.push(String(chunk));
            return true;
        });
    delete process.env.LOG_LEVEL;
    delete process.env.NODE_ENV;
});

afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    process.env = { ...savedEnv };
});

function parse(lines: string[]): Record<string, unknown>[] {
    return lines.map((l) => JSON.parse(l.trimEnd()));
}

// ---------------------------------------------------------------------------
// Level filtering + defaults
// ---------------------------------------------------------------------------

describe("level filtering", () => {
    it("suppresses events below the explicit LOG_LEVEL", () => {
        process.env.LOG_LEVEL = "warn";
        logger.debug({ a: 1 }, "d");
        logger.info({ a: 1 }, "i");
        logger.warn({ a: 1 }, "w");
        logger.error({ a: 1 }, "e");
        expect(out).toHaveLength(0); // debug + info suppressed
        expect(parse(err).map((l) => l.msg)).toEqual(["w", "e"]);
    });

    it("defaults to info in production (debug suppressed)", () => {
        process.env.NODE_ENV = "production";
        logger.debug({}, "d");
        logger.info({}, "i");
        expect(out).toHaveLength(1);
        expect(parse(out)[0].msg).toBe("i");
    });

    it("defaults to debug outside production", () => {
        // NODE_ENV + LOG_LEVEL both unset in beforeEach.
        logger.debug({}, "d");
        expect(parse(out)[0].msg).toBe("d");
    });

    it("ignores an unrecognized LOG_LEVEL and uses the default", () => {
        process.env.LOG_LEVEL = "banana";
        process.env.NODE_ENV = "production";
        logger.debug({}, "d");
        logger.info({}, "i");
        expect(parse(out).map((l) => l.msg)).toEqual(["i"]);
    });
});

// ---------------------------------------------------------------------------
// stdout vs stderr split
// ---------------------------------------------------------------------------

describe("stream routing", () => {
    it("writes info/debug to stdout and warn/error to stderr", () => {
        process.env.LOG_LEVEL = "debug";
        logger.debug({}, "d");
        logger.info({}, "i");
        logger.warn({}, "w");
        logger.error({}, "e");
        expect(parse(out).map((l) => l.msg)).toEqual(["d", "i"]);
        expect(parse(err).map((l) => l.msg)).toEqual(["w", "e"]);
    });

    it("stamps ts + level on every line", () => {
        logger.info({ route: "/x" }, "hi");
        const line = parse(out)[0];
        expect(line.level).toBe("info");
        expect(typeof line.ts).toBe("string");
        expect(line.route).toBe("/x");
        expect(line.msg).toBe("hi");
    });
});

// ---------------------------------------------------------------------------
// child() merge + precedence
// ---------------------------------------------------------------------------

describe("child()", () => {
    it("merges base fields into every event", () => {
        const child = logger.child({ request_id: "abc" });
        child.info({ route: "/chat" }, "req");
        const line = parse(out)[0];
        expect(line.request_id).toBe("abc");
        expect(line.route).toBe("/chat");
    });

    it("lets call-site fields override base fields", () => {
        const child = logger.child({ route: "base" });
        child.info({ route: "override" }, "req");
        expect(parse(out)[0].route).toBe("override");
    });

    it("supports nested children with accumulated fields", () => {
        logger.child({ a: 1 }).child({ b: 2 }).info({ c: 3 }, "m");
        const line = parse(out)[0];
        expect(line).toMatchObject({ a: 1, b: 2, c: 3 });
    });
});

// ---------------------------------------------------------------------------
// F2 — errFields redacts provider keys (never emits raw message/stack)
// ---------------------------------------------------------------------------

describe("errFields redaction (F2)", () => {
    it("redacts an Anthropic key in the error message", () => {
        const fields = errFields(
            new Error("Incorrect API key provided: sk-ant-api03-abcdef123456"),
        );
        expect(fields.err_msg).not.toContain("sk-ant-api03-abcdef123456");
        expect(String(fields.err_msg)).toContain("[redacted]");
    });

    it("redacts a bare OpenAI key anywhere in the message", () => {
        const fields = errFields(new Error("boom sk-abc123def456ghi789 boom"));
        expect(fields.err_msg).toBe("boom [redacted] boom");
    });

    it("redacts secrets in the stack trace too", () => {
        const fields = errFields(new Error("bad AIzaSyA1234567890abcdefghij"));
        expect(String(fields.err_stack)).not.toContain(
            "AIzaSyA1234567890abcdefghij",
        );
    });

    it("emits redacted fields end-to-end through logger.error", () => {
        logger.error(
            { route: "chat/stream", ...errFields(new Error("sk-abc123def456ghi789")) },
            "stream error",
        );
        const raw = err.join("");
        expect(raw).not.toContain("sk-abc123def456ghi789");
        expect(raw).toContain("[redacted]");
    });
});

// ---------------------------------------------------------------------------
// F3 — logger + errFields are throw-proof (they run inside catch blocks of
// async handlers; a throw becomes a process-fatal unhandled rejection).
// ---------------------------------------------------------------------------

describe("throw-proofing (F3)", () => {
    it("errFields does not throw on a BigInt value", () => {
        expect(() => errFields(10n)).not.toThrow();
    });

    it("errFields does not throw on a circular object", () => {
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        expect(() => errFields(circular)).not.toThrow();
    });

    it("errFields survives an Error whose message getter throws", () => {
        class Evil extends Error {
            get message(): string {
                throw new Error("nope");
            }
        }
        let fields: Record<string, unknown> = {};
        expect(() => {
            fields = errFields(new Evil());
        }).not.toThrow();
        expect(fields.err_msg).toBe("[unserializable error]");
    });

    it("logger.info does not throw on a circular field and still writes a line", () => {
        const circular: Record<string, unknown> = { name: "loop" };
        circular.self = circular;
        expect(() => logger.info({ circular }, "cycle")).not.toThrow();
        expect(out).toHaveLength(1);
        expect(out[0]).toContain("[circular]");
    });

    it("logger.info does not throw on a BigInt field", () => {
        expect(() => logger.info({ big: 42n }, "big")).not.toThrow();
        expect(out).toHaveLength(1);
        expect(out[0]).toContain("42");
    });
});
