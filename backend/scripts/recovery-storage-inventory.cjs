'use strict';
// Pinned MinIO RELEASE.2025-09-07T16-13-09Z recovery comparison, NOT generic S3.
// S3 does NOT cover IAM/server configuration: mandatory physical comparison
// remains the authority for those bytes. cmd/acl-handlers.go at that exact tag
// returns dummy FULL_CONTROL ACLs using current-key GetObjectInfo(ObjectOptions{}),
// not versionId. Never infer per-version permissions from that compatibility stub.
const { createHash } = require('node:crypto');
// Entry cap counts buckets, version/delete-marker records and independent current records.
// Byte cap covers the sum of every live version's body, including noncurrent versions.
const MAX_ENTRIES = 10000, MAX_BYTES = 256 * 1024 * 1024;
const REQUEST_MS = 15000, DEADLINE_MS = 300000;
const fail = () => { throw new Error('Storage inventory failed'); };
const check = value => { if (!value) fail(); };
const string = value => check(typeof value === 'string' && value.length > 0);
const size = value => check(Number.isSafeInteger(value) && value >= 0);
const date = value => check(value instanceof Date && Number.isFinite(value.getTime()));
const record = value => check(value && Object.getPrototypeOf(value) === Object.prototype);
function array(value, optional = false) {
  if (optional && value === undefined) return [];
  check(Array.isArray(value));
  return value;
}
function canonical(value) {
  if (value instanceof Date) { date(value); return value.toISOString(); }
  if (Array.isArray(value)) return value.map(canonical).sort((a, b) => {
    const x = JSON.stringify(a), y = JSON.stringify(b);
    return x < y ? -1 : x > y ? 1 : 0;
  });
  if (value && typeof value === 'object') {
    record(value);
    return Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, canonical(value[k])]));
  }
  check(value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)));
  return value;
}
// Remove only top-level transport fields; identically named application metadata stays.
function semantic(output, omit = []) {
  return canonical(Object.fromEntries(Object.entries(output).filter(([k]) => k !== '$metadata' && !omit.includes(k))));
}
function validateAcl(o) {
  // Preserve MinIO's empty canonical ACL IDs literally, never infer an owner.
  record(o.Owner); check(typeof o.Owner.ID === 'string');
  for (const g of array(o.Grants)) {
    record(g); string(g.Permission); record(g.Grantee); string(g.Grantee.Type);
    const field = { CanonicalUser: 'ID', Group: 'URI', AmazonCustomerByEmail: 'EmailAddress' }[g.Grantee.Type];
    check(field);
    if (field === 'ID') check(g.Grantee.ID === undefined || typeof g.Grantee.ID === 'string');
    else string(g.Grantee[field]);
  }
}
function validateTags(o) {
  const seen = new Set();
  for (const t of array(o.TagSet)) {
    record(t); string(t.Key); check(typeof t.Value === 'string');
    check(!seen.has(t.Key)); seen.add(t.Key);
  }
}
function nonempty(value) { const items = array(value); check(items.length > 0); return items; }
function validateRules(o, field, validate) {
  for (const rule of nonempty(o[field])) { record(rule); validate(rule); }
}
function validateLock(o) {
  record(o.ObjectLockConfiguration); check(o.ObjectLockConfiguration.ObjectLockEnabled === 'Enabled');
  const rule = o.ObjectLockConfiguration.Rule;
  if (rule !== undefined) {
    record(rule); record(rule.DefaultRetention);
    const r = rule.DefaultRetention;
    check(['GOVERNANCE', 'COMPLIANCE'].includes(r.Mode));
    check((r.Days === undefined) !== (r.Years === undefined));
    const duration = r.Days ?? r.Years; size(duration); check(duration > 0);
  }
}
// Documented S3 missing-configuration codes, ONLY with HTTP 404. Empty successful
// versioning/notification responses are valid; unsupported APIs are never absence.
const CONFIG = [
  ['GetBucketAcl', null, validateAcl],
  ['GetBucketVersioning', null, o => {
    if (o.Status !== undefined) check(['Enabled', 'Suspended'].includes(o.Status));
    if (o.MFADelete !== undefined) check(['Enabled', 'Disabled'].includes(o.MFADelete));
  }],
  ['GetBucketPolicy', 'NoSuchBucketPolicy', o => { string(o.Policy); record(JSON.parse(o.Policy)); }],
  ['GetBucketEncryption', 'ServerSideEncryptionConfigurationNotFoundError', o => {
    record(o.ServerSideEncryptionConfiguration);
    validateRules(o.ServerSideEncryptionConfiguration, 'Rules', r => {
      record(r.ApplyServerSideEncryptionByDefault); string(r.ApplyServerSideEncryptionByDefault.SSEAlgorithm);
    });
  }],
  ['GetBucketLifecycleConfiguration', 'NoSuchLifecycleConfiguration', o => validateRules(o, 'Rules', r => check(['Enabled', 'Disabled'].includes(r.Status)))],
  ['GetBucketReplication', 'ReplicationConfigurationNotFoundError', o => {
    record(o.ReplicationConfiguration); string(o.ReplicationConfiguration.Role);
    validateRules(o.ReplicationConfiguration, 'Rules', r => {
      check(['Enabled', 'Disabled'].includes(r.Status)); record(r.Destination); string(r.Destination.Bucket);
    });
  }],
  ['GetBucketTagging', 'NoSuchTagSet', validateTags],
  ['GetBucketNotificationConfiguration', null, o => {
    for (const [field, arn] of [['TopicConfigurations', 'TopicArn'], ['QueueConfigurations', 'QueueArn'], ['LambdaFunctionConfigurations', 'LambdaFunctionArn']]) {
      for (const r of array(o[field], true)) { record(r); string(r[arn]); nonempty(r.Events).forEach(string); }
    }
    if (o.EventBridgeConfiguration !== undefined) record(o.EventBridgeConfiguration);
  }],
  ['GetBucketCors', 'NoSuchCORSConfiguration', o => validateRules(o, 'CORSRules', r => { nonempty(r.AllowedMethods).forEach(string); nonempty(r.AllowedOrigins).forEach(string); })],
  ['GetObjectLockConfiguration', 'ObjectLockConfigurationNotFoundError', validateLock],
];
async function inventory(client) {
  const S3 = require('@aws-sdk/client-s3');
  const controller = new AbortController();
  const end = Date.now() + DEADLINE_MS;
  let entries = 0, bytes = 0, declaredBytes = 0, requests = 0;
  function count(n = 1) { entries += n; check(entries <= MAX_ENTRIES); }
  async function bounded(work) {
    const ms = Math.min(REQUEST_MS, end - Date.now()); check(ms > 0);
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('Storage inventory failed')); }, ms);
      })]);
    } finally { clearTimeout(timer); }
  }
  async function send(op, input) {
    check(++requests <= MAX_ENTRIES * 20);
    const o = await bounded(() => client.send(new S3[`${op}Command`](input), { abortSignal: controller.signal }));
    record(o); check(o.$metadata?.httpStatusCode === 200);
    return o;
  }
  async function config(op, input, absence, validate, absenceStatus = 404) {
    let o;
    try { o = await send(op, input); }
    catch (e) {
      if (absence && e?.name === absence && e?.$metadata?.httpStatusCode === absenceStatus) return { absent: absence };
      throw e;
    }
    validate(o);
    return semantic(o);
  }
  // No delimiter or prefix: omitted SDK collections mean an empty XML collection.
  async function pages(op, input, fields, visit) {
    let cursor = {}, seen = new Set();
    for (;;) {
      const o = await send(op, { ...input, ...cursor });
      if (op !== 'ListBuckets') {
        check(o.Name === input.Bucket); check(typeof o.IsTruncated === 'boolean');
        check(array(o.CommonPrefixes, true).length === 0);
      }
      await visit(o);
      const more = op === 'ListBuckets' ? o.ContinuationToken !== undefined : o.IsTruncated;
      const next = fields.map(([out]) => o[out]);
      if (!more) { check(next.every(v => v === undefined || v === '')); break; }
      next.forEach(string);
      const id = JSON.stringify(next); check(!seen.has(id)); seen.add(id);
      check(seen.size <= MAX_ENTRIES);
      cursor = Object.fromEntries(fields.map(([, into], i) => [into, next[i]]));
    }
  }
  try {
    const buckets = [], names = new Set();
    let owner;
    await pages('ListBuckets', { MaxBuckets: 1000 }, [['ContinuationToken', 'ContinuationToken']], o => {
      record(o.Owner); string(o.Owner.ID);
      const nextOwner = semantic(o.Owner);
      if (owner) check(JSON.stringify(owner) === JSON.stringify(nextOwner)); else owner = nextOwner;
      for (const b of array(o.Buckets, true)) {
        record(b); string(b.Name);
        // Prevent S3 ARN/access-point endpoint rewriting, even with an explicit endpoint.
        check(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(b.Name) && !b.Name.includes('..'));
        date(b.CreationDate); count();
        check(!names.has(b.Name)); names.add(b.Name);
        buckets.push({ bucket: semantic(b) });
      }
    });
    for (const b of buckets) {
      const input = { Bucket: b.bucket.Name };
      b.configuration = {};
      for (const [op, absence, validate] of CONFIG) b.configuration[op] = await config(op, input, absence, validate);
      const uploads = await send('ListMultipartUploads', { ...input, MaxUploads: 1 });
      check(uploads.Bucket === input.Bucket && uploads.IsTruncated === false);
      if (array(uploads.Uploads, true).length) throw new Error('Incomplete multipart uploads are not supported');
      check(array(uploads.CommonPrefixes, true).length === 0);
      // MinIO may return empty multipart marker strings on a final page.
      check([uploads.NextKeyMarker, uploads.NextUploadIdMarker].every(v => v === undefined || v === ''));
      b.versions = []; b.deleteMarkers = []; b.current = [];
      const ids = new Set(), byKey = new Map();
      await pages('ListObjectVersions', { ...input, MaxKeys: 1000 }, [['NextKeyMarker', 'KeyMarker'], ['NextVersionIdMarker', 'VersionIdMarker']], o => {
        for (const [field, destination] of [['Versions', b.versions], ['DeleteMarkers', b.deleteMarkers]]) {
          for (const v of array(o[field], true)) {
            record(v); string(v.Key); string(v.VersionId); date(v.LastModified); check(typeof v.IsLatest === 'boolean'); count();
            const id = JSON.stringify([v.Key, v.VersionId]); check(!ids.has(id)); ids.add(id);
            const group = byKey.get(v.Key) || []; group.push({ ...v, deleted: field === 'DeleteMarkers' }); byKey.set(v.Key, group);
            if (field === 'Versions') {
              size(v.Size); string(v.ETag); string(v.StorageClass);
              declaredBytes += v.Size; check(declaredBytes <= MAX_BYTES);
            }
            destination.push({ listing: semantic(v) });
          }
        }
      });
      const latest = new Map();
      for (const [key, group] of byKey) {
        const live = group.filter(v => v.IsLatest); check(live.length === 1);
        if (!live[0].deleted) latest.set(key, live[0]);
      }
      const currentKeys = new Set();
      await pages('ListObjectsV2', { ...input, MaxKeys: 1000 }, [['NextContinuationToken', 'ContinuationToken']], o => {
        const contents = array(o.Contents, true); size(o.KeyCount); check(o.KeyCount === contents.length);
        for (const v of contents) {
          record(v); string(v.Key); date(v.LastModified); size(v.Size); string(v.ETag); string(v.StorageClass); count();
          check(!currentKeys.has(v.Key)); currentKeys.add(v.Key);
          const expected = latest.get(v.Key); check(expected);
          for (const f of ['Size', 'ETag', 'StorageClass']) check(v[f] === expected[f]);
          check(v.LastModified.getTime() === expected.LastModified.getTime());
          b.current.push(semantic(v));
        }
      });
      check(currentKeys.size === latest.size);
      for (const current of b.current)
        current.acl = await config('GetObjectAcl', { ...input, Key: current.Key }, null, validateAcl);
      const locked = b.configuration.GetObjectLockConfiguration.ObjectLockConfiguration?.ObjectLockEnabled === 'Enabled';
      for (const v of b.versions) {
        const exact = { ...input, Key: v.listing.Key, VersionId: v.listing.VersionId };
        const o = await send('GetObject', exact);
        try {
          size(o.ContentLength); date(o.LastModified); string(o.ETag);
          // Unversioned MinIO/S3 reads can omit x-amz-version-id for the null version.
          check(o.VersionId === exact.VersionId || (exact.VersionId === 'null' && o.VersionId === undefined));
          // Last-Modified is HTTP-date (whole seconds); XML listings retain ms.
          // Hash both original values below, compare only their common precision.
          check(o.ContentLength === v.listing.Size && o.ETag === v.listing.ETag &&
            Math.floor(o.LastModified.getTime() / 1000) === Math.floor(Date.parse(v.listing.LastModified) / 1000));
          check(o.DeleteMarker !== true && o.ContentRange === undefined);
          check(o.Body && typeof o.Body[Symbol.asyncIterator] === 'function');
          record(o.Metadata);
          for (const value of Object.values(o.Metadata)) check(typeof value === 'string');
          const hash = createHash('sha256'); let length = 0;
          const iterator = o.Body[Symbol.asyncIterator]();
          for (;;) {
            const chunk = await bounded(() => iterator.next());
            check(chunk && typeof chunk.done === 'boolean');
            if (chunk.done) break;
            check(chunk.value instanceof Uint8Array);
            length += chunk.value.byteLength; bytes += chunk.value.byteLength;
            check(bytes <= MAX_BYTES && length <= o.ContentLength);
            hash.update(chunk.value);
          }
          check(length === o.ContentLength);
          v.body = { sha256: hash.digest('hex'), length };
          v.metadata = semantic(o, ['Body', 'AcceptRanges']);
        } finally { o.Body?.destroy?.(); }

        v.tags = await config('GetObjectTagging', exact, null, validateTags);
        if (v.tags.VersionId !== undefined) check(v.tags.VersionId === exact.VersionId);
        if (locked) {
          // MinIO's exact 400 NoSuchObjectLockConfiguration means unset; it is
          // recorded explicitly. Missing-object, auth and dependency errors fail.
          v.retention = await config('GetObjectRetention', exact, 'NoSuchObjectLockConfiguration', o => {
            record(o.Retention);
            if (Object.keys(o.Retention).length) {
              check(['GOVERNANCE', 'COMPLIANCE'].includes(o.Retention.Mode)); date(o.Retention.RetainUntilDate);
            }
          }, 400);
          v.legalHold = await config('GetObjectLegalHold', exact, 'NoSuchObjectLockConfiguration', o => {
            record(o.LegalHold);
            if (Object.keys(o.LegalHold).length) check(['ON', 'OFF'].includes(o.LegalHold.Status));
          }, 400);
        }
      }
    }
    return canonical({ format: 1, acl_model: 'minio-bucket-policy-iam; object-acl-is-current-key-stub', owner, buckets });
  } catch (e) { controller.abort(); throw e; }
}
function summarize(data) {
  const counts = { buckets: data.buckets.length, versions: 0, deleteMarkers: 0, currentObjects: 0, bytes: 0 };
  for (const b of data.buckets) {
    counts.versions += b.versions.length; counts.deleteMarkers += b.deleteMarkers.length;
    counts.currentObjects += b.current.length;
    for (const v of b.versions) counts.bytes += v.body.length;
  }
  return { sha256: createHash('sha256').update(JSON.stringify(canonical(data))).digest('hex'), counts };
}
async function cli() {
  let client;
  // Overall deadline, in addition to per-request and per-stream-read bounds.
  const timer = setTimeout(() => { process.stderr.write('Storage inventory failed\n'); process.exit(1); }, DEADLINE_MS);
  try {
    const endpoint = process.env.R2_ENDPOINT_URL;
    check(typeof endpoint === 'string' && /^(http:\/\/storage:9000|http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4})$/.test(endpoint));
    const url = new URL(endpoint); check(Number(url.port || 80) <= 65535);
    const accessKeyId = process.env.R2_ACCESS_KEY_ID, secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    string(accessKeyId); string(secretAccessKey);
    const S3 = require('@aws-sdk/client-s3');
    const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };
    client = new S3.S3Client({ endpoint, region: 'us-east-1', forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey }, maxAttempts: 1, logger,
      followRegionRedirects: false, useArnRegion: false,
      requestHandler: { connectionTimeout: REQUEST_MS, requestTimeout: REQUEST_MS, socketTimeout: REQUEST_MS, throwOnRequestTimeout: true, logger },
    });
    const result = summarize(await inventory(client));
    client.destroy(); client = undefined;
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch { process.stderr.write('Storage inventory failed\n'); process.exitCode = 1; }
  finally { clearTimeout(timer); try { client?.destroy(); } catch { /* Already failed; cleanup must not leak. */ } }
}
module.exports = { inventory, summarize };
if (require.main === module) void cli();
