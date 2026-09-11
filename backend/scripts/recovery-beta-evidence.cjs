'use strict';
// Test harness only. Importing this module registers TS loading, but performs
// no client creation, environment loading, source access or service operation.
require('tsx/cjs');

const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SOURCE = 'Synthetic smoke agreement. No client data.';
const MAX_INPUT_BYTES = 16 * 1024;
const MAX_DOCX_BYTES = 1024 * 1024;
const CLI_DEADLINE_MS = 30_000;
const sha = value => createHash('sha256').update(value).digest('hex');
const requireThat = condition => { if (!condition) throw new Error('BETA_EVIDENCE_FAILED'); };
const equal = (a, b) => requireThat(isDeepStrictEqual(a, b));

function validateInput(value) {
  const ids = ['owner_user_id', 'organization_id', 'matter_id', 'project_id', 'document_id', 'execution_id'];
  requireThat(value && typeof value === 'object' && !Array.isArray(value));
  equal(Object.keys(value).sort(), [...ids, 'owner_access_token', 'idempotency_key'].sort());
  for (const field of ids) requireThat(typeof value[field] === 'string' && UUID.test(value[field]));
  requireThat(typeof value.owner_access_token === 'string' &&
    value.owner_access_token.length > 0 && value.owner_access_token.length <= 8192 &&
    !/\s/.test(value.owner_access_token));
  requireThat(typeof value.idempotency_key === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value.idempotency_key));
  return Object.freeze({ ...value });
}

async function one(db, table, columns, filters) {
  let query = db.from(table).select(columns);
  for (const [key, value] of Object.entries(filters)) query = query.eq(key, value);
  const result = await query.maybeSingle();
  requireThat(result && result.error === null && result.data && typeof result.data === 'object' && !Array.isArray(result.data));
  return result.data;
}

// Confirm the OPC package declares and relates the Word main document; a ZIP
// containing only word/document.xml is sufficient for the text extractor but
// is not a DOCX. Use existing installed parsers, with bounded part inflation.
async function validateDocxPackage(bytes) {
  const JSZip = require('jszip');
  const { XMLParser, XMLValidator } = require('fast-xml-parser');
  const zip = await JSZip.loadAsync(bytes);
  const readPart = async name => {
    const entry = zip.file(name);
    requireThat(entry);
    const chunks = []; let length = 0;
    await new Promise((resolve, reject) => {
      const stream = entry.internalStream('nodebuffer');
      stream.on('data', chunk => {
        length += chunk.length;
        if (length > MAX_DOCX_BYTES) { stream.pause(); reject(new Error('BETA_EVIDENCE_FAILED')); }
        else chunks.push(chunk);
      }).on('error', reject).on('end', resolve).resume();
    });
    const xml = Buffer.concat(chunks).toString('utf8');
    requireThat(XMLValidator.validate(xml) === true && !/<!DOCTYPE/i.test(xml));
    return new XMLParser({ ignoreAttributes: false }).parse(xml);
  };
  const types = await readPart('[Content_Types].xml');
  const rels = await readPart('_rels/.rels');
  await readPart('word/document.xml');
  const array = value => Array.isArray(value) ? value : [value];
  requireThat(array(types.Types?.Override).some(item => item?.['@_PartName'] === '/word/document.xml' &&
    item['@_ContentType'] === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'));
  requireThat(array(rels.Relationships?.Relationship).some(item =>
    item?.['@_Type'] === 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument' &&
    ['word/document.xml', '/word/document.xml'].includes(item['@_Target']) && item['@_TargetMode'] !== 'External'));
}

/**
 * Caller supplies a real server Supabase client; only the storage boundary is
 * optional. No domain-service injection, real provider, retry, review or export.
 * Rejections carry a fixed code and the actual sender count, never raw causes.
 */
async function runBetaEvidence({ db, input: rawInput, download } = {}) {
  let providerCalls = 0;
  let phase = 'input';
  try {
    const input = validateInput(rawInput);
    const { buildAuthenticatedIdentity } = require('../src/lib/recovery/identity/authStateMatrix.ts');
    const { evaluateInitialAccess } = require('../src/lib/recovery/authorization/tenancyReadPort.ts');
    const { createSupabaseTenancyReadPort } = require('../src/lib/recovery/authorization/supabaseTenancyReadPort.ts');
    const { createBoundEvidenceResourceScopePort, createSupabaseAiReadRepository } = require('../src/lib/recovery/persistence/supabaseAiReadRepository.ts');
    const { createSupabaseAtomicEvidenceAppendPort } = require('../src/lib/recovery/persistence/supabaseAiPersistencePorts.ts');
    const { appendEvidenceAtomically } = require('../src/lib/recovery/evidence/appendOnlyEvidence.ts');
    const { buildExecutionProvenance } = require('../src/lib/recovery/evidence/executionEvidence.ts');
    const { verifyCitationBatch } = require('../src/lib/recovery/evidence/citationEvidence.ts');
    const { executeGovernedProviderCall } = require('../src/lib/recovery/providers/providerEgress.ts');
    const { parseGovernedWorkflowCatalogRow, parseWorkflowExecutionPin } = require('../src/lib/recovery/workflows/governedWorkflowCatalog.ts');
    const { MX_CIVIL_COMMERCIAL_CATALOG_ROW, MX_CIVIL_COMMERCIAL_PLAYBOOK, MX_CIVIL_COMMERCIAL_CONTENT_HASH } = require('../src/lib/recovery/workflows/mxCivilCommercialPlaybook.ts');
    const { extractDocxBodyText } = require('../src/lib/docxTrackedChanges.ts');
    const { storageKey, downloadFileStrict } = require('../src/lib/storage.ts');

    phase = 'auth';
    const auth = await db.auth.getUser(input.owner_access_token);
    requireThat(auth?.error === null && auth.data?.user?.id === input.owner_user_id);
    const assurance = await db.auth.mfa.getAuthenticatorAssuranceLevel(input.owner_access_token);
    requireThat(assurance?.error === null && assurance.data?.currentLevel === 'aal2');
    const identity = buildAuthenticatedIdentity({ user_id: auth.data.user.id,
      transport: { kind: 'non_browser_bearer', client_name: 'recovery-beta-evidence' },
      mfa_satisfied: assurance.data.currentLevel === 'aal2' });
    const tenancy = createSupabaseTenancyReadPort(db);
    const scope = { organization_id: input.organization_id, matter_id: input.matter_id, project_id: input.project_id };
    const access = await evaluateInitialAccess(tenancy, { identity,
      organization_id: input.organization_id, matter_id: input.matter_id, requiresMfa: true });
    requireThat(access.kind === 'decision' && access.decision.outcome === 'allow');
    const granted = access.decision.scope;
    const resources = createBoundEvidenceResourceScopePort(db, scope);
    const repository = createSupabaseAiReadRepository(db);

    // projects.ts handleDocumentUpload writes storage_path on V1, never on
    // documents. This deliberately accepts only its ready, original upload.
    phase = 'source';
    const documentFilters = { id: input.document_id, project_id: input.project_id, user_id: input.owner_user_id };
    const documentColumns = 'id,project_id,user_id,current_version_id,status';
    const document = await one(db, 'documents', documentColumns, documentFilters);
    for (const [key, value] of Object.entries(documentFilters)) equal(document[key], value);
    requireThat(document.status === 'ready' && typeof document.current_version_id === 'string' && UUID.test(document.current_version_id));
    const versionColumns = 'id,document_id,storage_path,source,version_number,filename,file_type,size_bytes,content_sha256,deleted_at';
    const versionFilters = { id: document.current_version_id, document_id: input.document_id };
    const version = await one(db, 'document_versions', versionColumns, versionFilters);
    for (const [key, value] of Object.entries(versionFilters)) equal(version[key], value);
    requireThat(version.source === 'upload' && version.version_number === 1 && version.deleted_at === null &&
      version.file_type === 'docx' && typeof version.filename === 'string' && /\.docx$/i.test(version.filename) &&
      typeof version.content_sha256 === 'string' && SHA256.test(version.content_sha256) &&
      Number.isSafeInteger(version.size_bytes) && version.size_bytes > 0 && version.size_bytes <= MAX_DOCX_BYTES);
    equal(version.storage_path, storageKey(input.owner_user_id, input.document_id, version.filename));
    const resource = await resources.getEvidenceResourceScope({ document_version_id: version.id });
    equal(resource, { ...scope, document_id: input.document_id, document_version_id: version.id,
      document_content_sha256: version.content_sha256 });
    const downloaded = await (download ?? downloadFileStrict)(version.storage_path);
    requireThat(downloaded instanceof Uint8Array && downloaded.byteLength === version.size_bytes);
    const bytes = Buffer.from(downloaded);
    equal(sha(bytes), version.content_sha256);
    requireThat(bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50);
    await validateDocxPackage(bytes);
    const source = await extractDocxBodyText(bytes);
    equal(source, SOURCE);

    // The definition is installed by the fixture through the production RPC.
    // Execution consumes the persisted active catalog and its exact prompt bytes,
    // never an in-memory registry or a fallback when the DB row is absent.
    const catalogColumns = 'workflow_key,version,content_hash,source_commit,distribution,type,source,approval_provenance,active,prompt_md';
    const catalogFilters = { workflow_key: MX_CIVIL_COMMERCIAL_CATALOG_ROW.workflow_key, active: true };
    const catalogSource = await one(db, 'mike_workflows', catalogColumns, catalogFilters);
    const catalog = parseGovernedWorkflowCatalogRow(catalogSource);
    requireThat(catalog.ok && catalog.row.active);
    equal(catalog.row, MX_CIVIL_COMMERCIAL_CATALOG_ROW);
    requireThat(typeof catalogSource.prompt_md === 'string' && catalogSource.prompt_md.length <= MAX_INPUT_BYTES);
    equal(sha(catalogSource.prompt_md), catalog.row.content_hash);
    equal(catalog.row.content_hash, MX_CIVIL_COMMERCIAL_CONTENT_HASH);
    const playbook = JSON.parse(catalogSource.prompt_md);
    equal(playbook, MX_CIVIL_COMMERCIAL_PLAYBOOK);
    equal(playbook.legal_validation, 'pending');
    const { active, ...catalogIdentity } = catalog.row;
    const pin = parseWorkflowExecutionPin(catalogIdentity);
    requireThat(pin.ok);
    const route = Object.freeze({ provider: 'claude', model: 'claude-sonnet-5', credential_ref: 'beta-fake-credential-fixture' });
    // Fake credential fixture only: "user" is the production contract's source
    // vocabulary; it does NOT mean this key came from DB BYOK.
    const credential = Object.freeze({ ref: route.credential_ref, provider: route.provider,
      domain: 'provider_api_key', source: 'user', enabled: true, version: 1,
      user_id: identity.user_id, provider_api_key: 'beta-in-memory-fake-key' });
    const credentialPort = Object.freeze({ getCredential: async ({ user_id, ref }) =>
      user_id === credential.user_id && ref === credential.ref ? credential : null });
    const assertCurrent = async () => {
      const current = await one(db, 'documents', documentColumns, documentFilters);
      for (const key of ['id', 'project_id', 'user_id', 'current_version_id', 'status']) equal(current[key], document[key]);
      const currentVersion = await one(db, 'document_versions', versionColumns, versionFilters);
      for (const key of versionColumns.split(',')) equal(currentVersion[key], version[key]);
      equal(await one(db, 'mike_workflows', catalogColumns, catalogFilters), catalogSource);
    };
    await assertCurrent();
    phase = 'provider';
    const call = await executeGovernedProviderCall({ user_id: identity.user_id, route,
      credentialPort, expected_credential_version: 1, host: 'fake',
      sender: async () => {
        providerCalls++;
        // The fake sender consumes the persisted source only while its binding
        // is still current. A late DB/source failure is a real sender failure.
        await assertCurrent();
        return ['Synthetic', 'smoke', 'agreement.'].map((quote, index) => ({
          rule: playbook.risks[index].id, quote,
          start_char: source.indexOf(quote), end_char: source.indexOf(quote) + quote.length,
          finding_text: `${playbook.risks[index].id}: abstain; synthetic fixture has insufficient context.`,
        }));
      } });
    requireThat(call.ok && providerCalls === 1);
    equal(call.route, route);
    const findings = call.senderResult;
    requireThat(Array.isArray(findings) && findings.length === 3);
    const candidates = findings.map((finding, index) => {
      requireThat(finding && typeof finding === 'object');
      equal(Object.keys(finding).sort(), ['rule', 'quote', 'start_char', 'end_char', 'finding_text'].sort());
      equal(finding.rule, ['R4', 'R6', 'R9'][index]);
      equal(finding.quote, ['Synthetic', 'smoke', 'agreement.'][index]);
      requireThat(Number.isInteger(finding.start_char) && Number.isInteger(finding.end_char) &&
        source.slice(finding.start_char, finding.end_char) === finding.quote &&
        typeof finding.finding_text === 'string' && finding.finding_text.length > 0 && finding.finding_text.length < 512);
      return { citation_id: finding.rule, document_id: input.document_id, document_version_id: version.id,
        page: 1, span: { start_char: finding.start_char, end_char: finding.end_char },
        quote: finding.quote, quote_sha256: sha(finding.quote), finding_text: finding.finding_text };
    });
    const page = { document_id: input.document_id, document_version_id: version.id,
      page: 1, text: source, text_sha256: sha(source) };
    const citations = verifyCitationBatch(candidates, { document_id: input.document_id,
      document_version_id: version.id, page_count: 1,
      pages: [{ page: 1, text: source, text_sha256: page.text_sha256 }] });
    requireThat(citations.ok);
    // Consume validated senderResult, never substitute output after a failure.
    const outputText = findings.map(f => f.finding_text).join('\n');
    const output = { execution_id: input.execution_id, output_text: outputText, output_sha256: sha(outputText) };
    const provenance = buildExecutionProvenance({ tenant_scope: { ...scope, document_version_id: version.id },
      input_hashes: [version.content_sha256], output_hashes: [output.output_sha256],
      citation_hashes: citations.citations.map(c => c.quote_sha256), route: call.route, workflow: pin.pin, status: 'completed' });
    requireThat(provenance.ok);
    await assertCurrent();
    phase = 'append';
    const appended = await appendEvidenceAtomically({ identity, granted_scope: granted,
      tenancy_port: tenancy, resource_scope_port: resources, requires_mfa: true,
      idempotency_key: input.idempotency_key,
      evidence: { execution_id: input.execution_id, provenance: provenance.provenance,
        pages: [page], output, citation_candidates: candidates },
      append_port: createSupabaseAtomicEvidenceAppendPort(db, { actor_user_id: identity.user_id,
        organization_id: input.organization_id, authorization_epoch: granted.authorization_epoch }) });
    requireThat(appended.ok);

    phase = 'readback';
    const persisted = await repository.loadExecutionEvidence({ project_id: input.project_id, execution_id: input.execution_id });
    requireThat(persisted);
    equal(persisted.execution, { ...scope, execution_id: input.execution_id, author_user_id: identity.user_id,
      document_id: input.document_id, document_version_id: version.id, document_content_sha256: version.content_sha256,
      status: 'succeeded', evidence_receipt_sha256: appended.receipt.receipt_sha256,
      output_text: outputText, output_sha256: output.output_sha256, citations: citations.citations });
    const receiptBody = JSON.parse(persisted.evidence_receipt.canonical_json);
    equal(receiptBody.workflow, pin.pin);
    equal(receiptBody.route, route);
    equal(receiptBody.input_hashes, [version.content_sha256]);
    equal(receiptBody.idempotency_key, input.idempotency_key);
    equal(persisted.evidence_receipt.receipt_sha256, appended.receipt.receipt_sha256);
    // The production repository verifies receipt bindings but does not expose
    // execution workflow columns; explicitly check their persisted projection.
    const expectedExecution = { id: input.execution_id, idempotency_key: input.idempotency_key,
      workflow_key: pin.pin.workflow_key, workflow_version: pin.pin.version,
      ...Object.fromEntries(['content_hash', 'source_commit', 'distribution', 'type', 'source', 'approval_provenance'].map(k => [`workflow_${k}`, pin.pin[k]])),
      route_provider: route.provider, route_model: route.model, credential_ref: route.credential_ref,
      input_hashes: provenance.provenance.input_hashes, output_hashes: provenance.provenance.output_hashes,
      citation_hashes: provenance.provenance.citation_hashes };
    const executionRow = await one(db, 'ai_executions', Object.keys(expectedExecution).join(','), { id: input.execution_id, project_id: input.project_id });
    for (const [key, value] of Object.entries(expectedExecution)) equal(executionRow[key], value);
    const receiptRow = await one(db, 'ai_receipts', 'execution_id,idempotency_key,receipt_sha256', { execution_id: input.execution_id });
    equal(receiptRow.idempotency_key, input.idempotency_key);
    equal(receiptRow.receipt_sha256, appended.receipt.receipt_sha256);
    equal(await repository.loadPages({ document_version_id: version.id }), [{ document_id: input.document_id,
      document_version_id: version.id, page: 1, content: source, content_sha256: page.text_sha256 }]);
    await assertCurrent();
    return { ...scope, execution_id: input.execution_id, document_id: input.document_id,
      document_version_id: version.id, document_sha256: version.content_sha256, page_sha256: page.text_sha256,
      output_sha256: output.output_sha256, receipt_sha256: appended.receipt.receipt_sha256,
      workflow_key: pin.pin.workflow_key, workflow_content_hash: pin.pin.content_hash,
      workflow_source_commit: pin.pin.source_commit, workflow_catalog: 'mike_workflows',
      provider_calls: providerCalls,
      limitations: ['Synthetic fixture; one logical evidence page, no rendered pagination fidelity.',
        'Governed fake sender and fake credential fixture; no DB BYOK or real provider acceptance.',
        'Persisted mike_workflows playbook; legal_validation pending.',
        'Human review, export and Drive out of scope.'] };
  } catch {
    const error = new Error('BETA_EVIDENCE_FAILED');
    error.code = 'BETA_EVIDENCE_FAILED';
    error.provider_calls = providerCalls;
    error.phase = phase;
    throw error;
  }
}

function validateLocalEndpoints(env) {
  // Exact textual hosts avoid URL parser normalization (e.g. 127.1 / integer
  // IPv4), credentials, redirects in input URLs, queries and path overrides.
  const loopback = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/;
  const valid = (value, service) => {
    if (value === service) return true;
    const match = typeof value === 'string' && loopback.exec(value);
    return Boolean(match && Number(match[1]) <= 65535);
  };
  requireThat(valid(env.SUPABASE_URL, 'http://proxy:8000'));
  requireThat(valid(env.R2_ENDPOINT_URL, 'http://storage:9000'));
}

async function cli() {
  const fs = require('node:fs');
  let fd;
  try {
    requireThat(process.argv.length === 3);
    validateLocalEndpoints(process.env); // Must precede production client creation.
    fd = fs.openSync(process.argv[2], fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    requireThat(stat.isFile() && (stat.mode & 0o7777) === 0o600 && stat.uid === process.getuid() &&
      stat.size > 0 && stat.size <= MAX_INPUT_BYTES);
    // Bounded read also guards a file growing after fstat. Never print path/data.
    const buffer = Buffer.alloc(MAX_INPUT_BYTES + 1);
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    requireThat(length === stat.size && length <= MAX_INPUT_BYTES);
    const input = validateInput(JSON.parse(buffer.subarray(0, length).toString('utf8')));
    buffer.fill(0);
    fs.closeSync(fd); fd = undefined;
    const { createServerSupabase } = require('../src/lib/supabase.ts');
    const result = await runBetaEvidence({ db: createServerSupabase(), input });
    fs.writeSync(1, `${JSON.stringify(result)}\n`);
    process.exit(0);
  } catch (error) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    const classified = error?.code === 'BETA_EVIDENCE_FAILED' &&
      ['input','auth','source','provider','append','readback'].includes(error.phase) &&
      Number.isInteger(error.provider_calls) && [0,1].includes(error.provider_calls);
    fs.writeSync(2, 'BETA_EVIDENCE_FAILED' + (classified ? ':' + error.phase + ':' + error.provider_calls : '') + '\n');
    process.exit(1);
  }
}

module.exports = { runBetaEvidence };
if (require.main === module) {
  // Hard stop rather than Promise.race: no abandoned mutation continues in this
  // CLI process. A timed-out remote commit is ambiguous; never retry here.
  setTimeout(() => {
    require('node:fs').writeSync(2, 'BETA_EVIDENCE_DEADLINE\n');
    process.exit(1);
  }, CLI_DEADLINE_MS);
  void cli();
}
