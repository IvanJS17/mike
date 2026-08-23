"use strict";
// Beta 0.1 — Supabase DISPOSABLE stack ownership (Gate 2 fix C).
//
// The AI smoke spec must never reuse/reset/stop a preexisting local Supabase
// stack nor mutate its terminal rows: the runner starts a DISPOSABLE CLI stack
// with a UNIQUE project_id + ports + workdir under SMOKE_DIR (config derived
// from the canonical backend/supabase/config.toml) and this module records the
// EXACT docker resources that belong to that disposable project — using the
// CLI's own label (com.supabase.cli.project=<project_id>) and docker IDs — and
// destroys ONLY those resources in the teardown trap, even when the start
// failed partway, while verifying that every preexisting Supabase stack kept
// the same containers/volumes/network IDs and state byte-by-byte.
//
// Decisions are persisted in a state file between CLI invocations; stdout
// carries ONLY JSON; diagnostics go to stderr so the runner can tee them.
//
//   node beta01-supabase-owner.cjs --snapshot --project-id PID --state-file F
//   node beta01-supabase-owner.cjs --record --state-file F
//   node beta01-supabase-owner.cjs --cleanup --state-file F
//
// Docker interactions go through an injectable
// `exec(argv) -> { status, stdout, stderr }` so the contractual test
// (scripts/test-beta01-supabase-disposable.sh) runs this exact module against
// a fake docker daemon with ZERO network.
//
// Gate 2 fix E — IDs canónicos full: `docker ps` expone IDs TRUNCADOS (12
// chars); NUNCA se persisten ni se comparan contra el Id full (64 chars) de
// `docker inspect`. Cada candidato del listado se resuelve vía `docker
// container inspect` y se guarda el ID canónico full 64-char + name/labels/
// state; un prefix ambiguo (dos contenedores comparten el prefix corto) o un
// candidato que desaparece entre `ps` e `inspect` es un FAIL fail-closed,
// nunca una adivinanza. El snapshot es read-only: sólo ps/inspect, cero
// mutaciones.
//
// Gate 2 fix F — volumen ausente en DOS formatos: el CLI clásico emite
// "No such volume: <name>" y el daemon API real "get <name>: no such volume";
// ambos (case/whitespace razonables) se interpretan como ABSENCIA y sólo
// cuando el inspect devolvió status≠0; daemon caído/permisos siguen FAIL.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");

const LABEL = "com.supabase.cli.project";

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

// Docker spells "inspect target does not exist" per resource type; those
// spellings mean ABSENCE and map to null/false. Daemon/permission/connection
// errors contain none of them and keep throwing.
//
// Gate 2 fix F — volumen ausente: el daemon docker real emite DOS textos
// distintos: el CLI clásico "No such volume: <name>" y el de la API real
// "get <name>: no such volume" (case/whitespace razonables). Ambos se
// interpretan como ABSENCIA, y sólo cuando el inspect devolvió status≠0 (el
// llamador únicamente consulta este matcher en ese caso). Errores de
// daemon/permisos/conexión no contienen esos textos y siguen siendo FAIL.
function isAbsentStderr(stderr, kind) {
  const patterns = {
    container: /no such (?:container|object):\s*\S+/i,
    volume: /(?:no such volume\s*:\s*\S+|get\s+\S+\s*:\s*no such volume)/i,
    network: /no such network:\s*\S+/i,
  };
  return patterns[kind].test(String(stderr || ""));
}

// Docker rejects a PREFIX that matches more than one container with
// "Multiple IDs found with provided prefix: <ref>". That is AMBIGUITY, not
// absence: the caller must fail closed instead of guessing which full ID the
// short prefix refers to.
function isAmbiguousStderr(stderr) {
  return /multiple ids? found with provided prefix/i.test(String(stderr || ""));
}

// Canonical Docker container IDs are 64 lowercase hex chars (`docker inspect`
// `.Id`). A short id from `docker ps` (12 chars) is NEVER a valid identity
// for compare/remove: it is only ever used as a lookup ref into inspect.
function isFullId(id) {
  return /^[0-9a-f]{64}$/i.test(String(id || ""));
}

class SupabaseDisposableOwnership {
  constructor(options = {}) {
    this.exec = options.exec || realDocker;
    this.projectId = options.projectId || "";
    this.statePath = options.statePath || null;
    this.state = null;
  }

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

  ownLabelFilter() {
    return `label=${LABEL}=${this.projectId}`;
  }

  anyLabelFilter() {
    return `label=${LABEL}`;
  }

  // ---------------------------------------------------------------------------
  // Docker primitives (container/volume/network)
  // ---------------------------------------------------------------------------
  async listContainers(filter) {
    const r = await this.exec([
      "ps", "-a", "--filter", filter,
      "--format", "{{.Names}}\t{{.ID}}\t{{.Status}}",
    ]);
    if (r.status !== 0) {
      throw new Error(`docker ps falló (status ${r.status}): ${firstLine(r.stderr)}`);
    }
    return String(r.stdout || "")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, id, status] = line.split("\t");
        return { name, id: id || "", running: /^Up/i.test(status || "") };
      });
  }

  // ---------------------------------------------------------------------------
  // listContainersCanonical: los IDs de `docker ps` vienen TRUNCADOS (12
  // chars). Nada de lo que se persiste/compare puede ser ese prefix: cada
  // candidato se resuelve vía `docker container inspect` y se guarda el ID
  // canónico full 64-char + name/labels/state. Un prefix ambiguo (dos full
  // ids comparten el prefix corto) o un candidato que desaparece entre `ps`
  // e `inspect` falla fail-closed — nunca se persiste un prefix ni se
  // adivina el full id.
  // ---------------------------------------------------------------------------
  async listContainersCanonical(filter) {
    const listed = await this.listContainers(filter);
    const canonical = [];
    for (const c of listed) {
      const info = await this.inspectContainer(c.id);
      if (info === null) {
        throw new Error(
          `race en listado: ${c.name} (ps ${c.id}) desapareció antes de resolver ` +
            "el ID canónico via inspect — fail-closed, no se persiste nada"
        );
      }
      if (!isFullId(info.id)) {
        throw new Error(
          `docker inspect devolvió ID no canónico para ${c.name}: '${info.id}' ` +
            "(se espera full 64-hex) — fail-closed"
        );
      }
      canonical.push(info);
    }
    return canonical;
  }

  async listVolumes(filter) {
    const r = await this.exec(["volume", "ls", "--filter", filter, "--format", "{{.Name}}"]);
    if (r.status !== 0) {
      throw new Error(`docker volume ls falló (status ${r.status}): ${firstLine(r.stderr)}`);
    }
    return String(r.stdout || "").split("\n").filter(Boolean);
  }

  async listNetworks(filter) {
    const r = await this.exec(["network", "ls", "--filter", filter, "--format", "{{.Name}}"]);
    if (r.status !== 0) {
      throw new Error(`docker network ls falló (status ${r.status}): ${firstLine(r.stderr)}`);
    }
    return String(r.stdout || "").split("\n").filter(Boolean);
  }

  // null -> the container does not exist (Docker 404). By ID or by name.
  async inspectContainer(ref) {
    const r = await this.exec(["container", "inspect", ref]);
    if (r.status === 0) {
      let parsed;
      try {
        parsed = JSON.parse(r.stdout || "");
      } catch (err) {
        throw new Error(`docker inspect devolvió JSON inválido: ${firstLine(r.stdout)}`);
      }
      const obj = parsed && parsed[0];
      if (!obj) return null;
      return {
        id: typeof obj.Id === "string" ? obj.Id : "",
        name: String(obj.Name || "").replace(/^\//, ""),
        running: Boolean(obj.State && obj.State.Running),
        labels: obj.Config && obj.Config.Labels ? obj.Config.Labels : {},
      };
    }
    if (isAbsentStderr(r.stderr, "container")) return null;
    if (isAmbiguousStderr(r.stderr)) {
      throw new Error(
        `docker container inspect ambiguo para '${ref}': el prefix corto coincide ` +
          `con varios contenedores (${firstLine(r.stderr)}) — FAIL fail-closed, ` +
          "no se resuelve por adivinanza ni se persiste/compara/elimina nada"
      );
    }
    throw new Error(`docker container inspect falló (status ${r.status}): ${firstLine(r.stderr)}`);
  }

  async volumeExists(name) {
    const r = await this.exec(["volume", "inspect", name]);
    if (r.status === 0) return true;
    if (isAbsentStderr(r.stderr, "volume")) return false;
    throw new Error(`docker volume inspect falló (status ${r.status}): ${firstLine(r.stderr)}`);
  }

  async networkExists(name) {
    const r = await this.exec(["network", "inspect", name]);
    if (r.status === 0) return true;
    if (isAbsentStderr(r.stderr, "network")) return false;
    throw new Error(`docker network inspect falló (status ${r.status}): ${firstLine(r.stderr)}`);
  }

  async removeContainer(id) {
    const r = await this.exec(["rm", "-f", id]);
    if (r.status !== 0) {
      throw new Error(`docker rm -f falló (status ${r.status}): ${firstLine(r.stderr)}`);
    }
    const after = await this.inspectContainer(id);
    if (after !== null) {
      throw new Error("tras docker rm -f el contenedor aún existe (verificado por ID)");
    }
  }

  async removeVolume(name) {
    const r = await this.exec(["volume", "rm", name]);
    if (r.status !== 0) {
      throw new Error(`docker volume rm falló (status ${r.status}): ${firstLine(r.stderr)}`);
    }
    if (await this.volumeExists(name)) {
      throw new Error("tras docker volume rm el volumen aún existe");
    }
  }

  async removeNetwork(name) {
    const r = await this.exec(["network", "rm", name]);
    if (r.status !== 0) {
      throw new Error(`docker network rm falló (status ${r.status}): ${firstLine(r.stderr)}`);
    }
    if (await this.networkExists(name)) {
      throw new Error("tras docker network rm la network aún existe");
    }
  }

  // ---------------------------------------------------------------------------
  // snapshot: decision BEFORE any mutation. If ANY resource already carries
  // OUR unique project label, a stale/racing stack owns that project id:
  // mode=fail, nothing is touched and the run aborts. Otherwise mode=create
  // and the PRE state of every OTHER Supabase-CLI-labeled resource (containers
  // with name+id+running, volumes, networks) is recorded so the teardown can
  // prove byte-by-byte that no preexisting stack was altered.
  // ---------------------------------------------------------------------------
  async snapshot() {
    if (!this.projectId) throw new Error("--snapshot requiere --project-id");

    // SIEMPRE IDs canónicos full: `docker ps` da prefixes truncados (12
    // chars); cada candidato se resuelve vía inspect (read-only) y se guarda
    // el full 64-hex + name/labels/state. Un prefix ambiguo o un candidato
    // que desaparece entre ps e inspect falla aquí, antes de persistir nada.
    const ownContainers = await this.listContainersCanonical(this.ownLabelFilter());
    const ownVolumes = await this.listVolumes(this.ownLabelFilter());
    const ownNetworks = await this.listNetworks(this.ownLabelFilter());
    const owned = ownContainers.length + ownVolumes.length + ownNetworks.length;

    if (owned > 0) {
      const reason =
        `el project ${this.projectId} ya tiene recursos en docker ` +
        `(containers=${ownContainers.length}, volumes=${ownVolumes.length}, ` +
        `networks=${ownNetworks.length}) — stack ajeno o residuo de otra corrida; ` +
        "FAIL fail-closed: no se reutiliza, resetea ni toca";
      this.state = {
        mode: "fail",
        projectId: this.projectId,
        pre: null,
        recorded: null,
        owned: { containers: ownContainers, volumes: ownVolumes, networks: ownNetworks },
        reason,
      };
      this.saveState();
      return { mode: "fail", reason };
    }

    this.state = {
      mode: "create",
      projectId: this.projectId,
      started: false,
      pre: {
        containers: await this.listContainersCanonical(this.anyLabelFilter()),
        volumes: await this.listVolumes(this.anyLabelFilter()),
        networks: await this.listNetworks(this.anyLabelFilter()),
      },
      recorded: null,
      reason: null,
    };
    this.saveState();
    return { mode: "create", projectId: this.projectId };
  }

  // ---------------------------------------------------------------------------
  // record: after `supabase start` succeeded. Captures the EXACT docker
  // resources bearing our project label; requires at least one container
  // (a "successful" start that created nothing is a failed contract, never an
  // empty ownership). Every later cleanup verifies/removes only these IDs.
  // ---------------------------------------------------------------------------
  async record() {
    this.ensureState();
    if (!this.state || this.state.mode !== "create") {
      throw new Error("record() requiere un snapshot que decidió mode=create");
    }
    // El CLI de record/cleanup no recibe --project-id: la identidad SIEMPRE
    // sale del estado durable (única fuente de verdad del ownership).
    this.projectId = this.state.projectId || this.projectId;
    // IDs canónicos full (ps truncado -> inspect full); un prefix ambiguo
    // entre los containers del stack aborta el record fail-closed.
    const containers = await this.listContainersCanonical(this.ownLabelFilter());
    if (containers.length === 0) {
      throw new Error(
        `supabase start no creó contenedores con ${this.ownLabelFilter()} — ` +
          "sin ownership que registrar; se aborta la corrida"
      );
    }
    const volumes = await this.listVolumes(this.ownLabelFilter());
    const networks = await this.listNetworks(this.ownLabelFilter());
    this.state.recorded = { containers, volumes, networks };
    this.state.started = true;
    this.saveState();
    return {
      recorded: true,
      projectId: this.state.projectId || this.projectId,
      containers: containers.length,
      volumes: volumes.length,
      networks: networks.length,
    };
  }

  // ---------------------------------------------------------------------------
  // cleanup: teardown contract, safe under partial failure:
  //   - fail-mode      -> the foreign stack with our label was never touched;
  //                       verified intact (same ids/names), nothing deleted;
  //   - create-mode    -> 1) every PREEXISTING labeled resource verified with
  //                       the SAME id/name/running state (any drift = FAIL);
  //                       2) RECORDED containers removed BY RECORDED ID after
  //                       re-verifying id+name+label (a substitute holding the
  //                       name, or a drift, = FAIL without deleting anything);
  //                       3) unrecorded sweep for partial starts: resources
  //                       with our label that were never recorded can only
  //                       have been created by THIS run (snapshot proved none
  //                       existed before), but are destroyed only when they
  //                       match the CLI naming pattern supabase_*_<pid> —
  //                       anything else fails closed, never deleted;
  //                       4) recorded+unrecorded volumes and networks removed
  //                       and verified gone; 5) FINAL: zero own resources.
  // ---------------------------------------------------------------------------
  async cleanup() {
    this.ensureState();
    if (!this.state) {
      return { ok: true, note: "sin estado de ownership — no se elimina nada" };
    }
    // Igual que record(): la identidad del proyecto sale SIEMPRE del estado.
    this.projectId = this.state.projectId || this.projectId;
    const projectId = this.state.projectId;

    if (this.state.mode === "fail") {
      const owned = this.state.owned || { containers: [], volumes: [], networks: [] };
      const problems = [];
      for (const c of owned.containers) {
        // Estado viejo podría persistir prefixes truncados: nunca se comparan
        // ni se usan como identidad (12 vs 64 sería siempre distinto).
        if (!isFullId(c.id)) {
          problems.push(`contenedor ${c.name} con ID no canónico persistido (${c.id}) — no se compara ni elimina`);
          continue;
        }
        const info = await this.inspectContainer(c.id);
        if (info === null || info.id !== c.id || info.name !== c.name) {
          problems.push(`contenedor ${c.name} (esperado ${c.id}) no está igual`);
        }
      }
      for (const v of owned.volumes) {
        if (!(await this.volumeExists(v))) problems.push(`volumen ${v} no está igual`);
      }
      for (const n of owned.networks) {
        if (!(await this.networkExists(n))) problems.push(`network ${n} no está igual`);
      }
      if (problems.length) {
        return { ok: false, reason: `fail-mode: recursos del project ${projectId} alterados: ${problems.join("; ")}` };
      }
      return { ok: true, note: `fail-mode: project ${projectId} ajeno — no se tocó nada (verificado intacto)` };
    }

    if (this.state.mode !== "create") {
      return { ok: true, note: "modo de estado desconocido — no se elimina nada" };
    }

    const recorded = this.state.recorded || { containers: [], volumes: [], networks: [] };
    const problems = [];

    // 1) Preexisting stacks: same IDs/state, byte-by-byte.
    for (const c of this.state.pre.containers) {
      const info = await this.inspectContainer(c.id);
      if (info === null) {
        problems.push(`preexistente ${c.name} (ID ${c.id}) desapareció durante la corrida`);
      } else if (info.id !== c.id || info.name !== c.name) {
        problems.push(`preexistente ${c.name}: ID/name distinto (esperado ${c.id}/${c.name}, actual ${info.id}/${info.name})`);
      } else if (info.running !== c.running) {
        problems.push(`preexistente ${c.name}: estado cambió (snapshot=${c.running}, actual=${info.running})`);
      }
    }
    for (const v of this.state.pre.volumes) {
      if (!(await this.volumeExists(v))) problems.push(`preexistente volumen ${v} desapareció`);
    }
    for (const n of this.state.pre.networks) {
      if (!(await this.networkExists(n))) problems.push(`preexistente network ${n} desapareció`);
    }
    if (problems.length) {
      return { ok: false, reason: `preexistente alterado: ${problems.join("; ")} — no se borra nada propio` };
    }

    // 2) Recorded containers: verify, then remove BY RECORDED FULL ID only.
    const recordedIds = new Set(recorded.containers.map((c) => c.id));
    for (const rec of recorded.containers) {
      // Sólo full 64-hex es una identidad válida para comparar/eliminar; un
      // prefix truncado en el estado (versión vieja) aborta fail-closed.
      if (!isFullId(rec.id)) {
        return {
          ok: false,
          reason: `ID no canónico en estado registrado: ${rec.id} para ${rec.name} (se espera full 64-hex) — fail-closed, no se borra nada`,
        };
      }
      const info = await this.inspectContainer(rec.id);
      if (info === null) {
        const byName = await this.inspectContainer(rec.name);
        if (byName !== null) {
          return {
            ok: false,
            reason: `ID race: ${rec.name} está en manos de otro contenedor (ID ${byName.id} ≠ creado ${rec.id}) — no se borra, se aborta el cleanup`,
          };
        }
        continue; // already gone — verified by recorded ID, nothing owned remains
      }
      if (info.id !== rec.id || info.name !== rec.name || info.labels[LABEL] !== projectId) {
        return {
          ok: false,
          reason: `ID/label race: contenedor con ID ${rec.id} ya no es ${rec.name}/${LABEL}=${projectId} (actual ${info.name}/${info.labels[LABEL]}) — no se borra, se aborta`,
        };
      }
      await this.removeContainer(rec.id);
      const nameAfter = await this.inspectContainer(rec.name);
      if (nameAfter !== null) {
        return {
          ok: false,
          reason: `ID race tras rm: ${rec.name} reapareció en manos de otro contenedor (ID ${nameAfter.id}) — no se borra`,
        };
      }
    }

    // 3) Unrecorded sweep (partial start / record never ran): only resources
    //    that match the CLI naming pattern AND our label are ours to destroy.
    //    Listado canónico: full IDs (ps truncado -> inspect), nunca prefixes.
    const expectedName = (name) => name.startsWith("supabase_") && name.endsWith(`_${projectId}`);
    for (const c of await this.listContainersCanonical(this.ownLabelFilter())) {
      if (recordedIds.has(c.id)) continue;
      if (c.labels[LABEL] !== projectId) {
        return {
          ok: false,
          reason: `sweep fail-closed: contenedor ${c.name} (${c.id}) no verifica label ${LABEL}=${projectId} — no se borra`,
        };
      }
      if (!expectedName(c.name)) {
        return {
          ok: false,
          reason: `sweep fail-closed: contenedor ${c.name} lleva el label del proyecto pero no el patrón supabase_*_${projectId} — no se borra`,
        };
      }
      await this.removeContainer(c.id);
    }

    // 4) Volumes (recorded + unrecorded sweep).
    for (const v of recorded.volumes) {
      if (await this.volumeExists(v)) await this.removeVolume(v);
    }
    for (const v of await this.listVolumes(this.ownLabelFilter())) {
      if (recorded.volumes.includes(v)) continue;
      if (!expectedName(v)) {
        return { ok: false, reason: `sweep fail-closed: volumen ${v} con label del proyecto pero nombre no coincide — no se borra` };
      }
      await this.removeVolume(v);
    }

    // 5) Networks (recorded + unrecorded sweep).
    for (const n of recorded.networks) {
      if (await this.networkExists(n)) await this.removeNetwork(n);
    }
    for (const n of await this.listNetworks(this.ownLabelFilter())) {
      if (recorded.networks.includes(n)) continue;
      if (!expectedName(n)) {
        return { ok: false, reason: `sweep fail-closed: network ${n} con label del proyecto pero nombre no coincide — no se borra` };
      }
      await this.removeNetwork(n);
    }

    // 6) Zero own resources after.
    const rest = {
      containers: await this.listContainers(this.ownLabelFilter()),
      volumes: await this.listVolumes(this.ownLabelFilter()),
      networks: await this.listNetworks(this.ownLabelFilter()),
    };
    if (rest.containers.length || rest.volumes.length || rest.networks.length) {
      return {
        ok: false,
        reason: `quedan recursos propios tras cleanup (c=${rest.containers.length}, v=${rest.volumes.length}, n=${rest.networks.length})`,
      };
    }
    return {
      ok: true,
      note: `stack disposable ${projectId} destruido — containers/volumes/network propios en cero, preexistentes intactos`,
    };
  }
}

// ---------------------------------------------------------------------------
// CLI surface (stdout carries ONLY JSON; stderr carries free-form diagnostics)
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { command: null, projectId: "", stateFile: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--snapshot") opts.command = "snapshot";
    else if (arg === "--record") opts.command = "record";
    else if (arg === "--cleanup") opts.command = "cleanup";
    else if (arg === "--project-id") {
      opts.projectId = argv[i + 1] || "";
      i += 1;
    } else if (arg === "--state-file") {
      opts.stateFile = argv[i + 1] || null;
      i += 1;
    } else {
      throw new Error(`argumento desconocido: ${arg}`);
    }
  }
  if (opts.command === null) {
    throw new Error("falta comando (--snapshot|--record|--cleanup)");
  }
  return opts;
}

function runCli(argv, execOverride) {
  const opts = parseArgs(argv);
  const ownership = new SupabaseDisposableOwnership({
    exec: execOverride || realDocker,
    projectId: opts.projectId,
    statePath: opts.stateFile,
  });

  if (opts.command === "snapshot") {
    return ownership
      .snapshot()
      .then((out) => ({ exitCode: 0, output: out }))
      .catch((err) => ({ exitCode: 1, output: { error: err.message } }));
  }
  if (opts.command === "record") {
    return ownership
      .record()
      .then((out) => ({ exitCode: 0, output: out }))
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

module.exports = { SupabaseDisposableOwnership, runCli, LABEL };

if (require.main === module) main(process.argv.slice(2));