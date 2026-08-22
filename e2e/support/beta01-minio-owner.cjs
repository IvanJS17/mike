"use strict";
//
// Beta 0.1 — MinIO container ownership (Gate 1, fix 3).
//
// Decides, BEFORE mutating anything, whether the `beta01-minio` container
// belongs to THIS smoke run:
//
//   container absent
//     -> this run CREATES it with fixture/owner/run labels, records the exact
//        container ID and MINIO_STARTED=yes; teardown removes ONLY that ID and
//        verifies it disappeared;
//   container present, running, healthy, label com.mike.beta01.fixture=true
//     -> this run REUSES it (MINIO_STARTED=no) and never stops/removes/alters
//        its lifecycle; teardown verifies the SAME ID and running state;
//   container present but unlabeled, stopped/unhealthy, or the ID changed
//   while this run was active
//     -> FAIL before using/cleaning; never touched.
//
// Docker interactions go through an injectable
// `exec(argv) -> { status, stdout, stderr }` so the contractual test
// (scripts/test-beta01-minio-owner.sh) runs this exact module against an
// in-memory Docker fake with ZERO network.
//
// CLI (used by scripts/e2e-beta01-setup-smoke.sh); stdout carries ONLY JSON:
//   node beta01-minio-owner.cjs --snapshot [--state-file F] [--run-id R]
//   node beta01-minio-owner.cjs --start IMAGE [--state-file F]
//   node beta01-minio-owner.cjs --verify [--state-file F]
//   node beta01-minio-owner.cjs --cleanup [--state-file F]

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");

const NAME = "beta01-minio";
const FIXTURE_LABEL = "com.mike.beta01.fixture";
const OWNER_LABEL = "com.mike.beta01.owner";
const RUN_LABEL = "com.mike.beta01.run";
const DEFAULT_OWNER = "beta01-smoke";
const FIXTURE_LABEL_VALUE = "true";

function realDocker(args) {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  return {
    status: result.status === null ? 1 : result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function firstLine(text) {
  return String(text || "").trim().split("\n")[0] || "";
}

class MinioOwnership {
  constructor(options = {}) {
    this.exec = options.exec || realDocker;
    this.name = options.name || NAME;
    this.owner = options.owner || DEFAULT_OWNER;
    this.runId = options.runId || "";
    this.statePath = options.statePath || null;
    this.state = null;
  }

  // Opens the persisted state when the CLI passes --state-file between
  // snapshot/start/verify/cleanup calls (each CLI invocation is a fresh
  // instance and MUST NOT revisit the decision it already made).
  ensureState() {
    if (this.state !== null || !this.statePath) return;
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
    } catch (err) {
      // Sin estado válido no hay prueba de ownership: nunca se elimina nada.
      parsed = null;
    }
    this.state = parsed;
  }

  saveState() {
    if (!this.statePath) return;
    const tmp = `${this.statePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2) + "\n");
    fs.renameSync(tmp, this.statePath);
  }

  // Result of `docker container inspect <name>`:
  //   null            -> the container does not exist
  //   { id, running, health, labels }
  // health is null when the image has no HEALTHCHECK (MinIO image does not);
  // in that case "healthy" means simply "running".
  async inspect(name) {
    const r = await this.exec(["container", "inspect", name]);
    if (r.status === 0) {
      let parsed;
      try {
        parsed = JSON.parse(r.stdout || "");
      } catch (err) {
        throw new Error(`docker inspect returned invalid JSON: ${firstLine(r.stdout)}`);
      }
      const obj = parsed && parsed[0];
      if (!obj) return null;
      return {
        id: typeof obj.Id === "string" ? obj.Id : "",
        running: Boolean(obj.State && obj.State.Running),
        health:
          obj.State && obj.State.Health && obj.State.Health.Status
            ? obj.State.Health.Status
            : null,
        labels: obj.Config && obj.Config.Labels ? obj.Config.Labels : {},
      };
    }
    if (/No such object/.test(r.stderr || "")) return null;
    throw new Error(`docker inspect failed (status ${r.status}): ${firstLine(r.stderr)}`);
  }

  isLabeled(info) {
    return info.labels[FIXTURE_LABEL] === FIXTURE_LABEL_VALUE;
  }

  isHealthy(info) {
    return info.health === null ? info.running : info.health === "healthy";
  }

  isReusable(info) {
    return this.isLabeled(info) && info.running && this.isHealthy(info);
  }

  // Decision BEFORE any mutation. Writes the ownership state file.
  async snapshot() {
    const info = await this.inspect(this.name);
    if (info === null) {
      this.state = {
        name: this.name,
        mode: "create",
        started: "no",
        createdId: null,
        preexistingId: null,
        preexistingRunning: null,
        preexistingHealthy: null,
        preexistingLabeled: null,
        owner: this.owner,
        runId: this.runId,
        reason: null,
      };
      this.saveState();
      return { mode: "create" };
    }

    const labeled = this.isLabeled(info);
    const healthy = this.isHealthy(info);
    if (!this.isReusable(info)) {
      const problems = [];
      if (!labeled) problems.push("sin label com.mike.beta01.fixture=true");
      if (!info.running) problems.push("no está running");
      if (!healthy) problems.push(`unhealthy (docker health=${info.health || "none"})`);
      this.state = {
        name: this.name,
        mode: "fail",
        started: "no",
        createdId: null,
        preexistingId: info.id,
        preexistingRunning: info.running,
        preexistingHealthy: healthy,
        preexistingLabeled: labeled,
        owner: this.owner,
        runId: this.runId,
        reason: `preexistente ${problems.join(", ")}`,
      };
      this.saveState();
      return { mode: "fail", reason: this.state.reason };
    }

    this.state = {
      name: this.name,
      mode: "reuse",
      started: "no",
      createdId: null,
      preexistingId: info.id,
      preexistingRunning: info.running,
      preexistingHealthy: healthy,
      preexistingLabeled: true,
      owner: this.owner,
      runId: this.runId,
      reason: null,
    };
    this.saveState();
    return { mode: "reuse", id: info.id };
  }

  // Create the container ONLY when the snapshot decided mode=create. Labels
  // fixture/owner/run identify ownership; the exact ID is captured afterwards
  // (never the name, which can be hijacked between run and inspect).
  async create(image) {
    this.ensureState();
    if (!this.state || this.state.mode !== "create") {
      throw new Error("create() requires a snapshot that decided mode=create");
    }
    const r = await this.exec([
      "run",
      "-d",
      "--name",
      this.name,
      "-p",
      "9000:9000",
      "-e",
      "MINIO_ROOT_USER=minioadmin",
      "-e",
      "MINIO_ROOT_PASSWORD=minioadmin",
      "--label",
      `${FIXTURE_LABEL}=${FIXTURE_LABEL_VALUE}`,
      "--label",
      `${OWNER_LABEL}=${this.owner}`,
      "--label",
      `${RUN_LABEL}=${this.runId}`,
      image,
      "server",
      "/data",
    ]);
    if (r.status !== 0) {
      // docker run failed (e.g. name raced in by someone else or a partial
      // create left a container behind). Adopt ONLY what provably carries our
      // fixture+owner labels — a stranger's container is never deleted.
      const after = await this.inspect(this.name);
      if (
        after !== null &&
        after.labels[FIXTURE_LABEL] === FIXTURE_LABEL_VALUE &&
        after.labels[OWNER_LABEL] === this.owner
      ) {
        this.state.createdId = after.id;
        this.state.started = "yes";
        this.saveState();
      }
      throw new Error(`docker run failed (status ${r.status}): ${firstLine(r.stderr)}`);
    }
    const info = await this.inspect(this.name);
    if (info === null) {
      throw new Error("container reported created but docker inspect cannot find it");
    }
    this.state.createdId = info.id;
    this.state.started = "yes";
    this.saveState();
    return { id: info.id };
  }

  // Reuse path: re-validates BEFORE use that the preexisting container is
  // still the same object (same ID), running and healthy. Any drift -> fail
  // without touching anything.
  async verify() {
    this.ensureState();
    if (!this.state || this.state.mode !== "reuse") {
      throw new Error("verify() requires a snapshot that decided mode=reuse");
    }
    const info = await this.inspect(this.name);
    if (info === null) {
      return { ok: false, reason: "preexistente desapareció antes de usarse" };
    }
    if (info.id !== this.state.preexistingId) {
      return {
        ok: false,
        reason: `ID del preexistente cambió (snapshot=${this.state.preexistingId}, actual=${info.id})`,
      };
    }
    if (!this.isReusable(info)) {
      return { ok: false, reason: "preexistente dejó de estar running/healthy con label de fixture" };
    }
    return { ok: true, id: info.id };
  }

  // Teardown contract:
  //   - created container  -> removed ONLY when its current ID is still the
  //     recorded one; then verified gone. ID race -> FAIL without deleting.
  //   - preexisting        -> verified same ID and still running; never
  //     stopped/removed. Drift -> FAIL without touching.
  //   - failed decision    -> never touched (verified intact).
  //   - no state           -> nothing owned by this run; nothing deleted.
  async cleanup() {
    this.ensureState();
    if (!this.state) {
      return { ok: true, note: "sin estado de ownership — no se elimina nada" };
    }

    if (this.state.mode === "create") {
      if (this.state.started !== "yes") {
        return { ok: true, note: "nunca se creó contenedor — nada que eliminar" };
      }
      const info = await this.inspect(this.name);
      if (info === null) {
        return {
          ok: true,
          note: `contenedor creado (${this.state.createdId}) ya no existe — verificado`,
        };
      }
      if (info.id !== this.state.createdId) {
        return {
          ok: false,
          reason: `ID race: el contenedor actual (${info.id}) NO es el creado por esta corrida (${this.state.createdId}) — no se borra`,
        };
      }
      const rm = await this.exec(["rm", "-f", info.id]);
      if (rm.status !== 0) {
        return {
          ok: false,
          reason: `docker rm -f falló (status ${rm.status}): ${firstLine(rm.stderr)}`,
        };
      }
      const after = await this.inspect(this.name);
      if (after !== null) {
        return { ok: false, reason: "tras docker rm -f el contenedor aún existe" };
      }
      return { ok: true, note: `contenedor creado eliminado (${info.id}) y verificado` };
    }

    if (this.state.mode === "reuse") {
      const info = await this.inspect(this.name);
      if (info === null) {
        return { ok: false, reason: "preexistente desapareció durante la corrida" };
      }
      if (info.id !== this.state.preexistingId) {
        return {
          ok: false,
          reason: `ID del preexistente cambió durante la corrida (snapshot=${this.state.preexistingId}, actual=${info.id}) — sin tocar`,
        };
      }
      if (!info.running) {
        return { ok: false, reason: "preexistente ya no está running durante la corrida" };
      }
      return {
        ok: true,
        note: `preexistente preservado (${info.id}, running, nunca detenido/eliminado)`,
      };
    }

    if (this.state.mode === "fail") {
      const info = await this.inspect(this.name);
      if (info === null) {
        return { ok: true, note: "fail-mode: no se tocó nada (contenedor no presente)" };
      }
      return { ok: true, note: `fail-mode: no se tocó nada (${info.id} intacto)` };
    }

    return { ok: true, note: "modo de estado desconocido — no se elimina nada" };
  }
}

// ---------------------------------------------------------------------------
// CLI surface (stdout carries ONLY JSON; diagnostics go to stderr so the
// runner can tee them into its log file).
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = {
    command: null,
    image: null,
    stateFile: null,
    runId: "",
    owner: DEFAULT_OWNER,
    name: NAME,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--snapshot") opts.command = "snapshot";
    else if (arg === "--start") {
      opts.command = "start";
      opts.image = argv[i + 1] || null;
      i += 1;
    } else if (arg === "--verify") opts.command = "verify";
    else if (arg === "--cleanup") opts.command = "cleanup";
    else if (arg === "--state-file") {
      opts.stateFile = argv[i + 1] || null;
      i += 1;
    } else if (arg === "--run-id") {
      opts.runId = argv[i + 1] || "";
      i += 1;
    } else if (arg === "--owner") {
      opts.owner = argv[i + 1] || DEFAULT_OWNER;
      i += 1;
    } else if (arg === "--name") {
      opts.name = argv[i + 1] || NAME;
      i += 1;
    } else {
      throw new Error(`argumento desconocido: ${arg}`);
    }
  }
  if (opts.command === null) throw new Error("falta comando (--snapshot|--start|--verify|--cleanup)");
  if (opts.command === "start" && !opts.image) throw new Error("--start requiere IMAGE");
  return opts;
}

function runCli(argv, execOverride) {
  const opts = parseArgs(argv);
  const ownership = new MinioOwnership({
    exec: execOverride || realDocker,
    name: opts.name,
    owner: opts.owner,
    runId: opts.runId,
    statePath: opts.stateFile,
  });

  if (opts.command === "snapshot") {
    return ownership
      .snapshot()
      .then((out) => ({ exitCode: 0, output: out }))
      .catch((err) => ({ exitCode: 1, output: { error: err.message } }));
  }
  if (opts.command === "start") {
    return ownership
      .create(opts.image)
      .then((out) => ({ exitCode: 0, output: out }))
      .catch((err) => ({ exitCode: 1, output: { error: err.message } }));
  }
  if (opts.command === "verify") {
    return ownership
      .verify()
      .then((out) => ({ exitCode: out.ok ? 0 : 1, output: out }))
      .catch((err) => ({ exitCode: 1, output: { error: err.message } }));
  }
  if (opts.command === "cleanup") {
    return ownership
      .cleanup()
      .then((out) => ({ exitCode: out.ok ? 0 : 1, output: out }))
      .catch((err) => ({ exitCode: 1, output: { error: err.message } }));
  }
  return Promise.resolve({ exitCode: 1, output: { error: "comando no soportado" } });
}

function main(argv) {
  let result;
  try {
    result = runCli(argv);
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: err.message }) + "\n");
    process.exitCode = 1;
    return;
  }
  result.then((done) => {
    process.stdout.write(JSON.stringify(done.output) + "\n");
    if (done.exitCode !== 0) process.exitCode = done.exitCode;
  });
}

module.exports = { MinioOwnership, runCli, NAME, FIXTURE_LABEL, OWNER_LABEL, RUN_LABEL };

if (require.main === module) main(process.argv.slice(2));