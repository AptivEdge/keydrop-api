# Keydrop AWS infrastructure

This Terraform stack provisions the Keydrop API platform:

- VPC networking and security groups
- ECS Fargate API service behind an Application Load Balancer
- ECR image repository
- Private encrypted S3 bucket for secret-related files
- RDS PostgreSQL for the Prisma schema
- Two Cognito pools: registered customers and staff
- Secrets Manager and CloudWatch logs

The stack does not provision anonymous-user identities. Anonymous senders and
recipients use the application’s public secret flows. Team plans and team roles
are stored in PostgreSQL.

## Prerequisites

- Terraform 1.6+
- AWS CLI credentials with permission to manage this stack
- A versioned S3 bucket for Terraform state
- A container image pushed to the ECR repository before the ECS service starts

Create the state bucket once:

```bash
aws s3api create-bucket \
  --bucket keydrop-terraform-state \
  --region ap-south-1 \
  --create-bucket-configuration LocationConstraint=ap-south-1

aws s3api put-bucket-versioning \
  --bucket keydrop-terraform-state \
  --versioning-configuration Status=Enabled
```

The backend configuration files contain only Terraform state settings. They do
not come from Cognito, RDS, or the application:

| Setting | Where it comes from |
|---|---|
| `bucket` | A globally unique S3 bucket that you create in your AWS account |
| `key` | A path chosen for each environment; keep the paths separate |
| `region` | The AWS region where the state bucket is created |
| `encrypt` | Keep `true` |

The repository already includes:

- `dev.tfconfig` with `keydrop/dev/terraform.tfstate`
- `staging.tfconfig` with `keydrop/staging/terraform.tfstate`
- `prod.tfconfig` with `keydrop/production/terraform.tfstate`

If `keydrop-terraform-state` is already taken by another AWS account, choose a
globally unique name such as `keydrop-company-terraform-state` and replace the
bucket name in all three files and in the AWS CLI commands above.

## Required Terraform variables

Create an environment-specific `*.tfvars` file outside version control:

```hcl
environment          = "dev"
aws_region           = "ap-south-1"
db_password          = "replace-with-a-secret"
db_publicly_accessible = false
image_tag            = "2026-10-16.1"

```

The important values are:

| Variable | Purpose |
|---|---|
| `environment` | `dev`, `staging`, or `production` |
| `aws_region` | AWS deployment region |
| `db_password` | RDS master password; never commit it |
| `image_tag` | Immutable ECR tag to deploy |
| `db_instance_class` | RDS size |
| `db_publicly_accessible` | Keep `false` unless there is a documented exception |
| `assets_bucket_name` | Optional globally unique S3 bucket name |

## CloudWatch alarm notifications

All CloudWatch alarms publish to the environment-specific SNS topic created by
Terraform. Set `cloudwatch_alarm_email` in the environment's `*.tfvars` file to
subscribe an email address; the recipient must confirm the SNS subscription
before notifications are delivered. The topic ARN is available as the
`cloudwatch_alarm_topic_arn` Terraform output.

## Deploy

```bash
terraform init \
  -backend-config=dev.tfconfig \
  -reconfigure

terraform fmt -recursive
terraform validate
terraform plan \
  -var-file=dev.tfvars \
  -out=dev.tfplan
terraform apply dev.tfplan
```

Use `staging.tfconfig` or `prod.tfconfig` for the other environments. Do not
use `-auto-approve` in production.

## Application environment

ECS receives the database URL and Cognito values from Secrets Manager. The
application needs:

```env
DATABASE_URL=postgresql://...
PORT=4000
NODE_ENV=production
USER_COGNITO_USER_POOL_ID=...
USER_COGNITO_CLIENT_ID=...
ADMIN_COGNITO_USER_POOL_ID=...
ADMIN_COGNITO_CLIENT_ID=...
COGNITO_REGION=ap-south-1
```

The user pool IDs and client IDs are Terraform outputs:

```bash
terraform output user_cognito_user_pool_id
terraform output user_cognito_client_id
terraform output admin_cognito_user_pool_id
terraform output admin_cognito_client_id
```

After a Cognito user is created, store its Cognito `sub` in
`User.cognitoSubject`. Staff users additionally need an `AdminUser` row with
one of `SUP`, `TS`, `BIL`, `ENG`, `ADM`, or `AUD`.

## Security rules

- Keep RDS private and allow PostgreSQL traffic only from ECS.
- Keep the S3 bucket private; use application-generated signed URLs.
- Keep database credentials in Secrets Manager.
- Do not add AWS access keys to ECS task environment variables.
- Do not commit `*.tfvars`, `.env`, Terraform plans, or state files.
- Review every Terraform plan before applying it.
