# Keydrop admin feature guide

This guide describes staff-facing capabilities implemented by the API and the
separate authenticated Next.js admin console. The API is authoritative for
identity, role checks, and data access.

## Contents

1. [Staff identity and roles](#1-staff-identity-and-roles)
2. [Implemented staff workflows](#2-implemented-staff-workflows)
3. [Staff and operational route catalogue](#3-staff-and-operational-route-catalogue)
4. [Current API boundaries](#4-current-api-boundaries)
5. [Operational behavior](#5-operational-behavior)

## 1. Staff identity and roles

Staff authenticate with Supabase Auth and send the resulting access token. The
global auth guard validates the JWT, maps its subject to a PostgreSQL `User`,
and loads the linked `AdminUser.role`. Staff and customers use the same
identity provider; staff status is granted only by the database-backed role,
not by public signup, possession of a customer token, or an API key.

Defined roles are:

| Role  | Intended area    | Access established in current controllers         |
| ----- | ---------------- | ------------------------------------------------- |
| `SUP` | Support          | No support-specific admin controller is present   |
| `TS`  | Trust and Safety | May moderate customer accounts and review abuse reports |
| `BIL` | Billing          | May issue refunds through the staff billing route |
| `ENG` | Engineering      | No engineering-only admin controller is present   |
| `ADM` | Admin            | May manage user records, moderate accounts, review abuse reports, and issue refunds |
| `AUD` | Audit            | May read staff audit records                     |

Team roles (`owner`, `admin`, `member`) are customer workspace roles, not
staff roles. A team admin does not gain staff privileges.

## 2. Implemented staff workflows

### 2.1 User administration

An `ADM` staff member can list non-deleted users, create a user linked to a
Supabase Auth identity subject, inspect a user, update email/plan, or delete a
user. `TS` or `ADM` staff can suspend or restore a customer account with a
reason. Suspensions block password login and protected requests, including
API-key access; the identity-provider session is not revoked. User records
include account plan, email verification date, suspension state, and optional
staff role metadata. Updates that change email clear `emailVerifiedAt`; clients
should not assume changing an email preserves verification.

The implementation creates and deletes the database user record. User
authentication synchronizes a local record at signup or first login. The staff
API's create and delete operations do not provision or delete a Supabase Auth
identity, and an admin client must not represent them as identity lifecycle
operations.

### 2.2 Billing refunds

`BIL` or `ADM` staff can request a refund for a Razorpay payment. The API
accepts a payment ID, a reason, and an optional amount in the smallest
currency unit. The response includes refund ID, payment ID, status, amount,
and currency. Refund processing is provider-backed and audited; repeated
requests and unsupported payment states are governed by billing service
validation. The staff UI should display provider status rather than marking a
refund complete solely because the request was accepted.

Customer subscription actions are not staff-only: customers use the
`/me/billing` routes described in the [frontend guide](./frontend-features.md).

### 2.3 Razorpay webhook integration

The Razorpay endpoint is provider-to-server infrastructure, not a staff UI
route. Razorpay posts the raw event body and must include
`x-razorpay-signature` and `x-razorpay-event-id`. The API verifies the
signature, deduplicates deliveries using the event identifier, and applies
subscription/payment changes. A duplicate delivery is acknowledged with
`duplicate: true`. Webhook events are not authenticated with a staff token;
they are authenticated by signature.

## 3. Staff and operational route catalogue

All routes are relative to `/api/v1`.

### Staff-only routes

| Method   | Route                    | Required role          | Purpose                                                        |
| -------- | ------------------------ | ---------------------- | -------------------------------------------------------------- |
| `GET`    | `/users`                 | `ADM`                  | List non-deleted user records, newest first                    |
| `POST`   | `/users/:id/suspend`     | `TS`, `ADM`            | Suspend a customer account with a required reason              |
| `POST`   | `/users/:id/unsuspend`   | `TS`, `ADM`            | Restore a suspended account with a required reason             |
| `POST`   | `/users`                 | `ADM`                  | Create a local user record for a Supabase identity subject     |
| `GET`    | `/users/:id`             | The same user or `ADM` | Read user profile; other roles cannot inspect a different user |
| `PATCH`  | `/users/:id`             | `ADM`                  | Update user email and/or plan                                  |
| `DELETE` | `/users/:id`             | `ADM`                  | Delete a user database record                                  |
| `POST`   | `/admin/billing/refunds` | `BIL` or `ADM`         | Issue a Razorpay payment refund                                |
| `GET`    | `/admin/billing/subscriptions` | `ADM`             | List up to 100 recent subscriptions                            |
| `GET`    | `/admin/billing/invoices` | `ADM`                   | List up to 100 recent invoices                                 |
| `GET`    | `/admin/billing/refunds` | `ADM`                    | List up to 100 recent refunds                                  |
| `GET`    | `/admin/teams`           | `ADM`                    | List up to 100 teams and aggregate counts                     |
| `GET`    | `/admin/teams/:id`       | `ADM`                    | Inspect team members, invitations, and policies                |
| `GET`    | `/admin/secrets/:id`     | `ADM`                    | Read secret metadata only; never secret contents              |
| `GET`    | `/admin/data-requests`   | `ADM`                    | List privacy request tracking records                          |
| `POST`   | `/admin/data-requests`   | `ADM`                    | Record a privacy export/deletion request                       |
| `PATCH`  | `/admin/data-requests/:id` | `ADM`                  | Advance or reject a request with an audit reason               |
| `GET`    | `/admin/blocklists`      | `ADM`                    | List account/domain restrictions, including expired entries   |
| `POST`   | `/admin/blocklists`      | `ADM`                    | Add an audited, optionally expiring restriction                |
| `DELETE` | `/admin/blocklists/:id`  | `ADM`                    | Remove an entry with a reason                                  |
| `GET`    | `/admin/abuse`           | `TS`, `ADM`            | List abuse reports for triage                                  |
| `GET`    | `/admin/abuse/:id`       | `TS`, `ADM`            | Read a report and non-sensitive related metadata               |
| `PATCH`  | `/admin/abuse/:id`       | `TS`, `ADM`            | Assign or update a report with reason                          |
| `PATCH`  | `/admin/secrets/:id/revoke` | `TS`, `ADM`          | Revoke a secret without reading its contents                   |
| `GET`    | `/admin/audit`           | `ADM`, `AUD`           | Read recent staff audit records                                |
| `GET`    | `/admin/approvals`       | `ADM`                  | List approval requests                                         |
| `POST`   | `/admin/approvals`       | `ADM`                  | Create a proposal for second-Admin review                      |
| `PATCH`  | `/admin/approvals/:id`   | `ADM`                  | Approve/reject a request made by another Admin                 |
| `GET`    | `/admin/system/diagnostics` | `ADM`               | Read scheduler, database, queue, and email configuration diagnostics |

`GET /users/me` and `PATCH /users/me` are authenticated customer self-service
routes, not staff console operations. The route list above describes the
staff-relevant paths, not all customer routes; see the frontend guide for the
complete customer-facing route catalogue.

### Provider and health routes (not staff UI)

| Method | Route                | Access                                        | Purpose                                 |
| ------ | -------------------- | --------------------------------------------- | --------------------------------------- |
| `POST` | `/webhooks/razorpay` | Public route with required provider signature | Process and deduplicate Razorpay events |
| `GET`  | `/health`            | Public                                        | Return API status and server timestamp  |

## 4. Current API boundaries

The database contains abuse reports and audit events, and public users can
submit an abuse report through `POST /secrets/:id/report`. The staff API now
supports report triage, customer suspension, metadata-only secret revocation,
audit reading, and second-Admin approval recording. Approval decisions do not
automatically execute proposed actions. Dashboard statistics and other
operational controllers remain unimplemented product features, not hidden
routes.

The staff UI is maintained in a separate Next.js repository. There is no
session-management screen or general staff user-provisioning workflow here.
Team routes are read-only. Data requests track manual fulfillment and do not
export/delete data. Blocklists cover account IDs and email domains, not IP
ranges; matching restrictions are enforced for password login, signup by a
blocked domain, and authenticated account/API-key requests. The sole `ADM`
account and its email domain cannot be blocklisted through the staff API.
Secret lookup is metadata-only.
Staff Supabase identities and the
corresponding database/admin-user records must be provisioned through trusted
identity and operational processes.

## 5. Operational behavior

- Swagger is available at `/api/v1/docs` when enabled. It is disabled by
  default in production.
- The API applies global DTO validation, logs HTTP requests, and maps
  exceptions through the global exception filter.
- Sensitive provider and database configuration is loaded from runtime
  environment/secrets. Do not copy credential values into this guide or into
  support tickets.
- Billing reconciliation runs in the background in addition to webhook
  processing. A billing UI should distinguish local pending state from
  provider-confirmed state.
- `GET /admin/system/diagnostics` is restricted to `ADM`. It checks actual
  in-process cron registration (or reports external trigger configuration in
  serverless mode), runs a read-only database probe, summarizes notification
  and storage-deletion outbox depth/age, and reports email provider
  configuration without returning secrets or sending mail. External scheduler
  invocations and provider deliverability are not claimed as verified.
- `GET /admin/v1/deliverability` is available to `ENG` and `ADM`. It reports
  email provider configuration, pending/due/retrying/exhausted notification
  counts, and sanitized retry metadata. It never returns recipients or payloads.
  The current provider integration does not persist delivery receipts or bounce
  events, so the endpoint explicitly reports that limitation rather than
  presenting queue state as confirmed delivery.
- Staff role checks are exact role checks against the database-backed role;
  the frontend must not rely on hidden controls as authorization.

For the complete staff role model and token behavior, see
[Authentication and authorization](./authentication.md). For schedules and
system boundaries, see the [backend overview](./backend-overview.md).
