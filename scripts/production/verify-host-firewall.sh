#!/usr/bin/env bash
# Read-only host firewall and listener check for the approved runtime host.
set -Eeuo pipefail

: "${VPN_CIDR:?set VPN_CIDR to the approved private IPv4 VPN range}"
: "${VPN_IPV6_CIDR:?set VPN_IPV6_CIDR to the approved private IPv6 VPN range}"
: "${VPN_UDP_PORT:=51820}"
python3 -c 'import ipaddress,sys; [(_ for _ in ()).throw(SystemExit(1)) for value in sys.argv[1:] if not (ipaddress.ip_network(value, strict=False).is_private and ipaddress.ip_network(value, strict=False).prefixlen > 0)]' "$VPN_CIDR" "$VPN_IPV6_CIDR" || { printf 'VPN CIDRs must be non-default private networks.\n' >&2; exit 1; }

rules_file=$(mktemp)
trap 'rm -f "$rules_file"' EXIT
nft -nn list ruleset >"$rules_file"
python3 - "$rules_file" "$VPN_CIDR" "$VPN_IPV6_CIDR" <<'PY'
import ipaddress
import re
import sys
from pathlib import Path

text = Path(sys.argv[1]).read_text()
ipv4, ipv6 = sys.argv[2:]

def block_after(pattern: str, source: str) -> str:
    match = re.search(pattern, source)
    if not match:
        raise SystemExit(f"missing {pattern}")
    start = source.find("{", match.start())
    depth = 0
    for index in range(start, len(source)):
        if source[index] == "{": depth += 1
        elif source[index] == "}":
            depth -= 1
            if depth == 0: return source[start + 1:index]
    raise SystemExit("unclosed nft block")

table = block_after(r"table\s+inet\s+litt_host\s*\{", text)
chain = block_after(r"chain\s+input\s*\{", table)
if not re.search(r"type\s+filter\s+hook\s+input", chain) or not re.search(r"policy\s+drop", chain):
    raise SystemExit("litt_host input chain is not default-drop")
if not (re.search(r"tcp\s+dport\s+\{\s*80,\s*443\s*\}\s+accept", chain) or
        (re.search(r"tcp\s+dport\s+80\s+accept", chain) and re.search(r"tcp\s+dport\s+443\s+accept", chain))):
    raise SystemExit("HTTP/HTTPS rule is absent")
ssh = [line.strip() for line in chain.splitlines() if re.search(r"tcp\s+dport\s+22\s+accept", line)]
if len(ssh) != 2:
    raise SystemExit("exactly two SSH rules are required")
if sum(f"ip saddr {ipv4}" in line for line in ssh) != 1 or sum(f"ip6 saddr {ipv6}" in line for line in ssh) != 1:
    raise SystemExit("SSH rules are not the exact approved IPv4/IPv6 VPN rules")
if any("0.0.0.0/0" in line or "::/0" in line for line in ssh):
    raise SystemExit("SSH is globally exposed")
PY

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
