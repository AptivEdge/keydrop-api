# Keydrop Infrastructure Guide

This document explains the AWS infrastructure configured for Keydrop and the
values required to deploy it. The Terraform source is in the
[`infra/`](../infra/) directory.

## Provisioned components

The stack provisions:

- A VPC with public and private subnets
- Security groups and VPC endpoints
- An Application Load Balancer
- An ECS Fargate service for the API
- An ECR repository for API images
- A private RDS PostgreSQL database for Prisma
- A private, encrypted, versioned S3 bucket for secret-related files
- Two Cognito user pools:
  - Customer authentication
  - Staff authentication
- Secrets Manager entries for database and Cognito configuration
- CloudWatch log groups

Anonymous senders and secret recipients do not receive Cognito identities.
Their public secret flows are handled by the API.

## Authentication infrastructure

Only two Cognito pools are configured:

| Pool     | Application variables                                   | Purpose                                           |
| -------- | ------------------------------------------------------- | ------------------------------------------------- |
| Customer | `USER_COGNITO_USER_POOL_ID`, `USER_COGNITO_CLIENT_ID`   | Registered Free, Pro, and Team users              |
| Staff    | `ADMIN_COGNITO_USER_POOL_ID`, `ADMIN_COGNITO_CLIENT_ID` | `SUP`, `TS`, `BIL`, `ENG`, `ADM`, and `AUD` staff |

Team roles and customer plans remain PostgreSQL data. They are not separate
Cognito pools.

After creating a Cognito user, store its Cognito `sub` in
`User.cognitoSubject`. Staff users also require an `AdminUser` record with the
appropriate staff role.

## Required deployment values

Create an environment-specific Terraform variables file outside version
control, for example `infra/dev.tfvars`:

```hcl
environment            = "dev"
aws_region             = "ap-south-1"
db_password            = "replace-with-a-long-random-password"
db_publicly_accessible = false
image_tag              = "2026-10-16.1"
```

| Variable                 | Required | Description                                                       |
| ------------------------ | -------: | ----------------------------------------------------------------- |
| `environment`            |      Yes | Deployment environment, such as `dev`, `staging`, or `production` |
| `aws_region`             |       No | AWS region; defaults to the configured region                     |
| `db_password`            |      Yes | RDS master password; keep it outside Git                          |
| `image_tag`              |      Yes | Immutable ECR image tag to deploy                                 |
| `db_name`                |       No | PostgreSQL database name                                          |
| `db_username`            |       No | PostgreSQL master username                                        |
| `db_instance_class`      |       No | RDS instance size                                                 |
| `db_allocated_storage`   |       No | RDS storage size in GB                                            |
| `db_publicly_accessible` |       No | Keep `false`; the database should remain private                  |
| `desired_count`          |       No | Number of ECS tasks                                               |
| `assets_bucket_name`     |       No | Globally unique S3 bucket name                                    |

## Razorpay subscription plans

The application currently supports INR monthly/yearly plans for Pro and Team.
Prices are set in Razorpay plans, not in application configuration. The
recommended launch pricing is Pro ₹299/month or ₹2,990/year and Team
₹999/month or ₹9,990/year. Confirm prices, taxes, and billing terms before
creating plans because Razorpay plans cannot be edited or deleted.

In the Razorpay Dashboard, switch to **Test Mode** first, then go to
**Subscriptions → Plans → + New Plan** and create these four plans:

| Plan                     | Billing frequency | Amount |
| ------------------------ | ----------------- | -----: |
| Keydrop Pro INR Monthly  | Monthly           |   ₹299 |
| Keydrop Pro INR Yearly   | Yearly            | ₹2,990 |
| Keydrop Team INR Monthly | Monthly           |   ₹999 |
| Keydrop Team INR Yearly  | Yearly            | ₹9,990 |

For each, set the currency to INR, use interval `1`, and copy its `plan_...` ID
from the Plan details page. Add the four plan IDs to your `prod.tfvars` as
`razorpay_pro_monthly_plan_id`,
`razorpay_pro_yearly_plan_id`, `razorpay_team_monthly_plan_id`, and
`razorpay_team_yearly_plan_id`. Keep these IDs in your private variables file
and deploy Terraform to inject them into ECS Secrets Manager.

Repeat the plan creation in **Live Mode** after testing. Test and Live plan IDs
are different; do not configure Test IDs in production.

The ECR repository uses immutable tags. Push a new image with a unique tag for
each deployment rather than reusing `latest`.

## Local application environment

For local development, copy [`.env.example`](../.env.example) to `.env` and
provide the local database and Cognito values:

```env
DATABASE_URL="postgresql://admin:password@localhost:7432/keydrop?schema=public"
PORT=4000
NODE_ENV=development
SWAGGER_ENABLED=true

USER_COGNITO_USER_POOL_ID=
USER_COGNITO_CLIENT_ID=
ADMIN_COGNITO_USER_POOL_ID=
ADMIN_COGNITO_CLIENT_ID=
COGNITO_REGION=ap-south-1

S3_REGION=ap-south-1
S3_BUCKET=
ASSETS_CUSTOM_DOMAIN=false
ASSETS_DOMAIN_NAME=
ASSETS_URL=
```

In ECS, database and Cognito values are injected from Secrets Manager. The ECS
task role provides S3 access, so AWS access keys must not be added to the task
environment.

## Terraform state

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

The backend files do not require Cognito, RDS, or application values. Their
settings are:

| Setting   | Value                                                     |
| --------- | --------------------------------------------------------- |
| `bucket`  | An S3 bucket you create; its name must be globally unique |
| `key`     | A separate Terraform state path for each environment      |
| `region`  | The AWS region containing the state bucket                |
| `encrypt` | `true`                                                    |

The repository already includes:

```text
dev.tfconfig      -> keydrop/dev/terraform.tfstate
staging.tfconfig  -> keydrop/staging/terraform.tfstate
prod.tfconfig     -> keydrop/production/terraform.tfstate
```

If the bucket name is unavailable, choose another globally unique name and
replace `keydrop-terraform-state` in all three files before initialization.

Environment backend configuration is provided by:

- [`infra/dev.tfconfig`](../infra/dev.tfconfig)
- [`infra/staging.tfconfig`](../infra/staging.tfconfig)
- [`infra/prod.tfconfig`](../infra/prod.tfconfig)

Use a separate Keydrop state key. Do not reuse the old application's state.

## Deployment workflow

From the repository root:

```bash
cd infra

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

Use the corresponding staging or production backend and variables for those
environments. Do not use `-auto-approve` in production.

Push the API image before applying the ECS service:

```bash
docker build -t keydrop-api:2026-10-16.1 .
```

The exact ECR login, tag, and push commands depend on the AWS account and
Terraform ECR output. The value passed as `image_tag` must match the pushed
immutable image tag.

## Outputs needed by the application

After applying Terraform, retrieve the Cognito values:

```bash
terraform output user_cognito_user_pool_id
terraform output user_cognito_client_id
terraform output admin_cognito_user_pool_id
terraform output admin_cognito_client_id
```

Use the outputs to configure local environments and deployment secrets. Do not
hard-code pool IDs or credentials in application source code.

## Security requirements

- Keep RDS private and allow PostgreSQL traffic only from ECS.
- Keep the S3 bucket private and use application-generated signed URLs.
- Store database credentials and Cognito settings in Secrets Manager.
- Never add AWS access keys to ECS task environment variables.
- Do not commit `.env`, `*.tfvars`, Terraform plans, or Terraform state.
- Review every Terraform plan before applying it.
- Replace placeholder frontend origins in
  [`infra/s3.tf`](../infra/s3.tf) before production.
- Review the first plan with extra care if migrating from the old
  infrastructure; the state and resource layout are not compatible by default.

## Database deployment

After the RDS database is available:

```bash
npm install
npx prisma migrate deploy
```

Run the seed only in development or other explicitly approved non-production
environments:

```bash
npm run db:seed
```

The Prisma schema and seed process are documented in
[`prisma/`](../prisma/) and [`prisma/seed.ts`](../prisma/seed.ts).

## Scheduled cleanup

The API registers a NestJS scheduled job through
[`CronJobsModule`](../src/cron-jobs/cron-jobs.module.ts). Every hour it finds
secrets whose `expiresAt` is in the past, deletes their encrypted payload and
file objects from S3, and then deletes the database records. Related files and
requests cascade-delete; audit events remain with their secret reference
cleared.

The old local OTP cleanup job was removed because Keydrop uses Cognito for
authentication and does not have a local OTP verification table. No OTP
database or Lambda cleanup resource is required.

Email OTP records are cleaned hourly. A daily retention job also removes read
notifications older than 90 days and detached audit events older than two
years. Audit events still attached to a secret are retained until the related
secret lifecycle removes the relation.
