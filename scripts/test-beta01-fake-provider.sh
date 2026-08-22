#!/usr/bin/env bash
#
# Contractual test for the Beta 0.1 deterministic fake provider (Gate 2).
#
# Demonstrates, WITHOUT raising the stack and with ZERO network, that the fake
# provider (e2e/support/beta01-fakes.cjs) satisfies el criterio de IA:
#
#   c1. responde EXACTAMENTE R4/R6/R9: cada cita trae citation_id,
#       finding_text y quote literales, span derivado de la página, page=1,
#       document_id/document_version_id del scope y quote_sha256 en minúsculas
#       igual al sha256 del quote exacto;
#   c2. una sola llamada determinista al provider por ejecución
#       (provider_calls === 1 en el estado persistido);
#   c3. la resolución contractual del backend (backend/src/lib/aiCitations.ts,
#       pura, sin stack) acepta el candidato íntegro y RECHAZA el caso
#       contractual negativo: omitir quote_sha256 (o escribirlo en mayúsculas
#       o con un valor incorrecto) falla con citation_unresolvable.
#
# Cero red: el scope de la ejecución se sirve desde un stub en memoria
# preloaded ANTES del fake provider (el fake captura ese stub como
# originalFetch); cualquier URL fuera de ai_executions/DeepSeek/Drive hace
# que el stub falle duro.
#
# Usage: bash scripts/test-beta01-fake-provider.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAKES="$ROOT/e2e/support/beta01-fakes.cjs"
TMP="$(mktemp -d /tmp/beta01-fake-provider.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

# Supabase local del harness (loopback). Ninguna petición real ocurre: el stub
# preloaded intercepta el scope lookup ANTES de tocar red. El service key demo
# se genera en RUNTIME (nunca como literal JWT en el repo, regla gitleaks).
LOCAL_SUPABASE_URL="http://127.0.0.1:54321"
jwt_for() { # role issuer
  node -e '
    const [role, iss] = process.argv.slice(1);
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const header = enc({ alg: "HS256", typ: "JWT" });
    const payload = enc({ iss, role, exp: 1983812996 });
    process.stdout.write(header + "." + payload + ".sig-" + role);
  ' "$1" "$2"
}
LOCAL_SERVICE_KEY="$(jwt_for service_role supabase-demo)"
SCOPE_DOCUMENT_ID="contract-doc-11111111-1111-4111-8111-111111111111"
SCOPE_DOCUMENT_VERSION_ID="contract-ver-22222222-2222-4222-8222-222222222222"

# Página sintética de contrato: contiene los tres quotes literales que el fake
# provider debe encontrar (mismo texto que e2e/fixtures/beta01-contract.docx
# para esos fragmentos).
PAGE_TEXT='Contrato de prestación de servicios profesionales (sintético Beta 0.1).

Primera. Objeto. El prestador se obliga a prestar los servicios profesionales descritos en el Anexo 1 de este contrato.

Segunda. Precio: por definir.

Tercera. La pena convencional será del 1% diario, sin límite.

Cuarta. Este contrato se rige por las leyes de México y las partes se someten a los tribunales de Ciudad de México.'
printf '%s' "$PAGE_TEXT" >"$TMP/page.txt"

# ---------------------------------------------------------------------------
# Scope stub: preloaded via NODE_OPTIONS ANTES del fake provider. Sirve el
# scope de la ejecución en memoria y falla duro ante cualquier otra URL.
# ---------------------------------------------------------------------------
SCOPE_STUB="$TMP/scope-stub.cjs"
cat >"$SCOPE_STUB" <<'STUB'
"use strict";
const supabaseUrl = process.env.SUPABASE_URL || "http://127.0.0.1:54321";
const documentId = process.env.BETA01_SCOPE_DOCUMENT_ID;
const documentVersionId = process.env.BETA01_SCOPE_DOCUMENT_VERSION_ID;
globalThis.fetch = async function contractScopeStub(input, init) {
  const url = typeof input === "string" ? input : input?.url || "";
  if (url.includes("/rest/v1/ai_executions")) {
    return new Response(
      JSON.stringify([
        { document_id: documentId, document_version_id: documentVersionId },
      ]),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  throw new Error(
    "fake-provider contract must never touch network: " + url,
  );
};
STUB

# ---------------------------------------------------------------------------
# Driver: una llamada al endpoint del provider fake y asserts de c1/c2.
# ---------------------------------------------------------------------------
DRIVER="$TMP/driver.cjs"
cat >"$DRIVER" <<'NODE'
"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");

const pageText = fs
  .readFileSync(process.env.BETA01_PAGE_TEXT_FILE, "utf8")
  .trimEnd();
const stateFile = process.env.BETA01_FAKE_STATE_FILE;
const scopeDocumentId = process.env.BETA01_SCOPE_DOCUMENT_ID;
const scopeDocumentVersionId = process.env.BETA01_SCOPE_DOCUMENT_VERSION_ID;

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log("PASS " + name + (detail ? " — " + detail : ""));
  } else {
    failures += 1;
    console.error("FAIL " + name + (detail ? " — " + detail : ""));
  }
}
const sha256Hex = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

const expected = [
  {
    citation_id: "R4-contraprestacion-01-c1",
    quote: "Precio: por definir.",
    finding_text:
      "R4: la contraprestación no está determinada; verificar precio, moneda y condiciones de pago antes de circular el contrato.",
  },
  {
    citation_id: "R6-pena-01-c1",
    quote: "La pena convencional será del 1% diario, sin límite.",
    finding_text:
      "R6: la pena diaria no tiene tope explícito; verificar alcance y tope de pena para evitar una aplicación desproporcionada o acumulada.",
  },
  {
    citation_id: "R9-ley-foro-01-c1",
    quote:
      "Este contrato se rige por las leyes de México y las partes se someten a los tribunales de Ciudad de México.",
    finding_text:
      "R9: la ley y el foro están indicados; confirmar que la elección de jurisdicción corresponde al expediente y a la revisión humana.",
  },
];

(async () => {
  for (const item of expected) {
    check(
      "quote localizable en la página sintética (" + item.citation_id + ")",
      pageText.includes(item.quote),
    );
  }

  const response = await globalThis.fetch(
    "https://api.deepseek.com/chat/completions",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [{ role: "user", content: "[Page 1]\n" + pageText }],
      }),
    },
  );
  check("provider fake responde HTTP 200", response.status === 200);
  const payload = await response.json();
  const text = payload?.choices?.[0]?.message?.content || "";
  check(
    "contenido con bloque <CITATIONS>",
    /<CITATIONS>[\s\S]*<\/CITATIONS>/.test(text),
  );
  const match = text.match(/<CITATIONS>\s*([\s\S]*?)\s*<\/CITATIONS>/);
  const citations = match ? JSON.parse(match[1]) : [];
  check("exactamente 3 citas (R4/R6/R9)", citations.length === 3);
  check(
    "citation_ids exactos R4/R6/R9",
    JSON.stringify(citations.map((c) => c.citation_id).sort()) ===
      JSON.stringify([
        "R4-contraprestacion-01-c1",
        "R6-pena-01-c1",
        "R9-ley-foro-01-c1",
      ]),
  );

  for (const item of expected) {
    const citation = citations.find((c) => c.citation_id === item.citation_id);
    check("cita " + item.citation_id + " presente", Boolean(citation));
    if (!citation) continue;
    check(
      item.citation_id + ": quote exacto",
      citation.quote === item.quote,
      JSON.stringify(citation.quote),
    );
    check(
      item.citation_id + ": finding_text exacto",
      citation.finding_text === item.finding_text,
    );
    check(item.citation_id + ": page=1", citation.page === 1);
    check(
      item.citation_id + ": document_id del scope",
      citation.document_id === scopeDocumentId,
    );
    check(
      item.citation_id + ": document_version_id del scope",
      citation.document_version_id === scopeDocumentVersionId,
    );
    const start = pageText.indexOf(item.quote);
    check(
      item.citation_id + ": span cubre exactamente el quote",
      Boolean(citation.span) &&
        citation.span.start_char === start &&
        citation.span.end_char === start + item.quote.length,
      JSON.stringify(citation.span),
    );
    const expectedSha = sha256Hex(item.quote);
    check(
      item.citation_id + ": quote_sha256 lowercase del quote exacto",
      typeof citation.quote_sha256 === "string" &&
        /^[a-f0-9]{64}$/.test(citation.quote_sha256) &&
        citation.quote_sha256 === expectedSha,
      citation.quote_sha256,
    );
  }

  // Determinismo (c2): una sola llamada al provider por ejecución.
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  check(
    "provider_calls === 1",
    state.provider_calls === 1,
    String(state.provider_calls),
  );
  check(
    "drive_upload_calls === 0 (sin Drive en este gate)",
    state.drive_upload_calls === 0,
  );

  if (failures > 0) {
    console.error(
      "fake-provider contract: " + failures + " check(s) fallaron",
    );
    process.exit(1);
  }
  console.log("fake-provider contract: R4/R6/R9 exactas — PASS");
})().catch((error) => {
  console.error(
    "fake-provider contract: error inesperado — " +
      String((error && error.stack) || error),
  );
  process.exit(1);
});
NODE

# ---------------------------------------------------------------------------
# Caso contractual negativo (c3): la resolución REAL del backend (lib pura,
# sin stack) rechaza una cita sin quote_sha256 o con hash no lowercase.
# ---------------------------------------------------------------------------
NEGATIVE_TS="$TMP/negative-contract.ts"
cat >"$NEGATIVE_TS" <<'TS'
import { createHash } from "node:crypto";
import fs from "node:fs";
import { resolveCitation } from "__LIB_PATH__";

const pageText = fs
  .readFileSync(process.env.BETA01_PAGE_TEXT_FILE || "", "utf8")
  .trimEnd();
const documentId = process.env.BETA01_SCOPE_DOCUMENT_ID || "";
const documentVersionId = process.env.BETA01_SCOPE_DOCUMENT_VERSION_ID || "";
const sha256Hex = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const contentSha = sha256Hex(pageText);
const context = {
  documentId,
  documentVersionId,
  documentContentSha256: contentSha,
  sourceContentSha256: contentSha,
  pageCount: 1,
  pages: [{ page: 1, text: pageText, textSha256: contentSha }],
};

const quote = "Precio: por definir.";
const start = pageText.indexOf(quote);
const baseCandidate = {
  citation_id: "R4-contraprestacion-01-c1",
  document_id: documentId,
  document_version_id: documentVersionId,
  page: 1,
  span: { start_char: start, end_char: start + quote.length },
  quote,
  quote_sha256: sha256Hex(quote),
  finding_text: "R4: la contraprestación no está determinada.",
};

let failures = 0;
function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log("PASS " + name + (detail ? " — " + detail : ""));
  } else {
    failures += 1;
    console.error("FAIL " + name + (detail ? " — " + detail : ""));
  }
}

const valid = resolveCitation(baseCandidate, context) as {
  verified?: boolean;
};
check(
  "candidato íntegro (con quote_sha256 lowercase) resuelve verified",
  valid.verified === true,
);

const missingSha = resolveCitation(
  { ...baseCandidate, quote_sha256: undefined },
  context,
) as { ok?: boolean; error_class?: string };
check(
  "omitir quote_sha256 FALLA (caso contractual negativo)",
  missingSha.ok === false && missingSha.error_class === "citation_unresolvable",
);

const upperSha = resolveCitation(
  { ...baseCandidate, quote_sha256: sha256Hex(quote).toUpperCase() },
  context,
) as { ok?: boolean };
check("quote_sha256 en mayúsculas FALLA", upperSha.ok === false);

const wrongSha = resolveCitation(
  { ...baseCandidate, quote_sha256: "0".repeat(64) },
  context,
) as { ok?: boolean };
check("quote_sha256 incorrecto FALLA", wrongSha.ok === false);

if (failures > 0) {
  console.error("negative contract: " + failures + " check(s) fallaron");
  process.exit(1);
}
console.log("negative contract: quote_sha256 obligatorio — PASS");
TS
sed -i "s|__LIB_PATH__|$ROOT/backend/src/lib/aiCitations|" "$NEGATIVE_TS"

# ---------------------------------------------------------------------------
# Runner: fake-provider contract y caso negativo, ambos sin stack.
# ---------------------------------------------------------------------------
STATE_FILE="$TMP/fake-state.json"

set +e
(
  export SUPABASE_URL="$LOCAL_SUPABASE_URL" \
    SUPABASE_SECRET_KEY="$LOCAL_SERVICE_KEY" \
    BETA01_FAKE_STATE_FILE="$STATE_FILE" \
    BETA01_PAGE_TEXT_FILE="$TMP/page.txt" \
    BETA01_SCOPE_DOCUMENT_ID="$SCOPE_DOCUMENT_ID" \
    BETA01_SCOPE_DOCUMENT_VERSION_ID="$SCOPE_DOCUMENT_VERSION_ID" \
    NODE_OPTIONS="--require=$SCOPE_STUB --require=$FAKES"
  node "$DRIVER"
) >"$TMP/driver.out" 2>"$TMP/driver.err"
DRIVER_RC=$?
set -e
cat "$TMP/driver.out"
if [ "$DRIVER_RC" -ne 0 ]; then
  cat "$TMP/driver.err" >&2
fi
[ "$DRIVER_RC" -eq 0 ] || { echo "test-beta01-fake-provider: FAIL (driver)" >&2; exit 1; }

set +e
(
  export BETA01_PAGE_TEXT_FILE="$TMP/page.txt" \
    BETA01_SCOPE_DOCUMENT_ID="$SCOPE_DOCUMENT_ID" \
    BETA01_SCOPE_DOCUMENT_VERSION_ID="$SCOPE_DOCUMENT_VERSION_ID"
  cd "$ROOT/backend"
  "$ROOT/backend/node_modules/.bin/tsx" "$NEGATIVE_TS"
) >"$TMP/negative.out" 2>"$TMP/negative.err"
NEGATIVE_RC=$?
set -e
cat "$TMP/negative.out"
if [ "$NEGATIVE_RC" -ne 0 ]; then
  cat "$TMP/negative.err" >&2
fi
[ "$NEGATIVE_RC" -eq 0 ] || { echo "test-beta01-fake-provider: FAIL (negativo)" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Prueba de cero red: el stub falla duro ante cualquier URL no cubierta; si
# algo tocó red, el driver ya habría fallado con exit != 0.
# ---------------------------------------------------------------------------
echo "test-beta01-fake-provider: todos los checks PASS (cero red, sin stack)"