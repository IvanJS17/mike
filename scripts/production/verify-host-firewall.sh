#!/usr/bin/env bash
# Read-only host firewall and listener check for the approved runtime host.
set -Eeuo pipefail

: "${VPN_CIDR:?set VPN_CIDR to the approved IPv4 VPN range}"
: "${VPN_UDP_PORT:=51820}"

ruleset=$(nft -nn list ruleset)
grep -Eq 'table[[:space:]]+inet[[:space:]]+litt_host' <<<"$ruleset" || { printf 'litt_host table is absent.\n' >&2; exit 1; }
grep -Eq 'chain[[:space:]]+input' <<<"$ruleset" || { printf 'litt_host input chain is absent.\n' >&2; exit 1; }
grep -Eq 'type[[:space:]]+filter[[:space:]]+hook[[:space:]]+input' <<<"$ruleset" || { printf 'Input hook is absent.\n' >&2; exit 1; }
grep -Eq 'policy[[:space:]]+drop' <<<"$ruleset" || { printf 'Host firewall has no input default-drop policy.\n' >&2; exit 1; }
grep -Eq 'tcp[[:space:]]+dport[[:space:]]+(80|\{[[:space:]]*80,[[:space:]]*443[[:space:]]*\})[[:space:]]+accept' <<<"$ruleset" || { printf 'HTTP/HTTPS rule is absent.\n' >&2; exit 1; }
grep -Fq "$VPN_CIDR" <<<"$ruleset" || { printf 'VPN CIDR is absent from host firewall.\n' >&2; exit 1; }
if grep -Eq '(0\.0\.0\.0/0|::/0).*dport[[:space:]]+22|dport[[:space:]]+22.*(0\.0\.0\.0/0|::/0)' <<<"$ruleset"; then
  printf 'SSH is globally exposed.\n' >&2
  exit 1
fi

while read -r address; do
  port=${address##*:}
  case "$port" in 22|80|443) ;; *) printf 'Unexpected TCP listener: %s\n' "$address" >&2; exit 1 ;; esac
done < <(ss -lntp | awk 'NR > 1 {print $4}')
while read -r address; do
  [[ -z "$address" ]] && continue
  port=${address##*:}
  [[ "$port" == "$VPN_UDP_PORT" ]] || { printf 'Unexpected UDP listener: %s\n' "$address" >&2; exit 1; }
done < <(ss -lnup | awk 'NR > 1 {print $5}')
printf 'Host firewall policy and listener inventory verified.\n'
