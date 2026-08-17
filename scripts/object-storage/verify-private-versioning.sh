#!/usr/bin/env bash
# Verify private versioning and SSE-C against an explicitly approved scratch target.
set -Eeuo pipefail
umask 077

: "${AWS_ENDPOINT_URL:?set AWS_ENDPOINT_URL to the private production object endpoint}"
: "${AWS_BUCKET_NAME:?set AWS_BUCKET_NAME to the production bucket}"
: "${AWS_ACCOUNT_ID:?set AWS_ACCOUNT_ID to the production account identifier}"
: "${SSE_C_CUSTOMER_KEY_FILE:?set SSE_C_CUSTOMER_KEY_FILE to the 0600 key file}"
: "${SSE_C_PROBE_APPROVAL:?set SSE_C_PROBE_APPROVAL=YES for a scratch probe}"
: "${SSE_C_PROBE_BUCKET_NAME:?set SSE_C_PROBE_BUCKET_NAME to a dedicated scratch bucket}"
: "${SSE_C_PROBE_ENDPOINT_URL:?set SSE_C_PROBE_ENDPOINT_URL to the isolated scratch endpoint}"
: "${SSE_C_PROBE_ALLOWED_HOST:?set SSE_C_PROBE_ALLOWED_HOST to the isolated scratch host}"
: "${SSE_C_PROBE_ACCOUNT_ID:?set SSE_C_PROBE_ACCOUNT_ID to the isolated scratch account}"
: "${SSE_C_PROBE_ACCESS_KEY_ID:?set SSE_C_PROBE_ACCESS_KEY_ID to the separate scratch credential}"
: "${SSE_C_PROBE_SECRET_ACCESS_KEY:?set SSE_C_PROBE_SECRET_ACCESS_KEY to the separate scratch credential}"
[[ "$SSE_C_PROBE_APPROVAL" == YES ]] || { printf 'Explicit scratch probe approval is required.\n' >&2; exit 2; }
[[ "$SSE_C_PROBE_BUCKET_NAME" =~ ^litt-probe-[a-z0-9-]+$ && "$SSE_C_PROBE_BUCKET_NAME" != "$AWS_BUCKET_NAME" ]] || { printf 'Probe bucket must be distinct and litt-probe-*.\n' >&2; exit 1; }
[[ "$AWS_ENDPOINT_URL" =~ ^https:// && "$SSE_C_PROBE_ENDPOINT_URL" =~ ^https:// ]] || { printf 'Object endpoints must use HTTPS.\n' >&2; exit 1; }
probe_host=${SSE_C_PROBE_ENDPOINT_URL#https://}; probe_host=${probe_host%%/*}
[[ "$SSE_C_PROBE_ENDPOINT_URL" != "$AWS_ENDPOINT_URL" && "$SSE_C_PROBE_ALLOWED_HOST" == "$probe_host" && "$SSE_C_PROBE_ACCOUNT_ID" != "$AWS_ACCOUNT_ID" ]] || { printf 'Scratch object target is not isolated.\n' >&2; exit 1; }
[[ -f "$SSE_C_CUSTOMER_KEY_FILE" && ! -L "$SSE_C_CUSTOMER_KEY_FILE" && "$(stat -c '%a' "$SSE_C_CUSTOMER_KEY_FILE")" == "600" ]] || { printf 'SSE-C key file must be a regular mode-600 file.\n' >&2; exit 1; }

versioning=$(aws s3api get-bucket-versioning --bucket "$AWS_BUCKET_NAME" --endpoint-url "$AWS_ENDPOINT_URL" --output json)
[[ "$(jq -r '.Status // empty' <<<"$versioning")" == "Enabled" ]] || { printf 'Bucket versioning is not enabled.\n' >&2; exit 1; }
public_access=$(aws s3api get-public-access-block --bucket "$AWS_BUCKET_NAME" --endpoint-url "$AWS_ENDPOINT_URL" --output json)
jq -e '.PublicAccessBlockConfiguration | .BlockPublicAcls == true and .IgnorePublicAcls == true and .BlockPublicPolicy == true and .RestrictPublicBuckets == true' <<<"$public_access" >/dev/null || { printf 'Bucket public-access-block is not fully enabled.\n' >&2; exit 1; }

probe_aws() {
  AWS_ACCESS_KEY_ID="$SSE_C_PROBE_ACCESS_KEY_ID" \
  AWS_SECRET_ACCESS_KEY="$SSE_C_PROBE_SECRET_ACCESS_KEY" \
  AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}" \
    aws --endpoint-url "$SSE_C_PROBE_ENDPOINT_URL" "$@"
}

key="__litt_sse_probe__/$(date -u +%Y%m%dT%H%M%SZ)-$$"
body=$(mktemp)
without_key=$(mktemp)
with_key=$(mktemp)
version_id=""
cleanup() {
  if [[ -n "$version_id" ]]; then
    probe_aws s3api delete-object --bucket "$SSE_C_PROBE_BUCKET_NAME" --key "$key" --version-id "$version_id" >/dev/null 2>&1 || true
  fi
  residue=$(probe_aws s3api list-object-versions --bucket "$SSE_C_PROBE_BUCKET_NAME" --prefix "$key" --output json 2>/dev/null || printf '{}')
  if [[ "$(jq '[.Versions[]?, .DeleteMarkers[]?] | length' <<<"$residue")" != "0" ]]; then
    printf 'SSE-C probe left versioned residue.\n' >&2
    rm -f "$body" "$without_key" "$with_key"
    exit 1
  fi
  rm -f "$body" "$without_key" "$with_key"
}
trap cleanup EXIT
printf 'litt-sse-probe\n' >"$body"
preexisting=$(probe_aws s3api list-object-versions --bucket "$SSE_C_PROBE_BUCKET_NAME" --prefix "$key" --output json)
[[ "$(jq '[.Versions[]?, .DeleteMarkers[]?] | length' <<<"$preexisting")" == "0" ]] || { printf 'Probe key already has residue.\n' >&2; exit 1; }
put_result=$(probe_aws s3api put-object --bucket "$SSE_C_PROBE_BUCKET_NAME" --key "$key" --body "$body" --sse-customer-algorithm AES256 --sse-customer-key "fileb://$SSE_C_CUSTOMER_KEY_FILE")
version_id=$(jq -er '.VersionId | select(type == "string" and length > 0)' <<<"$put_result")
if probe_aws s3api get-object --bucket "$SSE_C_PROBE_BUCKET_NAME" --key "$key" "$without_key" >/dev/null 2>&1; then
  printf 'A keyless read unexpectedly succeeded; SSE-C is not enforced.\n' >&2
  exit 1
fi
probe_aws s3api get-object --bucket "$SSE_C_PROBE_BUCKET_NAME" --key "$key" --version-id "$version_id" --sse-customer-algorithm AES256 --sse-customer-key "fileb://$SSE_C_CUSTOMER_KEY_FILE" "$with_key" >/dev/null
cmp -s "$body" "$with_key"
printf 'Private versioned bucket and SSE-C keyless-read rejection verified.\n'
