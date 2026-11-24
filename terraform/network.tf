locals {
  compartment_id = var.compartment_ocid != null ? var.compartment_ocid : var.tenancy_ocid
}

# Virtual Cloud Network (VCN)
resource "oci_core_vcn" "tmdb_vcn" {
  compartment_id = local.compartment_id
  cidr_block     = "10.0.0.0/16"
  display_name   = "tmdb-api-vcn"
  dns_label      = "tmdbvcn"
}

# Internet Gateway for public traffic
resource "oci_core_internet_gateway" "tmdb_igw" {
  compartment_id = local.compartment_id
  display_name   = "tmdb-api-igw"
  vcn_id         = oci_core_vcn.tmdb_vcn.id
  enabled        = true
}

# Default Route Table forwarding internet traffic to IGW
resource "oci_core_default_route_table" "tmdb_default_route_table" {
  manage_default_resource_id = oci_core_vcn.tmdb_vcn.default_route_table_id

  route_rules {
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = oci_core_internet_gateway.tmdb_igw.id
  }
}

# Security List allowing SSH (22), TMDB API (8787), HTTP (80), HTTPS (443)
resource "oci_core_security_list" "tmdb_security_list" {
  compartment_id = local.compartment_id
  vcn_id         = oci_core_vcn.tmdb_vcn.id
  display_name   = "tmdb-security-list"

  egress_security_rules {
    destination = "0.0.0.0/0"
    protocol    = "all"
    stateless   = false
  }

  # SSH
  ingress_security_rules {
    protocol    = "6" # TCP
    source      = "0.0.0.0/0"
    description = "SSH access"
    tcp_options {
      min = 22
      max = 22
    }
  }

  # TMDB API
  ingress_security_rules {
    protocol    = "6" # TCP
    source      = "0.0.0.0/0"
    description = "TMDB Embed API port"
    tcp_options {
      min = 8787
      max = 8787
    }
  }

  # HTTP
  ingress_security_rules {
    protocol    = "6" # TCP
    source      = "0.0.0.0/0"
    description = "HTTP web traffic"
    tcp_options {
      min = 80
      max = 80
    }
  }

  # HTTPS
  ingress_security_rules {
    protocol    = "6" # TCP
    source      = "0.0.0.0/0"
    description = "HTTPS web traffic"
    tcp_options {
      min = 443
      max = 443
    }
  }

  # Supabase Kong API Gateway
  ingress_security_rules {
    protocol    = "6" # TCP
    source      = "0.0.0.0/0"
    description = "Supabase Kong API Gateway"
    tcp_options {
      min = 8000
      max = 8000
    }
  }


}

# Public Subnet
resource "oci_core_subnet" "tmdb_subnet" {
  cidr_block        = "10.0.1.0/24"
  display_name      = "tmdb-public-subnet"
  dns_label         = "tmdbsubnet"
  compartment_id    = local.compartment_id
  vcn_id            = oci_core_vcn.tmdb_vcn.id
  route_table_id    = oci_core_vcn.tmdb_vcn.default_route_table_id
  security_list_ids = [oci_core_security_list.tmdb_security_list.id]
}
