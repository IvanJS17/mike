import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const script = new URL("../../scripts/production/verify-host-firewall.sh", import.meta.url);

test("host firewall rejects an ACCEPT listener in a second nftables table", () => {
  const dir = mkdtempSync("/tmp/litt-firewall-");
  const rules = `table inet litt_host {
  chain input {
    type filter hook input priority 0; policy drop;
    tcp dport { 80, 443 } accept
    ip saddr 10.42.0.0/24 tcp dport 22 accept
    ip6 saddr fd42:42::/64 tcp dport 22 accept
  }
}
 table inet unrelated { chain input { type filter hook input priority 0; policy accept; tcp dport 5432 accept; } }
`;
  writeFileSync(join(dir, "nft"), `#!/usr/bin/env bash\nprintf '%s' '${rules.replaceAll("'", "'\\''")}'\n`);
  writeFileSync(join(dir, "ss"), "#!/usr/bin/env bash\nprintf 'State Local Address:Port Peer\n'\n");
  chmodSync(join(dir, "nft"), 0o755);
  chmodSync(join(dir, "ss"), 0o755);
  try {
    assert.throws(() => execFileSync("bash", [script.pathname], {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        VPN_CIDR: "10.42.0.0/24",
        VPN_IPV6_CIDR: "fd42:42::/64",
        VPN_UDP_PORT: "51820",
      },
      stdio: "pipe",
    }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
