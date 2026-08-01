import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "events";
import type { Request, Response } from "express";
import { requestContext } from "../requestContext";

// ---------------------------------------------------------------------------
// These are true unit tests: we drive the middleware with fake req/res objects
// and fire the "close" event ourselves so we can deterministically exercise
// the abort path (F4) and route fallback (F5) without a live socket. stdout is
// spied to capture the JSON access line. LOG_LEVEL=debug ensures the /health
// (demoted, F9) line is also emitted so we can assert on it.
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
    process.env.LOG_LEVEL = "debug";
});

afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    process.env = { ...savedEnv };
});

type FakeReq = Partial<Request> & { headers: Record<string, string> };
type FakeRes = EventEmitter &
    Partial<Response> & { headers: Record<string, string> };

function makeReq(overrides: Partial<Request> = {}): Request {
    const headers: Record<string, string> = {};
    const req: FakeReq = {
        method: "GET",
        path: "/chat",
        baseUrl: "",
        originalUrl: "/chat",
        url: "/chat",
        route: undefined,
        headers,
        header(name: string) {
            return headers[name.toLowerCase()];
        },
        ...overrides,
    };
    // apply header overrides passed via `headers`
    if (overrides.headers) Object.assign(headers, overrides.headers);
    return req as unknown as Request;
}

function makeRes(): FakeRes {
    const res = new EventEmitter() as FakeRes;
    res.locals = {};
    res.statusCode = 200;
    res.writableFinished = true;
    res.headers = {};
    res.setHeader = ((name: string, value: string) => {
        res.headers[name] = value;
        return res as unknown as Response;
    }) as Response["setHeader"];
    return res;
}

function run(req: Request, res: FakeRes) {
    const next = vi.fn();
    requestContext()(req, res as unknown as Response, next);
    return next;
}

function accessLine(): Record<string, unknown> {
    // The access line is the last JSON line emitted (info→stdout / debug→stdout).
    const line = out[out.length - 1];
    return JSON.parse(line.trimEnd());
}

// ---------------------------------------------------------------------------
// X-Request-Id handling (F6)
// ---------------------------------------------------------------------------

describe("X-Request-Id", () => {
    it("generates a UUID when no inbound header is present", () => {
        const req = makeReq();
        const res = makeRes();
        run(req, res);
        const id = res.headers["X-Request-Id"];
        expect(id).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
        res.emit("close");
        expect(accessLine().request_id).toBe(id);
    });

    it("preserves and echoes a well-formed inbound id", () => {
        const req = makeReq({ headers: { "x-request-id": "trace-abc.123_ID" } });
        const res = makeRes();
        run(req, res);
        expect(res.headers["X-Request-Id"]).toBe("trace-abc.123_ID");
        res.emit("close");
        expect(accessLine().request_id).toBe("trace-abc.123_ID");
    });

    it("rejects an id with a bad charset and regenerates (F6)", () => {
        const req = makeReq({ headers: { "x-request-id": 'bad"id,{}!' } });
        const res = makeRes();
        run(req, res);
        expect(res.headers["X-Request-Id"]).not.toBe('bad"id,{}!');
        expect(res.headers["X-Request-Id"]).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("rejects an over-length id (>128 chars) and regenerates (F6)", () => {
        const long = "a".repeat(129);
        const req = makeReq({ headers: { "x-request-id": long } });
        const res = makeRes();
        run(req, res);
        expect(res.headers["X-Request-Id"]).not.toBe(long);
    });
});

// ---------------------------------------------------------------------------
// Access line shape
// ---------------------------------------------------------------------------

describe("access line", () => {
    it("logs method/route/status/elapsed_ms/user_id on close", () => {
        const req = makeReq({
            method: "POST",
            baseUrl: "/chat",
            route: { path: "/" } as Request["route"],
        });
        const res = makeRes();
        res.locals!.userId = "user-42";
        run(req, res);
        res.statusCode = 201;
        res.emit("close");
        const line = accessLine();
        expect(line).toMatchObject({
            method: "POST",
            route: "/chat/", // baseUrl(/chat) + route.path(/)
            status: 201,
            user_id: "user-42",
            msg: "request",
        });
        expect(typeof line.elapsed_ms).toBe("number");
    });

    it("prefixes baseUrl so matched routes are not router-relative (F5b)", () => {
        // POST /chat matched inside chatRouter → route.path is "/" (relative).
        const req = makeReq({
            method: "POST",
            baseUrl: "/chat",
            route: { path: "/" } as Request["route"],
        });
        const res = makeRes();
        run(req, res);
        res.emit("close");
        expect(accessLine().route).toBe("/chat/");
    });

    it("logs the route pattern (not the value) for /download/:token so tokens don't leak (F5)", () => {
        const req = makeReq({
            method: "GET",
            baseUrl: "/download",
            path: "/download/SECRET-TOKEN-xyz",
            originalUrl: "/download/SECRET-TOKEN-xyz",
            route: { path: "/:token" } as Request["route"],
        });
        const res = makeRes();
        run(req, res);
        res.emit("close");
        const raw = JSON.stringify(accessLine());
        expect(accessLine().route).toBe("/download/:token");
        expect(raw).not.toContain("SECRET-TOKEN-xyz");
    });

    it("populates user_id null when unauthenticated", () => {
        const req = makeReq();
        const res = makeRes();
        run(req, res);
        res.emit("close");
        expect(accessLine().user_id).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// F5 — unmatched-route fallback strips the query string / does not leak
// ---------------------------------------------------------------------------

describe("unmatched-route fallback (F5)", () => {
    it("uses req.path (no query string) when no route matched", () => {
        const req = makeReq({
            method: "GET",
            path: "/nonexistent/path-with-SECRET-VALUE",
            originalUrl:
                "/nonexistent/path-with-SECRET-VALUE?token=SECRET-QS-abc",
            route: undefined,
        });
        const res = makeRes();
        res.statusCode = 404;
        run(req, res);
        res.emit("close");
        const line = accessLine();
        const raw = JSON.stringify(line);
        expect(line.route).toBe("/nonexistent/path-with-SECRET-VALUE");
        expect(raw).not.toContain("SECRET-QS-abc");
        expect(raw).not.toContain("?token=");
    });

    it("does not leak a query secret on a 429 before the router", () => {
        const req = makeReq({
            method: "POST",
            path: "/chat",
            originalUrl: "/chat?token=SECRET-QS-abc",
            route: undefined,
        });
        const res = makeRes();
        res.statusCode = 429;
        run(req, res);
        res.emit("close");
        const raw = JSON.stringify(accessLine());
        expect(raw).not.toContain("SECRET-QS-abc");
        expect(accessLine().status).toBe(429);
    });
});

// ---------------------------------------------------------------------------
// F4 — abort / 499 detection
// ---------------------------------------------------------------------------

describe("client abort detection (F4)", () => {
    it("logs aborted:true and status 499 when the response did not finish", () => {
        const req = makeReq({ method: "POST", baseUrl: "/chat", route: { path: "/" } as Request["route"] });
        const res = makeRes();
        res.statusCode = 200; // handler set 200 but client hung up
        res.writableFinished = false;
        run(req, res);
        res.emit("close");
        const line = accessLine();
        expect(line.aborted).toBe(true);
        expect(line.status).toBe(499);
    });

    it("logs aborted:false and the real status on a clean finish", () => {
        const req = makeReq();
        const res = makeRes();
        res.writableFinished = true;
        run(req, res);
        res.emit("close");
        const line = accessLine();
        expect(line.aborted).toBe(false);
        expect(line.status).toBe(200);
    });
});

// ---------------------------------------------------------------------------
// F9 — /health access logging is demoted to debug
// ---------------------------------------------------------------------------

describe("/health demotion (F9)", () => {
    it("logs /health at debug level (suppressed at prod default)", () => {
        const req = makeReq({ method: "GET", path: "/health" });
        const res = makeRes();
        run(req, res);
        res.emit("close");
        expect(accessLine().level).toBe("debug");
    });

    it("suppresses the /health line entirely at info level", () => {
        process.env.LOG_LEVEL = "info";
        const req = makeReq({ method: "GET", path: "/health" });
        const res = makeRes();
        run(req, res);
        res.emit("close");
        expect(out).toHaveLength(0);
    });
});
