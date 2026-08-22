"use strict";
//
// Beta 0.1 — MinIO container ownership (Gate 1, fix 3).
//
// Decides, BEFORE mutating anything, whether the `beta01-minio` container
// belongs to THIS smoke run:
//
//   container absent
//     -> this run CREATES it with fixture/owner/run labels; state is armed
//        durably BEFORE `docker run`, then its stdout container ID becomes the
//        ONLY owned identity and is persisted as started=pending + createdId +
//        runId BEFORE any later inspect;
//        teardown inspects/removes/verifies ONLY that ID — a failed run
//        adopts or deletes NOTHING, and a substitute that took the name is
//        never touched;
//   container present, running, healthy, label com.mike.beta01.fixture=true
//     -> this run REUSES it (MINIO_STARTED=no) and never stops/removes/alters
//        its lifecycle; teardown compares ID, running, health and labels
//        fixture/owner/run BYTE-BY-BYTE against the snapshot and FAILS
//        without mutating on any drift;
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

// Docker spells the "inspect target does not exist" 404 in two ways,
// depending on CLI version/code path: `No such object: <ref>` and
// `No such container: <ref>`. BOTH mean absence and map to null; this is
// only consulted on the nonzero-exit branch, so it can never mask a healthy
// response. Daemon/permission/connection errors contain neither phrase and
// keep throwing — absence is never inferred from a broken daemon.
function isDockerAbsentStderr(stderr) {
  return /no such (?:object|container):\s*\S+/i.test(String(stderr || ""));
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

  // Keep memory aligned with the last durable state when an atomic save
  // fails. create() and an in-process cleanup may share this instance, while
  // the EXIT trap opens a fresh one from the same state file.
  persistCreationState(started, createdId) {
    const previousStarted = this.state.started;
    const previousCreatedId = this.state.createdId;
    this.state.started = started;
    this.state.createdId = createdId;
    try {
      this.saveState();
    } catch (err) {
      this.state.started = previousStarted;
      this.state.createdId = previousCreatedId;
      throw err;
    }
  }

  // Result of `docker container inspect <ref>` (ref = container ID or name).
  // Callers MUST pass the ID recorded in the ownership state: the name is
  // mutable and snapshot() uses it exactly ONCE, to DISCOVER the container;
  // every later inspect/verify/cleanup goes by the recorded ID.
  //   null            -> the container does not exist (both Docker 404
  //                      spellings: "No such object" / "No such container")
  //   { id, running, health, labels }
  // health is null when the image has no HEALTHCHECK (MinIO image does not);
  // in that case "healthy" means simply "running".
  async inspect(ref) {
    const r = await this.exec(["container", "inspect", ref]);
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
    if (isDockerAbsentStderr(r.stderr)) return null;
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

  labelValue(labels, key) {
    return labels[key] === undefined ? null : labels[key];
  }

  // Byte-by-byte comparison of EVERYTHING the snapshot recorded about a
  // PREEXISTING container: ID, running, health and labels fixture/owner/run.
  // Any drift -> a human-readable reason; none -> null. verify()/cleanup()
  // FAIL without mutating on any drift.
  driftReason(info, state) {
    const problems = [];
    if (info.id !== state.preexistingId) {
      problems.push(`ID cambió (snapshot=${state.preexistingId}, actual=${info.id})`);
    }
    if (info.running !== state.preexistingRunning) {
      problems.push(`running cambió (snapshot=${state.preexistingRunning}, actual=${info.running})`);
    }
    if (info.health !== state.preexistingHealthy) {
      problems.push(`health cambió (snapshot=${state.preexistingHealthy}, actual=${info.health})`);
    }
    const beforeLabels = state.preexistingLabels || {};
    for (const key of [FIXTURE_LABEL, OWNER_LABEL, RUN_LABEL]) {
      const before = this.labelValue(beforeLabels, key);
      const now = this.labelValue(info.labels, key);
      if (now !== before) {
        problems.push(`label ${key} cambió (snapshot=${before}, actual=${now})`);
      }
    }
    return problems.length === 0 ? null : `drift del preexistente: ${problems.join("; ")}`;
  }

  // `docker run` returned an immutable identity, but the started=pending save
  // failed, so the durable file remains armed. Compensate NOW using only that
  // stdout ID. Verified compensation is disarmed durably and rethrows the
  // original save error; rm/verification/disarm failure keeps armed evidence.
  async compensatePendingSaveFailure(id, saveError) {
    let cleanupFailure = null;
    try {
      const rm = await this.exec(["rm", "-f", id]);
      if (rm.status !== 0) {
        cleanupFailure = `docker rm -f falló (status ${rm.status}): ${firstLine(rm.stderr)}`;
      } else {
        const after = await this.inspect(id);
        if (after !== null) {
          cleanupFailure = "tras docker rm -f el contenedor aún existe (residuo verificado por ID)";
        }
      }
    } catch (err) {
      cleanupFailure = `cleanup/verificación lanzó error: ${err && err.message ? err.message : String(err)}`;
    }

    const saveMessage = saveError && saveError.message ? saveError.message : String(saveError);
    if (cleanupFailure === null) {
      try {
        this.persistCreationState("no", null);
      } catch (disarmError) {
        const compound = new Error(
          `saveState(started=pending, createdId=${id}, runId=${this.state.runId}) falló: ${saveMessage}; ` +
            `cleanup compensatorio por ID ${id} fue verificado, pero desarmar estado durable FALLÓ: ` +
            `${disarmError && disarmError.message ? disarmError.message : String(disarmError)}`
        );
        compound.cause = saveError;
        throw compound;
      }
      throw saveError;
    }

    const compound = new Error(
      `saveState(started=pending, createdId=${id}, runId=${this.state.runId}) falló: ${saveMessage}; ` +
        `cleanup compensatorio por ID ${id} FALLÓ: ${cleanupFailure}`
    );
    compound.cause = saveError;
    throw compound;
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
        preexistingLabels: null,
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
        preexistingHealthy: info.health,
        preexistingLabeled: labeled,
        preexistingLabels: {
          [FIXTURE_LABEL]: this.labelValue(info.labels, FIXTURE_LABEL),
          [OWNER_LABEL]: this.labelValue(info.labels, OWNER_LABEL),
          [RUN_LABEL]: this.labelValue(info.labels, RUN_LABEL),
        },
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
      preexistingHealthy: info.health,
      preexistingLabeled: true,
      preexistingLabels: {
        [FIXTURE_LABEL]: this.labelValue(info.labels, FIXTURE_LABEL),
        [OWNER_LABEL]: this.labelValue(info.labels, OWNER_LABEL),
        [RUN_LABEL]: this.labelValue(info.labels, RUN_LABEL),
      },
      owner: this.owner,
      runId: this.runId,
      reason: null,
    };
    this.saveState();
    return { mode: "reuse", id: info.id };
  }

  // Create the container ONLY when the snapshot decided mode=create. Labels
  // fixture/owner/run identify ownership, but the ONLY identity this run
  // owns is the container ID `docker run` PRINTS (never the name, which can
  // be hijacked between run and inspect). State is armed durably before the
  // mutation; after success the ID is persisted atomically as
  // started=pending + createdId + runId BEFORE any later inspect, so if
  // the inspect/verify/label/save step afterwards fails, a trap-based
  // --cleanup still removes and verifies EXACTLY that ID. A failed `docker
  // run` adopts NOTHING: containers that appeared during a failed run are
  // neither adopted nor deleted by this run (KISS: ownership only exists
  // through a returned ID).
  async create(image) {
    this.ensureState();
    if (!this.state || this.state.mode !== "create") {
      throw new Error("create() requires a snapshot that decided mode=create");
    }

    // Fail closed across the mutation boundary: a fresh trap distinguishes
    // "run never attempted" from "attempted but no ID became durable".
    this.persistCreationState("armed", null);

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
      // Zero adoption: a failed run provides no owned ID, so whatever
      // appeared (even bearing our exact labels) is left untouched — never
      // adopted, never deleted. Disarm durably; if that save fails, the last
      // durable state stays armed so every fresh cleanup remains FAIL.
      const runError = new Error(`docker run failed (status ${r.status}): ${firstLine(r.stderr)}`);
      try {
        this.persistCreationState("no", null);
      } catch (disarmError) {
        const compound = new Error(
          `${runError.message}; desarmar estado durable tras docker run fallido FALLÓ: ` +
            `${disarmError && disarmError.message ? disarmError.message : String(disarmError)}`
        );
        compound.cause = runError;
        throw compound;
      }
      throw runError;
    }
    const id = firstLine(r.stdout);
    if (!id || /\s/.test(id)) {
      throw new Error(
        `docker run did not return a container ID: ${JSON.stringify(String(r.stdout || "").slice(0, 80))}`
      );
    }
    // Persist ownership BEFORE inspecting. If this FIRST pending save fails,
    // a later trap cannot trust the state file, so compensate immediately by
    // the exact stdout ID and verify it disappeared before propagating error.
    try {
      this.persistCreationState("pending", id);
    } catch (saveError) {
      await this.compensatePendingSaveFailure(id, saveError);
    }

    // Always by ID, never by name.
    const info = await this.inspect(id);
    if (info === null) {
      throw new Error(
        `container reported created but docker inspect cannot find it — createdId ${id} persiste para teardown`
      );
    }
    this.persistCreationState("yes", id);
    return { id };
  }

  // Reuse path: re-validates BEFORE use, by the SNAPSHOT ID (never the
  // mutable name), that the preexisting container is still the same object
  // with the same running/health/labels. Any drift -> fail without touching.
  async verify() {
    this.ensureState();
    if (!this.state || this.state.mode !== "reuse") {
      throw new Error("verify() requires a snapshot that decided mode=reuse");
    }
    const info = await this.inspect(this.state.preexistingId);
    if (info === null) {
      return {
        ok: false,
        reason: `preexistente desapareció antes de usarse (ID ${this.state.preexistingId} ya no existe; nunca se toca un sustituto)`,
      };
    }
    const drift = this.driftReason(info, this.state);
    if (drift) return { ok: false, reason: drift };
    return { ok: true, id: info.id };
  }

  // Teardown contract:
  //   - created container  -> verified/removed by the RECORDED ID only
  //     (started=pending or yes); a container that took the name in the
  //     meantime is never inspected, adopted or deleted; rename does not
  //     hide residue (the ID is still ours and still verified/removed).
  //   - preexisting        -> re-verified BY THE SNAPSHOT ID: ID, running,
  //     health and labels fixture/owner/run compared byte-by-byte; any
  //     drift -> FAIL without touching.
  //   - failed decision    -> never touched (verified intact).
  //   - no state           -> nothing owned by this run; nothing deleted.
  async cleanup() {
    this.ensureState();
    if (!this.state) {
      return { ok: true, note: "sin estado de ownership — no se elimina nada" };
    }

    if (this.state.mode === "create") {
      if (this.state.started === "armed") {
        return {
          ok: false,
          reason:
            `estado armed (runId=${this.state.runId || "desconocido"}): docker run fue intentado, ` +
            "pero ningún createdId quedó durable; outcome desconocido — no se elimina por nombre",
        };
      }
      if (this.state.started !== "yes" && this.state.started !== "pending") {
        return { ok: true, note: "nunca se creó contenedor — nada que eliminar" };
      }
      const createdId = this.state.createdId;
      if (!createdId) {
        return { ok: true, note: "sin createdId registrado — nada que eliminar" };
      }
      // Verify and remove BY THE RECORDED ID only; whatever now holds the
      // name (substitute, renamed stranger) is never inspected or deleted.
      const info = await this.inspect(createdId);
      if (info === null) {
        return {
          ok: true,
          note: `contenedor creado (${createdId}) ya no existe — verificado por ID`,
        };
      }
      if (info.id !== createdId) {
        return {
          ok: false,
          reason: `ID race: el contenedor con ID ${info.id} NO es el creado por esta corrida (${createdId}) — no se borra`,
        };
      }
      const rm = await this.exec(["rm", "-f", createdId]);
      if (rm.status !== 0) {
        return {
          ok: false,
          reason: `docker rm -f falló (status ${rm.status}): ${firstLine(rm.stderr)}`,
        };
      }
      const after = await this.inspect(createdId);
      if (after !== null) {
        return { ok: false, reason: "tras docker rm -f el contenedor aún existe (verificado por ID)" };
      }
      return { ok: true, note: `contenedor creado eliminado (${createdId}) y verificado por ID` };
    }

    if (this.state.mode === "reuse") {
      const info = await this.inspect(this.state.preexistingId);
      if (info === null) {
        return {
          ok: false,
          reason: `preexistente desapareció durante la corrida (ID ${this.state.preexistingId} ya no existe; nunca se toca un sustituto)`,
        };
      }
      const drift = this.driftReason(info, this.state);
      if (drift) return { ok: false, reason: drift };
      return {
        ok: true,
        note: `preexistente preservado (${info.id}, running, healthy, labels fixture/owner/run intactas)`,
      };
    }

    if (this.state.mode === "fail") {
      // Fail-mode never touches anything. Verification goes by the recorded
      // ID only — the name is never inspected after snapshot (snapshot always
      // records preexistingId before a fail decision).
      if (!this.state.preexistingId) {
        return { ok: true, note: "fail-mode: sin preexistingId registrado — no se tocó nada" };
      }
      const info = await this.inspect(this.state.preexistingId);
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