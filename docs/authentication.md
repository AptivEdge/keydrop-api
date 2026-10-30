# Keydrop Authentication and Authorization

This document describes the authentication and authorization model used by the
Keydrop API.

## Role model

Keydrop separates customer plans, team membership roles, and staff roles.

### Customer plans

Customer plan is stored in [`prisma/models/user.prisma`](../prisma/models/user.prisma)
as `User.plan`:

- `free`
- `pro`
- `team`

Plans control customer capabilities such as text size, files, API access,
audit history, and team features. Plan limits must be enforced by the API.

### Team roles

Team membership is stored in
[`prisma/models/team.prisma`](../prisma/models/team.prisma) as
`TeamMember.role`:

- `owner`
- `admin`
- `member`

These roles apply only within a specific team. They are not global user roles.

### Staff roles

Staff membership is stored in
[`prisma/models/admin-user.prisma`](../prisma/models/admin-user.prisma) as
`AdminUser.role`:

- `SUP` - Support
- `TS` - Trust and Safety
- `BIL` - Billing
- `ENG` - Engineer
- `ADM` - Admin
- `AUD` - Auditor

Staff roles are enforced by the API and must not be enforced only in the UI.

### Admin account provisioning

An authenticated `ADM` can list staff accounts with `GET /admin/admin-users`
and create an Admin account with `POST /admin/admin-users` using
`{"email":"admin@example.com"}`. The endpoint is rate limited and requires an
authenticated staff session.

The first `ADM` can be created with `POST /admin/bootstrap` and
`{"email":"admin@example.com","password":"<your chosen password>"}`. Choose a
unique password of at least 12 characters; there is no shared or hard-coded
default. It is used as the initial Supabase password and is never returned or
emailed. This endpoint requires the
`x-admin-bootstrap-token` header, configured server-side as
`ADMIN_BOOTSTRAP_TOKEN` with at least 32 bytes. Generate a cryptographically
random value for this setting. The endpoint is disabled when the setting is
absent, rate limited to three attempts per hour, and uses a database
transaction lock to ensure only one first Admin can be created. Remove the
environment variable immediately after successful bootstrap. Never send the
bootstrap token from browser code or put it in a URL.

Bootstrap creates a Supabase identity with the chosen initial password,
creates the linked Keydrop user and `ADM` row, and sends the existing email
verification code. Verify the email before signing in. Additional Admin
invitations still use random undisclosed passwords and the password-reset
flow. Failed email delivery triggers cleanup of the pending OTP, database
records, and Supabase identity; cleanup failures are logged and returned as
service-unavailable errors. Never expose the Supabase service-role key
through this endpoint.

Admin sign-in uses the account password as its only authentication factor.

### GitHub customer sign-in

The customer web app starts Supabase OAuth with the GitHub provider and
exchanges the PKCE callback code server-side. It then calls
`POST /auth/oauth/github/session` with the Supabase access token. The API
validates the token with Supabase, requires a verified GitHub identity, and
creates or links only a customer profile. Staff profiles are rejected from
this customer OAuth flow. The web app stores the resulting session in its
existing HttpOnly cookies.

Configure `SUPABASE_URL` and `SUPABASE_ANON_KEY` in the web deployment, enable
GitHub in the Supabase Auth providers, and allow the web callback URL
`https://<customer-web-host>/api/session/github/callback` in Supabase's
redirect URL settings. No service-role key is used by the web app.

## Authentication provider and target flow

Supabase Auth is the only supported identity provider. The API continues to
enforce authorization from its PostgreSQL user, team, and staff-role records.

With Supabase Auth:

1. The API creates Supabase identities using the server-only Supabase Admin
   API. Signup confirmation and password reset use purpose-scoped,
   short-lived OTPs stored as HMAC hashes in PostgreSQL and sent only through
   Resend. Supabase Auth does not send application auth emails. Login, refresh,
   logout, identity confirmation, and password updates use Supabase Auth APIs.
   If signup fails before the verification email is accepted, the API consumes
   its pending code and deletes the newly created unverified Supabase identity.
   If cleanup fails, the API reports this explicitly and logs a safe cleanup
   failure event.
2. The API validates Supabase JWT signatures from the project's JWKS endpoint,
   issuer `${SUPABASE_URL}/auth/v1`, and audience `authenticated`.
3. The verified JWT `sub` is linked to `User.identitySubject`.
4. The global API guard loads the linked application profile and its
   `AdminUser` record. Customer plans, team membership, and staff permissions
   continue to come from PostgreSQL, never from client-provided or unverified
   role claims.
5. The existing response field `idToken` is retained as a compatibility alias
   for the Supabase access token. New clients should use `accessToken`; do not
   assume the alias has Cognito ID-token claims.

The API requires `EMAIL_PROVIDER=resend`, `EMAIL_API_KEY`, `EMAIL_FROM`, the
published `EMAIL_TEMPLATE_AUTH_VERIFICATION` and
`EMAIL_TEMPLATE_PASSWORD_RESET` aliases, and `SECRET_AUTH_PEPPER` to send
signup verification and password-reset codes. Configure Resend with a verified
sender domain. No Supabase Auth email template, SMTP sender, or redirect URL
is used by these API flows. See
[Resend email templates](./email-templates.md) for template setup and
configuration. Supabase Auth password policy,
session lifetime, refresh-token rotation, and any MFA/OAuth features must be
checked in the project before cutover.
The application-owned `EmailOtp` table has RLS enabled and grants no direct
access to Supabase `anon` or `authenticated` roles; OTPs are accessed only by
the API's server-side database connection.
Configure an asymmetric Supabase JWT signing key whose public key is available
from the project's JWKS endpoint; test a real signed token against the API.

Supabase uses one Auth project for customers and staff; it does not preserve
Cognito's separate user/staff pools. Provision staff identities through the
protected Admin account provisioning endpoint described above. Staff
authorization still comes only from the database record. The Supabase
service-role key is server-only and must never be sent to a client.

Staff requests require a valid Supabase JWT and an authorized staff role from
the database. MFA assurance claims are not required by the API.

## Previous Cognito authentication flow (historical)

This section records the retired Cognito behavior only. The Cognito guard and
dev pools have been deleted; the current implementation uses
[`SupabaseAuthGuard`](../src/common/auth/guards/supabase-auth.guard.ts).
No production Cognito pools were found in the AWS account inventory.

For each request, the guard:

1. Reads the `Authorization` header.
2. Requires the `Bearer <token>` format.
3. Validates the token against the configured customer or staff Cognito pool.
4. Reads the verified Cognito `sub`.
5. Looked up the legacy identity subject in PostgreSQL.
6. Loads the linked `AdminUser` record, if one exists.
7. Attaches the authenticated user to `request.user`.
8. Applies any route-level staff role requirements.

The token is validated against one of two configured pools:

- The customer pool (`USER_COGNITO_*`) for registered users.
- The staff pool (`ADMIN_COGNITO_*`) for all staff roles.

Anonymous senders and recipients do not use Cognito. Customer plans and team
roles are stored in PostgreSQL, not represented by separate Cognito pools.
The API does not select a verifier using an unverified token claim.

## Scoped API keys

Pro and Team users can create API keys. Keys use the `kd_` prefix, are returned
only once, and are stored as SHA-256 digests. Send a key using the standard
`Authorization: Bearer <key>` header. The global guard verifies that the key is
not revoked or expired, the user is not deleted and still has an API-enabled
plan, and that the key has the scope required by the route. Routes without an
explicit API-key scope reject API keys; API keys never grant staff access.

Available scopes are:

- `secrets:read` and `secrets:write`
- `account:read` and `account:write`
- `billing:read` and `billing:write`
- `teams:read` and `teams:write`

New keys default to `secrets:read`. Successful authorized requests update
`ApiKey.lastUsedAt`. Revoke compromised keys immediately; revoked keys cannot
be used even if their bearer token remains available.

## Email OTP verification

Email verification is tracked in PostgreSQL through the
[`EmailOtp`](../prisma/models/email-otp.prisma) model. The [`EmailOtpService`](../src/common/auth/services/email-otp.service.ts):

- Normalizes email addresses before lookup.
- Generates a six-digit code using a cryptographically secure random source.
- Stores only an HMAC-SHA-256 hash of the code, keyed by
  `SECRET_AUTH_PEPPER`.
- Separates recipient-access, signup verification, and password-reset codes by
  purpose so a code cannot be replayed across workflows.
- Expires codes after 10 minutes.
- Allows at most five failed attempts.
- Allows one unconsumed code request per email every 60 seconds.
- Marks a successful code as consumed so it cannot be reused.
- Persists the related Supabase identity subject with auth-purpose codes; after
  a valid signup code, the API confirms that identity and synchronizes its
  application profile.

The auth service sends generated codes through the shared Resend
[`EmailService`](../src/email/email.service.ts); codes are never returned by
public endpoints or logged. The hourly
[`EmailOtpCleanupCronService`](../src/cron-jobs/services/email-otp-cleanup.cron.service.ts)
deletes expired and older-than-24-hour OTP records. Email delivery is kept
outside the persistence service and uses the shared Resend email service.
Never return a code directly from a public HTTP endpoint or log it.

## User CRUD and authorization

User endpoints are implemented in
[`src/users/`](../src/users/). The global authentication guard protects every
route unless it is explicitly marked `@Public()`.

| Method   | Route               | Access                             |
| -------- | ------------------- | ---------------------------------- |
| `GET`    | `/api/v1/users/me`  | Any authenticated user             |
| `PATCH`  | `/api/v1/users/me`  | Any authenticated user; email only |
| `GET`    | `/api/v1/users`     | `ADM` staff                        |
| `POST`   | `/api/v1/users`     | `ADM` staff                        |
| `GET`    | `/api/v1/users/:id` | The user themselves or `ADM` staff |
| `PATCH`  | `/api/v1/users/:id` | `ADM` staff                        |
| `DELETE` | `/api/v1/users/:id` | `ADM` staff                        |

`@CurrentUser()` exposes the database-backed authenticated identity to a
controller. `@SelfOrStaff()` with `SelfOrStaffGuard` prevents a customer from
reading another user's profile. Staff authorization is still enforced by the
global `@AuthRoles()` mechanism and the database-backed `AdminUser.role`.

The create endpoint requires an email and an identity subject. It creates a
non-password login record; Supabase Auth owns password authentication. The
generated `passwordHash` is intentionally unusable and must not be used for
password authentication.

### Environment variables

Configure Supabase Auth in `.env`:

```env
AUTH_PROVIDER=supabase
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
```

The full environment template is available at
[`.env.example`](../.env.example).

### Client request

Clients must send a valid Supabase Auth JWT:

```http
Authorization: Bearer <cognito-id-token>
```

Protected endpoints and logout use Supabase Auth access tokens.

## Public routes

Routes are protected by default. Use
[`@Public()`](../src/common/auth/decorators/public.decorator.ts) for health
checks, login-related endpoints, or other routes that must not require a
Keydrop account:

```ts
import { Public } from '../common/auth/decorators/public.decorator.js';

@Public()
@Get('health')
healthCheck() {
  return { status: 'ok' };
}
```

The root application endpoint is already public.

## Staff role authorization

Use
[`@AuthRoles()`](../src/common/auth/decorators/auth.decorator.ts) for routes
that require one or more staff roles:

```ts
import { AuthRoles } from '../common/auth/decorators/auth.decorator.js';

@AuthRoles('TS', 'ADM')
@Get()
listAbuseReports() {
  // Trust and Safety or Admin staff only
}
```

Examples:

```ts
@AuthRoles('ADM')
@Delete('users/:id')
deleteUser() {}

@AuthRoles('BIL', 'ADM')
@Post('refunds')
refundUser() {}

@AuthRoles('ENG', 'ADM')
@Post('kill-switches')
activateKillSwitch() {}

@AuthRoles('AUD', 'ADM')
@Get('audit-log')
getAuditLog() {}
```

The database-backed `AdminUser.role` is the authorization source. Do not trust
a role claim from the JWT as the source of staff permissions.

## Team authorization

`@AuthRoles()` is for global staff roles. It must not be used for team roles,
because team roles are scoped to a particular team.

Team endpoints must check:

1. The authenticated user ID.
2. The requested team ID.
3. The user's `TeamMember.role`.

Example:

```ts
const membership = await prisma.teamMember.findUnique({
  where: {
    teamId_userId: {
      teamId,
      userId: request.user.userId,
    },
  },
});

if (!membership) {
  throw new ForbiddenException('You are not a team member');
}
```

Recommended team permissions:

| Capability                         | Owner | Admin | Member |
| ---------------------------------- | ----: | ----: | -----: |
| Create and view own secrets        |   Yes |   Yes |    Yes |
| View team audit log                |   Yes |   Yes |     No |
| Invite and remove members          |   Yes |   Yes |     No |
| Change team policies and branding  |   Yes |   Yes |     No |
| Manage billing and plan            |   Yes |    No |     No |
| Transfer ownership and delete team |   Yes |    No |     No |

## Authenticated request user

The guard attaches the following shape to `request.user`:

```ts
{
  id: string;
  userId: string;
  sub: string;
  username: string;
  email?: string;
  phone_number?: string;
  name?: string;
  userType: 'USER' | 'ADMIN';
  role: string;
  plan: string;
  tokenPayload: TokenPayload;
}
```

For a normal customer:

```ts
request.user.userType === 'USER';
request.user.role === 'USER';
request.user.plan === 'free' || 'pro' || 'team';
```

For staff:

```ts
request.user.userType === 'ADMIN';
request.user.role === 'TS' || 'ADM' || 'AUD';
```

## Legacy identity-to-database mapping

The previous Cognito implementation mapped its token `sub` to the identity
subject stored on the application user:

```text
Legacy Cognito token sub -> User identity subject
```

The current Supabase Auth implementation uses `User.identitySubject`. The
request is rejected when no matching application profile exists.

For staff users, create the linked `AdminUser` record:

```ts
await prisma.user.update({
  where: { email: 'staff@example.com' },
  data: {
    identitySubject: '<supabase-auth-uuid>',
  },
});

await prisma.adminUser.create({
  data: {
    userId: '<keydrop-user-id>',
    role: 'TS',
    ssoSubject: '<supabase-auth-uuid>',
  },
});
```

The `AdminUser.ssoSubject` should match the identity subject for the linked
user.

## Existing-identity recovery

The dev Cognito pools and users were permanently deleted during AWS retirement.
No production pools were found in the inventory. No password hashes or user
records were migrated by this repository. Legacy `User.passwordHash` values
are placeholders and must never be imported as Supabase credentials.

Before changing `AUTH_PROVIDER` for existing users:

1. If an independent authorized export exists, securely map each legacy subject and normalized email to
   its existing `User.id`, email-verification status, and (for staff) linked
   `AdminUser` record/role. Do not include passwords, tokens, or secret data.
2. Resolve duplicate emails, deleted users, unverified addresses, and any
   missing staff profile manually before identity creation. Do not auto-link
   solely on an unverified email.
3. Create corresponding Supabase Auth users through a controlled
   administrative migration using unique, high-entropy temporary passwords
   that are never stored or disclosed. Preserve verification state only when
   supported by a trusted verification record. Require a Supabase
   recovery/password-reset flow before users can resume password login.
4. Link each new Supabase Auth UUID to the existing `User.id` using
   `User.identitySubject`, and update
   `AdminUser.ssoSubject` for staff. Preserve plans, teams, audit records,
   billing data, and roles. Verify uniqueness and counts before cutover.
5. Send recovery instructions through the configured provider, support
   password reset, and test customer and staff authorization before routing
   traffic. Do not assume Cognito is available as a rollback option.

The repository does not include a bulk legacy identity importer. Any
independent migration must be rehearsed and audited before production use.

## Previous project role mapping

The previous project used `USER`, `OWNER`, `ADMIN`, and `SUPER_ADMIN`. These
should not be copied as global roles into Keydrop:

| Previous role | Keydrop equivalent                                                              |
| ------------- | ------------------------------------------------------------------------------- |
| `USER`        | Registered user with a `free`, `pro`, or `team` plan                            |
| `OWNER`       | `TeamMember.role = owner`                                                       |
| `ADMIN`       | `TeamMember.role = admin`, or staff `AdminUser.role = ADM` depending on context |
| `SUPER_ADMIN` | Staff `AdminUser.role = ADM`                                                    |

In Keydrop, Supabase Auth authenticates the identity while PostgreSQL determines the
current customer plan, team role, and staff role.

## Security rules

- No staff role may read secret content.
- Every staff mutation must include a written reason.
- Do not authorize staff access from unverified JWT claims.
- Do not treat team roles as global roles.
- Do not expose `passwordHash`, API key hashes, or raw token payloads in API
  responses.
- Keep `.env` out of source control. Commit only `.env.example` with
  placeholders or non-sensitive configuration.
