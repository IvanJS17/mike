#!/usr/bin/env bash
# Read-only host firewall and listener check for the approved runtime host.
set -Eeuo pipefail

: "${VPN_CIDR:?set VPN_CIDR to the approved private IPv4 VPN range}"
: "${VPN_IPV6_CIDR:?set VPN_IPV6_CIDR to the approved private IPv6 VPN range}"
: "${VPN_UDP_PORT:=51820}"
python3 -c 'import ipaddress,sys; [(_ for _ in ()).throw(SystemExit(1)) for value in sys.argv[1:] if (not (ipaddress.ip_network(value, strict=False).is_private and ipaddress.ip_network(value, strict=False).prefixlen > 0))]' "$VPN_CIDR" "$VPN_IPV6_CIDR" || { printf 'VPN CIDRs must be non-default private networks.\n' >&2; exit 1; }

ruleset=$(nft -nn list ruleset)
grep -Eq 'table[[:space:]]+inet[[:space:]]+litt_host' <<<"$ruleset" || { printf 'litt_host table is absent.\n' >&2; exit 1; }
grep -Eq 'chain[[:space:]]+input' <<<"$ruleset" || { printf 'litt_host input chain is absent.\n' >&2; exit 1; }
grep -Eq 'type[[:space:]]+filter[[:space:]]+hook[[:space:]]+input' <<<"$ruleset" || { printf 'Input hook is absent.\n' >&2; exit 1; }
grep -Eq 'policy[[:space:]]+drop' <<<"$ruleset" || { printf 'Host firewall has no input default-drop policy.\n' >&2; exit 1; }
grep -Eq 'tcp[[:space:]]+dport[[:space:]]+(80|\{[[:space:]]*80,[[:space:]]*443[[:space:]]*\})[[:space:]]+accept' <<<"$ruleset" || { printf 'HTTP/HTTPS rule is absent.\n' >&2; exit 1; }

ssh_rule_count=0
while IFS= read -r rule; do
  ssh_rule_count=$((ssh_rule_count + 1))
  if grep -q 'ip6 saddr' <<<"$rule"; then
    grep -Fq "ip6 saddr $VPN_IPV6_CIDR" <<<"$rule" || { printf 'Unauthorized IPv6 SSH source rule.\n' >&2; exit 1; }
  elif grep -q 'ip saddr' <<<"$rule"; then
    grep -Fq "ip saddr $VPN_CIDR" <<<"$rule" || { printf 'Unauthorized IPv4 SSH source rule.\n' >&2; exit 1; }
  else
    printf 'SSH rule has no explicit VPN source.\n' >&2
    exit 1
  fi
done < <(grep -E 'tcp[[:space:]]+dport[[:space:]]+22.*accept' <<<"$ruleset" || true)
[[ "$ssh_rule_count" -ge 2 ]] || { printf 'Both IPv4 and IPv6 VPN SSH rules are required.\n' >&2; exit 1; }

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
