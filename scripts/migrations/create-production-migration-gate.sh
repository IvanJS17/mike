#!/usr/bin/env bash
# Create the canonical production migration gate from verified recovery evidence.
set -Eeuo pipefail
umask 077
: "${MIGRATION_GATE_APPROVAL:?set MIGRATION_GATE_APPROVAL=YES}"
: "${LITT_APP_ROOT:?set LITT_APP_ROOT to the reviewed checkout}"
: "${LITT_DATA_ROOT:?set LITT_DATA_ROOT=/srv/litt-data}"
: "${RELEASE_SHA:?set RELEASE_SHA to the exact clean checkout commit}"
: "${MIGRATION_TREE_SHA256:?set MIGRATION_TREE_SHA256 to the reviewed migration tree hash}"
: "${RECOVERY_SUCCESS_FILE:?set RECOVERY_SUCCESS_FILE=/srv/litt-data/state/latest-success.json}"
: "${MIGRATION_REHEARSAL_RECEIPT_FILE:?set MIGRATION_REHEARSAL_RECEIPT_FILE=/srv/litt-data/state/migration-rehearsal.json}"
[[ "$MIGRATION_GATE_APPROVAL" == YES ]] || { printf 'Explicit production migration gate approval is required.\n' >&2; exit 2; }
[[ "$(realpath -m "$LITT_DATA_ROOT")" == "/srv/litt-data" && "$(realpath -m "$RECOVERY_SUCCESS_FILE")" == "/srv/litt-data/state/latest-success.json" && "$(realpath -m "$MIGRATION_REHEARSAL_RECEIPT_FILE")" == "/srv/litt-data/state/migration-rehearsal.json" ]] || { printf 'Migration evidence paths are not canonical.\n' >&2; exit 1; }
root=$(realpath -e "$LITT_APP_ROOT")
[[ "$(git -C "$root" rev-parse HEAD)" == "$RELEASE_SHA" && -z "$(git -C "$root" status --porcelain --untracked-files=all)" ]] || { printf 'Migration gate checkout is not the clean release.\n' >&2; exit 1; }
[[ -f "$RECOVERY_SUCCESS_FILE" && ! -L "$RECOVERY_SUCCESS_FILE" && -f "$MIGRATION_REHEARSAL_RECEIPT_FILE" && ! -L "$MIGRATION_REHEARSAL_RECEIPT_FILE" ]] || { printf 'Migration evidence files are missing.\n' >&2; exit 1; }
recovery_set_id=$(jq -er '.set_id' "$RECOVERY_SUCCESS_FILE")
jq -e --arg release "$RELEASE_SHA" '(.status == "success") and (.release_sha == $release) and (.set_id | type == "string" and length > 0)' "$RECOVERY_SUCCESS_FILE" >/dev/null || { printf 'Recovery SUCCESS is not bound to release.\n' >&2; exit 1; }
jq -e --arg release "$RELEASE_SHA" --arg tree "$MIGRATION_TREE_SHA256" '(.status == "success") and (.release_sha == $release) and (.migration_tree_sha256 == $tree)' "$MIGRATION_REHEARSAL_RECEIPT_FILE" >/dev/null || { printf 'Migration rehearsal receipt is not bound to release/tree.\n' >&2; exit 1; }
rehearsal_sha=$(sha256sum "$MIGRATION_REHEARSAL_RECEIPT_FILE" | cut -d' ' -f1)
gate="$LITT_DATA_ROOT/state/migration-gate.json"
tmp=$(mktemp "$gate.XXXXXX")
trap 'rm -f "$tmp"' EXIT
jq -n --arg release "$RELEASE_SHA" --arg tree "$MIGRATION_TREE_SHA256" --arg set_id "$recovery_set_id" --arg rehearsal "$rehearsal_sha" \
  '{approved:true,status:"approved",target_project:"litt-production",docker_context:"litt-production",release_sha:$release,migration_tree_sha256:$tree,recovery_set_id:$set_id,rehearsal_receipt_sha256:$rehearsal}' >"$tmp"
chmod 0600 "$tmp"
mv -f "$tmp" "$gate"
trap - EXIT
printf 'Production migration gate created from verified recovery/rehearsal evidence.\n'
