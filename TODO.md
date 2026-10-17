# Keydrop API TODO

Last updated: 2026-10-16

## Completed

- Runtime DTO validation with `class-validator`
- Basic endpoint rate limiting and abuse protection
- Cognito signup, login, email verification, resend, refresh, logout, and password reset
- Recipient email verification and short-lived recipient access tokens
- Secret purge lifecycle and S3 deletion retry queue
- Nullable secret ownership and anonymous secret creation
- Anonymous secret size, expiry, view, and creation-rate limits
- Anonymous secret unit lifecycle coverage
- Anonymous secret HTTP E2E and abuse-control integration tests
- Full S3 cleanup failure/retry integration tests
- Billing webhook event idempotency with atomic processing
- Billing refund audit migration and successful-refund audit coverage
- Account/API cursor pagination, retention-aware audit filtering, and expiring-secret notifications
- In-app and email notification preferences and delivery
- Scoped API-key authentication, authorization, and last-used tracking
- Account deletion, JSON export, and verified presigned file transfers
- Verified and idempotent Razorpay subscription, payment, invoice, and refund webhooks
- Invoice/refund synchronization and customer refund history
- Seven-day failed-payment grace period with provider cancellation and API-key revocation on Free downgrade
- Razorpay plan changes scheduled at cycle end
- Six-hour provider subscription and invoice reconciliation
- Razorpay webhook fixtures and signed HTTP E2E coverage
- CloudWatch alarm SNS notification actions
- Razorpay INR Test Mode plans created and configured in local `.env`
- Local Prisma migrations applied
- Terraform configuration validation
- Baseline unit and E2E test execution

## Blocked (external prerequisites)

- [blocked] Apply Terraform plan to a configured staging environment (missing `infra/staging.tfvars`; required staging values include `db_password`, `image_tag`, `frontend_url`, and provider secrets)
- [blocked] Apply and verify migrations in staging and production (staging variables and production migration authorization are not configured)
- [blocked] Create Razorpay INR Live Mode subscription plans and configure their IDs in production (Razorpay MCP currently has no plan-management operations; Dashboard access required)
- [blocked] Configure production Razorpay dashboard webhook endpoint (requires API DNS/issued ACM certificate, webhook secret, and Razorpay dashboard access; Terraform and runtime wiring are ready)

## P0 security and database

- Complete secret authentication-hash migration verification
- Define and enforce IP/device tracking policy
- Add terminal purge retention rules
- Add orphan-file reconciliation cleanup

## Teams

- Implement team ownership transfer
- Implement team deletion
- Enforce team seat limits
- Implement domain restrictions
- Implement team branding
- Enforce team policies during secret creation and reveal
- Clean up expired invitations
- Prevent duplicate and excessive memberships

## Testing

- Team invitation acceptance tests
- Secret request approval and denial tests
- File upload authorization tests
- Billing plan synchronization tests
- Refund role tests
- Concurrent secret reveal tests
- OTP replay tests
- Controller authentication tests
- PostgreSQL integration coverage beyond the baseline E2E test
- Full end-to-end suite

## Infrastructure and release

- Configure verified SES sender and production access
- Configure production Cognito values
- Configure S3 bucket and IAM permissions
- Configure explicit production CORS origins
- Verify private RDS connectivity from ECS
- Configure Terraform remote state bucket and locking
- Run Terraform plan for staging and production
- Verify scheduled-job monitoring
- Verify Git repository state and intended tracked files
- Review secrets and environment files before commit
- Complete production readiness review
