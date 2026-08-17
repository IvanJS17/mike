#!/usr/bin/env bash
# Promote one verified disposable restore receipt to the production metrics state.
set -Eeuo pipefail
umask 077
: "${RESTORE_RECEIPT_SOURCE:?set RESTORE_RECEIPT_SOURCE to the disposable success receipt}"
: "${RESTORE_RECEIPT_PROMOTION_APPROVAL:?set RESTORE_RECEIPT_PROMOTION_APPROVAL=YES}"
: "${LITT_DATA_ROOT:?set LITT_DATA_ROOT=/srv/litt-data}"
[[ "$RESTORE_RECEIPT_PROMOTION_APPROVAL" == YES ]] || { printf 'Explicit restore receipt promotion approval is required.\n' >&2; exit 2; }
[[ "$(realpath -m "$LITT_DATA_ROOT")" == "/srv/litt-data" ]] || { printf 'Production data root is not canonical.\n' >&2; exit 1; }
source_real=$(realpath -e "$RESTORE_RECEIPT_SOURCE")
[[ "$source_real" == /srv/litt-restore-*/* && ! -L "$RESTORE_RECEIPT_SOURCE" && "$(stat -c '%a' "$RESTORE_RECEIPT_SOURCE")" == "600" ]] || { printf 'Receipt source is not a disposable mode-600 file.\n' >&2; exit 1; }
jq -e '(.status == "success") and (.disposable_project | startswith("litt-restore-")) and (.secrets_included == false) and (.rpo_seconds <= 86400) and (.rto_seconds <= 14400)' "$RESTORE_RECEIPT_SOURCE" >/dev/null || { printf 'Receipt does not prove a successful disposable restore.\n' >&2; exit 1; }
destination="$LITT_DATA_ROOT/state/restore-receipt.json"
tmp=$(mktemp "$destination.XXXXXX")
trap 'rm -f "$tmp"' EXIT
cp --no-preserve=mode,ownership "$RESTORE_RECEIPT_SOURCE" "$tmp"
chmod 0600 "$tmp"
mv -f "$tmp" "$destination"
trap - EXIT
printf 'Verified disposable restore receipt promoted to metrics state.\n'
