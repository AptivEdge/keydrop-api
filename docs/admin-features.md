# Keydrop admin feature guide

This guide describes staff-facing capabilities implemented by the API. There
is no admin web application in this repository. A staff client must enforce a
usable workflow, but the API is authoritative for identity, role checks, and
data access.

## Contents

1. [Staff identity and roles](#1-staff-identity-and-roles)
2. [Implemented staff workflows](#2-implemented-staff-workflows)
3. [Staff and operational route catalogue](#3-staff-and-operational-route-catalogue)
4. [Current API boundaries](#4-current-api-boundaries)
5. [Operational behavior](#5-operational-behavior)

## 1. Staff identity and roles

Staff authenticate with the staff Cognito pool and a Cognito ID token. The
global auth guard validates the token, maps its Cognito subject to a
PostgreSQL `User`, and loads the linked `AdminUser.role`. The staff role is
database-backed and is checked by the API; possession of a customer token or
API key does not grant staff access.

Defined roles are:

| Role  | Intended area    | Access established in current controllers         |
| ----- | ---------------- | ------------------------------------------------- |
| `SUP` | Support          | No support-specific admin controller is present   |
| `TS`  | Trust and Safety | No abuse-report review controller is present      |
| `BIL` | Billing          | May issue refunds through the staff billing route |
| `ENG` | Engineering      | No engineering-only admin controller is present   |
| `ADM` | Admin            | May manage user records and issue billing refunds |
| `AUD` | Audit            | No audit-specific admin controller is present     |

Team roles (`owner`, `admin`, `member`) are customer workspace roles, not
staff roles. A team admin does not gain staff privileges.

## 2. Implemented staff workflows

### 2.1 User administration

An `ADM` staff member can list non-deleted users, create a user linked to a
Cognito subject, inspect a user, update email/plan, or delete a user. User
records include account plan, email verification date, and optional staff role
metadata. Updates that change email clear `emailVerifiedAt`; clients should
not assume changing an email preserves verification.

The implementation creates and deletes the database user record. User
authentication synchronizes a local record at first login. The staff API's
create and delete operations do not provision or delete a Cognito identity,
and an admin client must not represent them as Cognito lifecycle operations.

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
`duplicate: true`. Webhook events are not authenticated with staff Cognito;
they are authenticated by signature.

## 3. Staff and operational route catalogue

All routes are relative to `/api/v1`.

### Staff-only routes

| Method   | Route                    | Required role          | Purpose                                                        |
| -------- | ------------------------ | ---------------------- | -------------------------------------------------------------- |
| `GET`    | `/users`                 | `ADM`                  | List non-deleted user records, newest first                    |
| `POST`   | `/users`                 | `ADM`                  | Create a local user record for a Cognito subject               |
| `GET`    | `/users/:id`             | The same user or `ADM` | Read user profile; other roles cannot inspect a different user |
| `PATCH`  | `/users/:id`             | `ADM`                  | Update user email and/or plan                                  |
| `DELETE` | `/users/:id`             | `ADM`                  | Delete a user database record                                  |
| `POST`   | `/admin/billing/refunds` | `BIL` or `ADM`         | Issue a Razorpay payment refund                                |

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
submit an abuse report through `POST /secrets/:id/report`. However, there is
currently no staff API to list, inspect, assign, resolve, or dismiss abuse
reports. There is also no generic staff audit-search API, staff dashboard
statistics endpoint, or `SUP`/`TS`/`ENG`/`AUD`-specific controller in this
repository. These should be treated as unimplemented product features, not
hidden routes.

Likewise, there is no browser route map, staff UI, session-management screen,
or staff user-provisioning workflow here. Staff Cognito identities and the
corresponding database/admin-user records must be provisioned through the
configured identity and operational processes.

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
- Staff role checks are exact role checks against the database-backed role;
  the frontend must not rely on hidden controls as authorization.

For the complete staff role model and token behavior, see
[Authentication and authorization](./authentication.md). For schedules and
system boundaries, see the [backend overview](./backend-overview.md).
