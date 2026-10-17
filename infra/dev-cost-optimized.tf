# Cost-conscious network layout for development and early production.

locals {
  # Apply cost optimization to both dev and prod (early stage)
  is_cost_optimized_environment = (var.environment == "dev" || var.environment == "prod")
  # Use 2 AZs minimum for AWS requirements (ALB, RDS) but still cost-optimized
  cost_optimized_azs = local.is_cost_optimized_environment ? slice(var.availability_zones, 0, 2) : var.availability_zones
}

# The database remains private. CI/CD workflows should use an approved
# deployment path rather than connecting directly to PostgreSQL.
