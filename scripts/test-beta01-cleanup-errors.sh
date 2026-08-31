#!/usr/bin/env bash
#
# Contractual test for the Gate 2 fix B error composition
# (e2e/support/beta01-cleanup-errors.cjs), used by the AI smoke spec
# (e2e/beta01-ai-smoke.spec.ts) to run teardown of fixture/auth/state-file
# WITHOUT letting a cleanup failure replace the primary error.
#
# WITHOUT a live stack and with ZERO network (Node puro), proves:
#   c1. cuerpo OK + cleanup OK  -> combineCleanupErrors() devuelve null (éxito);
#   c2. cuerpo FAIL + cleanup OK -> se propaga EXACTAMENTE el error del cuerpo;
#   c3. cuerpo OK + cleanup FAIL -> se propaga EXACTAMENTE el error de cleanup;
#   c4. cuerpo FAIL + cleanup FAIL -> CleanupCompositeError: el mensaje
#       presenta [PRIMARY] ANTES de [CLEANUP 1], conserva mensajes y stacks de
#       AMBOS lados y el primario NUNCA se reemplaza (primaryError preserva la
#       referencia original);
#   c5. cuerpo OK + 2 cleanups FAIL -> CleanupOnlyCompositeError con ambos
#       mensajes y stacks preservados (ningún residuo se silencia).
#
# Usage: bash scripts/test-beta01-cleanup-errors.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODULE="$ROOT/e2e/support/beta01-cleanup-errors.cjs"
TMP="$(mktemp -d /tmp/beta01-cleanup-errors.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

DRIVER="$TMP/driver.cjs"
cat >"$DRIVER" <<'NODE'
"use strict";
const { combineCleanupErrors } = require(
  process.env.BETA01_CLEANUP_ERRORS_MODULE,
);

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log("PASS " + name + (detail ? " — " + detail : ""));
  } else {
    failures += 1;
    console.error("FAIL " + name + (detail ? " — " + detail : ""));
  }
}

function makeBodyError() {
  const error = new Error("body boom: revisión IA falló");
  error.stack = "BodyErrorStack@ai-executions\n    at runBody (spec.ts:600)";
  return error;
}
function makeCleanupError(label) {
  const error = new Error("cleanup boom: " + label);
  error.stack = "CleanupErrorStack@" + label + "\n    at teardown (spec.ts:700)";
  return error;
}

// c1: ambos OK -> null (éxito, nada que propagar).
const c1 = combineCleanupErrors(null, []);
check(
  "c1: cuerpo OK + cleanup OK devuelve null (éxito)",
  c1 === null,
  String(c1),
);

// c2: sólo el cuerpo falla -> se propaga EXACTAMENTE el cuerpo.
const body = makeBodyError();
const c2 = combineCleanupErrors(body, []);
check(
  "c2: cuerpo FAIL + cleanup OK propaga el MISMO error del cuerpo",
  c2 === body,
);
check(
  "c2: sin envoltorio compuesto",
  !(c2 instanceof Error && c2.name.indexOf("Cleanup") === 0),
);

// c3: sólo el cleanup falla -> se propaga EXACTAMENTE el cleanup.
const cleanup1 = makeCleanupError("auth");
const c3 = combineCleanupErrors(null, [cleanup1]);
check(
  "c3: cuerpo OK + cleanup FAIL propaga el MISMO error de cleanup",
  c3 === cleanup1,
);
check(
  "c3: sin envoltorio compuesto",
  !(c3 instanceof Error && c3.name.indexOf("Cleanup") === 0),
);

// c4: ambos fallan -> compuesto con PRIMARY primero y CLEANUP después,
//     mensajes y stacks de ambos preservados; primario nunca reemplazado.
const body2 = makeBodyError();
const cleanupA = makeCleanupError("fixture");
const cleanupB = makeCleanupError("state-file");
const c4 = combineCleanupErrors(body2, [cleanupA, cleanupB]);
check(
  "c4: ambos fallan -> CleanupCompositeError",
  c4 instanceof Error && c4.name === "CleanupCompositeError",
  c4 ? c4.name : String(c4),
);
const c4Message = c4 && c4.message ? String(c4.message) : "";
const primaryAt = c4Message.indexOf("[PRIMARY]");
const cleanupAt = c4Message.indexOf("[CLEANUP 1]");
check(
  "c4: [PRIMARY] aparece ANTES de [CLEANUP 1]",
  primaryAt !== -1 && cleanupAt !== -1 && primaryAt < cleanupAt,
  "primaryAt=" + primaryAt + " cleanupAt=" + cleanupAt,
);
check(
  "c4: conserva el mensaje del cuerpo",
  c4Message.includes("body boom: revisión IA falló"),
);
check(
  "c4: conserva los mensajes de cleanup",
  c4Message.includes("cleanup boom: fixture") &&
    c4Message.includes("cleanup boom: state-file"),
);
const c4Stack = c4 && c4.stack ? String(c4.stack) : "";
check(
  "c4: conserva el stack del cuerpo",
  c4Stack.includes("BodyErrorStack@ai-executions"),
);
check(
  "c4: conserva los stacks de cleanup",
  c4Stack.includes("CleanupErrorStack@fixture") &&
    c4Stack.includes("CleanupErrorStack@state-file"),
);
check(
  "c4: el primario NUNCA se reemplaza (referencia preservada)",
  Boolean(c4 && c4.primaryError === body2),
);
check(
  "c4: cleanupErrors preservados en orden",
  Boolean(
    c4 &&
      c4.cleanupErrors &&
      c4.cleanupErrors.length === 2 &&
      c4.cleanupErrors[0] === cleanupA &&
      c4.cleanupErrors[1] === cleanupB,
  ),
);

// c5: cuerpo OK + VARIOS cleanups fallan -> compuesto CLEANUP-only, sin
//     silenciar residuos (teardown de fixture/auth/state-file: cualquier
//     residuo debe diagnosticarse).
const cleanupX = makeCleanupError("fixture");
const cleanupY = makeCleanupError("state-file");
const c5 = combineCleanupErrors(null, [cleanupX, cleanupY]);
check(
  "c5: cuerpo OK + 2 cleanups FAIL -> CleanupOnlyCompositeError",
  c5 instanceof Error && c5.name === "CleanupOnlyCompositeError",
  c5 ? c5.name : String(c5),
);
const c5Message = c5 && c5.message ? String(c5.message) : "";
check(
  "c5: conserva ambos mensajes de cleanup",
  c5Message.includes("cleanup boom: fixture") &&
    c5Message.includes("cleanup boom: state-file"),
);
const c5Stack = c5 && c5.stack ? String(c5.stack) : "";
check(
  "c5: conserva ambos stacks de cleanup",
  c5Stack.includes("CleanupErrorStack@fixture") &&
    c5Stack.includes("CleanupErrorStack@state-file"),
);

if (failures > 0) {
  console.error(
    "cleanup-errors contract: " + failures + " check(s) fallaron",
  );
  process.exit(1);
}
console.log(
  "cleanup-errors contract: 4 combinaciones + orden/diagnóstico — PASS",
);
NODE

set +e
(
  export BETA01_CLEANUP_ERRORS_MODULE="$MODULE"
  node "$DRIVER"
) >"$TMP/driver.out" 2>"$TMP/driver.err"
RC=$?
set -e
cat "$TMP/driver.out"
if [ "$RC" -ne 0 ]; then
  cat "$TMP/driver.err" >&2
fi
[ "$RC" -eq 0 ] || { echo "test-beta01-cleanup-errors: FAIL" >&2; exit 1; }
echo "test-beta01-cleanup-errors: todos los checks PASS (cero red, sin stack)"