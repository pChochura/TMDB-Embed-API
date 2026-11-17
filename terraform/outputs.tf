output "instance_public_ip" {
  description = "Public IP address of the deployed instance"
  value       = oci_core_instance.tmdb_instance.public_ip
}

output "api_url" {
  description = "Direct URL to TMDB Embed API"
  value       = "http://${oci_core_instance.tmdb_instance.public_ip}:8787"
}

output "health_check_url" {
  description = "Health check endpoint"
  value       = "http://${oci_core_instance.tmdb_instance.public_ip}:8787/api/health"
}

output "ssh_command" {
  description = "Command to SSH into your instance"
  value       = "ssh ubuntu@${oci_core_instance.tmdb_instance.public_ip}"
}
