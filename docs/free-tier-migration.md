# Free-tier migration runbook (historical transition plan)

This runbook was written before the AWS dev environment was decommissioned.
It is retained as migration history and must not be followed as though the
original AWS dev resources still exist.

## Current AWS status

On 2026-10-24, the dev ECS service/cluster, RDS database and automated backups,
ALB, assets bucket, ECR repository, Cognito pools, Secrets Manager entries,
CloudWatch logs, VPC endpoints, and custom dev VPC were deleted with explicit
approval. Dev identity, database, and object data are permanently gone. The
dev API is offline. There is no AWS dev source database or assets bucket to
back up or migrate.

The Route 53 hosted zone and versioned Terraform-state bucket remain pending
verified Cloudflare DNS and state migration. The SES domain identity remains
pending email-provider verification. They may incur charges; do not delete
them until their dependencies and production impact have been verified.

The target Supabase/Vercel/R2 production integrations have not been validated.
Do not claim production cutover or zero AWS billing. Any recovery of deleted
dev data requires a separately stored backup, if one exists.

The phases below describe the original planned migration and are historical.
They do not authorize AWS changes or imply that Cognito, RDS, S3 assets, an
ECS deployment, or AWS rollback are still available.

## Prerequisites and safety

- Inventory actual AWS resources/state without printing or committing secrets.
- Record DNS, API base URLs, webhook URL, bucket names/object counts, database
  versions/extensions, Cognito pool settings, and the current deployment
  rollback point.
- Confirm each provider's current free-tier terms, quotas, eligibility, region,
  data retention, backups, and service limitations. Do not assume $0 at any
  usage level.
- Export secrets only through approved secure channels. Do not put them in
  Git, documentation, CI logs, tickets, or chat.
- No `terraform apply`, `terraform destroy`, production `migrate reset`, RDS
  deletion, Cognito deletion, S3 deletion, or production DNS switch without
  explicit operator approval.
- Keep a time-stamped decision and verification record for each phase.

## Phase 1 — Back up and prepare

1. Take a verified PostgreSQL backup using the existing AWS database's approved
   backup/snapshot/export procedure. Confirm the backup can be read/restored in
   an isolated target; do not test by restoring over production.
2. Record current RDS schema, PostgreSQL version, extensions, indexes,
   constraints, migration table, approximate database size, and connection
   requirements.
3. Record S3 object counts/size and representative keys/metadata without
   exposing secret contents. Keep bucket versioning/backups available.
4. Export Cognito user metadata/configuration needed for planning, never
   passwords. Determine customer/staff counts, verified status, MFA/OAuth
   configuration, account recovery behavior, and existing linked profiles.
5. Identify existing user sessions and communicate a password-reset/JIT
   migration strategy. Do not plan to copy Cognito password hashes.

## Phase 2 — Create Supabase and migrate PostgreSQL

1. Create a Supabase project and set strong project/database credentials in its
   secure dashboard.
2. Inspect and validate schema/migrations against PostgreSQL. Preserve the
   current Prisma schema and migration history; confirm any required extension
   is available on Supabase.
3. Use the selected PostgreSQL migration approach to transfer schema and data.
   Preserve IDs, unique constraints, foreign keys, enum values, timestamps,
   indexes, and `_prisma_migrations`.
4. Keep production writes on the current RDS source during initial load. For
   cutover, plan a short write freeze or a tested incremental synchronization
   so changes are not lost.
5. Configure `DATABASE_URL` in a secure local environment with the Supabase
   connection mode appropriate for Prisma's runtime. Use a direct/session
   connection for migrations if the pooler mode cannot run DDL.
6. Run, against a non-production target first:

   ```bash
   npx prisma validate --config prisma7.config.ts
   npx prisma generate --config prisma7.config.ts
   npx prisma migrate deploy --config prisma7.config.ts
   ```

   Never use `prisma migrate reset` on production.

7. Compare schema/migration state and key row counts; exercise application
   reads/writes and transaction paths. Retain the RDS snapshot/source.
8. Define rollback: pause target writes, route traffic back to the old
   deployment/database, and reconcile writes made after cutover using a
   documented reverse-sync or a pre-agreed maintenance window. Do not assume
   automatic rollback is lossless.

## Phase 3 — Configure Supabase Auth

1. Configure customer signup, email confirmation, password recovery, token
   expiry/refresh, allowed redirect URLs, and JWT signing/issuer settings.
2. Configure staff users as invite/admin-created identities only. Link each
   staff Supabase `sub` to the existing profile and `AdminUser.role`; do not
   grant staff based on a user-supplied claim.
3. The selected Cognito user transition is a forced Supabase password reset.
   Follow the account mapping and reset procedure in
   [authentication.md](./authentication.md). The repository does not yet
   contain a bulk identity importer; do not cut over existing users until the
   procedure has been rehearsed and audited. Keep Cognito enabled for rollback.
4. The API already supports Supabase issuer/JWKS/audience validation behind
   `AUTH_PROVIDER=supabase`. Verify asymmetric signing keys and preserve
   API-key authentication and current DB-backed authorization.
5. Test signup, confirmation, resend, login, logout, refresh, password reset,
   account deletion, token expiry, customer/staff separation, all roles, and
   forbidden access. Ensure user deletion handles Supabase Auth and database
   ordering safely.

## Phase 4 — Configure R2 and migrate objects

1. Create a Cloudflare R2 bucket with private access. Create scoped API tokens
   for only the required bucket operations.
2. Set server-side `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
   `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_ENDPOINT`, and (only if
   required) `R2_PUBLIC_URL`. Never commit their values.
3. Preserve S3 object-key conventions and use the existing AWS SDK S3 commands
   with the R2 endpoint/credentials. Keep `STORAGE_PROVIDER=s3` available for
   rollback and select `r2` only by configuration.
4. Configure restrictive CORS for upload/download origins and required
   `PUT`, `GET`, `HEAD` operations. Do not enable public bucket access.
5. Copy existing objects with a verified copy method and compare counts,
   checksums/metadata where available, and representative decrypted client
   flows. Preserve source objects through the rollback period.
6. Test direct presigned upload, API `HeadObject`, authorized download,
   expired/revoked object denial, delete, retry queue, account export, orphan
   cleanup, and large-file handling. Never proxy large files through NestJS.

## Phase 5 — Configure transactional email

1. Select a provider whose free-tier terms support the expected production
   use, volume, sender verification, and jurisdiction. Resend is the documented
   default candidate (published free limit currently 3,000/month and 100/day),
   not a guaranteed choice.
2. Verify the sending domain and configure SPF/DKIM/DMARC as the provider
   directs. Protect API credentials as server-only secrets.
3. App-owned mail is routed through `EmailService`/`EmailProvider` with Resend
   using published, configurable Resend templates. Follow
   [email-templates.md](./email-templates.md), and test auth/recipient OTPs,
   team invitations, secret-request invitations, and notifications, including
   retry/failure behavior.
4. Configure Supabase Auth identity/password policy. Application signup
   confirmation and password-reset email delivery are sent by the API through
   Resend; do not configure Supabase Auth SMTP/templates for these flows.
   Ensure the API's code-based verification/reset contract matches the
   frontend.
5. Test all workflows end to end, including non-delivery, rate limits, invalid
   codes, duplicate requests, expiry, and notification retry. Keep SES enabled
   until verified.

## Phase 6 — Prepare Vercel deployment

1. Use the repository's Vercel-compatible Node.js Functions entry point for the
   existing NestJS application; do not replace Nest with Workers or change
   public API paths. Reuse one initialized Nest app/Prisma client per warm
   process where the runtime allows.
2. Preserve JSON/body limits, CORS, validation, health route, Swagger policy,
   and raw-body verification for Razorpay webhooks.
3. Configure Supabase Cron as the scheduler for Vercel functions. Supabase
   Cron/`pg_cron` is part of the Postgres project and supports recurring jobs;
   `pg_net` makes the HTTP calls asynchronously. Confirm the extensions are
   available on the selected project/plan and monitor job and request history.
   Do not rely on Nest's in-process `@Cron` decorators in Vercel.
4. The API now stores rate-limit windows in PostgreSQL, shared across Vercel
   instances, and adds a scheduled stale-bucket cleanup. Verify the trusted
   client IP through Cloudflare/Vercel and measure the extra database work.
5. Configure separate Vercel dev/production variables. Server-only variables
   include database, Supabase service key, R2 secret, email API key, and
   Razorpay secrets. Ensure no server key is bundled or returned to clients.
6. Use the repository CI workflow (`.github/workflows/ci.yml`) for install,
   Prisma generate/validate, tests, lint, and build. Connect Vercel to GitHub
   for preview/dev deployment and configure server-only project variables.
   Keep existing AWS deploy workflow available for rollback until cutover
   acceptance.
7. Confirm current Vercel Hobby commercial-use eligibility, function timeout,
   memory, invocation/CPU limits, and database egress before calling it a
   production fit. The current schedule invokes the function about 21,750 times
   per 30-day month; this is an estimate, not a quota guarantee.

### Configure Supabase Cron for Vercel jobs

Use this only in the intended Supabase development project first. Set
`INTERNAL_JOBS_TOKEN` as a server-only Vercel environment variable using a
cryptographically random value. Store that same value and the full job endpoint
base URL in Supabase Vault through the Dashboard; do not paste production
secrets into source control or migration files. The base URL includes the
versioned prefix, for example `https://api-dev.example.com/api/v1/internal/jobs`.

Enable the `pg_cron`, `pg_net`, and Vault extensions from the Supabase
Extensions UI. Create a private schema and a helper that can only call the
allow-listed job names:

```sql
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.invoke_keydrop_internal_job(job_name text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  jobs_url text;
  jobs_token text;
  request_id bigint;
begin
  if job_name not in (
    'secret-cleanup',
    'storage-deletion-retry',
    'email-otp-cleanup',
    'retention-cleanup',
    'notification-generation',
    'notification-email-delivery',
    'past-due-subscription-reconciliation',
    'billing-reconciliation',
    'request-cleanup',
    'rate-limit-cleanup'
  ) then
    raise exception 'Unknown scheduled job';
  end if;

  select decrypted_secret into jobs_url
  from vault.decrypted_secrets
  where name = 'keydrop_internal_jobs_url';

  select decrypted_secret into jobs_token
  from vault.decrypted_secrets
  where name = 'keydrop_internal_jobs_token';

  if jobs_url is null or jobs_token is null then
    raise exception 'Scheduled job secrets are not configured in Vault';
  end if;

  select net.http_post(
    url := rtrim(jobs_url, '/') || '/' || job_name,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || jobs_token
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 25000
  ) into request_id;

  return request_id;
end;
$$;

revoke all on function private.invoke_keydrop_internal_job(text)
from public, anon, authenticated;
```

In Vault, use the unique names `keydrop_internal_jobs_url` and
`keydrop_internal_jobs_token`. Schedule each job from the Supabase SQL editor
(all times UTC):

```sql
select cron.schedule('keydrop-secret-cleanup', '2 * * * *',
  $$select private.invoke_keydrop_internal_job('secret-cleanup')$$);
select cron.schedule('keydrop-storage-retry', '*/10 * * * *',
  $$select private.invoke_keydrop_internal_job('storage-deletion-retry')$$);
select cron.schedule('keydrop-email-otp-cleanup', '4 * * * *',
  $$select private.invoke_keydrop_internal_job('email-otp-cleanup')$$);
select cron.schedule('keydrop-retention-cleanup', '15 3 * * *',
  $$select private.invoke_keydrop_internal_job('retention-cleanup')$$);
select cron.schedule('keydrop-notification-generation', '*/10 * * * *',
  $$select private.invoke_keydrop_internal_job('notification-generation')$$);
select cron.schedule('keydrop-notification-email-delivery', '*/5 * * * *',
  $$select private.invoke_keydrop_internal_job('notification-email-delivery')$$);
select cron.schedule('keydrop-past-due-reconciliation', '*/30 * * * *',
  $$select private.invoke_keydrop_internal_job('past-due-subscription-reconciliation')$$);
select cron.schedule('keydrop-billing-reconciliation', '12 */6 * * *',
  $$select private.invoke_keydrop_internal_job('billing-reconciliation')$$);
select cron.schedule('keydrop-request-cleanup', '6 * * * *',
  $$select private.invoke_keydrop_internal_job('request-cleanup')$$);
select cron.schedule('keydrop-rate-limit-cleanup', '8 * * * *',
  $$select private.invoke_keydrop_internal_job('rate-limit-cleanup')$$);
```

The Vercel routes are `POST /api/v1/internal/jobs/:job`. They fail closed when
the bearer token is unset or invalid, return 404 for unknown jobs, and use a
PostgreSQL advisory transaction lock to skip overlapping runs of the same job.
The function has a 30-second Vercel duration cap and the Supabase HTTP request
times out after 25 seconds. Each operation must remain within this bound.
Because `pg_net` is asynchronous, a successful `cron.job_run_details` row
means only that the request was enqueued. Check `net._http_response` for the
HTTP status/body and verify a completed job in Vercel runtime logs. Alert
operators to repeated non-2xx responses and timeouts. Supabase recommends no
more than eight concurrent jobs and less than ten minutes per job; keep the
number of concurrently executing requests below that and review actual job
duration before production.

## Phase 7 — Dev integration and Cloudflare DNS

1. Deploy to a Vercel dev project with non-production database/provider
   credentials.
2. Configure a Cloudflare dev API hostname, TLS, proxy mode, caching bypass
   for dynamic API paths, and basic WAF/rate controls. Do not cache
   authenticated or secret API responses.
3. Check `GET /api/v1/health`, API routes, CORS, upload/download, signup/login,
   role boundaries, emails, Razorpay test webhook, logs, and audit events.
4. Verify the webhook endpoint matches the configured Vercel domain and
   receives the exact raw body; verify duplicate Razorpay events are
   idempotent and invalid signatures fail.
5. Verify API requests do not leak signed URLs, OTPs, passwords, authorization
   headers, or secret payloads in logs.
6. Exercise background job endpoints manually and verify each action is
   idempotent, bounded, authenticated, and safe under concurrent calls.

## Phase 8 — Production cutover decision

Proceed only after all preceding phase evidence is accepted:

1. Take a fresh verified RDS backup and snapshot relevant Cognito/S3 state.
2. Confirm user migration/password reset plan and support communications.
3. Freeze writes or execute the rehearsed final data synchronization.
4. Deploy the exact tested build and production environment values to Vercel.
5. Route only the intended API hostname through Cloudflare to Vercel. Keep
   existing production DNS values recorded for rollback.
6. Update Razorpay webhook URL only after Vercel endpoint and signatures pass.
7. Verify API health, authentication, uploads/downloads, email, billing,
   database audits, background processing, and Vercel logs.
8. Monitor the agreed observation window. If a gate fails, restore the old
   DNS/deployment and database path; preserve new writes for reconciliation.

## Phase 9 — Retire AWS resources (separate approval required)

Only after successful production monitoring and an explicit approval:

1. Review a fresh Terraform plan and live AWS inventory; investigate unknown
   resources and state dependencies.
2. Retain verified RDS backups and keep Cognito/S3/SES available for the
   agreed rollback window.
3. Remove/disable ECS/Fargate and its deploy path only after Vercel is the
   accepted production runtime.
4. Remove ECR after no AWS service uses its images and the rollback window is
   closed.
5. Remove ALB/listeners/target groups after DNS and webhook routing are stable.
6. Remove RDS only after Supabase data validation, backups, rollback sign-off,
   and explicit data-owner approval.
7. Remove Cognito only after all identities/tokens/users and password
   transitions are accepted.
8. Remove S3 only after object copy verification and retention/rollback
   approval.
9. Remove SES only after all email workflows pass and sender migration is
   accepted.
10. Remove CloudWatch, Secrets Manager, IAM, NAT, VPC, endpoints, subnets,
    security groups, and remaining resources only after dependency review.
11. Route53 is not defined in the repository Terraform; inspect live AWS DNS
    separately and do not change or delete production zones as part of this
    code change.

Do not run `terraform apply` or `terraform destroy` automatically. Terraform
state is sensitive and must remain backed up before any approved cleanup.
