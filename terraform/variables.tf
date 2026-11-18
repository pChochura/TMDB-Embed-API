variable "tenancy_ocid" {
  type        = string
  description = "OCID of your tenancy (found in OCI console)"
}

variable "user_ocid" {
  type        = string
  description = "OCID of your user profile"
}

variable "fingerprint" {
  type        = string
  description = "Fingerprint of the OCI API private key"
}

variable "private_key_path" {
  type        = string
  description = "Path to your OCI API private key (e.g. ~/.oci/oci_api_key.pem)"
  default     = "~/.oci/oci_api_key.pem"
}

variable "region" {
  type        = string
  description = "OCI region identifier (e.g. eu-frankfurt-1, us-ashburn-1)"
}

variable "availability_domain_number" {
  type        = number
  description = "Availability Domain index (1, 2, or 3) for multi-AD regions"
  default     = 1
}

variable "compartment_ocid" {
  type        = string
  description = "OCID of the compartment (defaults to tenancy OCID for root compartment)"
  default     = null
}

variable "instance_shape" {
  type        = string
  description = "Always Free compute shape: VM.Standard.A1.Flex (ARM) or VM.Standard.E2.1.Micro (AMD)"
  default     = "VM.Standard.A1.Flex"
}

variable "instance_ocpus" {
  type        = number
  description = "OCPUs for Flex shape (up to 4 free forever on A1.Flex)"
  default     = 2
}

variable "instance_memory_in_gbs" {
  type        = number
  description = "Memory in GBs for Flex shape (up to 24 GB free forever on A1.Flex)"
  default     = 12
}

variable "ssh_public_key_path" {
  type        = string
  description = "Path to your public SSH key for instance login"
  default     = "~/.ssh/id_rsa.pub"
}

variable "tmdb_api_key" {
  type        = string
  description = "Your TMDB API key"
  sensitive   = true
}

variable "repo_url" {
  type        = string
  description = "Git repository URL to deploy"
  default     = "https://github.com/pChochura/TMDB-Embed-API.git"
}

variable "postgres_user" {
  type        = string
  description = "PostgreSQL database user"
  default     = "postgres"
}

variable "postgres_password" {
  type        = string
  description = "PostgreSQL database password"
  default     = "postgres_secure_pass_change_me"
  sensitive   = true
}

variable "postgres_db" {
  type        = string
  description = "PostgreSQL database name"
  default     = "tmdb_sync"
}

variable "sync_jwt_secret" {
  type        = string
  description = "JWT secret key for Auth & Sync API"
  default     = "filman_sync_secret_key_change_me"
  sensitive   = true
}

variable "enable_postgres_volume" {
  type        = bool
  description = "Whether to provision an OCI persistent block volume for PostgreSQL data"
  default     = true
}

variable "postgres_volume_size_in_gbs" {
  type        = number
  description = "Size in GBs for the persistent PostgreSQL block volume (OCI Always Free provides up to 200 GB total)"
  default     = 50
}
