output "server_id" {
  description = "Hetzner server ID for the approved runtime host."
  value       = hcloud_server.runtime.id
}

output "server_ipv4" {
  description = "Public IPv4; record only in the deployment custody receipt."
  value       = hcloud_server.runtime.ipv4_address
}

output "server_ipv6" {
  description = "Public IPv6; record only in the deployment custody receipt."
  value       = hcloud_server.runtime.ipv6_address
}

output "firewall_id" {
  description = "Hetzner firewall attached to the runtime host."
  value       = hcloud_firewall.runtime.id
}

output "encrypted_volume_id" {
  description = "Unformatted volume that the LUKS2 runbook initializes."
  value       = hcloud_volume.encrypted_data.id
}

output "encrypted_volume_linux_device" {
  description = "Linux device path exposed by the Hetzner volume attachment."
  value       = hcloud_volume.encrypted_data.linux_device
}
