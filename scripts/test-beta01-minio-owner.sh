#!/usr/bin/env bash
#
# Contractual test for the Beta 0.1 MinIO container ownership (Gate 1, fix 3).
#
# Demonstrates, WITHOUT raising the stack and with ZERO network, that the
# ownership helper (e2e/support/beta01-minio-owner.cjs) satisfies the único
# criterio de lifecycle seguro del contenedor `beta01-minio`:
#
#   c1. contenedor AUSENTE  -> esta corrida lo CREA con labels de
#       fixture/owner/run, guarda el container ID exacto y MINIO_STARTED=yes;
#       el teardown elimina SÓLO ese ID y verifica que desapareció;
#   c2. preexistente con label com.mike.beta01.fixture=true, running y healthy
#       -> se REUTILIZA (MINIO_STARTED=no) y jamás se detiene/elimina/alterá su
#       lifecycle; el teardown verifica el MISMO ID y estado;
#   c3. preexistente SIN label correcta, parado/unhealthy o con ID cambiado
#       durante la corrida -> FAIL antes de usar/limpiar y no se toca;
#   c4. ID race (el contenedor cambió de ID mientras la corrida estaba activa)
#       -> teardown FAIL sin borrar;
#   c5. error antes/después de docker run nunca elimina contenedores ajenos;
#   c6. el CLI (snapshot -> start/verify -> cleanup con state-file) mantiene la
#       misma decisión de ownership entre invocaciones.
#
# The docker client is a FAKE in-memory with the same `exec(argv)` interface
# the runner injects; globalThis.fetch is replaced by a spy that fails hard, so
# this test can never touch HTTP.
#
# Usage: bash scripts/test-beta01-minio-owner.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MINIO_HELPER="$ROOT/e2e/support/beta01-minio-owner.cjs"
TMP="$(mktemp -d /tmp/beta01-minio-owner.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

TEST_PROGRAM="$TMP/minio-owner-contract.cjs"
cat >"$TEST_PROGRAM" <<'NODE'
"use strict";

const path = require("node:path");

const helperPath = process.argv[2];
if (!helperPath) throw new Error("missing helper path");
const TMP_DIR = process.argv[3];
if (!TMP_DIR) throw new Error("missing tmp dir");
const { MinioOwnership, runCli, FIXTURE_LABEL, OWNER_LABEL, RUN_LABEL } =
  require(helperPath);

// ZERO network: any fetch in this contractual test is a bug.
globalThis.fetch = async function spyFetch() {
  throw new Error("minio-owner contractual test must never perform HTTP requests");
};

const IMAGE = "minio/minio:RELEASE.2025-09-07T16-13-09Z";

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures += 1;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// In-memory fake of the docker CLI with the same `exec(argv)` shape the runner
// injects: `exec(args) -> { status, stdout, stderr }`. Containers hold the
// `docker container inspect` document shape the helper parses.
// ---------------------------------------------------------------------------
function fakeDocker() {
  const containers = new Map(); // name -> inspect document
  const events = []; // every docker invocation, verbatim
  const state = { failRun: false, runCreatesThenFails: false };
  let nextId = 0;

  function addContainer(name, props = {}) {
    const doc = {
      Id: props.id || `cid-${(nextId += 1)}`,
      State: {
        Running: props.running ?? true,
        ...(props.health ? { Health: { Status: props.health } } : {}),
      },
      Config: { Labels: { ...(props.labels || {}) } },
    };
    containers.set(name, doc);
    return doc;
  }

  function findByIdOrName(target) {
    for (const [name, doc] of containers) {
      if (doc.Id === target) return { name, doc };
    }
    if (containers.has(target)) return { name: target, doc: containers.get(target) };
    return null;
  }

  async function exec(args) {
    events.push(args.join(" "));
    const [cmd, ...rest] = args;
    if (cmd === "container" && rest[0] === "inspect") {
      const doc = containers.get(rest[1]);
      if (!doc) return { status: 1, stdout: "", stderr: `Error: No such object: ${rest[1]}` };
      return { status: 0, stdout: JSON.stringify([doc]), stderr: "" };
    }
    if (cmd === "run") {
      if (state.failRun) {
        return { status: 125, stdout: "", stderr: "fake: docker daemon error (run never happened)" };
      }
      const nameIdx = rest.indexOf("--name");
      const name = rest[nameIdx + 1];
      const labels = {};
      for (let i = 0; i < rest.length; i += 1) {
        if (rest[i] === "--label") {
          const eq = rest[i + 1].indexOf("=");
          labels[rest[i + 1].slice(0, eq)] = rest[i + 1].slice(eq + 1);
        }
      }
      if (containers.has(name)) {
        return { status: 125, stdout: "", stderr: `Error: Conflict. The container name "/${name}" is already in use` };
      }
      addContainer(name, { labels });
      if (state.runCreatesThenFails) {
        return { status: 1, stdout: "", stderr: "fake: run failed AFTER creating the container" };
      }
      const created = containers.get(name);
      return { status: 0, stdout: `${created.Id}\n`, stderr: "" };
    }
    if (cmd === "rm") {
      const target = rest[rest[0] === "-f" ? 1 : 0];
      const found = findByIdOrName(target);
      if (!found) return { status: 1, stdout: "", stderr: `Error: No such container: ${target}` };
      containers.delete(found.name);
      return { status: 0, stdout: "", stderr: "" };
    }
    if (cmd === "stop") {
      const found = findByIdOrName(rest[0]);
      if (!found) return { status: 1, stdout: "", stderr: `Error: No such container: ${rest[0]}` };
      found.doc.State.Running = false;
      return { status: 0, stdout: "", stderr: "" };
    }
    throw new Error(`fake docker: comando no modelado: ${cmd}`);
  }

  return {
    exec,
    containers,
    events,
    addContainer,
    set(field, value) {
      state[field] = value;
    },
  };
}

const mutatingEvents = (events) =>
  events.filter((e) => /^(run|rm|stop) /.test(e));

const OWNER = "beta01-smoke";
async function main() {
  // -------------------------------------------------------------------------
  // c1 — contenedor AUSENTE: se CREA con labels de fixture/owner/run, se
  // guarda el container ID exacto y MINIO_STARTED=yes; el teardown elimina
  // SÓLO ese ID y verifica que desapareció.
  // -------------------------------------------------------------------------
  {
    const fake = fakeDocker();
    const ownership = new MinioOwnership({ exec: fake.exec, runId: "run-1" });
    const snap = await ownership.snapshot();
    check("c1 absent -> mode create", snap.mode === "create", JSON.stringify(snap));
    check("c1 MINIO_STARTED=no before create", ownership.state.started === "no");

    const created = await ownership.create(IMAGE);
    check("c1 create captures exact container ID", created.id === "cid-1", `id=${created.id}`);
    check("c1 MINIO_STARTED=yes after create", ownership.state.started === "yes");
    const runEvent = fake.events.find((e) => e.startsWith("run ")) || "";
    check("c1 run carries fixture label", runEvent.includes(`--label ${FIXTURE_LABEL}=true`));
    check("c1 run carries owner label", runEvent.includes(`--label ${OWNER_LABEL}=${OWNER}`));
    check("c1 run carries run label", runEvent.includes(`--label ${RUN_LABEL}=run-1`));
    const doc = fake.containers.get("beta01-minio");
    check("c1 container exists with our labels",
      doc && doc.Config.Labels[FIXTURE_LABEL] === "true" &&
        doc.Config.Labels[OWNER_LABEL] === OWNER &&
        doc.Config.Labels[RUN_LABEL] === "run-1");

    const cleaned = await ownership.cleanup();
    check("c1 cleanup ok", cleaned.ok === true, cleaned.note || "");
    check("c1 container removed (verified gone)", fake.containers.size === 0);
    const rms = fake.events.filter((e) => e.startsWith("rm "));
    check("c1 rm targets ONLY the exact created ID", rms.length === 1 && rms[0] === "rm -f cid-1", rms.join(" | "));
    check("c1 never stopped", fake.events.filter((e) => e.startsWith("stop ")).length === 0);
  }

  // -------------------------------------------------------------------------
  // c2 — preexistente con label com.mike.beta01.fixture=true, running y
  // healthy: se REUTILIZA (MINIO_STARTED=no) y el teardown NADA lo altera;
  // verifica el mismo ID y estado.
  // -------------------------------------------------------------------------
  {
    const fake = fakeDocker();
    fake.addContainer("beta01-minio", {
      id: "cid-9",
      running: true,
      health: "healthy",
      labels: { [FIXTURE_LABEL]: "true", [OWNER_LABEL]: OWNER, [RUN_LABEL]: "run-old" },
    });
    const ownership = new MinioOwnership({ exec: fake.exec, runId: "run-2" });
    const snap = await ownership.snapshot();
    check("c2 labeled running healthy -> reuse", snap.mode === "reuse" && snap.id === "cid-9", JSON.stringify(snap));
    check("c2 MINIO_STARTED=no for reuse", ownership.state.started === "no", ownership.state.started);
    const verified = await ownership.verify();
    check("c2 verify before use ok", verified.ok === true, verified.reason || "");
    const cleaned = await ownership.cleanup();
    check("c2 cleanup ok / preserved", cleaned.ok === true, cleaned.note || "");
    const doc = fake.containers.get("beta01-minio");
    check("c2 same ID and running after teardown",
      doc && doc.Id === "cid-9" && doc.State.Running === true,
      doc ? doc.Id : "container gone");
    check("c2 ZERO mutating docker calls",
      mutatingEvents(fake.events).length === 0,
      mutatingEvents(fake.events).join(" | ") || "(none)");
  }

  // -------------------------------------------------------------------------
  // c3 — preexistente SIN label correcta, o parado/unhealthy: FAIL antes de
  // usar/limpiar; el teardown no toca nada.
  // -------------------------------------------------------------------------
  {
    const fake = fakeDocker();
    fake.addContainer("beta01-minio", { id: "cid-9", running: true, health: null, labels: {} });
    const ownership = new MinioOwnership({ exec: fake.exec });
    const snap = await ownership.snapshot();
    check("c3 unlabeled running -> fail", snap.mode === "fail" && /label/.test(snap.reason || ""), JSON.stringify(snap));
    const cleaned = await ownership.cleanup();
    check("c3 unlabeled teardown untouched-but-verified", cleaned.ok === true, cleaned.note || "");
    const doc = fake.containers.get("beta01-minio");
    check("c3 unlabeled container intact", doc && doc.Id === "cid-9");
    check("c3 unlabeled ZERO mutating docker calls",
      mutatingEvents(fake.events).length === 0,
      mutatingEvents(fake.events).join(" | ") || "(none)");

    const fake2 = fakeDocker();
    fake2.addContainer("beta01-minio", {
      id: "cid-9",
      running: false,
      health: "unhealthy",
      labels: { [FIXTURE_LABEL]: "true" },
    });
    const ownership2 = new MinioOwnership({ exec: fake2.exec });
    const snap2 = await ownership2.snapshot();
    check("c3 stopped/unhealthy labeled -> fail",
      snap2.mode === "fail" && /running/.test(snap2.reason || "") && /unhealthy/.test(snap2.reason || ""),
      JSON.stringify(snap2));
    const cleaned2 = await ownership2.cleanup();
    check("c3 stopped teardown untouched-but-verified", cleaned2.ok === true, cleaned2.note || "");
    const doc2 = fake2.containers.get("beta01-minio");
    check("c3 stopped container intact (still not running, never altered)",
      doc2 && doc2.Id === "cid-9" && doc2.State.Running === false);
    check("c3 stopped ZERO mutating docker calls",
      mutatingEvents(fake2.events).length === 0,
      mutatingEvents(fake2.events).join(" | ") || "(none)");
  }

  // -------------------------------------------------------------------------
  // c4 — ID race: si el contenedor bajo nuestro nombre dejó de ser el que
  // esta corrida creó (o el preexistente que adoptó), el teardown FAIL sin
  // borrar nada.
  // -------------------------------------------------------------------------
  {
    const fake = fakeDocker();
    const ownership = new MinioOwnership({ exec: fake.exec, runId: "run-4" });
    await ownership.snapshot();
    const created = await ownership.create(IMAGE);
    check("c4 race setup: created captured", created.id === "cid-1", `id=${created.id}`);
    // Un ajeno tomó el nombre: el contenedor actual ya NO es el nuestro.
    fake.containers.set("beta01-minio", {
      Id: "cid-2",
      State: { Running: true },
      Config: { Labels: {} },
    });
    const cleaned = await ownership.cleanup();
    check("c4 created-path ID race -> cleanup FAIL", cleaned.ok === false && /ID race/.test(cleaned.reason || ""), cleaned.reason || "");
    const raced = fake.containers.get("beta01-minio");
    check("c4 created-path race container NOT deleted", raced && raced.Id === "cid-2", raced ? raced.Id : "gone");
    check("c4 created-path race ZERO rm calls",
      fake.events.filter((e) => e.startsWith("rm ")).length === 0,
      fake.events.filter((e) => e.startsWith("rm ")).join(" | ") || "(none)");

    const fake2 = fakeDocker();
    fake2.addContainer("beta01-minio", {
      id: "cid-9",
      running: true,
      health: "healthy",
      labels: { [FIXTURE_LABEL]: "true", [OWNER_LABEL]: OWNER, [RUN_LABEL]: "run-old" },
    });
    const ownership2 = new MinioOwnership({ exec: fake2.exec, runId: "run-4b" });
    const snap2 = await ownership2.snapshot();
    check("c4 reuse-path setup: reuse captured", snap2.mode === "reuse" && snap2.id === "cid-9", JSON.stringify(snap2));
    fake2.containers.get("beta01-minio").Id = "cid-7"; // el ID cambió durante la corrida
    const preUse = await ownership2.verify();
    check("c4 reuse-path ID change detected BEFORE use", preUse.ok === false && /cambió/.test(preUse.reason || ""), preUse.reason || "");
    const cleaned2 = await ownership2.cleanup();
    check("c4 reuse-path ID race -> cleanup FAIL", cleaned2.ok === false && /cambió/.test(cleaned2.reason || ""), cleaned2.reason || "");
    const raced2 = fake2.containers.get("beta01-minio");
    check("c4 reuse-path race container NOT touched", raced2 && raced2.Id === "cid-7" && raced2.State.Running === true);
    check("c4 reuse-path race ZERO mutating calls",
      mutatingEvents(fake2.events).length === 0,
      mutatingEvents(fake2.events).join(" | ") || "(none)");
  }

  // -------------------------------------------------------------------------
  // c5 — error antes/después de docker run nunca elimina contenedores ajenos.
  // -------------------------------------------------------------------------
  {
    // c5a: run falla sin crear nada -> nada que eliminar, cero rm.
    const fake = fakeDocker();
    fake.set("failRun", true);
    const ownership = new MinioOwnership({ exec: fake.exec, runId: "run-5a" });
    await ownership.snapshot(); // absent -> create
    let createError = null;
    try {
      await ownership.create(IMAGE);
    } catch (err) {
      createError = err;
    }
    check("c5a run failure is reported", createError !== null && /docker run failed/.test(createError.message), createError ? createError.message : "no error");
    check("c5a nothing adopted (started=no)", ownership.state.started === "no", ownership.state.started);
    const cleaned = await ownership.cleanup();
    check("c5a cleanup ok, nothing deleted", cleaned.ok === true, cleaned.note || "");
    check("c5a ZERO rm calls",
      fake.events.filter((e) => e.startsWith("rm ")).length === 0,
      fake.events.filter((e) => e.startsWith("rm ")).join(" | ") || "(none)");
    check("c5a no containers in fake", fake.containers.size === 0);

    // c5b: un AJENO tomó el nombre antes de nuestro run; nuestro run falla
    // (conflicto de nombre) y el ajeno NUNCA se adopta ni se borra.
    const fakeB = fakeDocker();
    const ownershipB = new MinioOwnership({ exec: fakeB.exec, runId: "run-5b" });
    await ownershipB.snapshot(); // absent -> create
    fakeB.addContainer("beta01-minio", { id: "cid-77", running: true, health: null, labels: {} });
    let createErrorB = null;
    try {
      await ownershipB.create(IMAGE);
    } catch (err) {
      createErrorB = err;
    }
    check("c5b name-conflict failure reported", createErrorB !== null && /docker run failed/.test(createErrorB.message), createErrorB ? createErrorB.message : "no error");
    check("c5b stranger NOT adopted as ours", ownershipB.state.started === "no", ownershipB.state.started);
    const cleanedB = await ownershipB.cleanup();
    check("c5b cleanup ok, stranger untouched", cleanedB.ok === true, cleanedB.note || "");
    const stranger = fakeB.containers.get("beta01-minio");
    check("c5b stranger container still intact", stranger && stranger.Id === "cid-77" && stranger.State.Running === true);
    check("c5b ZERO rm calls",
      fakeB.events.filter((e) => e.startsWith("rm ")).length === 0,
      fakeB.events.filter((e) => e.startsWith("rm ")).join(" | ") || "(none)");

    // c5c: run falla DESPUÉS de crear (dejó contenedor con NUESTRAS labels) ->
    // se adopta y el teardown elimina SÓLO ese ID; un contenedor ajeno
    // coexistente jamás se toca.
    const fakeC = fakeDocker();
    fakeC.addContainer("other-svc", { id: "cid-99", running: true, health: null, labels: {} });
    fakeC.set("runCreatesThenFails", true);
    const ownershipC = new MinioOwnership({ exec: fakeC.exec, runId: "run-5c" });
    await ownershipC.snapshot(); // absent -> create
    let createErrorC = null;
    try {
      await ownershipC.create(IMAGE);
    } catch (err) {
      createErrorC = err;
    }
    check("c5c post-create failure reported", createErrorC !== null && /docker run failed/.test(createErrorC.message), createErrorC ? createErrorC.message : "no error");
    const partial = fakeC.containers.get("beta01-minio");
    check("c5c partial container adopted ONLY because labels are ours",
      ownershipC.state.started === "yes" && ownershipC.state.createdId === partial.Id,
      `started=${ownershipC.state.started} createdId=${ownershipC.state.createdId}`);
    const cleanedC = await ownershipC.cleanup();
    check("c5c cleanup ok, partial ours removed", cleanedC.ok === true, cleanedC.note || "");
    check("c5c our container gone", !fakeC.containers.has("beta01-minio"));
    check("c5c stranger coexisting container untouched",
      fakeC.containers.has("other-svc") && fakeC.containers.get("other-svc").Id === "cid-99");
    const rmsC = fakeC.events.filter((e) => e.startsWith("rm "));
    check("c5c rm targeted ONLY our id, never the stranger",
      rmsC.length === 1 && rmsC[0] === `rm -f ${partial.Id}`,
      rmsC.join(" | "));
  }

  // -------------------------------------------------------------------------
  // c6 — CLI surface (lo que invoca el runner): la decisión de ownership se
  // persiste en el state-file entre snapshot/start/verify/cleanup.
  // -------------------------------------------------------------------------
  {
    const cliState = path.join(TMP_DIR, "cli-state.json");
    const fake = fakeDocker();

    const snap = await runCli(["--snapshot", "--state-file", cliState, "--run-id", "run-cli"], fake.exec);
    check("c6 CLI snapshot -> create", snap.exitCode === 0 && snap.output.mode === "create", JSON.stringify(snap.output));
    const start = await runCli(["--start", IMAGE, "--state-file", cliState], fake.exec);
    check("c6 CLI start captures exact ID", start.exitCode === 0 && start.output.id === "cid-1", JSON.stringify(start.output));
    check("c6 CLI state file records MINIO_STARTED=yes",
      ownershipStarted(cliState) === "yes", `started=${ownershipStarted(cliState)}`);
    const clean = await runCli(["--cleanup", "--state-file", cliState], fake.exec);
    check("c6 CLI cleanup ok", clean.exitCode === 0 && clean.output.ok === true, JSON.stringify(clean.output));
    check("c6 CLI container removed", fake.containers.size === 0);
    const rms = fake.events.filter((e) => e.startsWith("rm "));
    check("c6 CLI rm exact ID", rms.length === 1 && rms[0] === "rm -f cid-1", rms.join(" | "));

    const cliState2 = path.join(TMP_DIR, "cli-state2.json");
    const fake2 = fakeDocker();
    fake2.addContainer("beta01-minio", {
      id: "cid-9",
      running: true,
      health: "healthy",
      labels: { [FIXTURE_LABEL]: "true", [OWNER_LABEL]: OWNER, [RUN_LABEL]: "run-old" },
    });
    const snap2 = await runCli(["--snapshot", "--state-file", cliState2], fake2.exec);
    check("c6 CLI snapshot -> reuse", snap2.exitCode === 0 && snap2.output.mode === "reuse", JSON.stringify(snap2.output));
    const verify2 = await runCli(["--verify", "--state-file", cliState2], fake2.exec);
    check("c6 CLI verify ok", verify2.exitCode === 0 && verify2.output.ok === true, JSON.stringify(verify2.output));
    const clean2 = await runCli(["--cleanup", "--state-file", cliState2], fake2.exec);
    check("c6 CLI reuse cleanup ok / preserved", clean2.exitCode === 0 && clean2.output.ok === true, JSON.stringify(clean2.output));
    check("c6 CLI reuse ZERO mutating calls", mutatingEvents(fake2.events).length === 0);

    // Sanidad: sin state-file (corrida que jamás llegó a snapshot) el
    // cleanup no puede probar ownership -> no elimina nada.
    const cleanNoState = await runCli(["--cleanup", "--state-file", path.join(TMP_DIR, "missing-state.json")], fake2.exec);
    check("c6 no-state cleanup deletes nothing", cleanNoState.exitCode === 0 && cleanNoState.output.ok === true, JSON.stringify(cleanNoState.output));
    check("c6 no-state cleanup never called docker rm",
      fake2.events.filter((e) => e.startsWith("rm ")).length === 0);
  }

  check("c7 final: zero failures", failures === 0, `${failures} failures`);
  process.exit(failures === 0 ? 0 : 1);
}

function ownershipStarted(stateFile) {
  const fs = require("node:fs");
  const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  return parsed.started;
}

main().catch((error) => {
  console.error(`FAIL unhandled: ${error.message}`);
  process.exit(1);
});
NODE

node "$TEST_PROGRAM" "$MINIO_HELPER" "$TMP"
echo "ALL PASS — beta01 MinIO ownership contractual test OK"