# Retired AWS infrastructure

The Terraform under [`infra/`](../infra/) is retained as an archival record of
the former AWS deployment and its state layout. It is not an active deployment
path. Do not run `terraform apply` or `terraform destroy` from this repository.

The Keydrop development application stack in `ap-south-1` has been removed:
ECS/Fargate, RDS and its automated backups, ALB, ECR, Cognito pools, Secrets
Manager entries, application/flow logs, VPC endpoints, and the custom Keydrop
VPC. The dev API and its database, identity, and object data are gone.

The following AWS resources remain intentionally:

- The Route 53 hosted zone for `keydrop.aptivedge.in`, pending verified DNS
  migration to Cloudflare.
- The versioned S3 bucket used for Terraform state, pending secure state
  migration and an explicit retirement decision.
- The SES domain identity, pending verification of the replacement email
  provider.

These resources may still incur charges. The state bucket contains sensitive
infrastructure state and must not be made public or removed before state has
been safely migrated. The hosted zone must not be deleted until Cloudflare DNS
and production records are verified. The old Terraform configuration may no
longer match the live AWS account and must not be treated as a valid plan for
recreating or deleting resources.

For the current application topology, see the [free-tier
architecture](./free-tier-architecture.md). For the migration history and
remaining AWS cleanup gates, see the [migration
audit](./free-tier-migration-audit.md).
