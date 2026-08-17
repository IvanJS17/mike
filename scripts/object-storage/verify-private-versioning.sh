#!/usr/bin/env bash
# Read-only bucket policy checks plus a disposable SSE-C probe.
# The probe writes and deletes one temporary object in the approved bucket; it
# never changes bucket policy or versioning.
set -Eeuo pipefail

: "${AWS_ENDPOINT_URL:?set AWS_ENDPOINT_URL to the private object-storage endpoint}"
: "${AWS_BUCKET_NAME:?set AWS_BUCKET_NAME to the production bucket}"
: "${SSE_C_CUSTOMER_KEY_FILE:?set SSE_C_CUSTOMER_KEY_FILE to the 0600 key file}"

if [[ ! -f "$SSE_C_CUSTOMER_KEY_FILE" ]]; then
  printf 'Missing SSE-C key file.\n' >&2
  exit 1
fi
if [[ "$(stat -c '%a' "$SSE_C_CUSTOMER_KEY_FILE")" != "600" ]]; then
  printf 'SSE-C key file must be mode 600.\n' >&2
  exit 1
fi

versioning=$(aws s3api get-bucket-versioning \
  --bucket "$AWS_BUCKET_NAME" \
  --endpoint-url "$AWS_ENDPOINT_URL" \
  --output json)
if [[ "$(jq -r '.Status // ""' <<<"$versioning")" != "Enabled" ]]; then
  printf 'Bucket versioning is not enabled.\n' >&2
  exit 1
fi

public_access=$(aws s3api get-public-access-block \
  --bucket "$AWS_BUCKET_NAME" \
  --endpoint-url "$AWS_ENDPOINT_URL" \
  --output json)
if ! jq -e '
  .PublicAccessBlockConfiguration
  | .BlockPublicAcls == true
  and .IgnorePublicAcls == true
  and .BlockPublicPolicy == true
  and .RestrictPublicBuckets == true
' <<<"$public_access" >/dev/null; then
  printf 'Bucket public-access-block is not fully enabled.\n' >&2
  exit 1
fi

key="__litt_sse_probe__/$(date -u +%Y%m%dT%H%M%SZ)-$$"
body=$(mktemp)
without_key=$(mktemp)
with_key=$(mktemp)
trap 'rm -f "$body" "$without_key" "$with_key"; aws s3api delete-object --bucket "$AWS_BUCKET_NAME" --key "$key" --endpoint-url "$AWS_ENDPOINT_URL" >/dev/null 2>&1 || true' EXIT
printf 'litt-sse-probe\n' >"$body"

# fileb:// keeps the customer key out of the process argument list.
aws s3api put-object \
  --bucket "$AWS_BUCKET_NAME" \
  --key "$key" \
  --body "$body" \
  --endpoint-url "$AWS_ENDPOINT_URL" \
  --sse-customer-algorithm AES256 \
  --sse-customer-key "fileb://$SSE_C_CUSTOMER_KEY_FILE" >/dev/null

if aws s3api get-object \
  --bucket "$AWS_BUCKET_NAME" \
  --key "$key" \
  --endpoint-url "$AWS_ENDPOINT_URL" \
  "$without_key" >/dev/null 2>&1; then
  printf 'A keyless read unexpectedly succeeded; SSE-C is not enforced.\n' >&2
  exit 1
fi

aws s3api get-object \
  --bucket "$AWS_BUCKET_NAME" \
  --key "$key" \
  --endpoint-url "$AWS_ENDPOINT_URL" \
  --sse-customer-algorithm AES256 \
  --sse-customer-key "fileb://$SSE_C_CUSTOMER_KEY_FILE" \
  "$with_key" >/dev/null
cmp -s "$body" "$with_key"
printf 'Private versioned bucket and SSE-C keyless-read rejection verified.\n'
