locals {
  labels = {
    application = "litt"
    environment = "production"
    managed_by  = "opentofu"
    workstream  = "ws2-runtime"
  }
  vpn_ipv4_cidrs = [for cidr in var.vpn_cidrs : cidr if !strcontains(cidr, ":")]
  vpn_ipv6_cidrs = [for cidr in var.vpn_cidrs : cidr if strcontains(cidr, ":")]
}

resource "hcloud_ssh_key" "operator" {
  for_each = var.ssh_keys

  name       = "${var.project_name}-${each.key}"
  public_key = each.value
  labels     = local.labels
}

resource "hcloud_firewall" "runtime" {
  name   = "${var.project_name}-edge"
  labels = local.labels

  rule {
    direction   = "in"
    protocol    = "tcp"
    port        = "80"
    source_ips  = ["0.0.0.0/0", "::/0"]
    description = "Public HTTP for ACME and redirect to HTTPS"
  }

  rule {
    direction   = "in"
    protocol    = "tcp"
    port        = "443"
    source_ips  = ["0.0.0.0/0", "::/0"]
    description = "Public HTTPS application traffic"
  }

  rule {
    direction   = "in"
    protocol    = "tcp"
    port        = "22"
    source_ips  = var.vpn_cidrs
    description = "SSH only through the approved VPN"
  }

  rule {
    direction       = "out"
    protocol        = "tcp"
    port            = "1-65535"
    destination_ips = ["0.0.0.0/0", "::/0"]
    description     = "Required outbound TCP for updates and approved integrations"
  }

  rule {
    direction       = "out"
    protocol        = "udp"
    port            = "1-65535"
    destination_ips = ["0.0.0.0/0", "::/0"]
    description     = "Required outbound UDP for DNS and VPN transport"
  }

  rule {
    direction       = "out"
    protocol        = "icmp"
    destination_ips = ["0.0.0.0/0", "::/0"]
    description     = "Diagnostics and path MTU discovery"
  }
}

resource "hcloud_server" "runtime" {
  name         = var.server_name
  server_type  = var.server_type
  location     = var.location
  image        = var.image
  backups      = false
  ssh_keys     = [for key in hcloud_ssh_key.operator : key.name]
  firewall_ids = [hcloud_firewall.runtime.id]
  labels       = local.labels
  user_data = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    operators      = var.ssh_keys
    vpn_ipv4_cidrs = local.vpn_ipv4_cidrs
    vpn_ipv6_cidrs = local.vpn_ipv6_cidrs
  })
}

resource "hcloud_volume" "encrypted_data" {
  name      = "${var.project_name}-encrypted-data"
  size      = var.data_volume_size_gb
  location  = var.location
  server_id = hcloud_server.runtime.id
  automount = false
  format    = false
  labels    = local.labels
}
