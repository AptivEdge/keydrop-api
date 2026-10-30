# Keydrop API

NestJS API for Keydrop. The intended runtime uses Vercel, Supabase PostgreSQL
and Auth, Cloudflare R2, Resend, and Razorpay. AWS application runtime
integrations and AWS deployment workflows have been removed.

See the [migration audit](./docs/free-tier-migration-audit.md), [target
architecture](./docs/free-tier-architecture.md), and
[migration runbook](./docs/free-tier-migration.md) for current status and
operational constraints.

## Requirements

- Node.js 24 and npm
- Supabase PostgreSQL and Auth for local integration testing
- Cloudflare R2 credentials for file/object features
- Resend credentials for transactional email testing
- Docker only when using the optional local PostgreSQL service

Normal development does not require AWS credentials, AWS CLI, LocalStack, or
Terraform. Use development-only provider projects and credentials.

## Run locally

Create a local environment file:

```bash
test -f .env.local || cp .env.example .env.local
```

Configure Supabase, R2, Resend, and Razorpay development values in `.env.local`.
R2 credentials are needed for object-storage features; text-only development
can run without R2 configured. Keep the Supabase service-role key, R2 secret
key, database URL, email API key, and Razorpay secrets server-side. Set unique
local values for `RECIPIENT_ACCESS_TOKEN_SECRET` and `SECRET_AUTH_PEPPER`.

Nest loads `.env.local` first outside production, then uses `.env` for missing
variables; shell-provided variables take precedence. In production, Nest loads
`.env` only, while deployment environment variables remain highest priority.
The Prisma CLI uses the same file selection.

To use the optional local PostgreSQL container:

```bash
docker compose --env-file .env.local up -d db
```

Install dependencies, generate the Prisma client, apply migrations to the
explicitly configured development database, and start the API:

```bash
npm ci
npx prisma generate --config prisma7.config.ts
npx prisma migrate deploy --config prisma7.config.ts
npm run start:dev
```

Do not point local migration commands at production. The API listens on port
`4000`; Swagger is at `http://localhost:4000/api/v1/docs`, and health is at
`http://localhost:4000/api/v1/health`.

Razorpay operations require Test-mode credentials and plan IDs. Application
logs go to stdout/stderr. Vercel disables in-process Nest schedules; configure
the protected internal-job endpoints through the documented external scheduler.

## Storage protocol

Cloudflare R2 is the only configured object-storage provider. The application
uses the AWS SDK's S3-compatible client and presigner as protocol libraries to
connect to R2; no AWS account, credentials, endpoint, or bucket is used by the
runtime.

## AWS retirement status

The Keydrop dev ECS service, RDS database and automated backups, ALB, S3 assets
bucket, ECR repository, Cognito pools, Secrets Manager entries, CloudWatch
logs, VPC endpoints, and custom dev VPC have been deleted. Development identity,
database, and object data were permanently removed. The dev API is offline.

The Route 53 hosted zone and versioned Terraform state bucket remain
intentionally until DNS and state migration are verified. The SES domain
identity is retained until the replacement email configuration is verified.
These retained resources may still incur charges; no $0 bill is guaranteed.
Do not run Terraform apply/destroy or use the archived AWS infrastructure
configuration to recreate the retired stack.
