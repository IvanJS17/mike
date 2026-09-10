'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { runBetaEvidence } = require('./recovery-beta-evidence.cjs');
const { Document, Packer, Paragraph } = require('docx');
const { storageKey } = require('../src/lib/storage.ts');
const { MX_CIVIL_COMMERCIAL_SYNC_ENTRY } = require('../src/lib/recovery/workflows/mxCivilCommercialPlaybook.ts');
const sha = value => createHash('sha256').update(value).digest('hex');
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const input = Object.freeze({
  owner_user_id: uuid(1), owner_access_token: 'private-auth-boundary-fixture',
  organization_id: uuid(2), matter_id: uuid(3), project_id: uuid(4),
  document_id: uuid(5), execution_id: uuid(6), idempotency_key: 'beta-evidence-1',
});

// Only Auth, storage and the Supabase transport are faked. This in-memory
// relational/RPC double is NOT PostgreSQL transaction, RLS or runtime proof.
async function fixture() {
  const bytes = await Packer.toBuffer(new Document({
    sections: [{ children: [new Paragraph('Synthetic smoke agreement. No client data.')] }],
  }));
  const state = { reads: [], auth: [], downloads: 0, rpcs: 0, batch: null, fault: null };
  const rows = {
    mike_workflows: [structuredClone(MX_CIVIL_COMMERCIAL_SYNC_ENTRY)],
    organization_memberships: [{ user_id: input.owner_user_id,
      organization_id: input.organization_id, role: 'org_owner', status: 'active',
      organizations: { authorization_epoch: 1 } }],
    matters: [{ id: input.matter_id, project_id: input.project_id, workspace_id: uuid(7),
      visibility: 'public', workspaces: { organization_id: input.organization_id } }],
    documents: [{ id: input.document_id, project_id: input.project_id,
      user_id: input.owner_user_id, current_version_id: uuid(8), status: 'ready' }],
    document_versions: [{ id: uuid(8), document_id: input.document_id,
      source: 'upload', version_number: 1, filename: 'smoke.docx', file_type: 'docx',
      storage_path: storageKey(input.owner_user_id, input.document_id, 'smoke.docx'),
      size_bytes: bytes.length, content_sha256: sha(bytes), deleted_at: null,
      documents: { id: input.document_id, project_id: input.project_id } }],
    ai_executions: [], ai_output_versions: [], ai_receipts: [], ai_document_version_pages: [],
  };
  const db = {
    auth: {
      async getUser(token) {
        assert.equal(token, input.owner_access_token); state.auth.push('user');
        return { data: { user: { id: state.fault === 'auth' ? uuid(99) : input.owner_user_id } }, error: null };
      },
      mfa: { async getAuthenticatorAssuranceLevel(token) {
        assert.equal(token, input.owner_access_token); state.auth.push('mfa');
        return { data: { currentLevel: state.fault === 'mfa' ? 'aal1' : 'aal2' }, error: null };
      } },
    },
    from(table) {
      const filters = []; let single = false;
      const q = {
        select() { return q; }, eq(key, value) { filters.push([key, value]); return q; },
        order() { return q; }, maybeSingle() { single = true; return q; },
        then(resolve, reject) {
          return Promise.resolve().then(() => {
            state.reads.push(table);
            const documentReads = state.reads.filter(t => t === 'documents').length;
            if (state.fault === 'provider' && table === 'documents' && documentReads === 3)
              throw new Error(input.owner_access_token);
            if (state.fault === 'stale' && table === 'documents' && documentReads === 2)
              rows.documents[0].current_version_id = uuid(99);
            if (state.fault === 'epoch' && table === 'organization_memberships' && state.downloads)
              rows.organization_memberships[0].organizations.authorization_epoch++;
            if (state.fault === 'resource' && table === 'document_versions' && documentReads >= 4)
              rows.document_versions[0].documents.project_id = uuid(99);
            if (state.fault === 'readback' && state.rpcs && table === 'ai_receipts')
              throw new Error(input.owner_access_token);
            const data = (rows[table] || []).filter(row => filters.every(([k, v]) => row[k] === v));
            return { data: structuredClone(single ? data[0] ?? null : data), error: null };
          }).then(resolve, reject);
        },
      };
      return q;
    },
    async rpc(name, args) {
      state.rpcs++;
      assert.equal(name, 'append_ai_evidence_batch');
      assert.equal(args.p_actor_user_id, input.owner_user_id);
      assert.equal(args.p_organization_id, input.organization_id);
      assert.equal(args.p_authorization_epoch, 1);
      if (state.fault === 'persistence') return { data: null, error: { message: input.owner_access_token } };
      const b = structuredClone(args.p_batch); state.batch = b;
      const p = b.execution.provenance, w = p.workflow, route = p.route;
      rows.ai_executions.push({ id: b.execution.execution_id, author_user_id: args.p_actor_user_id,
        idempotency_key: b.idempotency_key, input_hashes: p.input_hashes, output_hashes: p.output_hashes, citation_hashes: p.citation_hashes,
        ...p.tenant_scope, document_id: b.pages[0].document_id,
        document_content_sha256: p.input_hashes[0], evidence_version: 'evidence-v1',
        status: 'succeeded', workflow_key: w.workflow_key, workflow_version: w.version,
        ...Object.fromEntries(['content_hash', 'source_commit', 'distribution', 'type', 'source', 'approval_provenance'].map(k => [`workflow_${k}`, w[k]])),
        route_provider: route.provider, route_model: route.model, credential_ref: route.credential_ref,
      });
      rows.ai_output_versions.push({ ...b.output, output_format: 'markdown', citation_refs: b.citations });
      rows.ai_receipts.push({ execution_id: b.execution.execution_id, idempotency_key: b.idempotency_key, ...b.receipt });
      rows.ai_document_version_pages.push(...b.pages.map(p => ({ document_id: p.document_id,
        document_version_id: p.document_version_id, page: p.page, content: p.text, content_sha256: p.text_sha256 })));
      if (state.fault === 'workflow') rows.ai_executions[0].workflow_content_hash = 'a'.repeat(64);
      if (state.fault === 'output') rows.ai_output_versions[0].output_text = 'corrupted';
      if (state.fault === 'citations') rows.ai_output_versions[0].citation_refs.pop();
      if (state.fault === 'receipt') rows.ai_receipts[0].idempotency_key = 'other';
      return { error: null, data: { disposition: 'applied', idempotency_key: b.idempotency_key,
        execution_id: b.execution.execution_id, receipt_sha256: b.receipt.receipt_sha256,
        counts: { pages: b.pages.length, outputs: rows.ai_output_versions.length, citations: b.citations.length } } };
    },
  };
  const download = async key => {
    assert.deepEqual(state.auth, ['user', 'mfa']);
    assert.equal(key, rows.document_versions[0].storage_path); state.downloads++;
    return bytes;
  };
  return { db, input, download, state, rows, bytes };
}

test('composes production services: one fake call, atomic append and persisted readback', async () => {
  const f = await fixture();
  const result = await runBetaEvidence(f);
  assert.equal(result.provider_calls, 1);
  assert.equal(result.execution_id, input.execution_id);
  assert.equal(result.document_version_id, uuid(8));
  assert.equal(result.document_sha256, sha(f.bytes));
  assert.equal(result.receipt_sha256, f.rows.ai_receipts[0].receipt_sha256);
  assert.equal(f.state.rpcs, 1);
  assert.equal(f.state.downloads, 1);
  assert.deepEqual(f.state.batch.citations.map(c => c.citation_id), ['R4', 'R6', 'R9']);
  assert.equal(f.state.batch.pages.length, 1);
  assert.ok(f.state.reads.includes('ai_output_versions'));
  assert.ok(f.state.reads.includes('ai_document_version_pages'));
  assert.match(result.limitations.join(' '), /fake credential fixture/);
  assert.doesNotMatch(JSON.stringify(result), /private-auth|Synthetic smoke agreement|finding_text|provider_api_key|beta-in-memory-fake-key/);
});

test('requires the persisted active catalog identity and exact prompt before egress', async () => {
  for (const fault of ['missing', 'inactive', 'hash', 'source', 'prompt']) {
    const f = await fixture();
    const row = f.rows.mike_workflows[0];
    if (fault === 'missing') f.rows.mike_workflows = [];
    if (fault === 'inactive') row.active = false;
    if (fault === 'hash') row.content_hash = 'a'.repeat(64);
    if (fault === 'source') row.source_commit = 'a'.repeat(40);
    if (fault === 'prompt') row.prompt_md += ' ';
    await rejectsSanitized(f, 0);
    assert.equal(f.state.rpcs, 0);
  }
});

async function rejectsSanitized(f, calls) {
  await assert.rejects(runBetaEvidence(f), error => {
    assert.equal(error.message, 'BETA_EVIDENCE_FAILED');
    assert.equal(error.code, 'BETA_EVIDENCE_FAILED');
    assert.equal(error.provider_calls, calls);
    assert.ok(['input','auth','source','provider','append','readback'].includes(error.phase));
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(error.stack + JSON.stringify(error), /private-auth|beta-in-memory-fake-key/);
    return true;
  });
}

test('Auth/AAL2 and source guards fail before provider or evidence writes', async () => {
  for (const fault of ['auth', 'mfa', 'auth-error', 'mfa-error', 'scope', 'hash', 'bytes', 'stale', 'path', 'version', 'uuid', 'not-docx', 'wrong-text']) {
    const f = await fixture(); f.state.fault = fault;
    if (fault === 'auth-error') f.db.auth.getUser = async () => { throw new Error(input.owner_access_token); };
    if (fault === 'mfa-error') f.db.auth.mfa.getAuthenticatorAssuranceLevel = async () => ({ data: { currentLevel: 'aal2' }, error: {} });
    if (fault === 'scope') f.rows.matters[0].project_id = uuid(99);
    if (fault === 'hash') f.rows.document_versions[0].content_sha256 = 'a'.repeat(64);
    if (fault === 'bytes') {
      const bytes = Buffer.alloc(f.bytes.length, 1);
      f.rows.document_versions[0].content_sha256 = sha(bytes);
      f.download = async () => bytes;
    }
    if (fault === 'not-docx' || fault === 'wrong-text') {
      const JSZip = require('jszip');
      const zip = fault === 'not-docx' ? new JSZip() : await JSZip.loadAsync(f.bytes);
      zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>' +
        (fault === 'not-docx' ? 'Synthetic smoke agreement. No client data.' : 'Different source') +
        '</w:t></w:r></w:p></w:body></w:document>');
      const bytes = await zip.generateAsync({ type: 'nodebuffer' });
      f.rows.document_versions[0].content_sha256 = sha(bytes);
      f.rows.document_versions[0].size_bytes = bytes.length;
      f.download = async () => bytes;
    }
    if (fault === 'path') f.rows.document_versions[0].storage_path = 'invented/source.docx';
    if (fault === 'version') f.rows.document_versions[0].document_id = uuid(99);
    if (fault === 'uuid') f.input = { ...input, execution_id: input.execution_id + ' ' };
    await rejectsSanitized(f, 0);
    assert.equal(f.state.rpcs, 0, fault);
    if (['auth', 'mfa', 'auth-error', 'mfa-error', 'uuid'].includes(fault)) {
      assert.equal(f.state.downloads, 0, fault);
      assert.deepEqual(f.state.reads, [], fault);
    }
  }
});

test('sender, fresh authorization/resource, persistence and readback failures never trigger another call', async () => {
  for (const fault of ['provider', 'epoch', 'resource', 'persistence', 'readback', 'workflow', 'output', 'citations', 'receipt']) {
    const f = await fixture(); f.state.fault = fault;
    await rejectsSanitized(f, 1);
    assert.equal(f.state.rpcs, ['provider', 'epoch', 'resource'].includes(fault) ? 0 : 1, fault);
    if (fault === 'provider') assert.equal(f.state.batch, null);
  }
});

test('import is inert and CLI rejects nonlocal endpoint spellings without network', () => {
  const { spawnSync } = require('node:child_process');
  const script = require.resolve('./recovery-beta-evidence.cjs');
  const imported = spawnSync(process.execPath, ['-e', 'require(process.argv[1])', script], {
    encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 5000,
  });
  assert.equal(imported.status, 0);
  assert.equal(imported.stdout, '');
  assert.equal(imported.stderr, '');
  for (const [SUPABASE_URL, R2_ENDPOINT_URL] of [
    ['https://remote.invalid', 'http://storage:9000'],
    ['http://proxy:8000', 'https://remote.invalid'],
    ['http://127.1:8000', 'http://storage:9000'],
    ['http://127.0.0.1:8000@remote.invalid', 'http://storage:9000'],
    ['http://proxy:8000/', 'http://storage:9000'],
    ['http://127.0.0.1:65536', 'http://storage:9000'],
    ['http://proxy:8000', 'http://127.0.0.1:9000/path'],
    // Valid endpoints still reject this public, non-JSON script as private input.
    ['http://proxy:8000', 'http://storage:9000'],
    ['http://127.0.0.1:8000', 'http://127.0.0.1:9000'],
  ]) {
    const rejected = spawnSync(process.execPath, [script, script], {
      encoding: 'utf8', env: { PATH: process.env.PATH, SUPABASE_URL, R2_ENDPOINT_URL }, timeout: 5000,
    });
    assert.equal(rejected.status, 1);
    assert.equal(rejected.stdout, '');
    assert.equal(rejected.stderr, 'BETA_EVIDENCE_FAILED\n');
  }
});
