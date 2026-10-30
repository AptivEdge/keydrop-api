# Free-tier migration audit

Repository audit date: 2026-10-23
Live AWS inventory and decommission update: 2026-10-24

The inventory below records the pre-purge implementation. The current AWS
resource disposition and runtime-code state are recorded first and supersede
the earlier migration recommendations where they differ.

## Current status (2026-10-24)

- AWS CLI inventory covered the enabled regions for the primary compute,
  network, database, storage, identity, secrets, and logging services. Keydrop
  dev resources were found only in `ap-south-1`; no production application
  service was found in the services/regions checked.
- The Keydrop dev ECS service/cluster, RDS instance and automated backups, ALB
  and target group, public IPv4 addresses, ECR repository, Cognito user pools,
  Secrets Manager entries, CloudWatch application/flow logs, VPC endpoints,
  subnets, route table, internet gateway, custom security groups, and custom
  VPC were deleted with explicit user approval.
- The versioned dev assets bucket was deleted, including all listed object
  versions and delete markers (the bucket contained zero versions at cleanup).
  Dev identity and database data were permanently deleted. The dev API is
  offline.
- The Route 53 hosted zone and versioned Terraform-state bucket were preserved
  pending verified Cloudflare DNS and Terraform-state migration. The SES domain
  identity and default VPC were also preserved. Retained AWS resources may
  still incur charges; this is not a guarantee of a zero AWS bill.
- CloudFront and WAF inventory returned no resources. AWS Cost Explorer
  reported near-zero month-to-date costs at inventory time, but billing can
  lag and credits/adjustments can affect totals.
- AWS runtime-only Cognito, SES, LocalStack, AWS credential configuration, and
  AWS deployment workflow code has been removed. The AWS SDK S3 client remains
  only as the S3-compatible protocol transport for Cloudflare R2; the runtime
  has no AWS S3 provider or AWS credentials path.
- Local Terraform variable files contained plaintext secrets. Treat those
  values as exposed: rotate applicable database, Razorpay, and application
  secrets, and check whether any such files or values entered Git history.
- No production DNS, production database, Terraform state bucket, or SES
  identity was deleted or modified.

## Historical pre-purge executive summary

The checked-in backend currently deploys to ECS/Fargate behind an ALB, uses
RDS PostgreSQL, Cognito, S3, SES, and CloudWatch. Application code directly
depends on Cognito, S3, SES, and CloudWatch. Secrets Manager is not read by the
application: Terraform places its values into ECS task environment variables.
The checked-in Terraform does not define Route53 or SES resources; those
services may be configured outside this repository.

The original implementation used a staged cutover with AWS rollback support.
That rollback posture has since been retired for the dev environment as
described above. The production target-provider integrations remain unverified;
dev AWS data is no longer available as a rollback source.

## Historical repository AWS inventory and classification

The following table describes the pre-purge source and Terraform. Its
`KEEP`/`REPLACE`/`REMOVE`/`UNKNOWN` entries are historical migration
classifications, not the current live resource status.

| AWS service/resource                           | Repository evidence and actual use                                                                                                                                                                                                                                    | Runtime / Terraform dependency                                                                                                                                       | Replacement and risk                                                                                                                                                                                                                            | Current status                                                                                                                    |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Cognito customer pool                          | `AuthService` handles registration, email confirmation/resend, password login/reset, refresh, and global sign-out. `TokenValidationService` validates ID/access JWTs. `CognitoAuthGuard` maps `sub` to the PostgreSQL user. Account deletion calls `AdminDeleteUser`. | Direct runtime dependency; separate customer pool/client in `infra/cognito.tf`.                                                                                      | Supabase Auth must preserve the current API's OTP/code flows, user sync/deletion, JWT validation, and refresh/logout semantics. Existing users need a planned identity/credential migration; passwords cannot be copied from Cognito as hashes. | REPLACE after migration plan and verification; KEEP Cognito for rollback.                                                         |
| Cognito staff pool                             | Separate admin-only staff pool/client, with a stronger configured password policy. Staff membership and roles are in `AdminUser`; staff role checks use database records, not Cognito groups.                                                                         | Direct JWT-verification runtime dependency; Terraform-managed pool/client.                                                                                           | Supabase Auth can share the issuer, but staff enrollment must remain admin-controlled and every staff principal must still have a linked `AdminUser` role. Do not allow public signup to grant staff status.                                    | REPLACE after staff provisioning/authorization tests; KEEP Cognito.                                                               |
| S3                                             | S3 SDK issues presigned `PutObject` and `GetObject` URLs; verifies uploads with `HeadObject`; deletes objects, including retry-queued cleanup; and creates account-export download URLs. The bucket is private, encrypted, and versioned in Terraform.                | Direct runtime dependency and Terraform bucket/policy/CORS resources.                                                                                                | Cloudflare R2's S3-compatible API can preserve object keys and SDK commands. Verify endpoint signing, path-style addressing, CORS, private access, signed URLs, deletion retries, and existing object migration before switching.               | REPLACE behind provider/configuration switch; KEEP S3 until verified.                                                             |
| SES                                            | Direct SESv2 sent application verification codes, team invitations, secret-request invitations, and notifications. Cognito sent identity confirmation/reset email.                                                                                                    | Direct runtime dependency in `RecipientAccessService` and `EmailDeliveryService`; sender/IAM policy configured in Terraform, but no SES resource in this repository. | Resend handles all application email through published, configurable templates, including API-generated signup verification and password-reset codes. Supabase Admin Auth operations do not send email. See [email template setup](./email-templates.md). Verify sender-domain setup and free-tier sending limits. | REPLACED in application runtime by Resend.                                                                                        |
| CloudWatch Logs                                | Winston adds a CloudWatch transport in production. ECS sends container stdout/stderr using `awslogs`; RDS/VPC/ALB logging is configured.                                                                                                                              | Direct runtime transport plus ECS/Terraform dependencies.                                                                                                            | Log to stdout/stderr for Vercel Runtime Logs. Keep persistent audit/business events in the existing PostgreSQL `AuditEvent` model, not in log storage.                                                                                          | REMOVE only after Vercel logs and audit persistence are verified; KEEP during rollback window.                                    |
| Secrets Manager                                | No application AWS Secrets Manager SDK/client usage was found. Terraform stores app/database values and injects them into ECS tasks.                                                                                                                                  | Terraform/ECS deployment dependency only; not an application runtime lookup.                                                                                         | Vercel server-side environment variables. Keep secrets out of source, client bundles, logs, and generated docs.                                                                                                                                 | REMOVE with ECS only after deployment is verified; do not delete current secrets prematurely.                                     |
| RDS PostgreSQL                                 | Prisma uses `@prisma/adapter-pg` with `DATABASE_URL`. Existing schema and ordered SQL migrations are PostgreSQL-specific but do not show provider-specific business logic.                                                                                            | Direct runtime dependency and Terraform-managed database/subnet/parameter resources.                                                                                 | Supabase PostgreSQL. Validate schema, migration history, extensions, indexes, constraints, SSL, Prisma 7 connection-pooler behavior, and data copy/rollback. Free projects can pause after inactivity and have small storage/egress quotas.     | REPLACE only after data and application validation; KEEP RDS/backups.                                                             |
| ECS / Fargate                                  | Current CI builds Docker images and deploys task definitions/services. Container runs `node dist/main`.                                                                                                                                                               | Runtime hosting and Terraform resources.                                                                                                                             | Vercel Node.js Function using the existing NestJS/Express app. Nest's `listen()` bootstrap is not a Functions handler. Scheduled tasks and process-local rate limiting are also not durable/shared across function instances.                   | REMOVE only after Vercel integration and feature verification; KEEP ECS as rollback.                                              |
| ECR                                            | CI pushes immutable Docker images; ECS task definitions reference ECR.                                                                                                                                                                                                | CI/CD and Terraform only.                                                                                                                                            | Vercel builds from GitHub. Docker may remain for local development.                                                                                                                                                                             | REMOVE only after new CI/deploy path is verified.                                                                                 |
| ALB                                            | Public HTTP/HTTPS endpoint and health check target group for ECS.                                                                                                                                                                                                     | Runtime routing and Terraform.                                                                                                                                       | Vercel deployment domain behind Cloudflare DNS/proxy as configured. Existing production DNS must not be changed during dev cutover.                                                                                                             | REMOVE only after domain/webhook verification.                                                                                    |
| VPC, subnets, NAT, IGW, routes, SGs, flow logs | RDS and ECS networking, NAT for private egress, ALB, VPC flow logs. VPC endpoints include Secrets Manager, ECR, Logs, SQS, and S3. No runtime SQS client use was found.                                                                                               | Terraform dependencies of RDS/ECS/ALB and logging.                                                                                                                   | Provider-managed networking. No AWS network resource should be removed until the live dependency graph is checked.                                                                                                                              | REMOVE only after all dependent AWS resources are retired; VPC endpoints and any unknown use are UNKNOWN until live-state review. |
| Route53                                        | No Route53 Terraform resource or SDK use was found in the checked-in source.                                                                                                                                                                                          | No checked-in dependency found; live account configuration unknown.                                                                                                  | Cloudflare DNS. Domain records/nameservers are an operator-controlled cutover.                                                                                                                                                                  | UNKNOWN in AWS account; no in-repo resource to remove.                                                                            |
| SNS/CloudWatch alarms/dashboard                | Terraform defines an SNS topic/subscription and alarms/dashboard for AWS compute/database/ALB.                                                                                                                                                                        | Terraform only.                                                                                                                                                      | Vercel runtime logs and provider dashboards/free usage screens; no new paid monitoring system.                                                                                                                                                  | REMOVE only with retired AWS resources.                                                                                           |
| IAM roles/policies                             | Terraform defines ECS execution/task roles for Secrets Manager, S3, Cognito deletion, SES, CloudWatch, and VPC flow logs.                                                                                                                                             | Terraform only; permissions are consumed by current AWS runtime.                                                                                                     | Vercel server-side env and provider-specific credentials.                                                                                                                                                                                       | REMOVE only after confirming no remaining AWS service consumes each role/policy.                                                  |
| AWS SQS                                        | No application SDK/client use or queue resource was found; only a VPC SQS endpoint is declared.                                                                                                                                                                       | Infrastructure-only; actual live usage unknown.                                                                                                                      | None planned unless an account-level use is discovered.                                                                                                                                                                                         | UNKNOWN pending live AWS inventory.                                                                                               |
| AWS EIP/NAT                                    | Terraform creates NAT/EIP outside the cost-optimized environment.                                                                                                                                                                                                     | Terraform only, supporting private subnet egress.                                                                                                                    | Vercel/Supabase/Cloudflare provider networking.                                                                                                                                                                                                 | REMOVE with VPC after dependency checks; never delete early.                                                                      |

## Cognito behavior to preserve

### Customer flows

- Email/password sign-up with Cognito-managed confirmation.
- Confirm and resend email confirmation code.
- Password login returning access token, ID token, optional refresh token,
  expiry, and token type.
- Refresh-token exchange.
- Forgot/reset password with email code.
- Global sign-out using an access token.
- Account deletion cancels subscriptions, deletes the Cognito identity, and
  then performs application-data cleanup/anonymization and storage cleanup.

### Staff and application authorization

- Terraform creates a separate staff pool with admin-only user creation.
- Customer and staff tokens are currently accepted from configured pools.
- PostgreSQL `User.cognitoSubject` associates an identity subject with a
  profile. A linked `AdminUser` record determines staff status and its `SUP`,
  `TS`, `BIL`, `ENG`, `ADM`, or `AUD` role.
- Customer plans, team roles, and API-key scopes are application data and must
  remain enforced by PostgreSQL/guards. Do not trust user-controlled JWT role
  claims.
- No Cognito MFA or OAuth configuration was found in `infra/cognito.tf`; check
  the live Cognito pools before assuming these are unused.
- Existing Cognito credentials cannot be safely re-created from the app's
  `passwordHash` column: the current Cognito-created records use a random
  placeholder hash. Plan a forced password reset or verified just-in-time
  migration; do not silently invalidate users.

## Other runtime and deployment findings

- **Storage:** production objects are currently private. Presigned browser
  uploads/downloads mean the API does not proxy file bodies. Storage deletion
  uses a PostgreSQL retry queue, with periodic retry and expiry jobs.
- **Audit:** Prisma `AuditEvent` is already used for secret lifecycle, recipient
  verification, API key actions, and billing refunds. Razorpay webhook events
  have a separate idempotency table. Preserve both; do not log payload secrets.
- **Email:** app-owned code sends recipient OTPs, team/secret-request
  invitations, and notifications. Auth confirmation/reset are Cognito-managed.
  Notification delivery is retried from PostgreSQL.
- **Billing:** Razorpay is not AWS-dependent. Webhooks require the raw body,
  HMAC verification, an event ID, and a unique `(provider, eventId)` database
  constraint. Keep this integration and its test coverage.
- **Background jobs:** Nest `@Cron` runs hourly, every 10 minutes, every 30
  minutes, every 6 hours, and daily; jobs cover secret/request cleanup, storage
  retries, email OTP cleanup, notifications, retention, and billing
  reconciliation. Vercel Functions do not provide a durable always-on process.
  The migration adds protected, bounded HTTP entry points, per-job PostgreSQL
  advisory locks, and Supabase Cron/`pg_net` calls. This scheduling path still
  requires verification in the target Supabase/Vercel projects before cutover.
- **Rate limiting:** policy limits are stored in PostgreSQL sliding-window
  buckets and protected with transaction advisory locks. Bucket identifiers
  are HMAC-hashed with `SECRET_AUTH_PEPPER`; a scheduled job cleans stale rows.
  Verify client-IP extraction behind Vercel/Cloudflare and measure the database
  cost before public launch.
- **Vercel request handling:** `main.ts` calls `app.listen()`. The Razorpay
  webhook depends on raw request bytes; a Functions adapter must retain raw-body
  behavior. There are no WebSocket or child-process use sites found. Vercel
  request/function limits still need verification against API request sizes and
  long-running operations.
- **Prisma:** Prisma 7 uses `prisma-client`, `@prisma/adapter-pg`, and a
  PostgreSQL connection URL. Keep existing migrations; use Supabase's runtime
  pooler URL for serverless connections and a direct/session connection for
  schema migration commands if required by the selected Supabase mode.
- **Local development:** current Compose starts PostgreSQL plus LocalStack for
  AWS emulation. This is a repository-local development choice, not a Vercel
  requirement. The target should allow local Nest development with a Supabase
  URL and provider credentials, without AWS/LocalStack.
- **No checked-in `vercel.json`:** deployment configuration and a
  serverless-compatible entry point are not present yet.

## Expected code/configuration surfaces

These are anticipated migration surfaces, not a promise to rewrite each file:

| Area            | Existing surfaces to update or preserve                                                                                                                                                                                                                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Storage         | `src/providers/s3-client.provider.ts`, `src/providers/aws-client-options.ts`, `src/secrets/secrets.service.ts`, `src/storage/storage-purge.service.ts`, `src/account/account.service.ts`, `.env.example`, storage tests                                                                                                       |
| Authentication  | `src/common/auth/services/auth.service.ts`, `src/common/auth/services/token-validation.service.ts`, `src/common/auth/guards/cognito-auth.guard.ts`, `src/account/account.service.ts`, `src/users/controllers/users.service.ts`, `src/main.ts`, auth/account/user tests, `docs/authentication.md`, Prisma user/profile mapping |
| Email           | `src/teams/email-delivery.service.ts`, `src/secrets/recipient-access.service.ts`, auth email flow, email tests, `src/app.module.ts`, `.env.example`                                                                                                                                                                           |
| Logging         | `src/logger/services/logger.service.ts`, `src/logger/aws/cloudwatch-transport.ts`, logger module/tests, production configuration                                                                                                                                                                                              |
| Vercel/runtime  | `src/main.ts`, a serverless function entry point, `vercel.json`, `src/cron-jobs/`, rate limiter, Prisma client lifecycle, raw-body webhook integration                                                                                                                                                                        |
| Deployment/docs | `.github/workflows/`, `Dockerfile` (keep for local use unless otherwise unnecessary), `README.md`, `docs/infrastructure.md`, this audit, architecture, migration sequence, environment docs                                                                                                                                   |
| Terraform       | Existing files in `infra/`; preserve current resources/state through the rollback window. Route53 is not defined in the checked-in Terraform.                                                                                                                                                                                 |

## Environment-variable migration

Keep `DATABASE_URL`, Razorpay variables, and existing application-specific
secrets. Introduce only the provider configuration required by each phase:

```env
DATABASE_URL=
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=
R2_ENDPOINT=
R2_PUBLIC_URL=
EMAIL_PROVIDER=resend
EMAIL_API_KEY=
EMAIL_FROM=
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=
```

The Supabase service-role key, R2 secret key, database URL/password, email API
key, and Razorpay secrets are server-only. Never add real values to this
document or the repository.

## Migration risks and verification gates

1. Supabase Auth has a different issuer, JWKS, token claims, refresh semantics,
   confirmation templates, and admin API than Cognito. Validate issuer and
   audience, customer/staff linkage, role enforcement, logout/revocation, and
   credential migration before switching traffic.
2. Supabase Free is not a production backup/availability guarantee: current
   published terms include a 500 MB database size, 5 GB egress, two active
   projects, and pausing after one week of inactivity. Export backups and
   monitor quotas; confirm whether the operational limits fit launch needs.
3. Existing S3 objects and identifiers must be copied without exposing private
   objects. Keep S3 enabled until R2 reads, writes, URLs, CORS, and deletion
   retries all pass.
4. Vercel does not preserve an always-running Nest process. Its scheduled work
   uses authenticated job endpoints and Supabase Cron/`pg_net`; verify actual
   HTTP responses, per-job advisory locks, execution duration, Supabase Free
   inactivity behavior, and current Hobby quotas before cutover.
5. Verify the PostgreSQL rate limiter's client-IP extraction behind the actual
   Cloudflare/Vercel routing path and observe added database load before
   relying on it for production abuse controls.
6. Cloudflare proxy/DNS changes can affect webhook routing and TLS. Cut over
   development first; do not change production nameservers/records until
   rollback and verification are rehearsed.
7. Supabase Free pauses inactive projects and does not include the same managed
   backup policy as paid plans. The database migration must include an
   independently stored backup and tested rollback.
8. Free-tier quotas and plan terms change. Verify current terms in provider
   dashboards before launch; usage beyond included quotas may incur charges or
   service limits.

## Required verification before cleanup

Run application tests/build, Prisma validate/generate/migrate deploy against a
non-production target, and focused end-to-end checks for object lifecycle,
authentication/authorization, email workflows, Razorpay signature/idempotency,
audit persistence, and Vercel request handling. Verify deployment and rollback
using dev first. Only then review a Terraform plan for retired AWS resources.
Never run `terraform apply`, `terraform destroy`, or a production migration
reset as part of this repository change.

## Implementation order

1. Audit (this document) and target architecture/migration docs.
2. Add R2 configuration behind the current S3-compatible storage code and
   preserve the AWS S3 mode until verified.
3. Validate Supabase PostgreSQL/Prisma connection and data migration strategy;
   retain PostgreSQL schema and migrations.
4. Implement Supabase Auth after resolving identity migration; preserve
   customer/staff and database role semantics.
5. Add a replaceable transactional email provider and validate each email flow.
6. Add a Vercel NestJS handler/configuration; isolate durable background jobs
   and validate rate limiting and raw webhooks.
7. Deploy dev via GitHub/Vercel, configure secrets and test integrations.
8. Configure Cloudflare DNS/WAF/CDN for dev and test Razorpay webhook reachability.
9. Validate all integration/security gates, monitor, and rehearse rollback.
10. Only with explicit operator approval, retire AWS services in dependency
    order; preserve backups and rollback resources until sign-off.

## Free-tier references

Published limits below were checked on 2026-10-23; verify again before
deployment. Free-tier status does not guarantee a $0 bill at arbitrary usage.

- [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/):
  Standard tier includes 10 GB-month storage, 1 million Class A and 10 million
  Class B operations monthly, with free egress; deletes are free. Infrequent
  Access is not covered by the same free tier.
- [Supabase pricing](https://supabase.com/pricing): Free includes 500 MB
  database size, 5 GB egress, 50,000 MAUs, and up to two active projects;
  inactive projects pause after one week. Paid backup/availability features are
  not assumed.
- [Vercel pricing](https://vercel.com/pricing): Hobby is $0 and currently
  includes function invocations and execution allowances, but its published
  positioning is for personal projects. Confirm commercial-use eligibility,
  cron frequency, function duration, and current account quotas before using it
  for production.
- [Resend pricing](https://resend.com/pricing): Free currently includes 3,000
  transactional emails per month with a 100/day limit. Sender-domain and
  deliverability requirements still apply.
