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

## Cognito authentication flow

The global
[`CognitoAuthGuard`](../src/common/auth/guards/cognito-auth.guard.ts)
protects routes by default.

For each request, the guard:

1. Reads the `Authorization` header.
2. Requires the `Bearer <token>` format.
3. Validates the token against the configured customer or staff Cognito pool.
4. Reads the verified Cognito `sub`.
5. Looks up `User.cognitoSubject` in PostgreSQL.
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
[`EmailOtp`](../prisma/models/email-otp.prisma) model. The
[`EmailOtpService`](../src/common/auth/services/email-otp.service.ts):

- Normalizes email addresses before lookup.
- Generates a six-digit code using a cryptographically secure random source.
- Stores only a SHA-256 hash of the code.
- Expires codes after 10 minutes.
- Allows at most five failed attempts.
- Allows one unconsumed code request per email every 60 seconds.
- Marks a successful code as consumed so it cannot be reused.
- Sets `User.emailVerifiedAt` when the OTP is linked to a user.

The hourly
[`EmailOtpCleanupCronService`](../src/cron-jobs/services/email-otp-cleanup.cron.service.ts)
deletes expired and older-than-24-hour OTP records. Email delivery is kept
outside the persistence service: an approved email provider should receive the
code returned by `EmailOtpService.issue()` and send it to the user. Never
return that code directly from a public HTTP endpoint or log it.

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

The create endpoint requires an email and Cognito `sub`. It creates a
non-password login record because Cognito is the only supported authentication
provider. The generated `passwordHash` is intentionally unusable and must not
be used for password authentication.

### Environment variables

Configure the Cognito pools in `.env`:

```env
USER_COGNITO_USER_POOL_ID=
USER_COGNITO_CLIENT_ID=
ADMIN_COGNITO_USER_POOL_ID=
ADMIN_COGNITO_CLIENT_ID=
COGNITO_REGION=ap-south-1
```

The full environment template is available at
[`.env.example`](../.env.example).

### Client request

Clients must send a valid Cognito token:

```http
Authorization: Bearer <cognito-id-token>
```

Logout endpoints use an access token. Other protected endpoints use an ID
token.

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

## Cognito-to-database mapping

Every authenticated Cognito user must have its Cognito `sub` stored in
`User.cognitoSubject`:

```text
Cognito token sub -> User.cognitoSubject
```

If no matching user exists, the request is rejected even when the Cognito token
is valid.

For staff users, create the linked `AdminUser` record:

```ts
await prisma.user.update({
  where: { email: 'staff@example.com' },
  data: {
    cognitoSubject: '<cognito-sub>',
  },
});

await prisma.adminUser.create({
  data: {
    userId: '<keydrop-user-id>',
    role: 'TS',
    ssoSubject: '<cognito-sub>',
  },
});
```

The `AdminUser.ssoSubject` should match the Cognito subject for the linked
user.

## Previous project role mapping

The previous project used `USER`, `OWNER`, `ADMIN`, and `SUPER_ADMIN`. These
should not be copied as global roles into Keydrop:

| Previous role | Keydrop equivalent                                                              |
| ------------- | ------------------------------------------------------------------------------- |
| `USER`        | Registered user with a `free`, `pro`, or `team` plan                            |
| `OWNER`       | `TeamMember.role = owner`                                                       |
| `ADMIN`       | `TeamMember.role = admin`, or staff `AdminUser.role = ADM` depending on context |
| `SUPER_ADMIN` | Staff `AdminUser.role = ADM`                                                    |

In Keydrop, Cognito authenticates the identity while PostgreSQL determines the
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
