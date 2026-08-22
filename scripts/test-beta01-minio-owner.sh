#!/usr/bin/env bash
#
# Contractual test for the Beta 0.1 MinIO container ownership (Gate 1, fix 3).
#
# Demonstrates, WITHOUT raising the stack and with ZERO network, that the
# ownership helper (e2e/support/beta01-minio-owner.cjs) satisfies the único
# criterio de lifecycle seguro del contenedor `beta01-minio`:
#
#   c1. contenedor AUSENTE -> esta corrida lo CREA con labels de
#       fixture/owner/run; la ÚNICA identidad propia es el container ID que
#       `docker run` devuelve, persistido de forma atómica (started=pending +
#       createdId + runId) ANTES de cualquier inspect posterior; inspect /
#       cleanup / verificación SIEMPRE por ID, nunca por nombre (el nombre se
#       usa exactamente una vez, en snapshot, para descubrir);
#   c2. preexistente con label com.mike.beta01.fixture=true, running y healthy
#       -> se REUTILIZA (MINIO_STARTED=no); el snapshot guarda ID, running,
#       health crudo y labels fixture/owner/run, y el teardown compara TODO
#       byte-a-byte contra el snapshot, FAIL sin mutar ante cualquier drift;
#   c3. preexistente SIN label correcta o parado/unhealthy -> FAIL antes de
#       usar/limpiar y no se toca;
#   c4. sustituto en el nombre / rename / ID cambiado mientras la corrida
#       estaba activa -> se opera SÓLO por el ID registrado: un sustituto
#       nunca se borra, un rename no oculta el residuo propio;
#   c5. error antes/después de docker run NUNCA elimina contenedores ajenos y
#       NUNCA adopta (cero adopción: ni con fixture+owner idénticos de otra
#       corrida);
#   c6. el CLI (snapshot -> start/verify -> cleanup con state-file) mantiene la
#       misma decisión de ownership entre invocaciones;
#   c7. fallo de INSPECT post-run: el ID devuelto por `docker run` ya está
#       persistido (started=pending + createdId) ANTES del inspect; si el
#       inspect posterior falla, el cleanup del trap elimina/verifica SÓLO ese
#       ID;
#   c8. fallo de SAVE post-run: started=pending + createdId siguen en disco y
#       el cleanup del trap elimina y verifica SÓLO ese ID;
#   c9. drift de HEALTH del preexistente (reuse): verify/cleanup FAIL sin mutar;
#   c10. drift de LABELS fixture/owner/run del preexistente (reuse):
#       verify/cleanup FAIL sin mutar.
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
const fs = require("node:fs");

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
  const byId = new Map(); // full container ID -> same documents
  const events = []; // every docker invocation, verbatim
  const state = { failRun: false, runCreatesThenFails: false, failInspects: 0 };
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
    byId.set(doc.Id, doc);
    return doc;
  }

  // Docker resolution: full container ID first, then name. Inspect/rm by ID
  // must work: the helper never inspects/removes by name after snapshot.
  function resolve(target) {
    if (byId.has(target)) return { doc: byId.get(target), name: null };
    if (containers.has(target)) return { doc: containers.get(target), name: target };
    return null;
  }

  // Removes a container by its ID from BOTH registries (and its name key).
  function dropById(id) {
    const doc = byId.get(id);
    if (!doc) return false;
    for (const [name, other] of containers) {
      if (other === doc) containers.delete(name);
    }
    byId.delete(id);
    return true;
  }

  async function exec(args) {
    events.push(args.join(" "));
    const [cmd, ...rest] = args;
    if (cmd === "container" && rest[0] === "inspect") {
      if (state.failInspects > 0) {
        state.failInspects -= 1;
        return { status: 1, stdout: "", stderr: "fake: docker daemon error (inspect unavailable)" };
      }
      const found = resolve(rest[1]);
      if (!found) return { status: 1, stdout: "", stderr: `Error: No such object: ${rest[1]}` };
      return { status: 0, stdout: JSON.stringify([found.doc]), stderr: "" };
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
      const found = resolve(target);
      if (!found) return { status: 1, stdout: "", stderr: `Error: No such container: ${target}` };
      dropById(found.doc.Id);
      return { status: 0, stdout: "", stderr: "" };
    }
    if (cmd === "stop") {
      const found = resolve(rest[0]);
      if (!found) return { status: 1, stdout: "", stderr: `Error: No such container: ${rest[0]}` };
      found.doc.State.Running = false;
      return { status: 0, stdout: "", stderr: "" };
    }
    throw new Error(`fake docker: comando no modelado: ${cmd}`);
  }

  return {
    exec,
    containers,
    byId,
    events,
    addContainer,
    // A stranger takes the NAME: the previous name->doc mapping is replaced
    // but the displaced document stays reachable BY ID (rename/substitute
    // semantics). Returns the newcomer's document.
    hijackName(name, props = {}) {
      const doc = {
        Id: props.id || `cid-${(nextId += 1)}`,
        State: {
          Running: props.running ?? true,
          ...(props.health ? { Health: { Status: props.health } } : {}),
        },
        Config: { Labels: { ...(props.labels || {}) } },
      };
      containers.set(name, doc);
      byId.set(doc.Id, doc);
      return doc;
    },
    dropById,
    set(field, value) {
      state[field] = value;
    },
    failInspect(n) {
      state.failInspects = n;
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
    const nameInspects = fake.events.filter((e) => e === "container inspect beta01-minio");
    check("c1 name used EXACTLY once (discovery); later inspects by ID",
      nameInspects.length === 1 && fake.events.includes("container inspect cid-1"),
      nameInspects.join(" | ") || "(none)");
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
    check("c2 snapshot records id/running/health/labels byte-by-byte",
      ownership.state.preexistingId === "cid-9" &&
        ownership.state.preexistingRunning === true &&
        ownership.state.preexistingHealthy === "healthy" &&
        ownership.state.preexistingLabels[FIXTURE_LABEL] === "true" &&
        ownership.state.preexistingLabels[OWNER_LABEL] === OWNER &&
        ownership.state.preexistingLabels[RUN_LABEL] === "run-old",
      JSON.stringify(ownership.state));
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
    const nameInspects2 = fake.events.filter((e) => e === "container inspect beta01-minio");
    check("c2 reuse: name inspected once, rest by snapshot ID",
      nameInspects2.length === 1 && fake.events.includes("container inspect cid-9"),
      nameInspects2.join(" | ") || "(none)");
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
  // c4 — carreras de identidad: un sustituto tomó el nombre, nuestro
  // contenedor fue renombrado o el ID cambió mientras la corrida estaba
  // activa. Se opera SÓLO por el ID registrado: un sustituto nunca se borra
  // y un rename no oculta el residuo propio.
  // -------------------------------------------------------------------------
  {
    // c4a: sustituto tomó el nombre y NUESTRO contenedor ya no existe: el
    // cleanup verifica por ID que no queda nada nuestro y NO toca al sustituto.
    const fake = fakeDocker();
    const ownership = new MinioOwnership({ exec: fake.exec, runId: "run-4a" });
    await ownership.snapshot();
    const created = await ownership.create(IMAGE);
    check("c4a created ID captured from run stdout", created.id === "cid-1", `id=${created.id}`);
    fake.dropById("cid-1"); // lo nuestro desapareció
    fake.hijackName("beta01-minio", { id: "cid-2", running: true, labels: {} }); // sustituto en el nombre
    const cleaned = await ownership.cleanup();
    check("c4a ours gone + substitute at name -> cleanup OK por ID (nada propio)",
      cleaned.ok === true && /ya no existe/.test(cleaned.note || ""), cleaned.note || "");
    check("c4a substitute NOT deleted", fake.containers.get("beta01-minio").Id === "cid-2");
    check("c4a ZERO rm calls",
      fake.events.filter((e) => e.startsWith("rm ")).length === 0,
      fake.events.filter((e) => e.startsWith("rm ")).join(" | ") || "(none)");

    // c4b: rename no oculta residuo — lo nuestro fue RENOMBRADO (sigue
    // existiendo por ID, ya sin nombre propio) y un sustituto tomó el nombre:
    // el cleanup elimina y verifica SÓLO nuestro ID, nunca al sustituto.
    const fakeB = fakeDocker();
    const ownershipB = new MinioOwnership({ exec: fakeB.exec, runId: "run-4b" });
    await ownershipB.snapshot();
    await ownershipB.create(IMAGE); // cid-1 en beta01-minio
    fakeB.hijackName("beta01-minio", { id: "cid-2", running: true, labels: {} });
    const cleanedB = await ownershipB.cleanup();
    check("c4b rename: cleanup removes OUR recorded ID", cleanedB.ok === true && /cid-1/.test(cleanedB.note || ""), cleanedB.note || "");
    check("c4b our renamed container gone (verified by ID)", !fakeB.byId.has("cid-1"));
    check("c4b substitute at the name intact", fakeB.containers.get("beta01-minio").Id === "cid-2");
    const rmsB = fakeB.events.filter((e) => e.startsWith("rm "));
    check("c4b rm ONLY our exact ID, never the substitute",
      rmsB.length === 1 && rmsB[0] === "rm -f cid-1", rmsB.join(" | ") || "(none)");

    const fake2 = fakeDocker();
    fake2.addContainer("beta01-minio", {
      id: "cid-9",
      running: true,
      health: "healthy",
      labels: { [FIXTURE_LABEL]: "true", [OWNER_LABEL]: OWNER, [RUN_LABEL]: "run-old" },
    });
    const ownership2 = new MinioOwnership({ exec: fake2.exec, runId: "run-4b" });
    const snap2 = await ownership2.snapshot();
    check("c4c reuse-path setup: reuse captured", snap2.mode === "reuse" && snap2.id === "cid-9", JSON.stringify(snap2));
    fake2.containers.get("beta01-minio").Id = "cid-7"; // el ID cambió durante la corrida
    const preUse = await ownership2.verify();
    check("c4c reuse-path ID change detected BEFORE use", preUse.ok === false && /cambió/.test(preUse.reason || ""), preUse.reason || "");
    const cleaned2 = await ownership2.cleanup();
    check("c4c reuse-path ID race -> cleanup FAIL", cleaned2.ok === false && /cambió/.test(cleaned2.reason || ""), cleaned2.reason || "");
    const raced2 = fake2.containers.get("beta01-minio");
    check("c4c reuse-path race container NOT touched", raced2 && raced2.Id === "cid-7" && raced2.State.Running === true);
    check("c4c reuse-path race ZERO mutating calls",
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

    // c5c: run falla DESPUÉS de crear (dejó contenedor con NUESTRAS labels):
    // CERO ADOPCIÓN — el run fallido no proporciona un ID propio, así que lo
    // aparecido ni se adopta ni se borra; el estado queda started=no y el
    // cleanup no elimina nada.
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
    check("c5c leftover with OUR labels NOT adopted (cero adopción)",
      ownershipC.state.started === "no" && ownershipC.state.createdId === null,
      `started=${ownershipC.state.started} createdId=${ownershipC.state.createdId}`);
    const cleanedC = await ownershipC.cleanup();
    check("c5c cleanup ok, leftover NOT deleted", cleanedC.ok === true, cleanedC.note || "");
    check("c5c leftover container still exists (no se adopta/borra lo aparecido)",
      fakeC.containers.has("beta01-minio"));
    check("c5c stranger coexisting container untouched",
      fakeC.containers.has("other-svc") && fakeC.containers.get("other-svc").Id === "cid-99");
    const rmsC = fakeC.events.filter((e) => e.startsWith("rm "));
    check("c5c ZERO rm calls", rmsC.length === 0, rmsC.join(" | ") || "(none)");

    // c5d: OTRA CORRIDA del MISMO owner (fixture+owner idénticos, RUN_LABEL
    // distinto) está en el nombre mientras nuestro run falla: el contenedor
    // ajeno con nuestros labels jamás se adopta ni se borra (la adopción vieja
    // lo habría borrado por no exigir RUN_LABEL=this.runId).
    const fakeD = fakeDocker();
    const ownershipD = new MinioOwnership({ exec: fakeD.exec, runId: "run-5d" });
    await ownershipD.snapshot(); // absent -> create
    fakeD.addContainer("beta01-minio", {
      id: "cid-66",
      running: true,
      health: "healthy",
      labels: { [FIXTURE_LABEL]: "true", [OWNER_LABEL]: OWNER, [RUN_LABEL]: "run-other" },
    });
    fakeD.set("failRun", true); // nuestro run falla; el de la otra corrida sigue ahí
    let createErrorD = null;
    try {
      await ownershipD.create(IMAGE);
    } catch (err) {
      createErrorD = err;
    }
    check("c5d other-run same owner: run failure reported", createErrorD !== null && /docker run failed/.test(createErrorD.message), createErrorD ? createErrorD.message : "no error");
    check("c5d other-run container NOT adopted",
      ownershipD.state.started === "no" && ownershipD.state.createdId === null,
      `started=${ownershipD.state.started} createdId=${ownershipD.state.createdId}`);
    const cleanedD = await ownershipD.cleanup();
    check("c5d cleanup ok, other-run container untouched", cleanedD.ok === true, cleanedD.note || "");
    const otherRun = fakeD.containers.get("beta01-minio");
    check("c5d other-run container intact (id + labels + running)",
      otherRun && otherRun.Id === "cid-66" &&
        otherRun.Config.Labels[FIXTURE_LABEL] === "true" &&
        otherRun.Config.Labels[OWNER_LABEL] === OWNER &&
        otherRun.Config.Labels[RUN_LABEL] === "run-other" &&
        otherRun.State.Running === true);
    const rmsD = fakeD.events.filter((e) => e.startsWith("rm "));
    check("c5d ZERO rm calls", rmsD.length === 0, rmsD.join(" | ") || "(none)");
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

  // -------------------------------------------------------------------------
  // c7 — fallo de INSPECT post-run (carrera run->inspect): el ID devuelto por
  // `docker run` se persiste (started=pending + createdId) ANTES del inspect;
  // si el inspect posterior falla, el cleanup del trap elimina/verifica SÓLO
  // ese ID y nunca toca lo que ahora tenga el nombre.
  // -------------------------------------------------------------------------
  {
    const statePath = path.join(TMP_DIR, "c7-state.json");
    const fake = fakeDocker();
    const ownership = new MinioOwnership({ exec: fake.exec, runId: "run-7", statePath });
    await ownership.snapshot(); // absent -> create (persiste started=no)
    fake.failInspect(1); // el inspect POST-run falla con error de daemon
    let createError = null;
    try {
      await ownership.create(IMAGE);
    } catch (err) {
      createError = err;
    }
    check("c7 post-run inspect failure reported",
      createError !== null && /docker inspect failed/.test(createError.message),
      createError ? createError.message : "no error");
    const persisted = JSON.parse(fs.readFileSync(statePath, "utf8"));
    check("c7 createdId+started=pending persisted BEFORE inspect",
      persisted.started === "pending" && persisted.createdId === "cid-1",
      `started=${persisted.started} createdId=${persisted.createdId}`);
    // El trap corre --cleanup en un proceso nuevo que lee el MISMO state file.
    const trap = new MinioOwnership({ exec: fake.exec, statePath });
    const cleaned = await trap.cleanup();
    check("c7 trap cleanup ok, removes ONLY recorded ID", cleaned.ok === true && /cid-1/.test(cleaned.note || ""), cleaned.note || "");
    check("c7 container gone (verified by ID)", fake.containers.size === 0 && fake.byId.size === 0);
    const rms = fake.events.filter((e) => e.startsWith("rm "));
    check("c7 rm exact created ID only", rms.length === 1 && rms[0] === "rm -f cid-1", rms.join(" | "));
  }

  // -------------------------------------------------------------------------
  // c8 — fallo de SAVE post-run: el persist started=pending + createdId ya
  // está en disco ANTES del inspect; si el save final (started=yes) falla, el
  // cleanup del trap sigue eliminando y verificando SÓLO ese ID.
  // -------------------------------------------------------------------------
  {
    const statePath = path.join(TMP_DIR, "c8-state.json");
    const fake = fakeDocker();
    const ownership = new MinioOwnership({ exec: fake.exec, runId: "run-8", statePath });
    await ownership.snapshot(); // absent -> create (persiste started=no)
    const realSave = ownership.saveState.bind(ownership);
    ownership.saveState = function () {
      if (ownership.state.started === "yes") throw new Error("fake: disk full (save started=yes)");
      return realSave();
    };
    let createError = null;
    try {
      await ownership.create(IMAGE);
    } catch (err) {
      createError = err;
    }
    check("c8 post-run save failure reported",
      createError !== null && /disk full/.test(createError.message),
      createError ? createError.message : "no error");
    const persisted = JSON.parse(fs.readFileSync(statePath, "utf8"));
    check("c8 disk kept pending+createdId (trap still owns the ID)",
      persisted.started === "pending" && persisted.createdId === "cid-1",
      `started=${persisted.started} createdId=${persisted.createdId}`);
    const trap = new MinioOwnership({ exec: fake.exec, statePath });
    const cleaned = await trap.cleanup();
    check("c8 trap cleanup ok, removes ONLY recorded ID", cleaned.ok === true && /cid-1/.test(cleaned.note || ""), cleaned.note || "");
    check("c8 container gone (verified by ID)", fake.containers.size === 0);
    const rms = fake.events.filter((e) => e.startsWith("rm "));
    check("c8 rm exact created ID only", rms.length === 1 && rms[0] === "rm -f cid-1", rms.join(" | "));
  }

  // -------------------------------------------------------------------------
  // c9 — DRIFT de health del preexistente (reuse): el snapshot guarda health
  // crudo; verify/cleanup comparan byte-a-byte y FAIL sin mutar nada.
  // -------------------------------------------------------------------------
  {
    const fake = fakeDocker();
    fake.addContainer("beta01-minio", {
      id: "cid-9",
      running: true,
      health: "healthy",
      labels: { [FIXTURE_LABEL]: "true", [OWNER_LABEL]: OWNER, [RUN_LABEL]: "run-old" },
    });
    const ownership = new MinioOwnership({ exec: fake.exec, runId: "run-9" });
    const snap = await ownership.snapshot();
    check("c9 reuse snapshot records id/running/health/labels byte-by-byte",
      snap.mode === "reuse" &&
        ownership.state.preexistingId === "cid-9" &&
        ownership.state.preexistingRunning === true &&
        ownership.state.preexistingHealthy === "healthy" &&
        ownership.state.preexistingLabels[RUN_LABEL] === "run-old",
      JSON.stringify(ownership.state));
    fake.containers.get("beta01-minio").State.Health.Status = "unhealthy"; // drift durante la corrida
    const verified = await ownership.verify();
    check("c9 health drift detected BEFORE use",
      verified.ok === false && /health cambió/.test(verified.reason || ""),
      verified.reason || "no drift");
    const cleaned = await ownership.cleanup();
    check("c9 health drift -> cleanup FAIL sin mutar",
      cleaned.ok === false && /health cambió/.test(cleaned.reason || ""),
      cleaned.reason || "");
    const doc = fake.containers.get("beta01-minio");
    check("c9 drifted preexisting never stopped/removed/altered",
      doc && doc.Id === "cid-9" && doc.State.Running === true);
    check("c9 ZERO mutating docker calls",
      mutatingEvents(fake.events).length === 0,
      mutatingEvents(fake.events).join(" | ") || "(none)");
  }

  // -------------------------------------------------------------------------
  // c10 — DRIFT de labels del preexistente (reuse): fixture/owner/run se
  // comparan byte-a-byte contra el snapshot; cualquier cambio -> FAIL sin
  // mutar (y health ausente se guarda como null, sin inventar "healthy").
  // -------------------------------------------------------------------------
  {
    const fake = fakeDocker();
    fake.addContainer("beta01-minio", {
      id: "cid-9",
      running: true,
      health: null,
      labels: { [FIXTURE_LABEL]: "true", [OWNER_LABEL]: OWNER, [RUN_LABEL]: "run-old" },
    });
    const ownership = new MinioOwnership({ exec: fake.exec, runId: "run-10" });
    await ownership.snapshot(); // reuse (health null == running ok)
    check("c10 snapshot saves RAW health and labels byte-by-byte",
      ownership.state.preexistingHealthy === null &&
        ownership.state.preexistingLabels[FIXTURE_LABEL] === "true" &&
        ownership.state.preexistingLabels[OWNER_LABEL] === OWNER &&
        ownership.state.preexistingLabels[RUN_LABEL] === "run-old",
      JSON.stringify(ownership.state));
    fake.containers.get("beta01-minio").Config.Labels[RUN_LABEL] = "run-other"; // otra corrida reetiquetó
    const verified = await ownership.verify();
    check("c10 run-label drift detected BEFORE use",
      verified.ok === false && /label com.mike.beta01.run cambió/.test(verified.reason || ""),
      verified.reason || "no drift");
    const cleaned = await ownership.cleanup();
    check("c10 run-label drift -> cleanup FAIL sin mutar",
      cleaned.ok === false && /label com.mike.beta01.run cambió/.test(cleaned.reason || ""),
      cleaned.reason || "");
    const doc = fake.containers.get("beta01-minio");
    check("c10 drifted preexisting never stopped/removed",
      doc && doc.Id === "cid-9" && doc.State.Running === true);
    check("c10 ZERO mutating docker calls",
      mutatingEvents(fake.events).length === 0,
      mutatingEvents(fake.events).join(" | ") || "(none)");

    // variante: la label de fixture desaparece -> mismo FAIL byte-a-byte.
    const fakeB = fakeDocker();
    fakeB.addContainer("beta01-minio", {
      id: "cid-9",
      running: true,
      health: null,
      labels: { [FIXTURE_LABEL]: "true", [OWNER_LABEL]: OWNER, [RUN_LABEL]: "run-old" },
    });
    const ownershipB = new MinioOwnership({ exec: fakeB.exec, runId: "run-10b" });
    await ownershipB.snapshot(); // reuse
    delete fakeB.containers.get("beta01-minio").Config.Labels[FIXTURE_LABEL];
    const cleanedB = await ownershipB.cleanup();
    check("c10b fixture-label drift -> cleanup FAIL sin mutar",
      cleanedB.ok === false && /label com.mike.beta01.fixture cambió/.test(cleanedB.reason || ""),
      cleanedB.reason || "no drift");
    const docB = fakeB.containers.get("beta01-minio");
    check("c10b fixture-less preexisting intact (not altered)",
      docB && docB.Id === "cid-9" && docB.State.Running === true);
    check("c10b ZERO mutating docker calls",
      mutatingEvents(fakeB.events).length === 0,
      mutatingEvents(fakeB.events).join(" | ") || "(none)");
  }

  check("final: zero failures", failures === 0, `${failures} failures`);
  process.exit(failures === 0 ? 0 : 1);
}

function ownershipStarted(stateFile) {
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