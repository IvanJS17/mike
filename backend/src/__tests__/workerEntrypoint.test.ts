import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// `node dist/worker.js` is the documented standalone-worker topology
// (WORKERS_MODE=none on the API, workers on their own container). Everything
// startAllWorkers() creates is deliberately unref'd — it has to be, because
// the same code runs inside the API process — and a signal handler is not a
// handle, so without one ref'd handle of its own the entrypoint starts the
// runner, logs "running", and exits immediately. In Redis mode BullMQ's open
// sockets hide this; in Postgres mode (the default transport) nothing does.
//
// This spawns the real entrypoint against a Supabase URL that does not answer
// — the runner logs claim failures and keeps polling, which is exactly the
// behaviour under test — and asserts it is still alive a second later.
//
// The entrypoint runs as a single Node process with the same loader hooks the
// tsx CLI installs, NOT through `tsx/dist/cli.mjs`: that launcher spawns the
// worker as a *grandchild*, so killing the launcher left the worker running
// forever (adopted by the init system, still polling). spawnWorker() spawns
// the worker in its own process group, stopWorker() always signals the whole
// group, waits for termination and escalates SIGTERM -> SIGKILL, and the
// afterEach net below (which vitest runs even after a failed or timed-out
// test) terminates anything a test spawned and proves no descendant survived.
const backendRoot = path.resolve(__dirname, "../..");
const ALIVE_AFTER_MS = 1_500;
const EXIT_WAIT_MS = 5_000;
const POSIX = process.platform !== "win32";

const TSX_PREFLIGHT = path.join(backendRoot, "node_modules/tsx/dist/preflight.cjs");
const TSX_LOADER = pathToFileURL(path.join(backendRoot, "node_modules/tsx/dist/loader.mjs")).href;
const WORKER_ENTRYPOINT = path.join(backendRoot, "src/worker.ts");

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const hasExited = (child: ChildProcess) =>
    child.exitCode !== null || child.signalCode !== null;

const activeWorkers = new Set<ChildProcess>();

function spawnWorker(env: NodeJS.ProcessEnv, cwd: string): ChildProcess {
    const child = spawn(
        process.execPath,
        ["--require", TSX_PREFLIGHT, "--import", TSX_LOADER, WORKER_ENTRYPOINT],
        { cwd, stdio: "ignore", env, detached: POSIX },
    );
    activeWorkers.add(child);
    return child;
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
    if (child.pid === undefined) {
        return;
    }
    try {
        if (POSIX) {
            process.kill(-child.pid, signal);
        } else {
            child.kill(signal);
        }
    } catch {
        // The process (group) is already gone; the awaited exit event settles it.
    }
}

// Terminates everything this test started, and only then returns: SIGTERM
// first, SIGKILL only for what refuses to leave. Runs from a `finally` so a
// failed assertion or a timeout cannot leak the worker.
async function stopWorker(child: ChildProcess): Promise<void> {
    if (child.pid === undefined) {
        return;
    }
    const exited = new Promise<void>((resolve) => {
        if (hasExited(child)) {
            resolve();
        } else {
            child.once("exit", () => resolve());
        }
    });
    signalGroup(child, "SIGTERM");
    if (!(await Promise.race([exited.then(() => true), delay(EXIT_WAIT_MS).then(() => false)]))) {
        signalGroup(child, "SIGKILL");
        if (!(await Promise.race([exited.then(() => true), delay(EXIT_WAIT_MS).then(() => false)]))) {
            throw new Error(`worker ${child.pid} survived SIGKILL`);
        }
    }
    // Sweep: if anything else from the group outlived the worker (a stray
    // subprocess, a future launcher's child), it must not survive the test
    // either; descendantsGone() then proves the group is empty.
    signalGroup(child, "SIGKILL");
}

// Regression check: the worker's process group must be empty. If any
// descendant of the spawned process were still alive, the group would still
// exist and the probe below would find it.
async function descendantsGone(child: ChildProcess): Promise<boolean> {
    if (!POSIX || child.pid === undefined) {
        return true;
    }
    const deadline = Date.now() + 2_000;
    for (;;) {
        try {
            process.kill(-child.pid, 0);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH") {
                return true;
            }
        }
        if (Date.now() > deadline) {
            return false;
        }
        await delay(50);
    }
}

// Safety net: vitest runs afterEach even when the test failed, threw or hit
// its timeout, so no worker can outlive a test — and the empty-group check
// runs on red runs too, not only on green ones.
afterEach(async () => {
    const children = [...activeWorkers];
    activeWorkers.clear();
    for (const child of children) {
        await stopWorker(child);
        expect(
            await descendantsGone(child),
            `worker ${child.pid} left descendants behind`,
        ).toBe(true);
    }
});

describe("standalone worker entrypoint", () => {
    it("stays alive in Postgres mode instead of exiting immediately", async () => {
        const child = spawnWorker(
            {
                ...process.env,
                QUEUE_DRIVER: "postgres",
                DB_JOBS_POLL_MS: "60000",
                SUPABASE_URL: "http://127.0.0.1:9",
                SUPABASE_SECRET_KEY: "not-a-real-key",
            },
            backendRoot,
        );

        try {
            const exited = new Promise<number | null>((resolve) =>
                child.on("exit", (code) => resolve(code)),
            );
            const stillRunning = Symbol("alive");
            const outcome = await Promise.race([
                exited,
                delay(ALIVE_AFTER_MS).then(() => stillRunning),
            ]);
            expect(
                outcome,
                "the worker process exited instead of staying up to poll",
            ).toBe(stillRunning);
        } finally {
            await stopWorker(child);
        }
    }, 30_000);

    // Bare-metal deployments configure the backend through backend/.env, not
    // through a container's environment block — and the API entrypoint reads
    // it (app.ts imports dotenv/config first). The worker entrypoint must do
    // the same, or `node dist/worker.js` dies at boot on the Supabase config
    // check on exactly the installs the split topology is documented for.
    // Compose masks the gap, so this spawns the worker with NO Supabase
    // variables in the environment and only a .env file in cwd to read.
    it("reads .env from the working directory like the API entrypoint", async () => {
        const workDir = mkdtempSync(path.join(os.tmpdir(), "worker-dotenv-"));
        writeFileSync(
            path.join(workDir, ".env"),
            [
                "QUEUE_DRIVER=postgres",
                "DB_JOBS_POLL_MS=60000",
                "SUPABASE_URL=http://127.0.0.1:9",
                "SUPABASE_SECRET_KEY=not-a-real-key",
                "",
            ].join("\n"),
        );

        const env = { ...process.env };
        delete env.SUPABASE_URL;
        delete env.SUPABASE_SECRET_KEY;
        delete env.QUEUE_DRIVER;
        delete env.REDIS_URL;

        const child = spawnWorker(env, workDir);

        try {
            const exited = new Promise<number | null>((resolve) =>
                child.on("exit", (code) => resolve(code)),
            );
            const stillRunning = Symbol("alive");
            const outcome = await Promise.race([
                exited,
                delay(ALIVE_AFTER_MS).then(() => stillRunning),
            ]);
            expect(
                outcome,
                "the worker exited at boot — .env was not loaded",
            ).toBe(stillRunning);
        } finally {
            try {
                await stopWorker(child);
            } finally {
                rmSync(workDir, { recursive: true, force: true });
            }
        }
    }, 30_000);
});
