# Keydrop backend overview

This document summarizes the runtime implemented by this repository. Use the
[documentation index](./README.md) for the frontend and staff feature guides.

## Contents

1. [Runtime and request path](#1-runtime-and-request-path)
2. [Feature modules](#2-feature-modules)
3. [Data and integrations](#3-data-and-integrations)
4. [Background work](#4-background-work)
5. [Cross-cutting API behavior](#5-cross-cutting-api-behavior)
6. [Implemented boundaries](#6-implemented-boundaries)

## 1. Runtime and request path

Keydrop API is a NestJS REST application. `main.ts` mounts routes under
`/api/v1`, enables configured CORS, applies global validation, installs
logging and Swagger where enabled, and listens on the configured port.
Swagger is normally available at `/api/v1/docs` outside production.

The request path is, at a high level:

1. HTTP logging middleware records the request.
2. The global rate-limit and authentication guards apply. Routes require
   authentication unless marked public; API keys must have the route's
   explicitly required scope.
3. DTO validation strips no unknown fields: with the current settings,
   unknown body properties are rejected, and known fields are transformed and
   validated.
4. Controllers delegate feature behavior to services.
5. Prisma persists relational records in PostgreSQL; Supabase Auth, Cloudflare
   R2, the email provider, and Razorpay handle identity, encrypted object
   storage, transactional email, and billing.
6. A global exception filter returns API errors and logs failures.

## 2. Feature modules

| Module              | Responsibility                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| `common/auth`       | Supabase Auth, API-key authentication, role checks, and email/password operations                  |
| `common/rate-limit` | Endpoint-specific request throttling                                                               |
| `secrets`           | Secret lifecycle, public recipient access, passphrase validation, abuse reports, uploads/downloads |
| `account`           | User entitlements, secret history, audit, API keys, notifications, export, account deletion        |
| `users`             | Profile self-service and admin user CRUD                                                           |
| `teams`             | Customer team membership, invitations, and policies                                                |
| `billing`           | Razorpay checkout, customer subscriptions/invoices/refunds, staff refunds, webhook processing      |
| `cron-jobs`         | Expiry cleanup, retention cleanup, notifications, OTP cleanup, billing reconciliation              |
| `storage`           | R2 object deletion and retry handling                                                              |
| `logger`            | HTTP/error logging to standard NestJS output                                                       |

The full HTTP route catalogue is in the [frontend guide](./frontend-features.md)
and staff route listing in the [admin guide](./admin-features.md).

## 3. Data and integrations

- **PostgreSQL + Prisma** are the source of truth for users, staff membership,
  secrets and metadata, file references, teams, invitations, policies, API
  keys, notifications, audit events, abuse reports, OTP tracking, subscriptions,
  invoices, refunds, and billing webhook events.
- **Supabase Auth** authenticates customers and staff. The validated JWT
  subject is linked to a local `User`; staff authorization comes from the
  linked `AdminUser.role`.
- **Cloudflare R2** stores encrypted secret/file objects. The API persists
  object references and encryption metadata and issues short-lived presigned
  URLs for file operations.
- **Resend** delivers application emails, including recipient verification,
  team invitations, and notifications.
- **Razorpay** provides subscription checkout and refund processing. Checkout
  signature verification is followed by signed webhook processing and
  reconciliation before subscription state is considered provider-confirmed.
- **Vercel Runtime Logs** capture NestJS standard output and errors. Persistent
  business/security audit events remain in PostgreSQL.

The API does not have access to plaintext shared-secret content or the
client-held decryption key. The browser/client encrypts and decrypts the
content; the server controls metadata, lifecycle, access checks, and object
references.

## 4. Background work

Local and non-serverless deployments run Nest scheduled jobs in the API
process. The same job handlers are exposed to Supabase Cron on Vercel. Current
schedules include:

| Work                     | Schedule                           | Result                                                                      |
| ------------------------ | ---------------------------------- | --------------------------------------------------------------------------- |
| Expired-secret cleanup   | Hourly                             | Purges expired secret and file objects, then removes expired secret records |
| Storage deletion retries | Every 10 minutes                   | Retries queued failed object deletions                                      |
| Email OTP cleanup        | Hourly                             | Removes expired/old verification records                                    |
| Retention cleanup        | Daily at 03:00                     | Removes expired notifications and detached/expired audit records            |
| Notification processing  | Every 5 and 10 minutes             | Creates expiring-secret notifications and delivers opted-in emails          |
| Billing reconciliation   | Every 30 minutes and every 6 hours | Reconciles provider subscription state and billing reliability workflows    |

Jobs use PostgreSQL and the relevant target providers directly. Vercel disables
in-process schedules and exposes protected internal-job endpoints for Supabase
Cron; local and non-serverless runtimes use NestJS scheduling. The runtime does
not depend on SQS or a separate worker service.

## 5. Cross-cutting API behavior

- Base path: `/api/v1`; service probe: `GET /health`.
- Public endpoints include authentication and recipient secret access,
  recipient metadata/reveal/access, abuse-report submission, Razorpay webhook,
  and health/welcome routes. Review the controller route tables for the exact
  distinction between public and protected actions.
- Customer and staff JWTs are validated against Supabase Auth. The API resolves
  the identity subject to a local user and loads database-backed roles. API
  keys are hashed in storage and validated for current plan,
  revocation, expiry, and route scope.
- The app rejects non-whitelisted request properties and transforms DTO input.
- Cursors are used for long histories and list endpoints. API errors are
  surfaced using Nest HTTP exceptions rather than success-shaped empty values.
- Recipient secret reveal consumes a view. Owner dashboard reveal returns
  encrypted content without consuming a recipient view, and link recovery is
  owner-only with a three-recovery limit before locking the secret.
- Metadata GET does not consume a view. Terminal or expired secrets cannot be
  revealed or recovered.
- Rate limits protect sensitive operations such as account creation, login,
  OTP, checkout, secret operations, API-key creation, and team invitations.

## 6. Implemented boundaries

The repository is an API/backend and infrastructure project, not a frontend
monorepo. It contains no browser route definitions or admin UI routes. Staff
HTTP capabilities currently cover `ADM` user CRUD and `BIL`/`ADM` refunds.
Although abuse reports and audit records are persisted, this codebase has no
staff endpoints for abuse-report review or generic audit search.

The [backend initial-flow document](./backend-initial-flow.md) is a historical
specification: its current-implementation notes distinguish live behavior from
older planned DynamoDB, SQS/worker, and other future architecture. Treat source
code and current feature guides as authoritative for routes.
