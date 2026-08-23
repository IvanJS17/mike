#!/usr/bin/env bash
#
# Contractual test for the Gate 2 failure probe
# (e2e/support/beta01-failure-probe.cjs), used by the AI smoke spec
# (e2e/beta01-ai-smoke.spec.ts) to preserve SANITIZED evidence when the POST
# /ai-executions responds 422 (before the finally/teardown destroys the
# stack).
#
# WITHOUT a live stack and with ZERO network (Node puro), proves:
#   c1. classifyFailure discriminación exacta de los 5 paths:
#       (0, citation_unresolvable)       -> calls0_citation
#       (1, provider_error)              -> calls1_provider
#       (1, citation_unresolvable)       -> calls1_citation
#       (1, provider_output_empty)       -> calls1_empty
#       (1, authorization_revoked)       -> calls1_revoked
#       cualquier otra combinación       -> other (nunca null)
#   c2. buildFailureProbe preserva status/code/status/error_class de la
#       ejecución y los contadores en los 5 paths;
#   c3. ausencia de receipt -> receipt.present=false y error_class=null;
#   c4. ausencia de state -> counters.present=false y contadores null;
#   c5. REDACCIÓN de secretos: el probe serializado NUNCA contiene tokens,
#       API keys, texto/quotes, emails/teléfonos ni ids crudos completos;
#       los ids sólo aparecen prefijados y truncados (exec:<últimos 8 hex>);
#   c6. writeFailureProbeSync escribe JSON válido con modo 0600 y la
#       discriminación del archivo coincide con la del objeto.
#
# Usage: bash scripts/test-beta01-failure-probe.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODULE="$ROOT/e2e/support/beta01-failure-probe.cjs"
TMP="$(mktemp -d /tmp/beta01-failure-probe.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

DRIVER="$TMP/driver.cjs"
cat >"$DRIVER" <<'NODE'
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const {
  classifyFailure,
  buildFailureProbe,
  probePath,
  writeFailureProbeSync,
} = require(process.env.BETA01_FAILURE_PROBE_MODULE);

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log("PASS " + name + (detail ? " — " + detail : ""));
  } else {
    failures += 1;
    console.error("FAIL " + name + (detail ? " — " + detail : ""));
  }
}

// Secretos de prueba: si el probe los filtra, NINGUNO puede aparecer en el
// JSON serializado (ni en crudo ni parcial).
const SECRETS = [
  "sk-beta01-super-secret-token-7f3ac2d1",
  "service_role_key_9f8e7d6c5b4a",
  "Precio: por definir.",
  "La pena convencional será del 1% diario, sin límite.",
  "beta01-owner-supersecret@mike.local",
  "+52 55 1234 5678",
];
const FULL_ID = "7f3ac2d1-9b4e-4c6a-8d1e-2f3a4b5c6d7e";

function sampleBody(errorClass) {
  return {
    id: FULL_ID,
    status: "failed",
    error_class: errorClass,
    matter_id: "m-a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8091a2",
    project_id: "p-1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
    document_id: "d-0f1e2d3c4b5a6978877665544332211009f8e7d6",
    detail:
      "Internal error near quote: " + SECRETS[2] + " email " + SECRETS[4],
    route: { provider: "deepseek", model: "chat", credential_secret: SECRETS[0] },
  };
}

function sampleReceipt(errorClass) {
  return {
    canonical_json: {
      result: {
        status: "failed",
        error_class: errorClass,
        output_text: SECRETS[2],
      },
      route: { credential_secret: SECRETS[1] },
    },
    receipt_sha256: "a".repeat(64),
  };
}

function sampleState(providerCalls) {
  return {
    provider_calls: providerCalls,
    drive_upload_calls: 0,
    drive_files: { "beta01-drive-file": { appProperties: { token: SECRETS[0] } } },
  };
}

function probeJson(probe) {
  return JSON.stringify(probe, null, 2);
}

// c1: discriminación pura de los 5 paths.
const DISCRIMINATIONS = [
  [0, "citation_unresolvable", "calls0_citation"],
  [1, "provider_error", "calls1_provider"],
  [1, "citation_unresolvable", "calls1_citation"],
  [1, "provider_output_empty", "calls1_empty"],
  [1, "authorization_revoked", "calls1_revoked"],
];
for (const [calls, errorClass, expected] of DISCRIMINATIONS) {
  const got = classifyFailure(calls, errorClass);
  check(
    "c1: classifyFailure(" + calls + ", " + errorClass + ") = " + expected,
    got === expected,
    "got=" + got,
  );
}
check(
  "c1: combinación fuera de los 5 paths cae en other (no null)",
  classifyFailure(0, "provider_error") === "other" &&
    classifyFailure(2, "citation_unresolvable") === "other" &&
    classifyFailure(null, "provider_error") === "other",
);

// c2: buildFailureProbe en los 5 paths — status/code/ejecución/contadores.
for (const [calls, errorClass, expected] of DISCRIMINATIONS) {
  const probe = buildFailureProbe({
    postStatus: 422,
    postBody: sampleBody(errorClass),
    receipt: sampleReceipt(errorClass),
    fakeState: sampleState(calls),
  });
  check(
    "c2: probe " + expected + " discrimina igual que classifyFailure",
    probe.discrimination === expected,
    "discrimination=" + probe.discrimination,
  );
  check(
    "c2: probe " + expected + " preserva status HTTP 422",
    probe.post.status === 422,
  );
  check(
    "c2: probe " + expected + " preserva status/error_class de la ejecución",
    probe.execution.status === "failed" &&
      probe.execution.error_class === errorClass,
    JSON.stringify(probe.execution),
  );
  check(
    "c2: probe " + expected + " preserva error_class del receipt",
    probe.receipt.present === true &&
      probe.receipt.error_class === errorClass,
    JSON.stringify(probe.receipt),
  );
  check(
    "c2: probe " + expected + " preserva contadores provider/drive",
    probe.counters.present === true &&
      probe.counters.provider_calls === calls &&
      probe.counters.drive_upload_calls === 0,
    JSON.stringify(probe.counters),
  );
}

// c3: ausencia de receipt -> present=false, error_class null (evidencia no
//     perdida; la discriminación cae a lo que diga la ejecución).
const probeNoReceipt = buildFailureProbe({
  postStatus: 422,
  postBody: sampleBody("provider_error"),
  receipt: null,
  fakeState: sampleState(1),
});
check(
  "c3: receipt ausente -> present=false y error_class=null",
  probeNoReceipt.receipt.present === false &&
    probeNoReceipt.receipt.error_class === null,
  JSON.stringify(probeNoReceipt.receipt),
);
check(
  "c3: discriminación con receipt ausente usa error_class de la ejecución",
  probeNoReceipt.discrimination === "calls1_provider",
  "discrimination=" + probeNoReceipt.discrimination,
);

// c4: ausencia de state -> present=false y contadores null; la ejecución
//     fallida sigue clasificándose (aquí caería en other, nunca null).
const probeNoState = buildFailureProbe({
  postStatus: 422,
  postBody: sampleBody("provider_error"),
  receipt: sampleReceipt("provider_error"),
  fakeState: null,
});
check(
  "c4: state ausente -> present=false y contadores null",
  probeNoState.counters.present === false &&
    probeNoState.counters.provider_calls === null &&
    probeNoState.counters.drive_upload_calls === null,
  JSON.stringify(probeNoState.counters),
);
check(
  "c4: discriminación con state ausente nunca es null",
  typeof probeNoState.discrimination === "string" &&
    probeNoState.discrimination.length > 0,
  "discrimination=" + probeNoState.discrimination,
);

// c5: REDACCIÓN — ningún secreto en el JSON serializado; ids sólo
//     prefijados/truncados; el id crudo completo NUNCA aparece.
const redactionProbe = buildFailureProbe({
  postStatus: 422,
  postBody: sampleBody("provider_error"),
  receipt: sampleReceipt("provider_error"),
  fakeState: sampleState(1),
});
const serialized = probeJson(redactionProbe);
for (const secret of SECRETS) {
  check(
    "c5: secreto redactado — " + secret.slice(0, 18) + "…",
    !serialized.includes(secret),
  );
}
check(
  "c5: id crudo completo NO aparece (sólo prefijado/truncado)",
  !serialized.includes(FULL_ID) &&
    !serialized.includes("m-a1b2c3d4") &&
    !serialized.includes("p-1a2b3c4d") &&
    !serialized.includes("d-0f1e2d3c"),
);
check(
  "c5: id de la ejecución aparece prefijado exec: + 8 hex",
  /"id": "exec:[a-f0-9]{8}"/.test(serialized),
  serialized.match(/"id": "exec:[a-f0-9]{8}"/)?.[0] || "no match",
);
check(
  "c5: el JSON del probe NO incluye detail/quotes del body",
  !serialized.includes("Internal error near quote"),
  serialized.includes('"detail"') ? "detail presente" : "ok",
);

// c6: writeFailureProbeSync escribe JSON válido con modo 0600 y la
//     discriminación persistida coincide con la del objeto.
const smokeDir = path.join(process.env.BETA01_PROBE_TMP, "smoke-dir");
const written = writeFailureProbeSync(smokeDir, redactionProbe);
const onDisk = JSON.parse(fs.readFileSync(written, "utf8"));
check(
  "c6: archivo escrito en SMOKE_DIR con nombre gate2-ai-failure-probe.json",
  path.basename(written) === "gate2-ai-failure-probe.json" &&
    written === probePath(smokeDir),
);
check(
  "c6: JSON en disco parsea y coincide con el probe construido",
  onDisk.discrimination === redactionProbe.discrimination &&
    onDisk.post.status === redactionProbe.post.status &&
    onDisk.execution.error_class === redactionProbe.execution.error_class,
  "discrimination=" + onDisk.discrimination,
);
const mode = fs.statSync(written).mode & 0o777;
check("c6: modo del archivo es 0600", mode === 0o600, "mode=" + mode.toString(8));
check(
  "c6: el archivo serializado también redacta secretos",
  !JSON.stringify(onDisk).includes(SECRETS[0]) &&
    !JSON.stringify(onDisk).includes(FULL_ID),
);

if (failures > 0) {
  console.error(
    "failure-probe contract: " + failures + " check(s) fallaron",
  );
  process.exit(1);
}
console.log(
  "failure-probe contract: 5 paths + ausencias receipt/state + redacción + 0600 — PASS",
);
NODE

set +e
(
  export BETA01_FAILURE_PROBE_MODULE="$MODULE"
  export BETA01_PROBE_TMP="$TMP"
  node "$DRIVER"
) >"$TMP/driver.out" 2>"$TMP/driver.err"
RC=$?
set -e
cat "$TMP/driver.out"
if [ "$RC" -ne 0 ]; then
  cat "$TMP/driver.err" >&2
fi
[ "$RC" -eq 0 ] || { echo "test-beta01-failure-probe: FAIL" >&2; exit 1; }
echo "test-beta01-failure-probe: todos los checks PASS (cero red, sin stack)"