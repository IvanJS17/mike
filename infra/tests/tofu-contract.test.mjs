import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("../..", import.meta.url).pathname);
const tofuDir = resolve(root, "infra/tofu");
const read = (name) => readFileSync(resolve(tofuDir, name), "utf8");

test("OpenTofu pins the hcloud provider and the approved Nuremberg CX23", () => {
  const source = ["versions.tf", "main.tf", "variables.tf", "outputs.tf"]
    .map(read)
    .join("\n");
  assert.match(source, /hetznercloud\/hcloud/);
  assert.match(source, /required_version\s*=\s*">=\s*1\./);
  assert.match(source, /location\s*=\s*var\.location/);
  assert.match(source, /default\s*=\s*"nbg1"/);
  assert.match(source, /server_type\s*=\s*var\.server_type/);
  assert.match(source, /default\s*=\s*"cx23"/);
  assert.match(source, /server_type.*cx23|cx23.*server_type/s);
});

test("Hetzner firewall exposes only HTTP/S and VPN-scoped nominal SSH", () => {
  const source = read("main.tf");
  assert.match(source, /hcloud_firewall/);
  assert.match(source, /port\s*=\s*"80"/);
  assert.match(source, /port\s*=\s*"443"/);
  assert.match(source, /port\s*=\s*"22"/);
  assert.match(source, /source_ips\s*=\s*var\.vpn_cidrs/);
  assert.match(source, /ssh_keys\s*=\s*\[for key in hcloud_ssh_key\.operator/);
  const sshRule = source.split("rule {").find((rule) => /port\s*=\s*"22"/.test(rule));
  assert.ok(sshRule);
  assert.doesNotMatch(sshRule, /0\.0\.0\.0\/0/);
  assert.doesNotMatch(source, /hcloud_token\s*=\s*"/);
});

test("OpenTofu examples are non-destructive and do not contain credentials", () => {
  const example = readFileSync(resolve(tofuDir, "terraform.tfvars.example"), "utf8");
  assert.match(example, /ssh_keys\s*=\s*\{/);
  assert.match(example, /vpn_cidrs\s*=\s*\[/);
  assert.doesNotMatch(example, /hcloud_token\s*=\s*"[A-Za-z0-9]/);
  assert.doesNotMatch(example, /BEGIN (RSA|OPENSSH|ED25519) PRIVATE KEY/);
  assert.doesNotMatch(example, /apply|destroy/i);
});

test("OpenTofu state and plans are excluded from Git", () => {
  const gitignore = readFileSync(resolve(root, ".gitignore"), "utf8");
  assert.match(gitignore, /\.terraform\//);
  assert.match(gitignore, /\.tfstate/);
  assert.match(gitignore, /\.tfplan/);
});
