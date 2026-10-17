# Keydrop API

NestJS API for Keydrop. This README covers local development and deploying the
API to AWS with Terraform, ECR, ECS Fargate, and RDS PostgreSQL.

## Requirements

- Node.js 24 and npm
- Docker with Buildx
- Terraform
- AWS CLI credentials for an account with permission to manage the resources in
  `infra/`
- An AWS region supported by the configured services (the current dev deployment
  uses `ap-south-1`)

Confirm the selected AWS identity before making changes:

```bash
aws sts get-caller-identity
aws configure get region
```

The Terraform AWS provider uses the standard AWS CLI/profile credentials. If
your login method does not expose credentials to the provider, configure an
AWS CLI profile or use your organization's standard credential process first.

## Run locally

Start the PostgreSQL database:

```bash
cp .env.example .env
docker compose up -d db
```

Copy `.env.example` to `.env`. For the supplied Compose database, use a local
connection URL like:

```env
DATABASE_URL="postgresql://admin:password@localhost:7432/keydrop?schema=public"
```

Install dependencies, generate the Prisma client, apply migrations, and start
the API:

```bash
npm ci
npx prisma generate
npx prisma migrate deploy --config prisma7.config.ts
npm run start:dev
```

The API listens on port `4000`. Swagger is at
`http://localhost:4000/api/v1/docs`; the health check is
`http://localhost:4000/api/v1/health`.

The local database credentials in Compose are for development only. Do not
reuse them in AWS or production. Configure Cognito, S3, SES, and Razorpay
values in `.env` if you need to exercise those features.

Useful checks:

```bash
npm test
npm run lint
npm run build
```

## Deploy to AWS

The Terraform configuration is in [`infra/`](./infra/). It provisions the
network, private RDS database, ECR repository, ECS service, load balancer,
Cognito pools, S3 bucket, Secrets Manager entries, and CloudWatch resources.
Review the Terraform files and every plan before applying them.

The steps below describe a **new environment**. If Terraform already manages
your environment, keep using its existing state key and variables file; do not
reinitialize the backend or set the running service's desired count to zero.
For an existing deployment, use a new image tag, push the image, run any
required migrations, and apply a reviewed plan.

### 1. Prepare AWS state storage

Terraform state contains sensitive infrastructure data. Use a private,
dedicated, versioned S3 bucket; do not commit state or share it publicly. Create
the bucket once if you do not already have one. For the current region:

```bash
export AWS_REGION=ap-south-1
export TF_STATE_BUCKET=replace-with-your-globally-unique-state-bucket

aws s3api create-bucket \
  --bucket "$TF_STATE_BUCKET" \
  --region "$AWS_REGION" \
  --create-bucket-configuration "LocationConstraint=$AWS_REGION"

aws s3api put-public-access-block \
  --bucket "$TF_STATE_BUCKET" \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

aws s3api put-bucket-versioning \
  --bucket "$TF_STATE_BUCKET" \
  --versioning-configuration Status=Enabled
```

If the bucket already exists, do not create it again. Confirm that it belongs
to your AWS account and has public access blocked and versioning enabled.
Terraform's S3 backend uses encryption and a separate state key per
environment.

### 2. Prepare domain, email, and billing settings

Before applying a configuration that uses a custom API domain:

1. Request or use an **issued ACM certificate in the same region** as the
   deployment. It must cover the API domain.
2. Complete the certificate's DNS validation.
3. After Terraform creates the load balancer, create a DNS alias from the API
   domain to the load balancer DNS name (Terraform outputs `alb_dns_name`).
   DNS records are not managed by this Terraform configuration.
4. Verify the SES sender identity and DKIM records in the deployment region.
5. Create the four Razorpay subscription plans in the appropriate Test or Live
   mode, and copy their plan IDs. Use Test credentials and Test plan IDs in
   development; use Live values only in production.

The API webhook endpoint is
`https://<api-domain>/api/v1/webhooks/razorpay`. Configure that URL and the
same webhook signing secret in the matching Razorpay mode.

### 3. Configure Terraform variables

Create a private variables file. It is ignored by Git:

```bash
umask 077
touch infra/dev.tfvars
chmod 600 infra/dev.tfvars
```

Edit `infra/dev.tfvars` and provide the values below. Do not put real values in
this README or commit the variables file.

```hcl
environment                   = "dev"
aws_region                    = "ap-south-1"
app_name                      = "keydrop"
api_domain_name               = "api-dev.example.com"
acm_certificate_arn           = "arn:aws:acm:ap-south-1:ACCOUNT_ID:certificate/CERTIFICATE_ID"
frontend_url                  = "https://dev.example.com"
db_password                   = "REPLACE_WITH_A_LONG_RANDOM_PASSWORD"
ses_from_email                = "no-reply@example.com"
razorpay_key_id               = "REPLACE_WITH_TEST_KEY_ID"
razorpay_key_secret           = "REPLACE_WITH_TEST_KEY_SECRET"
razorpay_webhook_secret       = "REPLACE_WITH_TEST_WEBHOOK_SECRET"
razorpay_pro_monthly_plan_id  = "plan_REPLACE_ME"
razorpay_pro_yearly_plan_id   = "plan_REPLACE_ME"
razorpay_team_monthly_plan_id = "plan_REPLACE_ME"
razorpay_team_yearly_plan_id  = "plan_REPLACE_ME"
recipient_access_token_secret = "REPLACE_WITH_A_LONG_RANDOM_SECRET"
image_tag                     = "dev-bootstrap-001"
desired_count                 = 0
```

`image_tag` must be unique for each deployment because the ECR repository uses
immutable tags. `dev-bootstrap-001` is only a placeholder for the first
infrastructure apply, when the service desired count is zero; replace it with
the tag you push before starting the service. `api_domain_name` and
`acm_certificate_arn` must either both be configured or both be empty.
Production requires both. Keep the RDS database private
(`db_publicly_accessible = false`, the default).

Terraform writes application and database credentials to AWS Secrets Manager;
Terraform state also contains sensitive values. Protect the state bucket and
the local variables and plan files accordingly.

### 4. Initialize and create the infrastructure

From the repository root, set the bucket name and initialize a separate state
key for this environment:

```bash
export TF_STATE_BUCKET=replace-with-your-globally-unique-state-bucket
export AWS_REGION=ap-south-1

terraform -chdir=infra init \
  -backend-config="bucket=$TF_STATE_BUCKET" \
  -backend-config="key=keydrop/dev/terraform.tfstate" \
  -backend-config="region=$AWS_REGION" \
  -backend-config="encrypt=true"

terraform -chdir=infra fmt -recursive
terraform -chdir=infra validate
```

For the first apply, set `desired_count = 0` in `dev.tfvars`. This creates the
ECR repository and infrastructure without starting a task that tries to pull
an image that has not been pushed yet. Then review and apply the plan:

```bash
terraform -chdir=infra plan \
  -var-file=dev.tfvars \
  -out=dev.tfplan
chmod 600 infra/dev.tfplan
terraform -chdir=infra apply dev.tfplan
```

Do not use a saved plan after changing the variables or Terraform files; create
and review a new plan instead.

### 5. Build and push the API image

Log Docker in to ECR, then build and push for the ECS Fargate architecture.
Use the same unique tag set in `dev.tfvars`:

```bash
AWS_ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
ECR_REPOSITORY="$(terraform -chdir=infra output -raw ecr_repository_url)"
IMAGE_TAG="dev-$(date -u +%Y%m%d%H%M%S)"

aws ecr get-login-password --region "$AWS_REGION" |
  docker login --username AWS --password-stdin \
    "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"

docker buildx build \
  --platform linux/amd64 \
  --tag "$ECR_REPOSITORY:$IMAGE_TAG" \
  --push \
  .
```

Copy the resulting `IMAGE_TAG` into `infra/dev.tfvars` as `image_tag`. Keep
`desired_count = 0` for now; plan and apply to update the task definition to
the image you pushed:

```bash
terraform -chdir=infra plan \
  -var-file=dev.tfvars \
  -out=dev.tfplan
chmod 600 infra/dev.tfplan
terraform -chdir=infra apply dev.tfplan
```

For future deployments, build and push a new unique tag first, update
`image_tag`, run any required migrations in step 6, and apply a newly reviewed
Terraform plan. Do not reuse an immutable tag.

### Automatic dev deployments from GitHub

The [Deploy dev workflow](./.github/workflows/deploy.yml) runs on every push to
the `dev` branch and can also be started manually from GitHub Actions. It
installs dependencies, generates Prisma Client, runs tests and the build,
pushes an image tagged with the commit SHA, registers an ECS task-definition
revision using that image, and waits for the ECS service to become stable.
Production is not deployed by this workflow.

Configure these **`dev` environment Actions secrets** in GitHub:

| Secret | Purpose |
| ------ | ------- |
| `AWS_ACCESS_KEY_ID` | AWS access key for the deployment identity |
| `AWS_SECRET_ACCESS_KEY` | Secret key for the deployment identity |

The AWS identity must be restricted to the dev resources and have permission
to push images to ECR (`ecr:GetAuthorizationToken` and the repository's layer
upload/image push actions), describe the ECS service and task definition,
register task definitions, update the ECS service, wait for service stability,
and pass the ECS task execution and task roles (`iam:PassRole`) when registering
task definitions. Store the secrets in GitHub's `dev` environment so they are
only exposed to this deployment job. Do not paste credentials into workflow
files. The workflow's AWS region, ECR repository, cluster, and service are
configured in the workflow file; no GitHub Actions variables are required.

The workflow deploys the new task definition directly through ECS, outside
Terraform. A later Terraform apply may restore the `image_tag` configured in
`infra/dev.tfvars`; review the plan before applying and coordinate Terraform
image updates with CI deployments.

Database migrations are deliberately not run by this GitHub-hosted workflow:
the dev RDS database is private and is not reachable from a standard
GitHub-hosted runner. Apply migrations from a trusted runner with VPC access,
as described in the next section, before deploying code that requires a schema
change.

### 6. Apply database migrations

RDS is private, so migrations must run from a trusted machine or CI runner that
has network access to the VPC and permission to read the database secret. Do
not make RDS public just to run migrations.

Run migrations before starting the service on a new database, or before
deploying application code that depends on a schema change. From a trusted
runner with Node.js 24 and the repository checked out, load the connection URL
from Secrets Manager without printing it, then run:

```bash
export DATABASE_URL="$(
  aws secretsmanager get-secret-value \
    --region "$AWS_REGION" \
    --secret-id keydrop/database/dev \
    --query SecretString \
    --output text |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["connection_string"])'
)"
npm ci
npx prisma migrate deploy --config prisma7.config.ts
unset DATABASE_URL
```

After successful first-time migrations, set `desired_count = 1` in
`dev.tfvars`, then create and apply another reviewed plan to start the API.
For subsequent deployments, run any required migrations before applying the
new image/task definition. Do not enable shell tracing (`set -x`) while
handling credentials. For production, use a controlled release runner and
review migrations for backward compatibility and data impact.

### 7. Verify deployment and configure DNS

Wait for the ECS service to stabilize:

```bash
aws ecs wait services-stable \
  --region "$AWS_REGION" \
  --cluster "$(terraform -chdir=infra output -raw ecs_cluster_name)" \
  --services "$(terraform -chdir=infra output -raw ecs_service_name)"
```

Use the `alb_dns_name` Terraform output to create the DNS alias for the API
domain. Then check:

```bash
curl --fail --show-error "https://YOUR_API_DOMAIN/api/v1/health"
```

The health endpoint should return HTTP 200. In development, Swagger is
available at `https://YOUR_API_DOMAIN/api/v1/docs`. Check ECS service events
and the CloudWatch log group reported by `terraform output
application_log_group` if the service does not become healthy.

Terraform also reports Cognito pool/client IDs, the ECR repository, and the
Razorpay webhook URL:

```bash
terraform -chdir=infra output
```

Treat Terraform output and state as potentially sensitive. Never copy database
credentials or application secrets into source files, issues, or logs.

## Production deployments

Use a separate production variables file and a separate backend state key, for
example `keydrop/production/terraform.tfstate`. Set `environment = "production"`,
configure the production API domain and ACM certificate, and use production
SES and Razorpay values. Review the full plan and backup/recovery strategy
carefully before applying; production resources enable deletion protection.

## Further information

- Terraform source and outputs: [`infra/`](./infra/)
- Prisma schema, migrations, and seed: [`prisma/`](./prisma/)
- Local environment variable names: [`.env.example`](./.env.example)
