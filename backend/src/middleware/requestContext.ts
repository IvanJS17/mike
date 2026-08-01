import { randomUUID } from "crypto";
import type { NextFunction, Request, Response } from "express";
import { logger, type Logger } from "../lib/logger";

/**
 * Type the request-scoped values we stash on `res.locals` via declaration
 * merging so call sites can read `res.locals.log` / `res.locals.requestId`
 * without per-site `as` casts. See F7 in the PR #156 review.
 */
declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Locals {
            log?: Logger;
            requestId?: string;
        }
    }
}

// Inbound X-Request-Id is attacker-controllable. We already bound the
// length, but an unbounded charset lets a caller inject arbitrary bytes
// that end up in the access log's `request_id` field (JSON.stringify keeps
// framing safe, but control chars / lookalikes still pollute logs and can
// confuse downstream tooling). Restrict to a conservative id charset and
// regenerate anything that doesn't match.
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * The route to record in the access line.
 *
 * - When Express matched a route, we use `req.baseUrl + req.route.path`.
 *   `req.route.path` alone is router-relative ("/" for POST /chat, ":token"
 *   for the downloads router) which loses the mount; prefixing `baseUrl`
 *   restores the full path pattern. Because we use the pattern
 *   (`/download/:token`), the actual signed token value never lands in logs.
 * - When nothing matched (404, or a 429 short-circuited by the rate limiter
 *   before the router), we fall back to `req.path` — the pathname only.
 *   Crucially this is NOT `req.originalUrl`, so query-string secrets
 *   (e.g. `?token=…`) are stripped and can't leak. See F5 in the review.
 */
function accessRoute(req: Request): string {
    const routePath = req.route?.path;
    if (typeof routePath === "string") {
        return `${req.baseUrl}${routePath}`;
    }
    return req.path;
}

/**
 * Adds a per-request id, an access log line on response close, and a
 * request-scoped logger on `res.locals.log`. The id is taken from the
 * inbound `X-Request-Id` header when present (and well-formed) so it can
 * stitch with upstream traces; otherwise a UUID is generated. It's echoed
 * back on the response so a curl user can grep their request out of the logs.
 */
export function requestContext() {
    return (req: Request, res: Response, next: NextFunction) => {
        const inbound = req.header("x-request-id");
        const requestId =
            inbound && REQUEST_ID_RE.test(inbound) ? inbound : randomUUID();
        res.setHeader("X-Request-Id", requestId);

        const startNs = process.hrtime.bigint();
        const reqLog = logger.child({ request_id: requestId });
        res.locals.requestId = requestId;
        res.locals.log = reqLog;

        res.on("close", () => {
            const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1e6;

            // `res.writableFinished` is false when the socket closed before
            // the full response was flushed — i.e. the client hung up mid
            // response (SSE window.stop(), curl ^C). Record it nginx-style as
            // status 499 + aborted:true so these are distinguishable from a
            // clean 200. See F4 in the review.
            const aborted = res.writableFinished === false;
            const status = aborted ? 499 : res.statusCode;

            const fields = {
                method: req.method,
                route: accessRoute(req),
                status,
                elapsed_ms: Math.round(elapsedMs),
                aborted,
                user_id: (res.locals.userId as string | undefined) ?? null,
            };

            // Health checks are polled frequently and carry no useful signal;
            // demote them to debug so they're suppressed at the default prod
            // level (info) but still visible when LOG_LEVEL=debug. See F9.
            if (req.path === "/health") {
                reqLog.debug(fields, "request");
            } else {
                reqLog.info(fields, "request");
            }
        });

        next();
    };
}
