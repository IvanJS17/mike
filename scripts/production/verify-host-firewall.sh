#!/usr/bin/env bash
# Read-only host firewall and listener check for the approved runtime host.
set -Eeuo pipefail

: "${VPN_CIDR:?set VPN_CIDR to the approved IPv4 VPN range}"
: "${LITT_EXPECTED_PUBLIC_PORTS:=80,443}"

ruleset=$(nft -nn list ruleset)
grep -Eq 'policy[[:space:]]+drop' <<<"$ruleset" || { printf 'Host firewall has no default-drop policy.\n' >&2; exit 1; }
grep -Eq 'dport[[:space:]]+80' <<<"$ruleset" || { printf 'Host firewall does not allow 80.\n' >&2; exit 1; }
grep -Eq 'dport[[:space:]]+443' <<<"$ruleset" || { printf 'Host firewall does not allow 443.\n' >&2; exit 1; }
grep -Fq "$VPN_CIDR" <<<"$ruleset" || { printf 'VPN CIDR is absent from host firewall.\n' >&2; exit 1; }

listeners=$(ss -lntup)
while read -r address; do
  port=${address##*:}
  case "$port" in
    22|80|443) ;;
    *) printf 'Unexpected TCP listener: %s\n' "$address" >&2; exit 1 ;;
  esac
done < <(awk 'NR > 1 {print $5}' <<<"$listeners")
printf 'Host firewall default-drop and listener inventory verified.\n'
