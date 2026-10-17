# Keydrop — Backend Specification

Source of truth · v1.0 draft · October 15, 2026 · Owner: Product and Engineering

## 1. Purpose and how to use this document

Keydrop is a one-time secret sharing service. A sender encrypts a password, API key or file in the browser, shares a link, and the secret self-destructs after a set number of views or a set time. The server never sees plaintext.

There are three source-of-truth documents:

- **Backend Specification (this document):** crypto protocol, status model, data model, API, business rules, limits. Authoritative for behaviour and data.
- **Frontend Specification:** screens, routes, components, copy, status-to-UI mapping, client crypto module.
- **Admin Dashboard Specification:** internal tooling for support, abuse and operations.

**Conflict rule:** the Backend wins on statuses, limits, API contracts and cryptography. The Frontend wins on layout and copy. Any change goes through a pull request that also updates the changelog at the end of the affected document.

**Screen IDs** match the design flow: A1 to A6 are anonymous sharing; B1 to B10 are account screens. Anonymous means no account; the recipient never needs an account.

### 1.1 Current implementation baseline

This document originally described a future DynamoDB-based architecture. The
current Keydrop API follows the implementation in this repository instead:

- PostgreSQL through Prisma is the authoritative datastore for users, secrets,
  files, requests, notifications, audit events, abuse reports, billing
  records, and email OTPs.
- Cognito is the identity provider for customer and staff authentication.
- S3 stores encrypted secret objects and file objects; the API stores only
  object references and encryption metadata.
- NestJS scheduled jobs perform expired-secret and email-OTP cleanup, create
  deduplicated expiring-secret notifications, and deliver opted-in notification
  emails through SES.
- SES also delivers team invitations and failed-payment notifications.
  Razorpay checkout, verified webhook processing, cycle-end plan changes,
  seven-day dunning, and provider reconciliation are implemented.
- DynamoDB, SQS, Slack OAuth, and the worker service are not implemented and
  must not be treated as available APIs or infrastructure.

Where older sections below mention DynamoDB, first-party password sessions,
Slack integrations, or SQS worker queues, those are planned work and not the
current runtime contract. New implementation work must update this section and
the relevant API/schema sections in the same change.

## 2. Principles

| ID  | Principle                   | Consequence                                                                                     |
| --- | --------------------------- | ----------------------------------------------------------------------------------------------- |
| P1  | Zero-knowledge              | Plaintext and the decryption key never reach servers, logs, analytics or backups.               |
| P2  | One-way lifecycle           | Statuses only move forward. A terminal secret can never be revived.                             |
| P3  | Reveal is explicit          | Only POST reveal consumes a view. GET requests never do, so link previews cannot burn a secret. |
| P4  | No enumeration              | Unknown, expired, viewed, revoked and locked links look identical to a recipient.               |
| P5  | Minimal data                | Ciphertext is deleted at the instant a secret becomes terminal.                                 |
| P6  | Metadata is sensitive       | Labels, recipient emails and IPs are protected and retention-limited.                           |
| P7  | Fail closed                 | On any doubt (clock skew, cache or database error), deny the reveal.                            |
| P8  | Audit everything privileged | User events and every admin action are logged.                                                  |

## 3. Architecture and stack

The platform is JavaScript and TypeScript end to end, runs entirely on AWS, and is defined with Terraform. Billing (Razorpay) is the one payment service outside AWS. These are decisions; changes need an entry in Section 16.

| Layer                  | Decision                                                       | Notes                                                                                                                                                                      |
| ---------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language               | TypeScript (strict) on Node.js 22 LTS                          | One language across web, api, worker and admin. Terraform itself is HCL.                                                                                                   |
| Monorepo               | pnpm workspaces and Turborepo                                  | Shared packages: `crypto`, `schemas` (zod), `ui`, `api-client`, `config`.                                                                                                  |
| Web and admin          | Next.js 15 (App Router), React 19                              | Run as containers on ECS Fargate.                                                                                                                                          |
| API                    | NestJS on the Fastify adapter                                  | REST, zod validated DTOs, generated OpenAPI, Passport for sessions and OAuth.                                                                                              |
| Relational data        | Amazon RDS for PostgreSQL 16, Multi-AZ in production           | Current source of truth for users, teams, secrets, files, billing, abuse, admin, audit, and OTP records. Prisma ORM for queries and migrations. Local: Postgres in Docker. |
| Secret hot path        | Amazon DynamoDB, on-demand                                     | Secrets, events, verification codes, rate-limit counters, sessions. Local: DynamoDB Local in Docker.                                                                       |
| Files                  | Amazon S3                                                      | Encrypted blobs only. Presigned URLs. SSE-KMS.                                                                                                                             |
| Queues and jobs        | Amazon SQS with dead-letter queues, plus EventBridge Scheduler | Replaces Redis and BullMQ. The worker is a NestJS app consuming SQS.                                                                                                       |
| Email                  | Amazon SES                                                     | DKIM, SPF and DMARC. Bounces and complaints flow through SNS to SQS.                                                                                                       |
| Edge                   | CloudFront, AWS WAF, Route 53, ACM                             | WAF managed rules and rate rules in front of the load balancer.                                                                                                            |
| Compute                | Amazon ECS on Fargate behind an Application Load Balancer      | Services: web, api, worker, admin. Autoscaling on CPU and request count.                                                                                                   |
| Secrets and keys       | AWS Secrets Manager and AWS KMS                                | Peppers, JWT keys, Razorpay keys. Customer-managed KMS keys.                                                                                                               |
| Observability          | CloudWatch (logs, metrics, alarms) and AWS X-Ray or ADOT       | Structured JSON logs without personal data.                                                                                                                                |
| Auth                   | Amazon Cognito pools for customers and staff                   | Customer plans, team roles, and staff roles are database-backed. Email OTP verification is tracked in PostgreSQL.                                                          |
| Billing                | Razorpay Subscriptions, Checkout and webhooks                  | See 3.5.                                                                                                                                                                   |
| Infrastructure as code | Terraform (HCL)                                                | Modules, environments and CI in 3.4.                                                                                                                                       |
| CI and CD              | GitHub Actions with OIDC into AWS                              | No long-lived AWS keys in CI.                                                                                                                                              |
| Region                 | ap-south-1 (Mumbai) for v1                                     | A second region comes later (D2).                                                                                                                                          |

**Deployables (ECS services):** `web` (Next.js: public site and recipient pages), `api` (NestJS REST API), `worker` (NestJS SQS consumers and scheduled tasks) and `admin` (separate app, domain and IAM role; see the Admin spec). Each has its own container image, task role and autoscaling policy.

Request path: Browser → CloudFront with WAF → Application Load Balancer → ECS services (web, api) → RDS PostgreSQL, DynamoDB and S3. The worker consumes SQS queues and talks to RDS, DynamoDB, SES, Razorpay and Slack. EventBridge Scheduler sends the periodic jobs in Section 12 to SQS.

### 3.1 Local development

- Docker Compose runs `postgres:16`, `amazon/dynamodb-local`, LocalStack (S3, SQS, SES) and Mailpit to read emails.
- The same code runs everywhere. An `AWS_ENDPOINT_URL` variable points the AWS SDK at local services; there are no per-environment code branches.
- Migrations run with prisma migrate dev locally and prisma migrate deploy as a release step in AWS. Seed scripts create sample users and secrets. One command (`pnpm dev`) starts everything.
- Razorpay runs in test mode. Webhooks are tested with a tunnel or with signed fixtures.

### 3.2 Data placement: PostgreSQL versus DynamoDB

Rule: data on the reveal hot path, or short-lived, goes to DynamoDB. Relational and reportable data goes to PostgreSQL.

| Data                                                        | Store                            | Why                                                                                                |
| ----------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------- |
| Secret metadata and ciphertext                              | DynamoDB                         | Single-item conditional writes give an atomic reveal without row locks; TTL is a deletion backstop |
| Secret events (timeline)                                    | DynamoDB                         | Append-only, read by secret or owner, TTL retention                                                |
| Email verification codes                                    | DynamoDB with TTL                | Short-lived                                                                                        |
| Rate-limit counters                                         | DynamoDB with TTL and atomic ADD | No Redis cluster to run                                                                            |
| Sessions                                                    | DynamoDB with TTL                | Read on every request                                                                              |
| Users, OAuth links, teams, members, invites, policies       | PostgreSQL                       | Relational integrity                                                                               |
| API keys, integrations, notification preferences            | PostgreSQL                       | Relational                                                                                         |
| Subscriptions, payments, webhook events, usage counters     | PostgreSQL                       | Transactions and reporting                                                                         |
| Abuse reports, blocklist, data requests, flags, plan limits | PostgreSQL                       | Admin workflows                                                                                    |
| Admin users, approvals, admin audit log                     | PostgreSQL                       | Append-only audit with a hash chain                                                                |

Cross-store references use ids only (`owner_id` in DynamoDB is `users.id`). There are no distributed transactions: entitlements are checked in PostgreSQL, then the secret is written to DynamoDB, then counters are updated through an idempotent SQS message (at-least-once, eventually consistent).

### 3.3 AWS accounts, network and security

- **Accounts:** separate AWS accounts for dev, staging and production, plus a tooling account for ECR and Terraform state, under AWS Organizations.
- **Network:** a VPC across two Availability Zones. Public subnets for the load balancer; private subnets for ECS and RDS. Gateway endpoints for S3 and DynamoDB, interface endpoints for SQS, Secrets Manager, KMS and CloudWatch Logs, and NAT for outbound calls to Razorpay, Slack and OAuth providers.
- **Encryption:** customer-managed KMS keys for RDS, DynamoDB, S3, SQS, Secrets Manager and logs. TLS everywhere.
- **IAM:** one task role per service with least privilege. The `admin` role reads DynamoDB metadata only: a `dynamodb:LeadingKeys` condition denies keys that start with `C#` (secret material).
- **Backups:** RDS automated backups with point-in-time recovery (7 days); DynamoDB point-in-time recovery on, 7 day window.
- **Cost control:** AWS Budgets and anomaly detection alerts; DynamoDB on-demand; small Fargate tasks that autoscale.

### 3.4 Terraform

- **Layout:** `infra/modules/` (network, ecs-service, rds, dynamodb, sqs, ses, s3, cloudfront-waf, kms, secrets, iam, observability, scheduler, dns) and `infra/envs/dev`, `staging`, `prod` that compose the modules with variables.
- **State:** S3 backend with locking, versioned and KMS encrypted, one state per environment and layer (network, data, compute, edge).
- **Versions:** Terraform and providers pinned; module versions pinned.
- **CI:** pull requests run `fmt`, `validate`, `tflint` and a security scan (Checkov or tfsec), then post the `plan`. Merge to main applies to dev automatically; staging and production need manual approval. Each environment has its own GitHub OIDC role.
- **Discipline:** nightly drift detection; no manual console changes in production; mandatory tags (`project`, `env`, `owner`).
- **Secrets:** Terraform creates Secrets Manager entries without values; values are set out of band so they never enter state.
- Terraform is HCL, the one non-JavaScript part of the stack (D12).

### 3.5 Billing with Razorpay

- **Product:** Razorpay Subscriptions with Standard Checkout and webhooks. Plans (Pro and Team, monthly and yearly) are created in Razorpay and mirrored in `plan_limits` with their plan ids. Team seats use the subscription quantity.
- **Currency:** Subscription plans and checkout currently support INR only. International-currency plans are not configured; see D13.
- **Flow:** `POST /billing/checkout` creates a subscription (status `created`) and returns its id. The browser opens Checkout. After payment the browser posts the signature to `POST /billing/verify`, but **the webhook is the source of truth** for any plan change.
- **Webhook:** `POST /webhooks/razorpay` verifies the `X-Razorpay-Signature` header against the raw body with the webhook secret, rejects the event when verification fails, stores the event id for idempotency, and handles `subscription.authenticated`, `subscription.activated`, `subscription.charged`, `subscription.pending`, `subscription.halted`, `subscription.updated`, `subscription.cancelled`, `subscription.completed` and `payment.failed`.
- **Status mapping:**

| Razorpay status                     | Product meaning                                                                   |
| ----------------------------------- | --------------------------------------------------------------------------------- |
| `created`, `authenticated`          | Checkout started; plan not yet active                                             |
| `active`                            | Plan active                                                                       |
| `pending`                           | A charge failed and is retrying: keep the plan and show the payment failed banner |
| `halted`                            | Retries exhausted: 7 day grace period, then downgrade to Free                     |
| `paused`                            | Plan paused; treated as inactive at the next renewal                              |
| `cancelled`, `completed`, `expired` | Plan ends at the end of the paid period                                           |

- **No hosted customer portal:** Razorpay does not provide one, so the app itself offers plan change, cancel, payment method update (through Checkout) and an invoice list in Settings. Razorpay restricts plan changes for some payment methods (for example UPI and eMandate subscriptions); when a change is not allowed, the flow cancels at the cycle end and starts a new subscription. Confirm the current rules in the Razorpay documentation during implementation.
- **India specifics:** GST invoicing needs accountant input. Store only Razorpay ids, never card data.
- **CSP:** the Razorpay Checkout script loads only on the pricing upgrade flow and `/app/billing`, never on `/s/*` or `/r/*`.

## 4. Cryptographic protocol

### 4.1 Primitives

- Encryption: AES-256-GCM, 96-bit random IV, WebCrypto API.
- Key derivation: HKDF-SHA-256.
- Passphrase hardening: Argon2id in the browser (WASM), m=64 MiB, t=3, p=1. Parameters are stored with each secret so they can be upgraded. There is no weaker fallback; if WASM fails the UI shows an error.
- Randomness: `crypto.getRandomValues` only.

### 4.2 Create (in the browser)

1. Generate the link key `Kl` (32 random bytes).
2. Without a passphrase: `Kc = HKDF(Kl, info = keydrop/v1/content)`.
3. With a passphrase: generate `salt` (16 bytes), `Kp = Argon2id(passphrase, salt)`, `auth = HKDF(Kp, info = keydrop/v1/auth)`, `Kc = HKDF(Kl || Kp, info = keydrop/v1/content)`.
4. Pad the plaintext up to the next size bucket (256 B, 1 KB, 4 KB, 16 KB, 64 KB, 256 KB) to hide its length.
5. Encrypt with AES-GCM using associated data `keydrop/v1`.
6. Send ciphertext, IV, KDF parameters, `auth` (if any) and settings to `POST /secrets`.
7. The server returns the public `id`. The browser builds the link: `https://{domain}/s/{id}#{base64url(Kl)}`.

### 4.3 Link rules

- `id` is 22 base62 characters from a CSPRNG (128 bits). IDs are never sequential.
- The key lives only in the URL fragment, which browsers never send to servers.
- The reveal page reads the fragment, then removes it with `history.replaceState`.
- Pages under `/s/*` set `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, `X-Robots-Tag: noindex` and load no third-party scripts.

### 4.4 Reveal

1. `GET /s/{id}` serves the shell. Nothing is consumed.
2. The page calls `GET /secrets/{id}/meta` to learn what is required (passphrase, email verification) and shows A3, A4 or the email-code screen.
3. The recipient clicks Reveal. The browser sends `POST /secrets/{id}/reveal` with `auth` (if passphrase protected) and `access_token` (if email locked).
4. The server runs the atomic reveal in Section 5.5 and returns ciphertext, IV and KDF parameters, or an error.
5. The browser derives `Kc` and decrypts. Plaintext exists only in memory and in the DOM. Copy and Hide are client features; the clipboard is cleared after 60 seconds on a best-effort basis.

### 4.5 Passphrase verification

The server stores `auth_hash = HMAC-SHA-256(server_pepper, auth)` and never sees the passphrase or `Kp`. Failed attempts are counted on the secret. The third failure sets status `locked` and deletes the ciphertext. Even a full database leak gives an attacker no ciphertext key (`Kl` is missing) and no way to test passphrases offline against anything useful.

### 4.6 Recipient email lock (Pro)

This is access control, not cryptography. The sender enters the recipient email. On reveal the server emails a 6-digit code (10 minute expiry, 5 attempts, stored hashed). After verification it issues an `access_token` (JWT, 5 minutes, bound to the secret id) that reveal requires. The link fragment is still needed to decrypt.

### 4.7 Files (Pro and Team)

Files are split into 1 MiB chunks. Each chunk is encrypted with AES-GCM using a per-chunk IV derived from a counter, then uploaded to a presigned URL. A small manifest (chunk count, size, encrypted filename) is encrypted into the secret's ciphertext. The server cannot scan encrypted files, so file sharing is limited to paid plans.

### 4.8 Request a secret (Phase 3, constraints only)

The requester's browser generates an ECDH P-256 key pair and stores the public key on the request. The responder encrypts to that public key. Open design point: where the requester's private key is kept (browser storage with export, or wrapped by an account vault key). It must satisfy P1 and is tracked as D6.

### 4.9 What the server stores and never sees

| Server stores                                      | Server never sees                     |
| -------------------------------------------------- | ------------------------------------- |
| Ciphertext, IV, KDF parameters, salt               | Plaintext secret                      |
| Passphrase verifier (HMAC of `auth`)               | Passphrase, `Kp`, `Kl`, `Kc`          |
| Settings, status, counters, timestamps             | URL fragment                          |
| Owner id, optional label, optional recipient email | File contents                         |
| Coarse region and HMAC of IP                       | Raw IP after the log retention window |

### 4.10 Threat model

| Threat                            | Mitigation                                                                                     | Residual risk                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Database leak                     | No key material stored; verifier is HMAC with pepper                                           | Metadata exposure, covered by P6                                                        |
| Malicious or compromised web code | Strict CSP, SRI, no third-party scripts on `/s/*`, open-sourced crypto module, signed releases | A compromised deploy could exfiltrate keys. CLI and extension (later) do crypto locally |
| Leaked link                       | One view, short expiry, passphrase through a second channel, email lock                        | A link leaked before the recipient opens it wins the race                               |
| Link preview bots                 | Reveal is a POST after a click                                                                 | None for scanners that do not execute JavaScript                                        |
| ID guessing                       | 128-bit ids, uniform 410 responses, rate limits                                                | Negligible                                                                              |
| Double reveal races               | Atomic SQL with row lock                                                                       | None                                                                                    |
| Shoulder surfing, clipboard       | Hide toggle, 60 second clipboard clear                                                         | Best effort only                                                                        |

## 5. Status model

### 5.1 Stored secret statuses

| Status             | Meaning                                    | Terminal | Ciphertext kept | Set by                |
| ------------------ | ------------------------------------------ | -------- | --------------- | --------------------- |
| `active`           | Created, no reveal yet, within limits      | No       | Yes             | Create                |
| `partially_viewed` | Multi-view secret with views remaining     | No       | Yes             | Reveal                |
| `viewed`           | View limit reached                         | Yes      | No              | Reveal                |
| `expired`          | Time ran out                               | Yes      | No              | Sweeper or lazy check |
| `revoked`          | Cancelled by owner, admin or abuse process | Yes      | No              | Owner, admin          |
| `locked`           | Too many failed passphrase attempts        | Yes      | No              | Reveal                |

### 5.2 Derived display statuses

`awaiting_verification` is computed, not stored: status is `active`, a recipient email is set, and no verification has succeeded yet. The dashboard and detail screens show it as a badge. No other derived statuses exist; `expiring soon` is a UI hint only.

### 5.3 Allowed transitions

| From                         | To                 | Trigger                                           |
| ---------------------------- | ------------------ | ------------------------------------------------- |
| `active`                     | `partially_viewed` | Reveal, `views_used < max_views`, `max_views > 1` |
| `active`                     | `viewed`           | Reveal reaches `max_views`                        |
| `partially_viewed`           | `viewed`           | Reveal reaches `max_views`                        |
| `active`, `partially_viewed` | `expired`          | `expires_at` passed                               |
| `active`, `partially_viewed` | `revoked`          | Owner, admin or abuse action                      |
| `active`, `partially_viewed` | `locked`           | Third failed passphrase                           |

Any other transition is rejected with `409 invalid_transition` and logged.

### 5.4 Terminal cleanup

In the same atomic write as the terminal transition: delete the secret-material item (`C#{id}`), set `status`, `terminal_at` and `purge_at` on the metadata item, remove its sweep keys, and enqueue deletion of any file objects.

### 5.5 Atomic reveal

A secret is two DynamoDB items: a metadata item (`S#{id}`) and a secret-material item (`C#{id}`) that holds ciphertext, IV, KDF parameters and the passphrase verifier. Reveal uses optimistic concurrency with a version counter:

1. Read the metadata item with a strongly consistent `GetItem`. Reject unless status is `active` or `partially_viewed` and `expires_at` is in the future.
2. Check the passphrase verifier or the email access token.
3. Read the material item with a strongly consistent `GetItem`.
4. Compute `views_used + 1` and the new status: `viewed` when it reaches `max_views`, otherwise `partially_viewed`.
5. Run one `TransactWriteItems`: update the metadata item (new counters and status, `version` + 1, and on the last view remove the sweep keys and set `terminal_at` and `purge_at`) with the condition below. On the last view the same transaction also deletes the material item.
6. If the transaction is cancelled because the condition failed, repeat from step 1 up to three times.
7. Only after the transaction commits, return the material read in step 3 to the browser.

```typescript
// Condition on the metadata update
ConditionExpression: '#version = :seen AND #status IN (:active, :partial) AND expires_at > :now';
```

If the retries end without a commit, the secret counts as unavailable and the API answers `410 secret_unavailable`. Passphrase and access-token checks run before step 5. Failed passphrase attempts use an atomic `ADD failed_attempts :1` with a condition; the third failure runs the same terminal transaction with status `locked`. When many requests race for a one-view secret, exactly one transaction can succeed because they all condition on the same `version`.

### 5.6 Recipient response matrix

| Situation                                                  | HTTP                                           | Code                                           | Screen             |
| ---------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------- | ------------------ |
| Ready, no protection                                       | 200 on meta                                    | n/a                                            | A3 Ready to reveal |
| Passphrase required                                        | 200 on meta with `requires_passphrase`         | n/a                                            | A4 Passphrase      |
| Wrong passphrase                                           | 401                                            | `passphrase_invalid`, includes `attempts_left` | A4 error           |
| Third wrong passphrase                                     | 423 (this request only)                        | `secret_locked`                                | A4 locked          |
| Email code required                                        | 200 on meta with `requires_email_verification` | n/a                                            | Email verification |
| Wrong or expired code                                      | 401                                            | `code_invalid`                                 | Verification error |
| Revealed                                                   | 200                                            | n/a                                            | A5 Revealed        |
| Unknown, expired, viewed, revoked, locked (later requests) | 410                                            | `secret_unavailable`                           | A6 Gone            |
| Malformed id                                               | 404                                            | `not_found`                                    | Link not found     |
| Rate limited                                               | 429 with `Retry-After`                         | `rate_limited`                                 | Rate limited       |

### 5.7 Other entity statuses

| Entity       | Statuses                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| Request (B6) | `pending`, `fulfilled`, `expired`, `cancelled`                                                             |
| User         | `active`, `suspended`, `deletion_pending`                                                                  |
| Subscription | `created, authenticated, active, pending, halted, paused, cancelled, completed, expired (Razorpay values)` |
| Team invite  | `pending`, `accepted`, `revoked`, `expired`                                                                |
| File upload  | `pending`, `stored`, `deleted`                                                                             |
| Abuse report | `open`, `actioned`, `dismissed`                                                                            |

### 5.8 Event types

Events are append-only rows in `secret_events`: `created`, `meta_viewed`, `email_code_sent`, `email_verified`, `email_code_failed`, `revealed`, `passphrase_failed`, `locked`, `expired`, `revoked`, `reported`, `notification_sent`. `meta_viewed` is deduplicated per 10 minutes and tagged `likely_bot` from user-agent heuristics, which feeds the timeline entry Link opened, not revealed.

## 6. Data model

Conventions: internal ids are UUIDv7; the public secret id is the 22-character base62 string; timestamps are ISO 8601 UTC strings in DynamoDB and `timestamptz` in PostgreSQL; only users are soft-deleted. Section 3.2 explains which store holds what.

### 6.1 DynamoDB (production) and DynamoDB Local (development)

On-demand capacity, KMS encryption and point-in-time recovery on every table.

| Table                   | Keys                                                                        | Main attributes                                                                                                                                                                                                                                                                                                                                          |
| ----------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `keydrop-secrets`       | Metadata item: PK `S#{id}`, SK `META`. Material item: PK `C#{id}`, SK `MAT` | Metadata: owner\_id, team\_id, status, label, max\_views, views\_used, failed\_attempts, recipient\_email, notify flags, expires\_at, created\_at, last\_viewed\_at, terminal\_at, purge\_at (TTL), version, sweep\_pk and sweep\_sk (only while non-terminal). Material: ciphertext, iv, kdf, auth\_hash, ttl (set to expires\_at, a deletion backstop) |
| `keydrop-events`        | PK `secret_id`, SK `ts#{ulid}`                                              | type, actor, region, device, ip\_hmac, likely\_bot, owner\_id, purge\_at (TTL)                                                                                                                                                                                                                                                                           |
| `keydrop-verifications` | PK `secret_id`                                                              | email, code\_hash, attempts, verified\_at, ttl                                                                                                                                                                                                                                                                                                           |
| `keydrop-ratelimit`     | PK `{rule}#{key}#{window}`                                                  | count (atomic ADD), ttl                                                                                                                                                                                                                                                                                                                                  |
| `keydrop-sessions`      | PK `token_hash`                                                             | user\_id, ip\_hmac, user\_agent, created\_at, ttl                                                                                                                                                                                                                                                                                                        |

Global secondary indexes:

| Index                                             | Keys                                       | Used for                                            |
| ------------------------------------------------- | ------------------------------------------ | --------------------------------------------------- |
| `owner-created` (on secrets, metadata items only) | PK `owner_id`, SK `created_at`             | Dashboard list and stats (B3)                       |
| `owner-status` (on secrets)                       | PK `owner_id#status`, SK `created_at`      | Status filter                                       |
| `sweep` (on secrets, sparse)                      | PK `sweep_pk` (16 shards), SK `expires_at` | Expiry sweeper; items leave the index when terminal |
| `owner-time` (on events)                          | PK `owner_id`, SK `ts`                     | Account audit log (B7)                              |

Rules: dashboard queries read metadata items only, never material items. Label search runs as a filter over the owner's items, bounded by the plan's history limit. DynamoDB TTL deletes lazily (up to about 48 hours), so it is only a backstop; correctness comes from the conditions in Section 5.5 and from the sweeper.

### 6.2 PostgreSQL (RDS)

| Table                | Key columns                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`              | id, email (unique, citext), password\_hash, email\_verified\_at, status, plan, totp\_secret\_enc, created\_at                                                                         |
| `oauth_accounts`     | user\_id, provider, provider\_user\_id                                                                                                                                                |
| `teams`              | id, name, owner\_id, custom\_domain, branding (json)                                                                                                                                  |
| `team_members`       | team\_id, user\_id, role (owner, admin, member)                                                                                                                                       |
| `team_invites`       | id, team\_id, email, role, status, expires\_at                                                                                                                                        |
| `team_policies`      | team\_id, max\_expiry\_hours, require\_passphrase, blocked\_domains                                                                                                                   |
| `api_keys`           | id, user\_id, name, key\_hash, last\_used\_at, revoked\_at                                                                                                                            |
| `integrations`       | user\_id or team\_id, kind (slack), token\_enc, channel                                                                                                                               |
| `notification_prefs` | user\_id, trigger, email, slack, in\_app                                                                                                                                              |
| `subscriptions`      | id, owner (user or team), razorpay\_customer\_id, razorpay\_subscription\_id, razorpay\_plan\_id, plan, status, quantity, current\_period\_end, cancel\_at\_period\_end, grace\_until |
| `payments`           | id, subscription\_id, razorpay\_payment\_id, razorpay\_invoice\_id, amount, currency, status, created\_at                                                                             |
| `webhook_events`     | event\_id (unique), provider, type, received\_at, processed\_at                                                                                                                       |
| `usage_counters`     | owner\_id, period, secrets\_created, files\_bytes                                                                                                                                     |
| `requests`           | id (public), owner\_id, title, instructions, public\_key, status, expires\_at, fulfilled\_secret\_id                                                                                  |
| `secret_files`       | id, secret\_id, object\_key, size\_bytes, status                                                                                                                                      |
| `abuse_reports`      | id, secret\_id, reason, reporter\_ip\_hmac, status, actioned\_by                                                                                                                      |
| `admin_audit_log`    | id, admin\_id, action, target\_type, target\_id, reason, created\_at (append-only)                                                                                                    |

PostgreSQL indexes: `users (email)` unique, `team_members (user_id)`, `subscriptions (owner)`, `webhook_events (event_id)` unique, `abuse_reports (status, created_at)`.

## 7. API

### 7.1 Conventions

- Base path `/api/v1`, JSON bodies, ISO 8601 timestamps, cursor pagination (`limit`, `cursor`).
- Web uses an HttpOnly, Secure, SameSite=Lax session cookie with double-submit CSRF. API clients use `Authorization: Bearer {api_key}` (Pro and Team).
- `POST /secrets` accepts an `Idempotency-Key` header.
- Errors use `application/problem+json` with a stable `code`.
- Secret endpoints never log request or response bodies.

### 7.2 Endpoints

**Public (recipient and anonymous creator)**

| Method and path                   | Auth     | Purpose                                                   |
| --------------------------------- | -------- | --------------------------------------------------------- |
| POST `/secrets`                   | Optional | Create a secret (anonymous or account)                    |
| GET `/secrets/{id}/meta`          | None     | What the recipient must provide. Never returns ciphertext |
| POST `/secrets/{id}/email-code`   | None     | Send the recipient a verification code                    |
| POST `/secrets/{id}/email-verify` | None     | Exchange code for `access_token`                          |
| POST `/secrets/{id}/reveal`       | None     | Atomic reveal, returns ciphertext                         |
| POST `/secrets/{id}/report`       | None     | Report abuse                                              |
| GET `/requests/{id}/meta`         | None     | Request instructions and public key                       |
| POST `/requests/{id}/respond`     | None     | Submit an encrypted answer                                |

**Authentication**

`POST /auth/signup`, `/auth/login`, `/auth/logout`, `/auth/forgot`, `/auth/reset`, `/auth/verify-email`, `/auth/resend-verification`, `/auth/oauth/{provider}/start`, `/auth/oauth/{provider}/callback`, `/auth/2fa/enable`, `/auth/2fa/verify`.

**Account**

| Method and path                                                                              | Plan                     | Purpose                                       |
| -------------------------------------------------------------------------------------------- | ------------------------ | --------------------------------------------- |
| GET `/me`, PATCH `/me`                                                                       | Free                     | Profile                                       |
| GET `/me/entitlements`                                                                       | Free                     | Limits and features the UI must obey          |
| GET `/me/stats`                                                                              | Free                     | Dashboard stat cards                          |
| GET `/me/secrets`                                                                            | Free                     | List with filters: status, search, date range |
| GET `/me/secrets/{id}`                                                                       | Free                     | Detail                                        |
| GET `/me/secrets/{id}/events`                                                                | Free (basic), Pro (full) | Activity timeline                             |
| POST `/me/secrets/{id}/revoke`                                                               | Free                     | Revoke before use                             |
| DELETE `/me/secrets/{id}`                                                                    | Free                     | Remove a terminal secret's metadata           |
| POST `/uploads`, POST `/uploads/{id}/complete`                                               | Pro                      | Presigned file upload                         |
| POST `/me/requests`, GET `/me/requests`, POST `/me/requests/{id}/cancel`                     | Pro                      | Request a secret                              |
| GET `/me/audit`, GET `/me/audit/export`                                                      | Pro (export Pro)         | Account-wide event log                        |
| GET and POST `/me/api-keys`, DELETE `/me/api-keys/{id}`                                      | Pro                      | Key is shown once                             |
| GET and PATCH `/me/notifications`                                                            | Free                     | Preferences                                   |
| POST `/me/integrations/slack/connect`, DELETE `.../slack`                                    | Pro                      | Slack                                         |
| GET and POST `/teams`, members, invites, policies, branding, domain                          | Team                     | Workspace management                          |
| GET `/billing`, POST `/billing/checkout`, POST `/billing/verify, POST /billing/subscription` | Free                     | Plan management                               |
| POST `/webhooks/razorpay`                                                                    | Signature                | Billing events                                |
| GET `/health`, GET `/status`                                                                 | None                     | Probes and public status                      |

### 7.2.1 Implemented Prisma API

The following routes are currently implemented against Prisma/PostgreSQL:

| Method  | Path                         | Access                 | Behavior                                                                        |
| ------- | ---------------------------- | ---------------------- | ------------------------------------------------------------------------------- |
| `POST`  | `/api/v1/secrets`            | Authenticated customer | Stores encrypted payload references and metadata; writes `secret_created`       |
| `GET`   | `/api/v1/secrets/:id/meta`   | Public                 | Returns non-secret metadata and passphrase requirement; does not consume a view |
| `POST`  | `/api/v1/secrets/:id/reveal` | Public                 | Verifies the optional auth hash and atomically increments `viewsUsed`           |
| `POST`  | `/api/v1/secrets/:id/revoke` | Secret owner           | Revokes an active secret and writes `secret_revoked`                            |
| `POST`  | `/api/v1/secrets/:id/report` | Public                 | Creates an abuse report and writes `abuse_reported`                             |
| `GET`   | `/api/v1/users/me`           | Authenticated user     | Returns the current database-backed user                                        |
| `PATCH` | `/api/v1/users/me`           | Authenticated user     | Updates the account email                                                       |

Secret creation supports both account-owned and anonymous secrets.
Recipient-email access tokens, rate limiting, and S3 presigned file transfers
are implemented. Full terminal purge retention remains follow-up work.
Passphrase checks use the stored `Secret.authHash`; plaintext passphrases are
never persisted.

Account dashboard routes currently implemented:

| Method         | Path                                  | Access                                                                     |
| -------------- | ------------------------------------- | -------------------------------------------------------------------------- |
| `GET`          | `/api/v1/me/entitlements`             | Authenticated user                                                         |
| `GET`          | `/api/v1/me/stats`                    | Authenticated user                                                         |
| `GET`          | `/api/v1/me/secrets`                  | Authenticated user; own records only; cursor-paginated                     |
| `GET`          | `/api/v1/me/secrets/:id`              | Authenticated owner only                                                   |
| `GET`          | `/api/v1/me/secrets/:id/events`       | Authenticated owner only; retention-aware and cursor-paginated             |
| `DELETE`       | `/api/v1/me/secrets/:id`              | Authenticated owner; terminal records only                                 |
| `GET`          | `/api/v1/me/audit`                    | Pro or Team plan; retention-aware and cursor-paginated                     |
| `POST`         | `/api/v1/me/api-keys`                 | Pro or Team plan; scoped key plaintext shown once                          |
| `GET`          | `/api/v1/me/api-keys`                 | Pro or Team plan; metadata only                                            |
| `DELETE`       | `/api/v1/me/api-keys/:id`             | Pro or Team plan; owner only                                               |
| `GET`          | `/api/v1/me/notifications`            | Authenticated user; preference-filtered and cursor-paginated               |
| `PATCH`        | `/api/v1/me/notifications/:id/read`   | Authenticated owner                                                        |
| `POST`         | `/api/v1/me/notifications/read-all`   | Authenticated user                                                         |
| `GET`, `PATCH` | `/api/v1/me/notification-preferences` | Authenticated user                                                         |
| `GET`          | `/api/v1/me/export`                   | Authenticated user; JSON with 15-minute URLs for active encrypted objects  |
| `DELETE`       | `/api/v1/me/account`                  | Authenticated Cognito user; cancels subscriptions and deletes account data |

API keys are generated with cryptographically secure random bytes and only a
SHA-256 digest is persisted. The plaintext key is returned once from the
creation response and cannot be recovered later. Keys default to `secrets:read`;
explicit `secrets`, `account`, `billing`, and `teams` read/write scopes are
enforced per route. Successful API-key requests update `lastUsedAt`.

Account deletion removes the Cognito identity, secrets, keys, notifications,
and other account-owned data, and queues encrypted-object deletion through the
storage retry mechanism. Active subscriptions are canceled first. Billing
records remain associated with an anonymized database tombstone for referential
and financial history. Team ownership is transferred to an existing member;
empty teams are deleted.

In-app preferences filter notification listings, and opted-in notification
emails are delivered through SES. Expiring-secret notifications are generated
every 10 minutes; email delivery runs every 5 minutes with exponential retry
backoff and stops after five failed attempts.

Current team routes:

| Method   | Path                                  | Access                        |
| -------- | ------------------------------------- | ----------------------------- |
| `POST`   | `/api/v1/teams`                       | Team-plan user                |
| `GET`    | `/api/v1/teams`                       | Team member; cursor-paginated |
| `GET`    | `/api/v1/teams/:id`                   | Team member                   |
| `PATCH`  | `/api/v1/teams/:id`                   | Owner or Admin                |
| `PATCH`  | `/api/v1/teams/:id/members/:memberId` | Owner or Admin                |
| `DELETE` | `/api/v1/teams/:id/members/:memberId` | Owner or Admin                |

Team invitations are now persisted in `TeamInvitation`, with SHA-256 token
hashes, seven-day expiry, single-use acceptance, revocation, and email delivery
through AWS SES. The invitation token is never stored or returned by the API.

Invitation routes:

| Method   | Path                                          | Access                     |
| -------- | --------------------------------------------- | -------------------------- |
| `POST`   | `/api/v1/teams/:id/invitations`               | Owner or Admin             |
| `GET`    | `/api/v1/teams/:id/invitations`               | Owner or Admin             |
| `DELETE` | `/api/v1/teams/:id/invitations/:invitationId` | Owner or Admin             |
| `POST`   | `/api/v1/teams/invitations/accept`            | Authenticated invited user |
| `GET`    | `/api/v1/teams/:id/policies`                  | Team member                |
| `PATCH`  | `/api/v1/teams/:id/policies/:policyType`      | Owner or Admin             |

Invitation delivery requires `SES_REGION`, `SES_FROM_EMAIL`, and
`FRONTEND_URL`; AWS credentials are resolved through the standard AWS SDK
credential chain.

Secret request and file routes:

| Method | Path                                         | Access                                                    |
| ------ | -------------------------------------------- | --------------------------------------------------------- |
| `POST` | `/api/v1/secrets/:id/requests`               | Public requester; email required                          |
| `GET`  | `/api/v1/secrets/:id/requests`               | Secret owner                                              |
| `POST` | `/api/v1/secrets/:id/requests/:requestId`    | Secret owner; approve or deny                             |
| `POST` | `/api/v1/secrets/:id/files`                  | Secret owner; creates S3 upload URL                       |
| `POST` | `/api/v1/secrets/:id/files/:fileId/complete` | Secret owner; verifies object size and content type in S3 |
| `GET`  | `/api/v1/secrets/:id/files/:fileId/download` | Secret owner; returns a 15-minute presigned GET URL       |

File uploads require `S3_REGION` and `S3_BUCKET`. The API creates a metadata
record and a 15-minute presigned PUT URL; the client uploads directly to the
private bucket. Upload size is capped at 256 MB per file. Clients must call
the completion route after upload; download URLs are not issued until S3
confirms the declared size and content type.

Invoice listing at `/api/v1/me/billing/invoices` is cursor-paginated. Paginated
list responses use `{ "items": [...], "nextCursor": "..." }`; pass `nextCursor`
as the next request's `cursor` parameter. The default page size is 50 and the
maximum is 100.

Billing routes currently backed by PostgreSQL:

| Method   | Path                                               | Access                                     |
| -------- | -------------------------------------------------- | ------------------------------------------ |
| `GET`    | `/api/v1/me/billing`                               | Authenticated user                         |
| `GET`    | `/api/v1/me/billing/subscriptions`                 | Authenticated user                         |
| `GET`    | `/api/v1/me/billing/invoices`                      | Authenticated user                         |
| `GET`    | `/api/v1/me/billing/refunds`                       | Authenticated user; cursor-paginated       |
| `DELETE` | `/api/v1/me/billing/subscriptions/:id`             | Subscription owner                         |
| `POST`   | `/api/v1/me/billing/subscriptions/:id/change-plan` | Subscription owner; effective at cycle end |
| `POST`   | `/api/v1/me/billing/checkout`                      | Authenticated user                         |
| `POST`   | `/api/v1/me/billing/verify`                        | Authenticated subscription owner           |
| `POST`   | `/api/v1/webhooks/razorpay`                        | Razorpay signature                         |
| `POST`   | `/api/v1/admin/billing/refunds`                    | BIL or ADM staff role; written reason      |

Subscription cancellation changes the local subscription status to `canceled`.
Razorpay is the configured payment provider. Checkout and browser signature
verification are available, but the browser response never changes a plan.
Only a verified `POST /api/v1/webhooks/razorpay` event can synchronize the
subscription and user plan. Webhook event ids are persisted for idempotency.
Configure `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`,
`RAZORPAY_WEBHOOK_SECRET`, and the four INR plan IDs in `.env`.

Suggested INR launch pricing to validate with customer interviews: Pro at
₹299/month or ₹2,990/year and Team at ₹999/month or ₹9,990/year. These are
recommendations, not values enforced by the API: Razorpay plans are immutable,
so settle prices and applicable taxes before creating them. Annual prices are
roughly two months free compared with monthly billing (about a 17 percent
discount). The suggested Team price is a flat workspace price; per-seat billing
and seat limits are not currently enforced, so do not advertise it as a
per-user rate. Review after the first 30-50 paying customers and confirm GST
and Razorpay fees with an accountant.

Refunds call Razorpay directly and require the BIL or ADM staff role. The
payment id, optional amount (smallest currency unit), and written reason are
validated; the refund result is audited as `billing_refunded`. Signed invoice
and payment events update local invoices; signed refund events synchronize
refund state and the customer refund listing.

Razorpay should deliver `subscription.activated`, `subscription.charged`,
`subscription.halted`, `subscription.cancelled`, `subscription.completed`,
`subscription.expired`, all `invoice.*` events, `payment.failed`,
`payment.captured`, `payment.authorized`, and all `refund.*` events to
`https://<api-domain>/api/v1/webhooks/razorpay`. Use the
exact webhook secret configured as `RAZORPAY_WEBHOOK_SECRET`. Terraform emits
the endpoint as `razorpay_webhook_url` when `api_domain_name` and an issued ACM
certificate are configured; DNS for the API host must point to the ALB.

Razorpay manages payment retries. The first failed subscription payment starts
a seven-day grace period; a successful charge clears it. If still past due
after seven days, the API cancels the provider subscription, downgrades the
user to the highest remaining active plan or Free, and revokes all active API
keys when the effective plan becomes Free. Provider state and invoices are
reconciled every six hours. Plan changes use Razorpay's `cycle_end` scheduling
and only become the local entitlement after a charge confirms the new plan.

### 7.3 Create secret: request fields

`ciphertext`, `iv`, `kdf` (algorithm, salt, parameters), `auth` (only with passphrase), `expires_in` (seconds, validated against plan), `max_views`, `label` (account only), `recipient_email` (Pro), `notify_email`, `notify_slack` (Pro), `file_ids` (Pro). The response returns `id`, `expires_at`, `max_views` and the dashboard status. The server never returns the link, because it does not know the key.

### 7.4 Error codes

| Code                 | HTTP | Meaning                                               | UI                     |
| -------------------- | ---- | ----------------------------------------------------- | ---------------------- |
| `validation_failed`  | 422  | Field errors listed under `errors`                    | Inline field error     |
| `unauthenticated`    | 401  | No or expired session                                 | Session expired screen |
| `forbidden`          | 403  | Not allowed                                           | Inline message         |
| `plan_required`      | 402  | Feature needs a higher plan; includes `required_plan` | Upgrade dialog         |
| `limit_reached`      | 402  | Plan quota hit                                        | Limit banner           |
| `not_found`          | 404  | Malformed id or unknown account resource              | 404 page               |
| `secret_unavailable` | 410  | Gone, for any reason                                  | A6                     |
| `passphrase_invalid` | 401  | Includes `attempts_left`                              | A4 error               |
| `secret_locked`      | 423  | Final failed attempt                                  | A4 locked              |
| `code_invalid`       | 401  | Email code wrong or expired                           | Verification error     |
| `invalid_transition` | 409  | Status change not allowed                             | Inline message         |
| `rate_limited`       | 429  | Includes `Retry-After`                                | Rate limited screen    |
| `payment_failed`     | 402  | Card declined                                         | Billing banner         |
| `server_error`       | 500  | Unexpected                                            | Retry state            |

## 8. Plans and entitlements

Entitlements are enforced on the server and returned by `GET /me/entitlements`. The UI only reflects them. Prices are configuration, not code (set per currency in the Razorpay plan catalogue).

| Capability                       | Anonymous                | Free account    | Pro                   | Team                 |
| -------------------------------- | ------------------------ | --------------- | --------------------- | -------------------- |
| Max text size                    | 16 KB                    | 64 KB           | 256 KB                | 256 KB               |
| Expiry options                   | 1 hour, 24 hours, 7 days | Up to 7 days    | Up to 30 days, custom | Up to policy maximum |
| Max views                        | 1, 3, 5                  | 1 to 10         | 1 to 100              | 1 to 100             |
| Passphrase                       | No                       | Yes             | Yes                   | Yes                  |
| Email when opened                | No                       | Yes             | Yes                   | Yes                  |
| Recipient email lock             | No                       | No              | Yes                   | Yes                  |
| Slack notifications              | No                       | No              | Yes                   | Yes                  |
| File sharing                     | No                       | No              | 25 MB                 | 100 MB               |
| Dashboard history                | None                     | 30 days         | 1 year                | 2 years              |
| Activity detail                  | None                     | Timestamps only | Full (region, device) | Full                 |
| Audit log and export             | No                       | No              | Yes                   | Yes, shared          |
| API and CLI                      | No                       | No              | Yes                   | Yes                  |
| Active secrets cap               | n/a                      | 25              | Unlimited             | Unlimited            |
| Teams, roles, policies, branding | No                       | No              | No                    | Yes                  |

Policy resolution: the strictest of plan limit and team policy applies. Downgrades never delete existing secrets; they only restrict new ones.

## 9. Rate limiting and abuse

| Action                   | Key                  | Limit                                      | On exceed                      |
| ------------------------ | -------------------- | ------------------------------------------ | ------------------------------ |
| Create (anonymous)       | IP                   | 10 per hour                                | 429, CAPTCHA challenge after 5 |
| Create (Free, Pro, Team) | Account              | 60, 600, 3000 per hour                     | 429                            |
| Meta and reveal          | IP and secret id     | 30 per minute per IP, 10 per minute per id | 429                            |
| Passphrase attempts      | Secret               | 3 total                                    | Status `locked`                |
| Email code send          | Secret and recipient | 3 per hour                                 | 429                            |
| Email code verify        | Secret               | 5 per 15 minutes                           | 429                            |
| Login                    | IP and email         | 10 per 15 minutes                          | 429, then CAPTCHA              |
| Signup                   | IP                   | 5 per hour                                 | 429                            |
| Report                   | IP                   | 10 per day                                 | 429                            |

Abuse handling:

- Content cannot be inspected, so controls are structural: small anonymous size cap, paid-only files, rate limits, CAPTCHA, disposable email blocking, and per-account email send caps so the product cannot be used to spam.
- Reports create an `abuse_reports` row. Support (Admin spec) can revoke the secret by id, suspend the account or ban an IP range.
- Terms of service must forbid illegal content and credential theft, and state that abuse reports lead to link takedown.

## 10. Notifications and integrations

| Trigger                         | Email | Slack    | In-app |
| ------------------------------- | ----- | -------- | ------ |
| `revealed`                      | Yes   | Yes      | Yes    |
| First `passphrase_failed`       | Yes   | Yes      | Yes    |
| `locked`                        | Yes   | Yes      | Yes    |
| Expired without a reveal        | Yes   | Optional | Yes    |
| Request fulfilled               | Yes   | Yes      | Yes    |
| Payment failed, plan limit near | Yes   | No       | Banner |

Rules: notifications never contain secret content, passphrases or links; secret
labels are limited to the owner's in-app notification. The current runtime
supports in-app preferences and opted-in email for notification categories.
Expiring-secret notices are deduplicated and generated by a scheduled job;
pending notification emails are retried by the scheduled dispatcher. SQS,
five-retry exponential backoff, and Slack OAuth remain planned work.

## 11. Audit and retention

| Data                                    | Retention                                                                                                      |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Ciphertext                              | Deleted when the secret becomes terminal                                                                       |
| Anonymous secret rows                   | 7 days after terminal                                                                                          |
| Free account secret metadata and events | 30 days after terminal                                                                                         |
| Pro                                     | 1 year after terminal                                                                                          |
| Team                                    | 2 years after terminal                                                                                         |
| Raw IP in application logs              | 7 days                                                                                                         |
| IP in events                            | Coarse region plus HMAC with a rotating key                                                                    |
| Admin audit log                         | 2 years, append-only                                                                                           |
| Deleted accounts                        | Personal data anonymised within 30 days                                                                        |
| Database backups                        | 7 days; older ciphertext may persist in backups for that window and remains undecryptable without the link key |

## 12. Background jobs

| Job                       | Schedule             | Purpose                                     |
| ------------------------- | -------------------- | ------------------------------------------- |
| `expire_sweeper`          | Every minute         | Mark expired secrets, run terminal cleanup  |
| `notification_dispatcher` | Continuous           | Send email, Slack and in-app events         |
| `orphan_upload_cleanup`   | Hourly               | Delete uploads pending for more than 1 hour |
| `retention_purge`         | Daily                | Remove rows past retention                  |
| `razorpay_sync`           | Webhook plus nightly | Reconcile subscriptions                     |
| `dunning`                 | Daily                | Past-due reminders and plan downgrade       |
| `account_deletion`        | Daily                | Finish deletion and anonymisation           |
| `data_export`             | On demand            | Subject access exports                      |

Expiry is also enforced lazily: any read that finds `expires_at` in the past treats the secret as expired, so the sweeper's delay never grants access.

## 13. Security and compliance

- TLS 1.2 or higher, HSTS preload, strict CSP, SRI for scripts, `Permissions-Policy` locked down.
- Logging redaction for secret endpoints; no request bodies, tokens or fragments in logs, traces or analytics.
- Secrets and keys in AWS Secrets Manager (KMS-encrypted); the pepper and JWT keys rotate with a documented runbook.
- Dependency scanning, SBOM and signed builds in CI. Third-party penetration test before public launch. `security.txt` and a disclosure policy.
- GDPR: data export, deletion, DPA and a sub-processor list. SOC 2 is a post-launch roadmap item.

## 14. Observability and SLOs

- SLOs: reveal and meta availability 99.9 percent; p95 reveal latency under 300 ms; notification delivery within 60 seconds for 99 percent of events.
- Metrics: secrets created by mode, reveal outcomes by code, OTP sends, rate-limit hits, sweeper lag, queue depth, 5xx rate.
- Structured JSON logs without personal data. Distributed tracing with request ids. Alerts page on SLO burn, sweeper lag above 5 minutes, queue backlog and webhook failures.

## 15. Testing and release

- Crypto: fixed test vectors, round-trip tests, cross-browser runs. The same module is used by web, CLI and tests.
- State machine: property tests prove no illegal transition.
- Concurrency: 100 parallel reveals of a one-view secret must produce exactly one success.
- End-to-end flows (Playwright): A1 to A6 and B1 to B5 on desktop and mobile viewports.
- Load and abuse tests before launch; migrations are backward compatible for one release.
- Environments: local, staging, production. Feature flags for Phase 3 features. CI gates: types, lint, tests, dependency audit.

## 16. Open decisions

| ID  | Decision                                      | Recommendation                                                                         |
| --- | --------------------------------------------- | -------------------------------------------------------------------------------------- |
| D1  | Entitlement split: is passphrase free or Pro? | Free account gets passphrase (matches the core promise). Revisit if conversion is weak |
| D2  | Hosting region                                | Decided: ap-south-1 (Mumbai) for v1; add an EU region before selling to EU teams       |
| D3  | Revocation for anonymous links                | Optional revoke link stored only in the creator's browser (Phase 2)                    |
| D4  | Argon2id parameters                           | m=64 MiB, t=3, p=1; benchmark on low-end phones before launch                          |
| D5  | Labels plaintext vs encrypted                 | Plaintext, encrypted at rest, with a UI warning not to put secrets in labels           |
| D6  | Request-a-secret key management               | Decide before building B6                                                              |
| D7  | Fastify vs NestJS                             | Decided: NestJS on the Fastify adapter                                                 |
| D8  | Custom domains and cookie scoping             | Team-plan feature; separate cookies per domain                                         |
| D9  | Bot detection for the opened event            | User-agent heuristics first; refine with data                                          |

**D10. Copy link on the dashboard (raised by Frontend FD1).** The server never knows the link key, so it cannot rebuild a link. Recommendation: for account users, the browser keeps the link key in IndexedDB on the creating device only. The dashboard offers Copy link there and disables it elsewhere. The key never leaves that browser and is wiped on logout or when the secret becomes terminal.

**Admin additions to Section 6 (from the Admin Dashboard Specification):** tables `admin_users`, `admin_approvals`, `blocklist`, `data_requests`, `feature_flags` and `plan_limits`, plus the columns `severity`, `assignee` and `resolution_note` on `abuse_reports`. The abuse report status set in Section 5.7 becomes `open`, `in_review`, `actioned`, `dismissed`, `escalated`.

**D11. Authentication provider.** Recommendation: first-party sessions in NestJS. The zero-knowledge flow needs no identity federation, it avoids per-user Cognito costs and keeps sign-up and recovery flows under our control. Amazon Cognito is the more AWS-native alternative.

**D12. Infrastructure language.** Terraform in HCL (recommended, widest module ecosystem) versus a TypeScript wrapper around Terraform. HCL is the only non-JavaScript part of the stack.

**D13. Currencies and payment methods.** Support INR subscription plans and checkout first, with UPI and cards for India. International-currency plans are out of scope until their pricing, payment-method availability, and Razorpay account activation are reviewed.

**D14. Local environment.** Docker Compose runs Postgres, DynamoDB Local, LocalStack (S3, SQS, SES) and Mailpit so local code paths match production.

## Changelog

- v1.2 implementation alignment (October 16, 2026): Current Prisma/PostgreSQL
  runtime declared authoritative; Cognito and S3 documented as implemented
  dependencies; first secure secret metadata/reveal/revoke/report API added.

* v1.0 draft (October 15, 2026): first complete specification.

- v1.1 draft (October 15, 2026): AWS-only platform defined in Terraform (RDS PostgreSQL, DynamoDB, ECS Fargate, SQS, SES, S3, KMS), NestJS API, Razorpay billing, DynamoDB-based reveal algorithm, local Docker setup.

* v1.2 draft (October 15, 2026): Prisma ORM replaces Drizzle for PostgreSQL; DynamoDB access stays on the AWS SDK v3 behind repository classes.
