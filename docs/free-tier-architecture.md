# Free-tier target architecture

## Current implementation status

The application code now uses Supabase Auth, Cloudflare R2, Resend, standard
NestJS stdout/stderr logging, and PostgreSQL audit tables; direct AWS service
providers and AWS deployment workflows have been removed. The AWS SDK S3
client/presigner remain solely as the S3-compatible R2 transport. The dev AWS
deployment and data have been deleted. Production target-provider deployment
and live integration tests are still required before launch.

The Route 53 zone, versioned Terraform-state bucket, and SES domain identity
remain pending DNS/state migration and email-provider verification. The
archived Terraform must not be applied or destroyed.

## Topology

```text
                      Cloudflare
              DNS / CDN / basic WAF
                         │ HTTPS
                         ▼
                       Vercel
                 NestJS Node.js API
             ┌───────────┼───────────┐
             │           │           │
             ▼           ▼           ▼
         Supabase    Cloudflare R2   Resend
        PostgreSQL      objects    transactional
        + Supabase                    email
           Auth
             │
             ▼
       Audit/business events
       (PostgreSQL tables)

  Vercel Runtime Logs            GitHub
  (stdout/stderr)              source + CI

  Supabase Cron
  (scheduled, protected calls to Vercel jobs)
```

The backend remains NestJS + Express + Prisma + PostgreSQL. Cloudflare Workers
are not a target runtime. Vercel runs the API as Node.js Functions, with
Cloudflare handling DNS/proxy/CDN/WAF and R2 object storage. Use the free
provider plans only while usage and policy remain within their current limits.

## Request flows

### Authentication

1. The client calls the existing `/api/v1/auth/*` endpoints.
2. NestJS delegates identity operations to Supabase Auth: signup, confirmation,
   password login/reset, refresh, and sign-out.
3. Supabase issues JWTs. The API validates signature using Supabase's issuer
   and JWKS, plus expiry and configured audience/claims.
4. The API maps the JWT `sub` to the existing application `User` profile.
   Database `AdminUser.role`, team roles, plans, and API-key scopes remain the
   authorization source.
5. Public signup can create customer identities only. Staff identity creation
   remains an administrator-controlled process and requires the linked
   `AdminUser` row.

The dev Cognito pools and their users were deleted during AWS decommission.
No production Cognito pools were found in the account inventory. If any users
exist outside that inventory, do not assume their passwords can be exported;
establish a reset/linking plan before allowing them to use Supabase Auth.

### Database and audit

NestJS uses Prisma 7's PostgreSQL adapter and `DATABASE_URL`. For Vercel,
configure the Supabase pooler URL appropriate to the selected pooling mode and
connection limits. Use the database's direct/session connection for schema
migrations when the transaction pooler does not support migration operations.
Keep existing Prisma schema and migration history.

Audit and business events continue to use the existing PostgreSQL models,
including `AuditEvent`, `BillingWebhookEvent`, and existing delivery/retry
tables. Runtime logs are not copied into SQL. Never place passwords, access or
refresh tokens, raw secret values, private keys, or provider credentials in
audit metadata.

### Uploads

1. The authenticated API creates the existing object key and issues a
   short-lived presigned R2 `PutObject` URL.
2. The client uploads directly to the private R2 bucket; large bodies do not
   pass through a Vercel Function.
3. The API verifies expected metadata with `HeadObject` before associating the
   object with a secret/file record.
4. R2 CORS allows only configured application origins and required methods.

R2 access credentials are only available to the server. A presigned URL is a
temporary bearer capability; do not log it or make the bucket public.

### Download and deletion

1. The API performs the existing user/recipient/secret authorization checks.
2. It issues a short-lived presigned `GetObject` URL for the private object.
3. Expiry/revocation continues to enqueue object deletion in PostgreSQL; the
   retry processor deletes from R2. Verify revocation semantics and retries
   against the target R2 account before production launch.

### Email

The existing `EmailDeliveryService`/provider boundary sends recipient codes,
team/secret-request invitations, notifications, signup confirmation codes, and
password-reset codes through published Resend templates. Supabase Auth does
not send auth email. Email delivery failures remain visible to the caller/queue
and must not be reported as successful sends.

### Billing

Razorpay remains unchanged. The client calls the API for checkout/subscription
operations. Razorpay calls the public webhook path; Nest preserves the raw
request bytes, validates the HMAC signature, and uses the unique provider event
ID to make delivery idempotent. Billing/refund audit events remain in
PostgreSQL. Configure the final Cloudflare-routed API webhook URL in Razorpay
only after dev verification.

### Logs and monitoring

NestJS logs structured, redacted messages to stdout/stderr. Vercel captures
runtime logs. The existing database audit events remain persistent. Do not add
a custom log database, CloudWatch, or a paid observability product. Free-plan
retention and visibility are not equivalent to durable audit storage.

### Background work

`@nestjs/schedule` remains enabled for local/non-serverless runtime only and is
disabled on Vercel. Supabase Cron schedules the same cleanup, notification,
storage-retry, and billing work by calling allow-listed Vercel job endpoints.
Each request requires a server-side bearer token stored in Vercel environment
variables and Supabase Vault. PostgreSQL advisory transaction locks prevent
overlapping executions of an individual job. The `pg_net` HTTP request is
asynchronous; operators must check both Cron run history and HTTP response
records rather than treating a queued request as completed.

Supabase documents Cron as part of its Postgres module and supports schedules
from once per second to once per year; it recommends no more than eight
concurrent jobs and less than ten minutes per job. This design schedules nine
jobs at staggered intervals, with a maximum Vercel function duration of 30
seconds. Supabase Free projects can pause after one week of inactivity, so this
must be tested on the selected plan and region and does not remove the
production eligibility/availability gate. The expected schedule is about
21,750 HTTP function invocations per 30-day month; verify current provider
quotas and actual runtime before production.

The rate limiter stores a sliding-window bucket per policy/client in
PostgreSQL and serializes updates with transaction-scoped advisory locks, so
limits are shared across Vercel instances. Bucket identifiers are HMAC-hashed
with the server-only `SECRET_AUTH_PEPPER`; raw IP/user-agent identifiers are
not persisted. Expired rows are removed by the scheduled
`rate-limit-cleanup` job. This adds a small database transaction to each
rate-limited request; measure that load on Supabase Free. Verify the actual
client IP presented behind Vercel and Cloudflare before public production, and
keep Cloudflare's available edge controls as an additional perimeter rather
than a replacement for application authorization.

## Security boundaries

- Cloudflare DNS/proxy and WAF protect the public edge; Vercel handles HTTPS
  and API execution.
- Vercel environment variables contain server-only credentials. Never expose
  Supabase service-role, R2 secret, database, email-provider, or Razorpay
  secrets to frontend code.
- Supabase Auth owns identity; PostgreSQL application records own roles,
  plans, team membership, and authorization.
- Supabase service-role access bypasses Row Level Security; use only from
  trusted API code and grant the narrowest possible database role/permissions.
- R2 objects remain private; client access uses short-lived signed URLs only
  after NestJS authorization.
- Razorpay signatures and idempotency remain mandatory.
- Logs are redacted; audit events exclude authentication secrets and secret
  contents.
- DNS migration is staged by hostname/environment. Production records are not
  changed until the dev path, TLS, API health, and webhook path are verified.

## Free-tier cost controls and limits

The $0/month goal is conditional on provider eligibility, limits, and measured
usage. It is not a guarantee.

As published on 2026-10-23:

| Provider       | Free-tier allowance/constraint to watch                                                                                                                                                                               |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare R2  | Standard storage 10 GB-month; 1 million Class A and 10 million Class B requests/month; egress free. Infrequent Access has separate charges and is not included in the standard free tier.                             |
| Supabase       | Free project: 500 MB DB, 5 GB egress, 50,000 MAUs, two active projects; inactivity pause after one week. Free backup/availability characteristics differ from paid plans.                                             |
| Vercel Hobby   | $0 plan with function invocation/compute limits. Pricing page positions Hobby for personal projects; confirm commercial/production eligibility, cron limits, function duration, and current quotas before production. |
| Resend         | 3,000 transactional email/month, limited to 100/day on Free; verified sender domain and provider rules apply.                                                                                                         |
| Cloudflare DNS | DNS and basic security are available on free plans, but feature/rule limits vary; check zone-specific WAF/rate-limit feature availability before relying on it.                                                       |
| GitHub         | GitHub-hosted Actions and repository features have plan-specific limits; CI usage is not assumed unlimited.                                                                                                           |

Recheck the current provider pricing and terms before deployment:
[Cloudflare R2](https://developers.cloudflare.com/r2/pricing/),
[Supabase](https://supabase.com/pricing),
[Supabase Cron](https://supabase.com/docs/guides/cron),
[Supabase `pg_net`](https://supabase.com/docs/guides/database/extensions/pg_net),
[Vercel](https://vercel.com/pricing), and
[Resend](https://resend.com/pricing).

## Deployment flow

1. GitHub source and CI run tests, Prisma generation/validation, and build.
2. Vercel builds and deploys the Node.js API from the repository with separate
   dev/production environment variables.
3. Supabase schema migrations run as a controlled release step against the
   intended database connection. Do not reset a production database.
4. Supabase Vault and Cron schedule authenticated HTTP calls to the protected
   Vercel job endpoints. Verify each job's schedule, lock behavior, logs, and
   `pg_net` response before relying on it.
5. Cloudflare DNS directs the dev API hostname to Vercel. Verify health,
   auth, storage, email, billing webhook, logs, and audit events.
6. Repeat production cutover only with backups, rollback details, and explicit
   approval. Do not apply or destroy AWS resources automatically.
