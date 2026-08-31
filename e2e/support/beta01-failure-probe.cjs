"use strict";

// Beta 0.1 — probe de fallo de la ejecución IA (Gate 2, Gate 2 probe).
//
// Cuando el POST /projects/:id/ai-executions responde 422, el spec escribe
// ANTES del teardown (finally) un probe JSON saneado dentro de SMOKE_DIR
// (gate2-ai-failure-probe.json, modo 0600) que discrimina el path de fallo
// combinando error_class con los contadores del fake provider:
//   disk  -> provider_calls=0 + citation_unresolvable
//   prov  -> provider_calls=1 + provider_error
//   cit   -> provider_calls=1 + citation_unresolvable
//   empty -> provider_calls=1 + provider_output_empty
//   revok -> provider_calls=1 + authorization_revoked
//   other -> cualquier otra combinación (siempre etiquetada, nunca silenciada)
//
// REGLAS DE REDACCIÓN (hard): el probe NUNCA incluye tokens, API keys,
// texto/quotes de documentos, PII, ni ids crudos completos. Sólo se persiste:
// status HTTP, `code` de la respuesta (string), status/error_class de la
// ejecución, error_class del receipt, contadores, y ids PREFIJADOS y
// TRUNCADOS a los últimos 8 caracteres hex (p.ej. "exec:1a2b3c4d"); la
// ausencia de receipt o de state file se registra explícitamente (nunca una
// excepción pierde la evidencia).
//
// El contract test (scripts/test-beta01-failure-probe.sh) lo ejercita con
// Node puro y cero red: los 5 paths de discriminación, la ausencia de
// receipt/state y la redacción de secretos.

const PROBE_FILENAME = "gate2-ai-failure-probe.json";
const PROBE_KIND = "gate2-ai-failure-probe";
const PROBE_VERSION = 1;

// Discriminación pura: (provider_calls, error_class) -> path. Devuelve una de
// las 5 etiquetas del contrato; cualquier combinación fuera de ellas cae en
// "other" (nunca null: una corrida fallida siempre se clasifica).
function classifyFailure(providerCalls, errorClass) {
  const calls =
    providerCalls === null || providerCalls === undefined
      ? null
      : Number(providerCalls);
  const cls = typeof errorClass === "string" ? errorClass : "";
  if (calls === 0 && cls === "citation_unresolvable") return "calls0_citation";
  if (calls === 1) {
    if (cls === "provider_error") return "calls1_provider";
    if (cls === "citation_unresolvable") return "calls1_citation";
    if (cls === "provider_output_empty") return "calls1_empty";
    if (cls === "authorization_revoked") return "calls1_revoked";
  }
  return "other";
}

function lastHexTail(value, length) {
  if (typeof value !== "string" || !value.trim()) return null;
  const hex = value.toLowerCase().replace(/[^a-f0-9]/g, "");
  return hex.length > 0 ? hex.slice(-length) : null;
}

function optionalString(value) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function toCount(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

// Saneado de la respuesta POST: NUNCA se copia el body crudo ni sus campos
// de texto (detail, mensajes, quotes). Sólo el code string (p.ej.
// "citation_unresolvable") y los campos de la ejecución fallida; los ids se
// prefijan y truncan. Un body no-objeto o ausente produce nulls explícitos.
function sanitizePostBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {
      code: null,
      execution: { id: null, status: null, error_class: null },
    };
  }
  const record = body;
  return {
    code: optionalString(record.code),
    execution: {
      id: lastHexTail(record.id, 8) ? "exec:" + lastHexTail(record.id, 8) : null,
      status: optionalString(record.status),
      error_class: optionalString(record.error_class),
    },
  };
}

// Saneado del receipt: sólo canonical_json.result.status/error_class; el
// resto del receipt (hashes, timing, route, citations) NO se persiste.
function sanitizeReceipt(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    return { present: false, status: null, error_class: null };
  }
  const canonical =
    receipt.canonical_json &&
    typeof receipt.canonical_json === "object" &&
    !Array.isArray(receipt.canonical_json)
      ? receipt.canonical_json
      : null;
  const result =
    canonical && canonical.result && typeof canonical.result === "object"
      ? canonical.result
      : null;
  if (!result) return { present: true, status: null, error_class: null };
  return {
    present: true,
    status: optionalString(result.status),
    error_class: optionalString(result.error_class),
  };
}

// Saneado del fake state: SÓLO los contadores provider/drive; los campos de
// archivos/contenido (drive_files) jamás se persisten. Estado ausente/ilegible
// se registra con present:false y contadores null (la evidencia no se pierde).
function sanitizeFakeState(fakeState) {
  if (!fakeState || typeof fakeState !== "object" || Array.isArray(fakeState)) {
    return {
      present: false,
      provider_calls: null,
      drive_upload_calls: null,
    };
  }
  return {
    present: true,
    provider_calls: toCount(fakeState.provider_calls),
    drive_upload_calls: toCount(fakeState.drive_upload_calls),
  };
}

// Construye el probe completo SANEADO a partir de entradas ya leídas por el
// spec (respuesta POST parseada, receipt del endpoint, state file parseado).
// Función pura: no toca filesystem ni red.
function buildFailureProbe(inputs) {
  const post = sanitizePostBody(inputs && inputs.postBody);
  const receipt = sanitizeReceipt(
    inputs && inputs.receipt !== undefined ? inputs.receipt : null,
  );
  const fakeState = sanitizeFakeState(
    inputs && inputs.fakeState !== undefined ? inputs.fakeState : null,
  );
  const errorClass =
    post.execution.error_class !== null
      ? post.execution.error_class
      : receipt.error_class;
  const discrimination = classifyFailure(
    fakeState.provider_calls,
    errorClass,
  );
  const postStatus =
    inputs && typeof inputs.postStatus === "number"
      ? inputs.postStatus
      : null;
  return {
    probe_kind: PROBE_KIND,
    version: PROBE_VERSION,
    post: {
      status: postStatus,
      code: post.code,
    },
    execution: post.execution,
    receipt,
    counters: fakeState,
    discrimination,
  };
}

function probePath(smokeDir) {
  return require("node:path").join(smokeDir, PROBE_FILENAME);
}

// Escribe el probe como JSON con modo 0600 (crea el directorio si falta).
// Devuelve el path escrito. Sincrónico a propósito: el spec lo invoca ANTES
// del finally/teardown y un fallo aquí debe propagarse como error primario.
function writeFailureProbeSync(smokeDir, probe) {
  const fs = require("node:fs");
  const target = probePath(smokeDir);
  fs.mkdirSync(smokeDir, { recursive: true });
  fs.writeFileSync(target, JSON.stringify(probe, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  return target;
}

module.exports = {
  PROBE_FILENAME,
  PROBE_KIND,
  PROBE_VERSION,
  classifyFailure,
  buildFailureProbe,
  probePath,
  writeFailureProbeSync,
};