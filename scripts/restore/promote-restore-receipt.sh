#!/usr/bin/env bash
# Promote one verified disposable restore receipt to the production metrics state.
set -Eeuo pipefail
umask 077
: "${RESTORE_RECEIPT_SOURCE:?set RESTORE_RECEIPT_SOURCE to the disposable success receipt}"
: "${RESTORE_RECEIPT_PROMOTION_APPROVAL:?set RESTORE_RECEIPT_PROMOTION_APPROVAL=YES}"
: "${RESTORE_MANUAL_QUALIFICATION_FILE:?set RESTORE_MANUAL_QUALIFICATION_FILE to the mode-600 qualification evidence}"
: "${RESTORE_MANUAL_QUALIFICATION_APPROVAL:?set RESTORE_MANUAL_QUALIFICATION_APPROVAL=YES}"
: "${RESTORE_TARGET_ID:?set RESTORE_TARGET_ID=restore-disposable}"
: "${LITT_APP_ROOT:?set LITT_APP_ROOT to the reviewed checkout}"
: "${LITT_DATA_ROOT:?set LITT_DATA_ROOT=/srv/litt-data}"
: "${RELEASE_MANIFEST_PATH:?set RELEASE_MANIFEST_PATH to /srv/litt-data/state/release-manifest.json}"
[[ "$RESTORE_RECEIPT_PROMOTION_APPROVAL" == YES && "$RESTORE_MANUAL_QUALIFICATION_APPROVAL" == YES ]] || { printf 'Explicit restore qualification approval is required.\n' >&2; exit 2; }
[[ "$(realpath -m "$LITT_DATA_ROOT")" == "/srv/litt-data" ]] || { printf 'Production data root is not canonical.\n' >&2; exit 1; }
[[ "$(realpath -m "$RELEASE_MANIFEST_PATH")" == "/srv/litt-data/state/release-manifest.json" && -f "$RELEASE_MANIFEST_PATH" && ! -L "$RELEASE_MANIFEST_PATH" && "$(stat -c '%a' "$RELEASE_MANIFEST_PATH")" == "600" ]] || { printf 'Release manifest path is not canonical mode 600.\n' >&2; exit 1; }
root=$(realpath -e "$LITT_APP_ROOT")
target_manifest="$root/infra/production/disposable-targets.json"
expected_root=$(jq -er '.restore.root' "$target_manifest")
expected_project=$(jq -er '.restore.project' "$target_manifest")
jq -e --arg id "$RESTORE_TARGET_ID" '(.restore.target_id == $id)' "$target_manifest" >/dev/null || { printf 'Restore target ID is not versioned.\n' >&2; exit 1; }
target_manifest_sha256=$(sha256sum "$target_manifest" | cut -d' ' -f1)
source_real=$(realpath -e "$RESTORE_RECEIPT_SOURCE")
[[ "$source_real" == "$expected_root/restore-receipts/"* && ! -L "$RESTORE_RECEIPT_SOURCE" && "$(stat -c '%a' "$RESTORE_RECEIPT_SOURCE")" == "600" ]] || { printf 'Receipt source is not under the canonical disposable root.\n' >&2; exit 1; }
[[ -f "$RESTORE_MANUAL_QUALIFICATION_FILE" && ! -L "$RESTORE_MANUAL_QUALIFICATION_FILE" && "$(stat -c '%a' "$RESTORE_MANUAL_QUALIFICATION_FILE")" == "600" ]] || { printf 'Manual qualification evidence must be regular mode 600.\n' >&2; exit 1; }
set_id=$(jq -er '.set_id' "$RESTORE_RECEIPT_SOURCE")
release_sha=$(jq -er '.release_sha' "$RESTORE_RECEIPT_SOURCE")
[[ "$(git -C "$root" rev-parse HEAD)" == "$release_sha" && -z "$(git -C "$root" status --porcelain --untracked-files=all)" ]] || { printf 'Promotion checkout is not the clean receipt release.\n' >&2; exit 1; }
jq -e --arg release "$release_sha" '(.release_sha == $release) and (.source_offer == ("https://github.com/IvanJS17/mike/tree/" + $release))' "$RELEASE_MANIFEST_PATH" >/dev/null || { printf 'Current release manifest is not bound to receipt release.\n' >&2; exit 1; }
jq -e --arg project "$expected_project" --arg set_id "$set_id" --arg release "$release_sha" --arg target "$RESTORE_TARGET_ID" --arg manifest "$target_manifest_sha256" --arg context "$(jq -er '.restore.docker_context' "$target_manifest")" --arg endpoint "$(jq -er '.restore.object_endpoint' "$target_manifest")" --arg bucket "$(jq -er '.restore.bucket' "$target_manifest")" \
  '(.status == "success") and (.disposable_project == $project) and (.secrets_included == false) and (.readiness == "green") and (.cleanup_verified == true) and (.set_id == $set_id) and (.release_sha == $release) and (.release_sha | test("^[0-9a-f]{40}$")) and (.target_id == $target) and (.target_manifest_sha256 == $manifest) and (.docker_context == $context) and (.object_endpoint == $endpoint) and (.object_bucket == $bucket) and (.migration_version | type == "string" and length > 0) and (.restored_object_count | type == "number" and . >= 0) and (.restored_delete_marker_count | type == "number" and . >= 0) and (.rpo_seconds >= 0 and .rpo_seconds <= 86400) and (.rto_seconds >= 0 and .rto_seconds <= 14400)' "$RESTORE_RECEIPT_SOURCE" >/dev/null || { printf 'Restore receipt is incomplete, stale, or not bound to the current target.\n' >&2; exit 1; }
jq -e --arg set_id "$set_id" --arg release "$release_sha" \
  '(.set_id == $set_id) and (.release_sha == $release) and (.object_references_verified == true) and (.positive_search_verified == true) and (.negative_cross_matter_verified == true) and (.revoked_access_verified == true) and (.audit_events_verified == true)' "$RESTORE_MANUAL_QUALIFICATION_FILE" >/dev/null || { printf 'Manual qualification does not match the promoted restore.\n' >&2; exit 1; }
destination="$LITT_DATA_ROOT/state/restore-receipt.json"
tmp=$(mktemp "$destination.XXXXXX")
trap 'rm -f "$tmp"' EXIT
cp --no-preserve=mode,ownership "$RESTORE_RECEIPT_SOURCE" "$tmp"
chmod 0600 "$tmp"
mv -f "$tmp" "$destination"
trap - EXIT
printf 'Verified disposable restore receipt promoted to metrics state.\n'
