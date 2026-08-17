# Private Object Storage runbook

Production uses an external S3-compatible bucket. There is no RustFS, MinIO,
storage gateway, or public bucket in `compose.prod.yml`.

## Bucket controls

Create the bucket only after Iván approves the provider, region, account, and
retention. Before accepting data, configure and record:

- versioning enabled;
- public access block enabled for ACLs and bucket policy;
- no anonymous bucket policy or public object ACL;
- lifecycle/retention policy approved by Socium;
- a bucket credential that cannot administer the independent backup destination;
- SSE-C enabled for application PUT/GET operations.

The application receives a base64-encoded 32-byte customer key through
`R2_SSE_CUSTOMER_KEY` in the encrypted mode-0600 backend secret file. The key
is outside the bucket, outside Git, outside CI logs, and under the separate
Socium recovery custody procedure. Rotating it requires a planned object
rewrite and a recovery set; do not overwrite the key in place and assume old
objects remain readable.

Generate a key only in the approved secret workstation:

```bash
openssl rand -base64 32 > /srv/litt-secrets/object-storage-sse-c.key
chmod 600 /srv/litt-secrets/object-storage-sse-c.key
```

Do not paste the output into chat, a PR, a bucket object, or a shell history.

## Verification

Run the read-only policy check plus one temporary-object probe from the host:

```bash
export AWS_ENDPOINT_URL=https://<approved-private-endpoint>
export AWS_BUCKET_NAME=<approved-bucket>
export SSE_C_CUSTOMER_KEY_FILE=/srv/litt-secrets/object-storage-sse-c.key
scripts/object-storage/verify-private-versioning.sh
```

The probe must show that the bucket is versioned/private, a read without the
customer key fails, and the same object is readable with the key. Preserve the
command, timestamp, bucket identity, object version ID, and sanitized output in
the Gate B receipt; never preserve the key or object content.

## Backup relationship

Versioning protects against accidental overwrite/delete but is not the backup.
The recovery job exports every object version and delete marker, encrypts the
complete set before transfer, and copies it to an independent destination with
independent credentials. A bucket-only recovery point never closes W2.6.
