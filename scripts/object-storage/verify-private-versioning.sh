#!/usr/bin/env bash
# Verify private versioning and SSE-C against an explicitly approved scratch target.
set -Eeuo pipefail
umask 077

: "${AWS_ENDPOINT_URL:?set AWS_ENDPOINT_URL to the private production object endpoint}"
: "${AWS_BUCKET_NAME:?set AWS_BUCKET_NAME to the production bucket}"
: "${AWS_ACCOUNT_ID:?set AWS_ACCOUNT_ID to the production account identifier}"
: "${AWS_PRODUCTION_ACCESS_KEY_ID:?set AWS_PRODUCTION_ACCESS_KEY_ID to the production credential}"
: "${AWS_PRODUCTION_SECRET_ACCESS_KEY:?set AWS_PRODUCTION_SECRET_ACCESS_KEY to the production credential}"
: "${AWS_PRODUCTION_IDENTITY_FILE:?set AWS_PRODUCTION_IDENTITY_FILE to the mode-600 provider identity receipt}"
: "${SSE_C_PROBE_CUSTOMER_KEY_FILE:?set SSE_C_PROBE_CUSTOMER_KEY_FILE to the separate scratch 0600 key file}"
: "${SSE_C_PROBE_APPROVAL:?set SSE_C_PROBE_APPROVAL=YES for a scratch probe}"
: "${SSE_C_PROBE_BUCKET_NAME:?set SSE_C_PROBE_BUCKET_NAME to a dedicated scratch bucket}"
: "${SSE_C_PROBE_ENDPOINT_URL:?set SSE_C_PROBE_ENDPOINT_URL to the isolated scratch endpoint}"
: "${SSE_C_PROBE_ALLOWED_HOST:?set SSE_C_PROBE_ALLOWED_HOST to the isolated scratch host}"
: "${SSE_C_PROBE_ACCOUNT_ID:?set SSE_C_PROBE_ACCOUNT_ID to the isolated scratch account}"
: "${SSE_C_PROBE_TARGET_ID:?set SSE_C_PROBE_TARGET_ID to the versioned probe target}"
: "${SSE_C_PROBE_ACCESS_KEY_ID:?set SSE_C_PROBE_ACCESS_KEY_ID to the separate scratch credential}"
: "${SSE_C_PROBE_SECRET_ACCESS_KEY:?set SSE_C_PROBE_SECRET_ACCESS_KEY to the separate scratch credential}"
: "${LITT_APP_ROOT:?set LITT_APP_ROOT to the reviewed checkout}"
target_manifest="$(realpath -e "$LITT_APP_ROOT")/infra/production/disposable-targets.json"
jq -e --arg endpoint "$SSE_C_PROBE_ENDPOINT_URL" --arg host "$SSE_C_PROBE_ALLOWED_HOST" --arg account "$SSE_C_PROBE_ACCOUNT_ID" --arg bucket "$SSE_C_PROBE_BUCKET_NAME" --arg id "$SSE_C_PROBE_TARGET_ID" --arg prod_endpoint "$AWS_ENDPOINT_URL" --arg prod_bucket "$AWS_BUCKET_NAME" --arg prod_account "$AWS_ACCOUNT_ID" \
  '(.probe.target_id == $id) and (.probe.endpoint == $endpoint) and (.probe.host == $host) and (.probe.account_id == $account) and (.probe.bucket == $bucket) and (.object.endpoint == $prod_endpoint) and (.object.bucket == $prod_bucket) and (.object.account_id == $prod_account)' "$target_manifest" >/dev/null || { printf 'SSE-C probe/production targets are not the versioned targets.\n' >&2; exit 1; }
[[ -f "$AWS_PRODUCTION_IDENTITY_FILE" && ! -L "$AWS_PRODUCTION_IDENTITY_FILE" && "$(stat -c '%a' "$AWS_PRODUCTION_IDENTITY_FILE")" == "600" ]] || { printf 'Production identity receipt must be a regular mode-600 file.\n' >&2; exit 1; }
jq -e --arg endpoint "$AWS_ENDPOINT_URL" --arg bucket "$AWS_BUCKET_NAME" --arg account "$AWS_ACCOUNT_ID" --arg key "$AWS_PRODUCTION_ACCESS_KEY_ID" '(.endpoint == $endpoint) and (.bucket == $bucket) and (.account_id == $account) and (.access_key_id == $key)' "$AWS_PRODUCTION_IDENTITY_FILE" >/dev/null || { printf 'Production identity receipt does not match the explicit target credential.\n' >&2; exit 1; }
[[ "$SSE_C_PROBE_APPROVAL" == YES ]] || { printf 'Explicit scratch probe approval is required.\n' >&2; exit 2; }
[[ "$SSE_C_PROBE_BUCKET_NAME" =~ ^litt-probe-[a-z0-9-]+$ && "$SSE_C_PROBE_BUCKET_NAME" != "$AWS_BUCKET_NAME" ]] || { printf 'Probe bucket must be distinct and litt-probe-*.\n' >&2; exit 1; }
[[ "$AWS_ENDPOINT_URL" =~ ^https:// && "$SSE_C_PROBE_ENDPOINT_URL" =~ ^https:// ]] || { printf 'Object endpoints must use HTTPS.\n' >&2; exit 1; }
probe_host=${SSE_C_PROBE_ENDPOINT_URL#https://}; probe_host=${probe_host%%/*}
[[ "$SSE_C_PROBE_ACCESS_KEY_ID" != "$AWS_PRODUCTION_ACCESS_KEY_ID" && "$SSE_C_PROBE_SECRET_ACCESS_KEY" != "$AWS_PRODUCTION_SECRET_ACCESS_KEY" ]] || { printf 'Scratch credentials must differ from production credentials.\n' >&2; exit 1; }
[[ -f "$SSE_C_PROBE_CUSTOMER_KEY_FILE" && ! -L "$SSE_C_PROBE_CUSTOMER_KEY_FILE" && "$(stat -c '%a' "$SSE_C_PROBE_CUSTOMER_KEY_FILE")" == "600" ]] || { printf 'Scratch SSE-C key file must be a regular mode-600 file.\n' >&2; exit 1; }
[[ -f "$SSE_C_CUSTOMER_KEY_FILE" && ! -L "$SSE_C_CUSTOMER_KEY_FILE" && "$(stat -c '%a' "$SSE_C_CUSTOMER_KEY_FILE")" == "600" ]] || { printf 'Production SSE-C key file must be a regular mode-600 file.\n' >&2; exit 1; }
if cmp -s "$SSE_C_PROBE_CUSTOMER_KEY_FILE" "$SSE_C_CUSTOMER_KEY_FILE"; then
  printf 'Scratch and production SSE-C keys must differ.\n' >&2
  exit 1
fi
[[ "$AWS_ENDPOINT_URL" != "$SSE_C_PROBE_ENDPOINT_URL" && "$SSE_C_PROBE_ALLOWED_HOST" == "$probe_host" && "$SSE_C_PROBE_ACCOUNT_ID" != "$AWS_ACCOUNT_ID" ]] || { printf 'Scratch object target is not isolated.\n' >&2; exit 1; }

production_aws() {
  AWS_ACCESS_KEY_ID="$AWS_PRODUCTION_ACCESS_KEY_ID" \
  AWS_SECRET_ACCESS_KEY="$AWS_PRODUCTION_SECRET_ACCESS_KEY" \
  AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}" \
    aws --endpoint-url "$AWS_ENDPOINT_URL" "$@"
}

versioning=$(production_aws s3api get-bucket-versioning --bucket "$AWS_BUCKET_NAME" --output json)
[[ "$(jq -r '.Status // empty' <<<"$versioning")" == "Enabled" ]] || { printf 'Bucket versioning is not enabled.\n' >&2; exit 1; }
public_access=$(production_aws s3api get-public-access-block --bucket "$AWS_BUCKET_NAME" --output json)
jq -e '.PublicAccessBlockConfiguration | .BlockPublicAcls == true and .IgnorePublicAcls == true and .BlockPublicPolicy == true and .RestrictPublicBuckets == true' <<<"$public_access" >/dev/null || { printf 'Bucket public-access-block is not fully enabled.\n' >&2; exit 1; }

probe_aws() {
  AWS_ACCESS_KEY_ID="$SSE_C_PROBE_ACCESS_KEY_ID" \
  AWS_SECRET_ACCESS_KEY="$SSE_C_PROBE_SECRET_ACCESS_KEY" \
  AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}" \
    aws --endpoint-url "$SSE_C_PROBE_ENDPOINT_URL" "$@"
}
probe_key_is_empty() {
  local key_marker="" version_marker="" listing truncated next_key next_version
  while :; do
    args=(s3api list-object-versions --bucket "$SSE_C_PROBE_BUCKET_NAME" --prefix "$key" --output json)
    [[ -n "$key_marker" ]] && args+=(--key-marker "$key_marker")
    [[ -n "$version_marker" ]] && args+=(--version-id-marker "$version_marker")
    listing=$(probe_aws "${args[@]}")
    [[ "$(jq '[.Versions[]?, .DeleteMarkers[]?] | length' <<<"$listing")" == "0" ]] || return 1
    truncated=$(jq -r '.IsTruncated // false' <<<"$listing")
    [[ "$truncated" == "true" ]] || return 0
    next_key=$(jq -er '.NextKeyMarker | select(type == "string" and length > 0)' <<<"$listing")
    next_version=$(jq -er '.NextVersionIdMarker | select(type == "string" and length > 0)' <<<"$listing")
    [[ "$next_key" != "$key_marker" || "$next_version" != "$version_marker" ]] || return 1
    key_marker="$next_key"
    version_marker="$next_version"
  done
}
probe_cleanup_key() {
  local key_marker="" version_marker="" listing truncated next_key next_version
  while :; do
    args=(s3api list-object-versions --bucket "$SSE_C_PROBE_BUCKET_NAME" --prefix "$key" --output json)
    [[ -n "$key_marker" ]] && args+=(--key-marker "$key_marker")
    [[ -n "$version_marker" ]] && args+=(--version-id-marker "$version_marker")
    listing=$(probe_aws "${args[@]}")
    while IFS= read -r version; do
      probe_aws s3api delete-object --bucket "$SSE_C_PROBE_BUCKET_NAME" --key "$(jq -r '.Key' <<<"$version")" --version-id "$(jq -r '.VersionId' <<<"$version")" >/dev/null
    done < <(jq -c '.Versions[]?' <<<"$listing")
    while IFS= read -r marker; do
      probe_aws s3api delete-object --bucket "$SSE_C_PROBE_BUCKET_NAME" --key "$(jq -r '.Key' <<<"$marker")" --version-id "$(jq -r '.VersionId' <<<"$marker")" >/dev/null
    done < <(jq -c '.DeleteMarkers[]?' <<<"$listing")
    truncated=$(jq -r '.IsTruncated // false' <<<"$listing")
    [[ "$truncated" == "true" ]] || break
    next_key=$(jq -er '.NextKeyMarker | select(type == "string" and length > 0)' <<<"$listing")
    next_version=$(jq -er '.NextVersionIdMarker | select(type == "string" and length > 0)' <<<"$listing")
    [[ "$next_key" != "$key_marker" || "$next_version" != "$version_marker" ]] || return 1
    key_marker="$next_key"
    version_marker="$next_version"
  done
  probe_key_is_empty
}
key="__litt_sse_probe__/$(date -u +%Y%m%dT%H%M%SZ)-$$"
body=$(mktemp)
without_key=$(mktemp)
with_key=$(mktemp)
version_id=""
cleanup() {
  local cleanup_failed=0
  if ! probe_cleanup_key; then cleanup_failed=1; fi
  rm -f "$body" "$without_key" "$with_key"
  if (( cleanup_failed == 1 )); then
    printf 'SSE-C probe cleanup failed or left versioned residue.\n' >&2
    trap - EXIT
    exit 1
  fi
}
trap cleanup EXIT
printf 'litt-sse-probe\n' >"$body"
probe_key_is_empty || { printf 'Probe key already has versioned residue.\n' >&2; exit 1; }
put_result=$(probe_aws s3api put-object --bucket "$SSE_C_PROBE_BUCKET_NAME" --key "$key" --body "$body" --sse-customer-algorithm AES256 --sse-customer-key "fileb://$SSE_C_PROBE_CUSTOMER_KEY_FILE")
version_id=$(jq -er '.VersionId | select(type == "string" and length > 0)' <<<"$put_result")
if probe_aws s3api get-object --bucket "$SSE_C_PROBE_BUCKET_NAME" --key "$key" "$without_key" >/dev/null 2>&1; then
  printf 'A keyless read unexpectedly succeeded; SSE-C is not enforced.\n' >&2
  exit 1
fi
probe_aws s3api get-object --bucket "$SSE_C_PROBE_BUCKET_NAME" --key "$key" --version-id "$version_id" --sse-customer-algorithm AES256 --sse-customer-key "fileb://$SSE_C_PROBE_CUSTOMER_KEY_FILE" "$with_key" >/dev/null
cmp -s "$body" "$with_key"
printf 'Private versioned bucket and SSE-C keyless-read rejection verified.\n'
