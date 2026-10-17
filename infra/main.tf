# Main Terraform Configuration
# All resources are defined in their respective files
# for better organization and maintainability.

# This file can be used for any cross-module data sources
# or locals that need to be referenced across multiple resources.

data "aws_caller_identity" "current" {}

data "aws_region" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.name

  common_tags = {
    Project     = var.app_name
    Environment = var.environment
    ManagedBy   = "Terraform"
  }
}
