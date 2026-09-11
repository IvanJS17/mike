'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { spawnSync } = require('node:child_process');
const { inventory, summarize } = require('./recovery-storage-inventory.cjs');
const date = new Date('2026-01-01T00:00:00Z');
const owner = { ID: 'owner' };
const acl = { Owner: owner, Grants: [{ Grantee: { Type: 'CanonicalUser', ID: 'owner' }, Permission: 'FULL_CONTROL' }] };
const absent = {
  GetBucketPolicy: 'NoSuchBucketPolicy', GetBucketEncryption: 'ServerSideEncryptionConfigurationNotFoundError',
  GetBucketLifecycleConfiguration: 'NoSuchLifecycleConfiguration', GetBucketReplication: 'ReplicationConfigurationNotFoundError',
  GetBucketTagging: 'NoSuchTagSet', GetBucketCors: 'NoSuchCORSConfiguration',
  GetObjectLockConfiguration: 'ObjectLockConfigurationNotFoundError',
};
function fixture(change = () => {}) {
  const calls = [];
  return { calls, async send(command) {
    const op = command.constructor.name.replace(/Command$/, '');
    const input = command.input;
    calls.push({ op, input });
    let out;
    const version = (Key, VersionId, IsLatest) => ({ Key, VersionId, IsLatest, LastModified: date, ETag: '"etag"', Size: 3, StorageClass: 'STANDARD', Owner: owner });
    switch (op) {
      case 'ListBuckets': out = { Buckets: [{ Name: input.ContinuationToken ? 'bucket-b' : 'bucket-a', CreationDate: date }], Owner: owner, ...(input.ContinuationToken ? {} : { ContinuationToken: 'b-page' }) }; break;
      case 'ListMultipartUploads': out = { Bucket: input.Bucket, IsTruncated: false }; break;
      case 'ListObjectVersions': out = input.KeyMarker
        ? { Name: input.Bucket, IsTruncated: false, Versions: [version('x', 'null', false), version('gone', 'old', false)], DeleteMarkers: [{ Key: 'gone', VersionId: 'deleted', IsLatest: true, LastModified: date, Owner: owner }] }
        : { Name: input.Bucket, IsTruncated: true, NextKeyMarker: 'x', NextVersionIdMarker: 'v1', Versions: [version('x', 'v1', true)] }; break;
      case 'ListObjectsV2': out = { Name: input.Bucket, IsTruncated: false, KeyCount: 1, Contents: [{ Key: 'x', LastModified: date, ETag: '"etag"', Size: 3, StorageClass: 'STANDARD' }] }; break;
      case 'GetObject': out = { Body: Readable.from([Buffer.from('abc')]), ContentLength: 3, LastModified: date, ETag: '"etag"', VersionId: input.VersionId, Metadata: { custom: 'yes' }, ContentType: 'text/plain' }; break;
      case 'GetBucketAcl': case 'GetObjectAcl': out = structuredClone(acl); break;
      case 'GetObjectTagging': out = { VersionId: input.VersionId, TagSet: [] }; break;
      case 'GetBucketVersioning': out = { Status: 'Enabled' }; break;
      case 'GetBucketNotificationConfiguration': out = {}; break;
      default: out = Object.assign(new Error('sensitive dependency error'), { name: absent[op], $metadata: { httpStatusCode: 404 } });
    }
    if (!(out instanceof Error)) out.$metadata = { httpStatusCode: 200, requestId: 'volatile' };
    const replacement = await change(op, input, out, calls);
    if (replacement !== undefined) out = replacement;
    if (out instanceof Error) throw out;
    return out;
  } };
}
test('all buckets, pages, versions, null versions, delete markers and exact version reads', async () => {
  const client = fixture();
  const data = await inventory(client);
  assert.deepEqual(summarize(data).counts, { buckets: 2, versions: 6, deleteMarkers: 2, currentObjects: 2, bytes: 18 });
  assert.equal(data.buckets.length, 2);
  assert.equal(client.calls.filter(x => x.op === 'GetObject').length, 6);
  assert.ok(client.calls.filter(x => x.op === 'GetObject').every(x => x.input.VersionId));
  assert.equal(summarize(data).sha256.length, 64);
});
test('bytes, metadata, ACL and bucket config each affect digest; transport does not', async () => {
  const baseline = summarize(await inventory(fixture())).sha256;
  for (const change of [
    (op, i, o) => { if (op === 'GetObject') o.Body = Readable.from([Buffer.from('xyz')]); },
    (op, i, o) => { if (op === 'GetObject') o.Metadata.custom = 'changed'; },
    (op, i, o) => { if (op === 'GetObjectAcl') o.Grants[0].Permission = 'READ'; },
    (op, i, o) => { if (op === 'GetBucketVersioning') o.MFADelete = 'Enabled'; },
  ]) assert.notEqual(summarize(await inventory(fixture(change))).sha256, baseline);
  assert.equal(summarize(await inventory(fixture((op, i, o) => { if (!(o instanceof Error)) o.$metadata.requestId = 'other'; }))).sha256, baseline);
});
test('malformed listings, duplicates, pagination, inconsistent current view and uploads fail closed', async () => {
  for (const change of [
    (op,i,o) => { if (op === 'ListBuckets') delete o.Buckets[0].Name; },
    (op,i,o) => { if (op === 'ListBuckets') o.Buckets[0].Name = 'bucket-a'; },
    (op,i,o) => { if (op === 'ListBuckets') o.ContinuationToken = 'repeat'; },
    (op,i,o) => { if (op === 'ListObjectVersions') delete o.IsTruncated; },
    (op,i,o) => { if (op === 'ListObjectVersions') delete o.NextVersionIdMarker; },
    (op,i,o) => { if (op === 'ListObjectVersions' && i.KeyMarker) o.Versions.push(o.Versions[0]); },
    (op,i,o) => { if (op === 'ListObjectVersions') delete o.Versions[0].VersionId; },
    (op,i,o) => { if (op === 'ListObjectsV2') o.Contents = []; },
    (op,i,o) => { if (op === 'ListObjectsV2') { o.IsTruncated = true; } },
    (op,i,o) => { if (op === 'ListObjectsV2') o.Contents[0].Size = 4; },
    (op,i,o) => { if (op === 'ListMultipartUploads') o.Uploads = [{ Key: 'pending', UploadId: 'id' }]; },
    (op,i,o) => { if (op === 'GetObject') delete o.ContentLength; },
    (op,i,o) => { if (op === 'GetObject') o.VersionId = 'wrong'; },
    (op,i,o) => { if (op === 'GetBucketAcl') delete o.Grants; },
  ]) await assert.rejects(inventory(fixture(change)));
});
test('unknown errors, incorrect absence status, stream failures and byte/entry caps fail closed', async () => {
  for (const change of [
    (op,i,o) => { if (op === 'GetBucketPolicy') o.$metadata.httpStatusCode = 403; },
    (op) => { if (op === 'GetBucketPolicy') return Object.assign(new Error('secret'), { name: 'Unknown', $metadata: { httpStatusCode: 404 } }); },
    (op) => { if (op === 'GetObject') throw new Error('secret'); },
    (op,i,o) => { if (op === 'GetObject') o.Body = Readable.from((async function* () { throw new Error('secret'); })()); },
    (op,i,o) => { if (op === 'GetObject') o.Body = Readable.from([Buffer.from('shorter?')]); },
    (op,i,o) => { if (op === 'ListObjectVersions') o.Versions[0].Size = 256 * 1024 * 1024 + 1; },
    (op,i,o) => { if (op === 'ListBuckets') o.Buckets = Array.from({ length: 10001 }, (_, n) => ({ Name: `bucket-${n}`, CreationDate: date })); },
  ]) await assert.rejects(inventory(fixture(change)));
});
test('MinIO object-lock absence is explicit operation-specific 400, never missing object', async () => {
  for (const operation of ['GetObjectRetention', 'GetObjectLegalHold']) {
    const client = code => fixture(op => {
      const configs = { GetObjectLockConfiguration: { ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' } }, GetObjectRetention: { Retention: {} }, GetObjectLegalHold: { LegalHold: {} } };
      if (op === operation) throw Object.assign(new Error('synthetic lock absence'), { name: code, $metadata: { httpStatusCode: 400 } });
      if (configs[op]) return { ...configs[op], $metadata: { httpStatusCode: 200 } };
    });
    const data = await inventory(client('NoSuchObjectLockConfiguration'));
    assert.equal(data.buckets[0].versions[0][operation === 'GetObjectRetention' ? 'retention' : 'legalHold'].absent, 'NoSuchObjectLockConfiguration');
    await assert.rejects(inventory(client('NoSuchKey')));
  }
});

test('pinned MinIO ACL stub is read only for current keys, never fabricated for historical versions', async () => {
  const client = fixture((op, input) => {
    if (op === 'GetObjectAcl' && (input.VersionId !== undefined || input.Key === 'gone'))
      throw Object.assign(new Error('MinIO current key lookup'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
  });
  const data = await inventory(client);
  assert.deepEqual(summarize(data).counts, { buckets: 2, versions: 6, deleteMarkers: 2, currentObjects: 2, bytes: 18 });
  assert.equal(client.calls.filter(c => c.op === 'GetObjectAcl').length, 2);
  assert.equal(data.acl_model, 'minio-bucket-policy-iam; object-acl-is-current-key-stub');
  await assert.rejects(inventory(fixture(op => {
    if (op === 'GetObjectAcl') throw Object.assign(new Error('gone during read'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
  })));
});

test('HTTP object dates have second precision; XML listing milliseconds stay in the digest', async () => {
  const data = await inventory(fixture((op, i, o) => {
    if (op === 'ListObjectVersions') for (const v of o.Versions || []) v.LastModified = new Date(date.getTime() + 500);
    if (op === 'ListObjectsV2') for (const v of o.Contents || []) v.LastModified = new Date(date.getTime() + 500);
  }));
  assert.ok(data.buckets[0].versions.some(v => v.listing.LastModified.endsWith('.500Z')));
  await assert.rejects(inventory(fixture((op, i, o) => {
    if (op === 'GetObject') o.LastModified = new Date(date.getTime() + 1000);
  })));
});

test('terminal version pages accept MinIO empty markers without hiding truncation', async () => {
  const client = fixture((op, i, o) => {
    if (op === 'ListObjectVersions' && !o.IsTruncated) {
      o.NextKeyMarker = ''; o.NextVersionIdMarker = '';
    }
  });
  assert.deepEqual(summarize(await inventory(client)), summarize(await inventory(fixture())));
  await assert.rejects(inventory(fixture((op, i, o) => {
    if (op === 'ListObjectVersions' && o.IsTruncated) o.NextVersionIdMarker = '';
  })));
});

test('MinIO empty canonical ACL IDs remain literal security facts, not omitted grants', async () => {
  const make = permission => fixture((op, i, o) => {
    if (op === 'GetBucketAcl' || op === 'GetObjectAcl') {
      o.Owner = { ID: '', DisplayName: '' };
      o.Grants = [{ Grantee: { DisplayName: '', Type: 'CanonicalUser' }, Permission: permission }];
    }
  });
  const data = await inventory(make('FULL_CONTROL'));
  assert.equal(data.buckets[0].configuration.GetBucketAcl.Owner.ID, '');
  assert.equal(data.buckets[0].configuration.GetBucketAcl.Grants.length, 1);
  assert.notEqual(summarize(data).sha256, summarize(await inventory(make('READ'))).sha256);
  await assert.rejects(inventory(fixture((op, i, o) => { if (op === 'GetBucketAcl') delete o.Owner.ID; })));
});

test('CLI rejects unsafe endpoint or missing explicit credentials with fixed output', () => {
  for (const endpoint of ['https://example.com', 'http://localhost:9000', 'http://127.1:9000', 'http://storage:9000/path', 'http://127.0.0.1:0', 'http://storage:9000']) {
    const p = spawnSync(process.execPath, [require.resolve('./recovery-storage-inventory.cjs')], { env: { PATH: process.env.PATH, R2_ENDPOINT_URL: endpoint }, encoding: 'utf8' });
    assert.equal(p.status, 1);
    assert.equal(p.stdout, '');
    assert.equal(p.stderr, 'Storage inventory failed\n');
  }
});

test('malformed security configurations and ARN-like bucket names are rejected', async () => {
  for (const change of [
    (op,i,o) => { if (op === 'ListBuckets') o.Buckets[0].Name = 'arn:aws:s3:us-east-1:123456789012:accesspoint/private'; },
    (op) => { if (op === 'GetBucketEncryption') return { $metadata: { httpStatusCode: 200 }, ServerSideEncryptionConfiguration: {} }; },
    (op) => { if (op === 'GetBucketLifecycleConfiguration') return { $metadata: { httpStatusCode: 200 }, Rules: null }; },
    (op) => { if (op === 'GetBucketReplication') return { $metadata: { httpStatusCode: 200 }, ReplicationConfiguration: {} }; },
    (op) => { if (op === 'GetBucketCors') return { $metadata: { httpStatusCode: 200 }, CORSRules: [{}] }; },
    (op,i,o) => { if (op === 'GetBucketNotificationConfiguration') o.QueueConfigurations = [{}]; },
  ]) await assert.rejects(inventory(fixture(change)));
});

test('populated bucket security and enabled object retention/legal hold are inventoried', async () => {
  const configs = {
    GetBucketPolicy: { Policy: '{"Version":"2012-10-17","Statement":[]}' },
    GetBucketEncryption: { ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] } },
    GetBucketLifecycleConfiguration: { Rules: [{ ID: 'expire', Status: 'Enabled', Filter: { Prefix: '' }, Expiration: { Days: 30 } }] },
    GetBucketReplication: { ReplicationConfiguration: { Role: 'role', Rules: [{ Status: 'Enabled', Destination: { Bucket: 'arn:aws:s3:::replica' } }] } },
    GetBucketTagging: { TagSet: [{ Key: 'scope', Value: 'test' }] },
    GetBucketNotificationConfiguration: { QueueConfigurations: [{ QueueArn: 'arn:queue', Events: ['s3:ObjectCreated:*'] }] },
    GetBucketCors: { CORSRules: [{ AllowedMethods: ['GET'], AllowedOrigins: ['*'] }] },
    GetObjectLockConfiguration: { ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' } },
    GetObjectRetention: { Retention: { Mode: 'GOVERNANCE', RetainUntilDate: date } },
    GetObjectLegalHold: { LegalHold: { Status: 'ON' } },
  };
  const client = fixture(op => configs[op] && { ...structuredClone(configs[op]), $metadata: { httpStatusCode: 200 } });
  const data = await inventory(client);
  assert.equal(client.calls.filter(c => c.op === 'GetObjectRetention').length, 6);
  assert.equal(data.buckets[0].versions[0].legalHold.LegalHold.Status, 'ON');
  const base = summarize(data).sha256;
  for (const op of Object.keys(configs)) {
    const next = structuredClone(configs);
    if (op === 'GetBucketPolicy') next[op].Policy = '{"Version":"2008-10-17","Statement":[]}';
    else next[op].AdditionalSemanticField = 'changed';
    assert.notEqual(summarize(await inventory(fixture(name => next[name] && { ...next[name], $metadata: { httpStatusCode: 200 } }))).sha256, base);
  }
  await assert.rejects(inventory(fixture(op => {
    if (op === 'GetObjectRetention') return { Retention: null, $metadata: { httpStatusCode: 200 } };
    if (configs[op]) return { ...configs[op], $metadata: { httpStatusCode: 200 } };
  })));
});
test('current pagination completes and response/list ordering is canonical', async () => {
  const baseline = summarize(await inventory(fixture())).sha256;
  const paged = fixture((op, i, o) => {
    if (op === 'ListObjectsV2' && !i.ContinuationToken) { o.IsTruncated = true; o.NextContinuationToken = 'current-next'; }
    else if (op === 'ListObjectsV2') { o.Contents = []; o.KeyCount = 0; }
    if (op === 'ListObjectVersions' && i.KeyMarker) o.Versions.reverse();
  });
  assert.equal(summarize(await inventory(paged)).sha256, baseline);
  for (const mutate of [
    o => { o.IsTruncated = true; o.NextContinuationToken = 'same'; o.Contents = []; o.KeyCount = 0; },
    o => { o.IsTruncated = false; o.NextContinuationToken = 'unexpected'; },
    o => { o.Contents.push(o.Contents[0]); o.KeyCount = 2; },
  ]) await assert.rejects(inventory(fixture((op, i, o) => { if (op === 'ListObjectsV2') mutate(o); })));
});
test('all absence codes require their operation-specific 404; 500/501 are fatal', async () => {
  for (const op of Object.keys(absent)) {
    for (const status of [403, 500, 501]) await assert.rejects(inventory(fixture((name, i, o) => {
      if (op === name) o.$metadata.httpStatusCode = status;
    })));
    await assert.rejects(inventory(fixture((name, i, o) => { if (op === name) o.name = 'NoSuchBucket'; })));
  }
});
test('hung dependencies and body reads are bounded and aborted', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const pending = inventory({ send: (_command, options) => { signal = options.abortSignal; return new Promise(() => {}); } });
  const rejected = assert.rejects(pending);
  await Promise.resolve();
  t.mock.timers.tick(15001);
  await rejected;
  assert.equal(signal.aborted, true);
  let started;
  const reading = new Promise(resolve => { started = resolve; });
  let destroyed = false;
  const streamPending = inventory(fixture((op, i, o) => {
    if (op === 'GetObject') o.Body = {
      [Symbol.asyncIterator]() { return this; },
      next() { started(); return new Promise(() => {}); },
      destroy() { destroyed = true; },
    };
  }));
  const streamRejected = assert.rejects(streamPending);
  await reading;
  t.mock.timers.tick(15001);
  await streamRejected;
  assert.equal(destroyed, true);
});
test('256 MiB is accepted exactly, excess streamed bytes and aggregate declared bytes fail', async () => {
  const limit = 256 * 1024 * 1024;
  function large(extra = false) {
    return fixture((op, i, o) => {
      if (op === 'ListBuckets') { delete o.ContinuationToken; }
      if (op === 'ListObjectVersions') {
        o.IsTruncated = false; delete o.NextKeyMarker; delete o.NextVersionIdMarker;
        o.Versions[0].Size = limit;
      }
      if (op === 'ListObjectsV2') o.Contents[0].Size = limit;
      if (op === 'GetObject') {
        o.ContentLength = limit;
        o.Body = Readable.from((async function* () {
          const chunk = Buffer.alloc(1024 * 1024);
          for (let n = 0; n < 256; n++) yield chunk;
          if (extra) yield Buffer.from('x');
        })());
      }
    });
  }
  assert.equal(summarize(await inventory(large())).counts.bytes, limit);
  await assert.rejects(inventory(large(true)));
  await assert.rejects(inventory(fixture((op, i, o) => {
    if (op === 'ListObjectVersions') for (const v of o.Versions) v.Size = 100 * 1024 * 1024;
  })));
});

test('CLI SDK loading failures are sanitized, without exposing dependency errors', () => {
  const helper = require.resolve('./recovery-storage-inventory.cjs');
  const code = `const M = require('node:module'); const original = M._load;
    M._load = function(name, ...args) { if (name === '@aws-sdk/client-s3') throw new Error('SECRET dependency path'); return original.call(this, name, ...args); };
    process.argv[1] = ${JSON.stringify(helper)}; M.runMain(process.argv[1]);`;
  const p = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env: {
    PATH: process.env.PATH, R2_ENDPOINT_URL: 'http://storage:9000', R2_ACCESS_KEY_ID: 'synthetic', R2_SECRET_ACCESS_KEY: 'synthetic',
  } });
  assert.equal(p.status, 1); assert.equal(p.stdout, ''); assert.equal(p.stderr, 'Storage inventory failed\n');
});

test('CLI allowlist is enforced before client construction and success prints only hash/counts', () => {
  const helper = require.resolve('./recovery-storage-inventory.cjs');
  const sdkPath = require.resolve('@aws-sdk/client-s3');
  const code = `const M = require('node:module'), assert = require('node:assert/strict');
    const { Readable } = require('node:stream');
    const date = new Date(${JSON.stringify(date.toISOString())});
    const owner = ${JSON.stringify(owner)}, acl = ${JSON.stringify(acl)}, absent = ${JSON.stringify(absent)};
    const fixture = ${fixture.toString()};
    const sdk = require(${JSON.stringify(sdkPath)}), original = M._load;
    M._load = function(name, ...args) {
      if (name !== '@aws-sdk/client-s3') return original.call(this, name, ...args);
      return { ...sdk, S3Client: class {
        constructor(options) {
          if (process.env.EXPECT_REJECT) { process.stderr.write('CLIENT CONSTRUCTED'); process.exit(9); }
          assert.equal(options.endpoint, process.env.R2_ENDPOINT_URL);
          assert.deepEqual(options.credentials, { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' });
          assert.equal(options.maxAttempts, 1); assert.equal(options.forcePathStyle, true);
          assert.equal(options.followRegionRedirects, false);
          assert.ok(options.requestHandler.connectionTimeout > 0 && options.requestHandler.requestTimeout > 0);
          this.client = fixture();
        }
        send(command) { return this.client.send(command); }
        destroy() {}
      }};
    };
    process.argv[1] = ${JSON.stringify(helper)}; M.runMain(process.argv[1]);`;
  for (const endpoint of ['http://storage:9000', 'http://127.0.0.1:80', 'http://127.0.0.1:65535',
    'http://storage:9001', 'https://127.0.0.1:9000', 'http://127.0.0.1:65536', 'http://user:pass@storage:9000',
    'http://storage:9000/', 'http://storage:9000?x=1', 'http://storage:9000#x', 'http://2130706433:9000']) {
    const allowed = ['http://storage:9000', 'http://127.0.0.1:80', 'http://127.0.0.1:65535'].includes(endpoint);
    const p = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env: {
      PATH: process.env.PATH, R2_ENDPOINT_URL: endpoint, R2_ACCESS_KEY_ID: 'synthetic', R2_SECRET_ACCESS_KEY: 'synthetic',
      ...(allowed ? {} : { EXPECT_REJECT: '1' }),
    } });
    assert.equal(p.status, allowed ? 0 : 1, p.stderr);
    if (allowed) {
      const summary = JSON.parse(p.stdout);
      assert.deepEqual(Object.keys(summary).sort(), ['counts', 'sha256']);
      assert.match(summary.sha256, /^[a-f0-9]{64}$/);
      assert.deepEqual(summary.counts, { buckets: 2, versions: 6, deleteMarkers: 2, currentObjects: 2, bytes: 18 });
      assert.equal(p.stderr, '');
    } else { assert.equal(p.stdout, ''); assert.equal(p.stderr, 'Storage inventory failed\n'); }
  }
});
