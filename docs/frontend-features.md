# Keydrop frontend feature guide

This guide describes how a web or mobile client integrates with the API in this
repository. It is an API feature guide, not a description of browser routes:
the frontend application itself is not present here.

## Contents

1. [API conventions](#1-api-conventions)
2. [Customer and recipient journeys](#2-customer-and-recipient-journeys)
3. [Route catalogue](#3-route-catalogue)
4. [Plan and API-key behavior](#4-plan-and-api-key-behavior)
5. [Client implementation notes](#5-client-implementation-notes)

## 1. API conventions

- Prefix every route with `/api/v1`.
- Swagger is available at `/api/v1/docs` outside production when enabled.
- Protected routes use the Supabase Auth `accessToken` as a bearer token. The
  API verifies the JWT and resolves its identity subject to a local user record
  in PostgreSQL.
- Pro and Team API keys can replace a customer token only on routes marked
  with a required scope below. Send them in the same bearer header; they begin
  with `kd_`. API keys cannot access staff operations.
- `POST`, `PATCH`, and `DELETE` request bodies are validated globally. Unknown
  body properties are rejected; DTO values are transformed and validated.
- Cursor-paginated collections return `{ items, nextCursor }`. Pass the returned
  `nextCursor` as `?cursor=...`; `limit` is supported by the shared pagination
  DTO.
- Public routes do not require a login. Routes without a required API-key scope
  reject API-key authentication, even when an API key is otherwise valid.

## 2. Customer and recipient journeys

### 2.1 Create an account and authenticate

1. Call `POST /auth/signup` with email and password. Supabase Auth creates the
   identity; the response indicates
   whether confirmation is required and whether the next step is `login` or
   `confirm_email`.
2. Enter the six-digit verification code from the email and submit the email
   and code to `POST /auth/email/verify`. A new code can be requested through
   `POST /auth/email/resend` with the email address.
3. Call `POST /auth/login` to obtain Supabase Auth tokens. Login also
   synchronizes the local user record. Use `accessToken` as the bearer token
   for protected API requests. `idToken` remains only as a compatibility alias.
4. Refresh with `POST /auth/token/refresh` before expiry and call
   `POST /auth/logout` to sign out the supplied access token.
5. For a forgotten password, request a code with `POST /auth/password/forgot`
   and submit it with the new password to `POST /auth/password/reset`.

Email/password authentication and reset are handled by Supabase Auth through
the API's auth service; the API does not use its local generated password hash
for login.

### 2.2 Create and reveal a secret

1. Create a secret only with a Pro or Team account: call `POST /secrets` with
   a Supabase Auth access token or a Pro/Team API key scoped `secrets:write`.
   Requests without an authenticated paid account receive `403 Forbidden`.
   `POST /secrets/anonymous` is disabled and also returns `403 Forbidden`.
2. Encrypt the secret in the client before sending it. The API persists
   ciphertext references and encryption metadata, not plaintext or a decryption
   key. The client must retain/provide the decryption material through its
   sharing flow; the server does not decrypt content.
3. Share the generated secret identifier/link. The recipient can call
   `GET /secrets/:id/meta` to check public metadata and whether a passphrase is
   required. This GET does not consume a view.
4. For recipient-email-gated secrets, request recipient access through
   `POST /secrets/:id/access/request` with the authorized recipient email. The
   API emails a short-lived access token; pass it to
   `POST /secrets/:id/reveal`.
5. Call `POST /secrets/:id/reveal` only on an explicit reveal action. It
   consumes a view and returns encrypted material for client-side decryption.
   It may require a passphrase and/or recipient access token. Secrets that are
   expired, revoked, exhausted, or unavailable cannot be revealed.
6. The owner can list, approve, or deny access requests, revoke a secret, and
   attach files using the authenticated routes below.

`POST /secrets/:id/requests` is a separate owner-approval request flow. The
requester submits an email, the owner is notified, and the owner can change
the request's pending status to approved or denied. That status update does
not itself issue a recipient access token; email-gated reveal still requires
the token issued by `/access/request`.

Account-owned secret limits and available features depend on the current plan;
load `GET /me/entitlements` rather than hard-coding plan limits in the UI.
Free accounts can sign in and view existing history, but cannot create
secrets. Recipients can still open existing links without an account.

### 2.3 Account dashboard and settings

After sign-in, the `/me` routes provide entitlements, usage stats, owned-secret
history and events, audit history, API-key management, notifications,
notification preferences, export, and account deletion. Plan retention
determines which events and audit records remain available.

Account-owned secret history and event endpoints return metadata rather than
secret plaintext. Deleting a secret from account history is limited to a
terminal secret. Account export returns account data and short-lived URLs for
active encrypted objects. Account deletion removes the Supabase Auth identity
and account-owned data while retaining billing records in anonymized form.

The owner can revalidate and copy a saved secret link up to three times.
Recovery is counted server-side; a fourth recovery attempt locks the secret and
purges its encrypted content and file objects. The server cannot reconstruct a
lost link key, so the owner must provide the original saved link. Owner reveal
returns encrypted content only on explicit request; the client decrypts it
locally and the operation does not consume a recipient view.

### 2.4 Teams

Team endpoints are customer features, not staff administration. Creating a
team requires the Team plan. Owners and admins manage team settings and
members; only the owner can assign administrator roles. Invitations are
delivered by email and accepted by an authenticated user using the invitation
token. Team policies are JSON rules for the supported policy types.

### 2.5 Billing

The user billing flow is:

1. Load billing overview and subscriptions from `/me/billing`.
2. Create checkout for a Pro or Team monthly/yearly plan. The API verifies
   that the configured Razorpay plan matches the published INR amount: Pro
   ₹299 monthly / ₹2,990 yearly and Team ₹999 monthly / ₹9,990 yearly.
3. Complete Razorpay checkout in the client and submit the provider identifiers
   and signature to `/me/billing/verify`.
4. The API verifies the checkout signature, fetches the Razorpay subscription,
   and activates the plan immediately when Razorpay reports it as active.
   Signed webhooks remain the event source of truth; if provider activation is
   still pending, use `POST /me/billing/refresh` to check again without creating
   another payment.
5. Use billing reads for invoices/refunds; cancellation is scheduled for the
   end of the current paid period and plan changes can be scheduled through
   the subscription routes.

Prices are managed by the configured Razorpay plans and are denominated in
INR. Do not infer an active plan from a successful browser checkout alone.
Checkout and payment verification require configured Razorpay credentials and
all four Razorpay plan IDs.

## 3. Route catalogue

All routes below are relative to `/api/v1`. `Public` means no authentication;
otherwise use a Supabase Auth access token unless the API-key scope column
explicitly permits a scoped key.

### Service and authentication

| Method | Route                   | Access | Purpose                                     |
| ------ | ----------------------- | ------ | ------------------------------------------- |
| `GET`  | `/`                     | Public | Welcome response                            |
| `GET`  | `/health`               | Public | API status and timestamp                    |
| `POST` | `/auth/signup`          | Public | Register through Supabase Auth              |
| `POST` | `/auth/login`           | Public | Authenticate and return tokens              |
| `POST` | `/auth/email/verify`    | Public | Confirm email with email and six-digit code |
| `POST` | `/auth/email/resend`    | Public | Request a new confirmation code             |
| `POST` | `/auth/password/forgot` | Public | Request password-reset code                 |
| `POST` | `/auth/password/reset`  | Public | Reset password with code                    |
| `POST` | `/auth/token/refresh`   | Public | Refresh Supabase Auth tokens                |
| `POST` | `/auth/logout`          | Public | Sign out supplied access token              |

### Secrets and recipient access

| Method | Route                                 | Access / scope                | Purpose                                        |
| ------ | ------------------------------------- | ----------------------------- | ---------------------------------------------- |
| `POST` | `/secrets`                            | Pro/Team user / `secrets:write` | Create an account-owned secret requiring an active paid plan |
| `POST` | `/secrets/anonymous`                  | Public (disabled)             | Returns 403; anonymous creation is unavailable |
| `GET`  | `/secrets/:id/meta`                   | Public                        | Read metadata without consuming a view         |
| `POST` | `/secrets/:id/access/request`         | Public                        | Request recipient email access                 |
| `POST` | `/secrets/:id/reveal`                 | Public                        | Consume a view and retrieve encrypted material |
| `POST` | `/secrets/:id/report`                 | Public; optional user context | Report a secret for abuse                      |
| `POST` | `/secrets/:id/revoke`                 | Owner / `secrets:write`       | Revoke an owned secret                         |
| `POST` | `/secrets/:id/requests`               | Public                        | Create a secret access request                 |
| `GET`  | `/secrets/:id/requests`               | Owner / `secrets:read`        | List requests for an owned secret              |
| `POST` | `/secrets/:id/requests/:requestId`    | Owner / `secrets:write`       | Approve or deny a request                      |
| `POST` | `/secrets/:id/files`                  | Pro/Team owner / `secrets:write` | Create a presigned upload URL              |
| `POST` | `/secrets/:id/files/:fileId/complete` | Pro/Team owner / `secrets:write` | Verify and complete file upload            |
| `GET`  | `/secrets/:id/files/:fileId/download` | Owner / `secrets:read`        | Create a presigned download URL                |

Upload and download URLs are short-lived (900 seconds). File uploads are
available only to active Pro and Team accounts.

### User profile and account

| Method   | Route                          | Access / scope           | Purpose                                        |
| -------- | ------------------------------ | ------------------------ | ---------------------------------------------- |
| `GET`    | `/users/me`                    | Authenticated user       | Read own profile                               |
| `GET`    | `/users/:id`                   | Same user or `ADM` staff | Read a user profile                            |
| `PATCH`  | `/users/me`                    | Authenticated user       | Change own email                               |
| `GET`    | `/me/entitlements`             | User / `account:read`    | Read plan limits and feature availability      |
| `GET`    | `/me/stats`                    | User / `account:read`    | Read secret usage counts                       |
| `GET`    | `/me/secrets`                  | User / `secrets:read`    | Cursor-page owned secrets                      |
| `GET`    | `/me/secrets/:id`              | Owner / `secrets:read`   | Read owned-secret summary                      |
| `POST` | `/me/secrets/:id/recovery`     | Owner / `secrets:write`  | Revalidate/count recovery; fourth attempt locks secret |
| `POST` | `/me/secrets/:id/reveal`       | Owner / `secrets:read`   | Return encrypted content without consuming a view |
| `GET`  | `/me/secrets/:id/events`       | Owner / `secrets:read`   | Read retained events for a secret              |
| `DELETE` | `/me/secrets/:id`              | Owner / `secrets:write`  | Delete a terminal secret                       |
| `GET`    | `/me/audit`                    | User / `account:read`    | Read retained audit history (Pro/Team)         |
| `POST`   | `/me/api-keys`                 | User token               | Create an API key (Pro/Team)                   |
| `GET`    | `/me/api-keys`                 | User token               | List key metadata; never returns key plaintext |
| `DELETE` | `/me/api-keys/:id`             | User token               | Revoke own API key                             |
| `GET`    | `/me/notifications`            | User / `account:read`    | Cursor-page notifications                      |
| `GET`    | `/me/notification-preferences` | User / `account:read`    | Read delivery preferences                      |
| `PATCH`  | `/me/notification-preferences` | User / `account:write`   | Update delivery preferences                    |
| `PATCH`  | `/me/notifications/:id/read`   | User / `account:write`   | Mark one notification read                     |
| `POST`   | `/me/notifications/read-all`   | User / `account:write`   | Mark all notifications read                    |
| `GET`    | `/me/export`                   | User / `account:read`    | Export account data                            |
| `DELETE` | `/me/account`                  | User token               | Delete account                                 |

An API key is returned in plaintext only in the response from `POST
/me/api-keys`. The client should show it once and not expect to retrieve it
again. API-key creation is rate-limited.

### Teams

| Method   | Route                                  | Access / scope              | Purpose                                        |
| -------- | -------------------------------------- | --------------------------- | ---------------------------------------------- |
| `POST`   | `/teams`                               | User / `teams:write`        | Create a Team-plan workspace                   |
| `GET`    | `/teams`                               | User / `teams:read`         | Cursor-page the user's teams                   |
| `GET`    | `/teams/:id`                           | Team member / `teams:read`  | Read team and member details                   |
| `PATCH`  | `/teams/:id`                           | Owner/admin / `teams:write` | Rename a team                                  |
| `POST`   | `/teams/:id/invitations`               | Owner/admin / `teams:write` | Invite a member by email                       |
| `GET`    | `/teams/:id/invitations`               | Owner/admin / `teams:read`  | List team invitations                          |
| `GET`    | `/teams/:id/policies`                  | Team member / `teams:read`  | List team policies                             |
| `PATCH`  | `/teams/:id/policies/:policyType`      | Owner/admin / `teams:write` | Create or update a policy                      |
| `DELETE` | `/teams/:id/invitations/:invitationId` | Owner/admin / `teams:write` | Revoke an invitation                           |
| `PATCH`  | `/teams/:id/members/:memberId`         | Owner/admin / `teams:write` | Change member role; only owner can grant admin |
| `DELETE` | `/teams/:id/members/:memberId`         | Owner/admin / `teams:write` | Remove a non-owner member                      |
| `POST`   | `/teams/invitations/accept`            | User / `teams:write`        | Accept invitation token                        |

Supported `policyType` values are `secret_expiration`, `access_control`,
`view_limit`, `team_security`, `retention`, and `custom`. Team-level role
checks are enforced by the service in addition to authentication and scopes.
Only the owner can invite or assign a member to the `admin` team role.

### Billing

| Method   | Route                                       | Access / scope         | Purpose                            |
| -------- | ------------------------------------------- | ---------------------- | ---------------------------------- |
| `GET`    | `/me/billing`                               | User / `billing:read`  | Read plan and latest subscription  |
| `GET`    | `/me/billing/subscriptions`                 | User / `billing:read`  | List subscriptions                 |
| `GET`    | `/me/billing/invoices`                      | User / `billing:read`  | Cursor-page invoices               |
| `GET`    | `/me/billing/refunds`                       | User / `billing:read`  | Cursor-page synchronized refunds   |
| `DELETE` | `/me/billing/subscriptions/:id`             | User / `billing:write` | Cancel at the end of the current paid period |
| `POST`   | `/me/billing/subscriptions/:id/change-plan` | User / `billing:write` | Schedule plan change at cycle end  |
| `POST`   | `/me/billing/checkout`                      | User / `billing:write` | Create Razorpay checkout           |
| `POST`   | `/me/billing/verify`                        | User / `billing:write` | Verify payment and sync active subscription |
| `POST`   | `/me/billing/refresh`                       | User / `billing:write` | Refresh subscription status from Razorpay |

## 4. Plan and API-key behavior

Plans are `free`, `pro`, and `team`. Entitlements are server-authoritative:
the client should render capability state from `/me/entitlements` and handle
the API's plan-limit errors. Creating teams requires Team; API keys and
extended audit access require Pro or Team.

Available API-key scopes are `secrets:read`, `secrets:write`, `account:read`,
`account:write`, `billing:read`, `billing:write`, `teams:read`, and
`teams:write`. Keys are hashed before persistence, checked for plan,
expiration, revocation, and scope on each request, and update `lastUsedAt`
after successful authorization.

## 5. Client implementation notes

- Never send plaintext secret material to the API. Perform encryption and
  decryption in the client and preserve the client-held decryption capability
  required by the share link.
- Do not call the reveal route for previews, prefetches, or automatic page
  loads; each successful reveal consumes a view.
- Treat all secret content as unavailable when metadata/reveal indicates a
  terminal or expired state.
- Use `GET /secrets/:id/meta` for previews and avoid exposing ciphertext or
  passphrase data in analytics, browser logs, or error telemetry.
- Preserve `nextCursor` until the next page is requested; do not synthesize
  cursors.
- Never grant a paid plan from a browser callback alone. The API verifies the
  signature and confirms the subscription state directly with Razorpay; signed
  webhook delivery and scheduled reconciliation continue to synchronize it.
- If checkout succeeds but activation is delayed, offer an authenticated
  billing refresh and tell the customer not to retry payment while status is
  pending.
