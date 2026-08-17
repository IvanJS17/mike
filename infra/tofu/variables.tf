variable "hcloud_token" {
  description = "Hetzner API token supplied through TF_VAR_hcloud_token, never committed."
  type        = string
  sensitive   = true
  nullable    = false
}

variable "project_name" {
  description = "Hetzner project/application label."
  type        = string
  default     = "litt-production"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{2,30}$", var.project_name))
    error_message = "project_name must be a short lowercase DNS-safe identifier."
  }
}

variable "server_name" {
  description = "Unique Hetzner server name."
  type        = string
  default     = "litt-runtime-01"
}

variable "location" {
  description = "Hetzner location: nbg1 is Nuremberg, Germany."
  type        = string
  default     = "nbg1"

  validation {
    condition     = var.location == "nbg1"
    error_message = "WS2 is pinned to the Nuremberg location nbg1."
  }
}

variable "server_type" {
  description = "Initial x86 server type."
  type        = string
  default     = "cx23"

  validation {
    condition     = var.server_type == "cx23"
    error_message = "WS2 starts on the approved CX23 server type."
  }
}

variable "image" {
  description = "OS image used for the disposable runtime host."
  type        = string
  default     = "ubuntu-24.04"
}

variable "data_volume_size_gb" {
  description = "Encrypted volume for PostgreSQL, secrets, Caddy state, and temporaries."
  type        = number
  default     = 50

  validation {
    condition     = var.data_volume_size_gb >= 20 && floor(var.data_volume_size_gb) == var.data_volume_size_gb
    error_message = "data_volume_size_gb must be an integer of at least 20 GB."
  }
}

variable "vpn_cidrs" {
  description = "IPv4/IPv6 CIDRs of the approved VPN egress; the only SSH sources."
  type        = set(string)
  default     = []

  validation {
    condition = length(var.vpn_cidrs) > 0 && alltrue([
      for cidr in var.vpn_cidrs : can(cidrhost(cidr, 0))
    ])
    error_message = "vpn_cidrs must contain at least one valid VPN CIDR."
  }
}

variable "ssh_keys" {
  description = "Map of nominal operator name to public SSH key. Private keys stay with their owner."
  type        = map(string)
  default     = {}

  validation {
    condition = length(var.ssh_keys) > 0 && alltrue([
      for key in values(var.ssh_keys) : can(regex("^ssh-(ed25519|rsa|ecdsa) ", key))
    ])
    error_message = "ssh_keys must contain at least one named OpenSSH public key."
  }
}
