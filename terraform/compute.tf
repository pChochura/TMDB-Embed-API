# Availability Domain lookup
data "oci_identity_availability_domains" "ads" {
  compartment_id = var.tenancy_ocid
}

# Image lookup: dynamically find latest Ubuntu image matching the shape architecture
data "oci_core_images" "ubuntu_images" {
  compartment_id           = local.compartment_id
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "24.04"
  shape                    = var.instance_shape
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

# Always Free Compute Instance
resource "oci_core_instance" "tmdb_instance" {
  availability_domain = data.oci_identity_availability_domains.ads.availability_domains[var.availability_domain_number - 1].name
  compartment_id      = local.compartment_id
  display_name        = "tmdb-embed-api"
  shape               = var.instance_shape

  dynamic "shape_config" {
    for_each = length(regexall("Flex", var.instance_shape)) > 0 ? [1] : []
    content {
      ocpus         = var.instance_ocpus
      memory_in_gbs = var.instance_memory_in_gbs
    }
  }

  source_details {
    source_type = "image"
    source_id   = data.oci_core_images.ubuntu_images.images[0].id
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.tmdb_subnet.id
    assign_public_ip = true
    display_name     = "tmdb-primary-vnic"
  }

  metadata = {
    ssh_authorized_keys = file(pathexpand(var.ssh_public_key_path))
    user_data = base64encode(templatefile("${path.module}/cloud-init.yaml", {
      tmdb_api_key = var.tmdb_api_key
      api_port     = 8787
      repo_url     = var.repo_url
    }))
  }

  preserve_boot_volume = false
}
