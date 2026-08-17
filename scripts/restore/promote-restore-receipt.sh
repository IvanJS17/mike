#!/usr/bin/env bash
# Promote one verified disposable restore receipt to the production metrics state.
set -Eeuo pipefail
umask 077
: "${RESTORE_RECEIPT_SOURCE:?set RESTORE_RECEIPT_SOURCE to the disposable success receipt}"
: "${RESTORE_RECEIPT_PROMOTION_APPROVAL:?set RESTORE_RECEIPT_PROMOTION_APPROVAL=YES}"
: "${RESTORE_MANUAL_QUALIFICATION_FILE:?set RESTORE_MANUAL_QUALIFICATION_FILE to the mode-600 qualification evidence}"
: "${RESTORE_MANUAL_QUALIFICATION_APPROVAL:?set RESTORE_MANUAL_QUALIFICATION_APPROVAL=YES}"
: "${LITT_DATA_ROOT:?set LITT_DATA_ROOT=/srv/litt-data}"
[[ "$RESTORE_RECEIPT_PROMOTION_APPROVAL" == YES ]] || { printf 'Explicit restore receipt promotion approval is required.\n' >&2; exit 2; }
[[ "$(realpath -m "$LITT_DATA_ROOT")" == "/srv/litt-data" ]] || { printf 'Production data root is not canonical.\n' >&2; exit 1; }
source_real=$(realpath -e "$RESTORE_RECEIPT_SOURCE")
[[ "$source_real" == /srv/litt-restore-*/* && ! -L "$RESTORE_RECEIPT_SOURCE" && "$(stat -c '%a' "$RESTORE_RECEIPT_SOURCE")" == "600" ]] || { printf 'Receipt source is not a disposable mode-600 file.\n' >&2; exit 1; }
[[ "$RESTORE_MANUAL_QUALIFICATION_APPROVAL" == YES ]] || { printf 'Manual restore qualification approval is required.\n' >&2; exit 2; }
[[ -f "$RESTORE_MANUAL_QUALIFICATION_FILE" && ! -L "$RESTORE_MANUAL_QUALIFICATION_FILE" && "$(stat -c '%a' "$RESTORE_MANUAL_QUALIFICATION_FILE")" == "600" ]] || { printf 'Manual qualification evidence must be regular mode 600.\n' >&2; exit 1; }
jq -e '(.object_references_verified == true) and (.positive_search_verified == true) and (.negative_cross_matter_verified == true) and (.revoked_access_verified == true) and (.audit_events_verified == true)' "$RESTORE_MANUAL_QUALIFICATION_FILE" >/dev/null || { printf 'Manual restore qualification is incomplete.\n' >&2; exit 1; }
jq -e '(.status == "success") and (.disposable_project | startswith("litt-restore-")) and (.secrets_included == false) and (.rpo_seconds <= 86400) and (.rto_seconds <= 14400)' "$RESTORE_RECEIPT_SOURCE" >/dev/null || { printf 'Receipt does not prove a successful disposable restore.\n' >&2; exit 1; }
destination="$LITT_DATA_ROOT/state/restore-receipt.json"
tmp=$(mktemp "$destination.XXXXXX")
trap 'rm -f "$tmp"' EXIT
cp --no-preserve=mode,ownership "$RESTORE_RECEIPT_SOURCE" "$tmp"
chmod 0600 "$tmp"
mv -f "$tmp" "$destination"
trap - EXIT
printf 'Verified disposable restore receipt promoted to metrics state.\n'
