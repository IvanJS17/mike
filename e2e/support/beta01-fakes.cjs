const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const originalFetch = globalThis.fetch;
const stateFile = process.env.BETA01_FAKE_STATE_FILE || "";
const state = {
  provider_calls: 0,
  drive_upload_calls: 0,
  drive_get_calls: 0,
  drive_delete_calls: 0,
  drive_files: {},
};

function saveState() {
  if (!stateFile) return;
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

function readDotEnvValue(key) {
  if (process.env[key]) return process.env[key];
  const candidates = [
    path.join(process.cwd(), ".env"),
    path.join(process.cwd(), "backend", ".env"),
  ];
  let value;
  for (const candidate of candidates) {
    try {
      for (const line of fs.readFileSync(candidate, "utf8").split("\n")) {
        const match = line.match(new RegExp(`^${key}=(.*)$`));
        if (match) value = match[1].trim().replace(/^"(.*)"$/, "$1");
      }
    } catch {
      // The local-stack setup writes backend/.env before the API starts.
    }
  }
  return value;
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestUrl(input) {
  return typeof input === "string" ? input : input?.url || "";
}

function requestHeader(init, name) {
  const headers = init?.headers;
  if (!headers) return "";
  if (typeof headers.get === "function") return headers.get(name) || "";
  const key = Object.keys(headers).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  return key ? String(headers[key]) : "";
}

async function currentExecutionScope() {
  const supabaseUrl = readDotEnvValue("SUPABASE_URL");
  const serviceKey = readDotEnvValue("SUPABASE_SECRET_KEY");
  if (!supabaseUrl || !serviceKey) {
    throw new Error("Beta fake provider cannot read the local Supabase env");
  }
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
  };
  const running = await originalFetch(
    `${supabaseUrl}/rest/v1/ai_executions?select=document_id,document_version_id&status=eq.running&order=started_at.desc&limit=1`,
    { headers },
  );
  if (!running.ok) {
    throw new Error(
      `Beta fake provider scope lookup failed: ${running.status}`,
    );
  }
  const rows = await running.json();
  if (!Array.isArray(rows) || !rows[0]) {
    throw new Error("Beta fake provider found no running execution");
  }
  return rows[0];
}

function citationFor(pageText, scope, citationId, quote, findingText) {
  const start = pageText.indexOf(quote);
  if (start < 0)
    throw new Error(`Beta fake provider could not find quote: ${quote}`);
  return {
    citation_id: citationId,
    document_id: scope.document_id,
    document_version_id: scope.document_version_id,
    page: 1,
    span: { start_char: start, end_char: start + quote.length },
    quote,
    quote_sha256: crypto.createHash("sha256").update(quote).digest("hex"),
    finding_text: findingText,
  };
}

async function fakeProviderResponse(init) {
  state.provider_calls += 1;
  const body = JSON.parse(Buffer.from(init?.body || "").toString("utf8"));
  const userMessage =
    body.messages?.find((message) => message.role === "user")?.content || "";
  const marker = "[Page 1]\n";
  const pageText = userMessage.includes(marker)
    ? userMessage.slice(userMessage.indexOf(marker) + marker.length).trimEnd()
    : "";
  const scope = await currentExecutionScope();
  const citations = [
    citationFor(
      pageText,
      scope,
      "R4-contraprestacion-01-c1",
      "Precio: por definir.",
      "R4: la contraprestación no está determinada; verificar precio, moneda y condiciones de pago antes de circular el contrato.",
    ),
    citationFor(
      pageText,
      scope,
      "R6-pena-01-c1",
      "La pena convencional será del 1% diario, sin límite.",
      "R6: la pena diaria no tiene tope explícito; verificar alcance y tope de pena para evitar una aplicación desproporcionada o acumulada.",
    ),
    citationFor(
      pageText,
      scope,
      "R9-ley-foro-01-c1",
      "Este contrato se rige por las leyes de México y las partes se someten a los tribunales de Ciudad de México.",
      "R9: la ley y el foro están indicados; confirmar que la elección de jurisdicción corresponde al expediente y a la revisión humana.",
    ),
  ];
  const content = [
    "# Revisión sintética Beta 0.1",
    "Hallazgos verificables R4, R6 y R9; no es asesoría para un caso real.",
    "",
    "<CITATIONS>",
    JSON.stringify(citations),
    "</CITATIONS>",
  ].join("\n");
  saveState();
  return jsonResponse({
    id: "beta01-fake-completion",
    choices: [{ message: { role: "assistant", content } }],
  });
}

function parseDriveMultipart(init) {
  const body = Buffer.from(init?.body || "");
  const contentType = requestHeader(init, "content-type");
  const boundary = contentType.match(/boundary=([^;]+)/)?.[1];
  if (!boundary) throw new Error("Beta fake Drive request has no boundary");
  const headerSeparator = Buffer.from("\r\n\r\n");
  const firstHeaderEnd = body.indexOf(headerSeparator);
  const firstPartEnd = body.indexOf(
    Buffer.from(`\r\n--${boundary}`),
    firstHeaderEnd + 4,
  );
  const metadata = JSON.parse(
    body.subarray(firstHeaderEnd + 4, firstPartEnd).toString("utf8"),
  );
  const secondHeaderEnd = body.indexOf(headerSeparator, firstPartEnd + 2);
  const bytesEnd = body.lastIndexOf(Buffer.from(`\r\n--${boundary}--\r\n`));
  const bytes = body.subarray(secondHeaderEnd + 4, bytesEnd);
  return { metadata, bytes };
}

function fakeDriveUpload(init) {
  const { metadata, bytes } = parseDriveMultipart(init);
  state.drive_upload_calls += 1;
  const file = {
    id: "beta01-drive-file",
    parents: metadata.parents || [],
    size: String(bytes.byteLength),
    md5Checksum: crypto.createHash("md5").update(bytes).digest("hex"),
    appProperties: metadata.appProperties || {},
  };
  state.drive_files[file.id] = file;
  saveState();
  return jsonResponse(file);
}

function fakeDriveGet(url) {
  state.drive_get_calls += 1;
  const fileId = decodeURIComponent(url.split("/files/")[1].split("?")[0]);
  const file = state.drive_files[fileId];
  saveState();
  return file ? jsonResponse(file) : jsonResponse({ error: "not found" }, 404);
}

function fakeDriveDelete(url) {
  state.drive_delete_calls += 1;
  const fileId = decodeURIComponent(url.split("/files/")[1].split("?")[0]);
  delete state.drive_files[fileId];
  saveState();
  return new Response(null, { status: 204 });
}

globalThis.fetch = async function beta01Fetch(input, init) {
  const url = requestUrl(input);
  if (url === "https://api.deepseek.com/chat/completions") {
    return fakeProviderResponse(init);
  }
  if (url.startsWith("https://www.googleapis.com/upload/drive/v3/files")) {
    return fakeDriveUpload(init);
  }
  if (url.startsWith("https://www.googleapis.com/drive/v3/files/")) {
    if ((init?.method || "GET").toUpperCase() === "DELETE")
      return fakeDriveDelete(url);
    return fakeDriveGet(url);
  }
  return originalFetch(input, init);
};

// Boot marker: lets the setup smoke verify the fakes were preloaded into the
// backend process (scripts/e2e-beta01-setup-smoke.sh greps for this line).
console.log("[beta01-fakes] loaded");
