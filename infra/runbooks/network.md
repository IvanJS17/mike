# Host network and SSH runbook

The Hetzner firewall and the host nftables firewall are both required. A cloud
firewall rule alone is not the acceptance proof.

## Required effective policy

- Internet ingress: TCP 80/443 only.
- SSH: TCP 22 only from the approved VPN CIDR(s), with nominal public keys.
- PostgreSQL, Auth, PostgREST, backend, frontend, metrics, and admin services:
  no host-published ports.
- Caddy is the only public Compose service.
- SSH password, root login, and keyboard-interactive authentication are off.
- `litt-operators` is the only SSH group; each member maps to a named key and
  an access receipt.

Before applying the host rules, replace the example VPN CIDR and inspect the
rendered nftables ruleset. Apply during a maintenance window with an active
VPN session and a second break-glass console available. Never test by opening
SSH to `0.0.0.0/0`.

Run the read-only verification after every firewall, SSH, or Compose change:

```bash
export VPN_CIDR=10.42.0.0/24
export VPN_IPV6_CIDR=fd42:42::/64
scripts/production/verify-host-firewall.sh
ss -lntup
nft -nn list ruleset
```

The receipt records the effective firewall policy, listener ports, VPN identity,
nominal key names, and timestamp. It contains no private keys or secret env
values.
