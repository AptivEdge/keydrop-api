# Keydrop documentation index

This index separates product-facing API journeys from staff operations and
describes the backend that implements both. The repository contains the
NestJS API and its infrastructure configuration; it does not contain the
frontend or admin web application. The frontend and admin guides therefore
document the API capabilities and expected integration flows, not browser
page routes or UI components.

## Feature documentation

| Document                                         | Audience                | Coverage                                                                                                             |
| ------------------------------------------------ | ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| [Frontend feature guide](./frontend-features.md) | Frontend engineers      | Customer and recipient journeys, every client-facing API route, authentication, secrets, account, teams, and billing |
| [Admin feature guide](./admin-features.md)       | Admin/staff engineers   | Staff roles, staff-only routes, refund operations, webhook operations, and gaps in the current admin API             |
| [Backend overview](./backend-overview.md)        | Engineering and product | Runtime architecture, cross-cutting behavior, storage, background jobs, and feature boundaries                       |

## Existing reference documents

| Document                                                    | Use it for                                                             |
| ----------------------------------------------------------- | ---------------------------------------------------------------------- |
| [Authentication and authorization](./authentication.md)     | Customer/staff identity, role model, API-key scopes, user access rules |
| [Resend email templates](./email-templates.md)               | Published Resend templates, variables, aliases, and deployment configuration |
| [Retired AWS infrastructure](./infrastructure.md)           | AWS decommission status and the remaining DNS/state cleanup gates       |
| [Backend initial flow](./backend-initial-flow.md)           | Historical product/API specification and initial flows                 |
| [Free-tier migration audit](./free-tier-migration-audit.md) | Existing AWS usage, runtime dependencies, risks, and migration gates   |
| [Free-tier architecture](./free-tier-architecture.md)       | Target Cloudflare, Vercel, Supabase, R2, and email-provider design     |
| [Free-tier migration runbook](./free-tier-migration.md)     | Historical migration sequence and current AWS retirement status       |

The current source code and the three feature guides above describe the
implemented runtime. The initial-flow specification contains both current
implementation notes and older planned designs; its explicitly marked planned
sections should not be treated as live routes or services.

## API entry points

- API prefix: `/api/v1`
- Swagger UI: `/api/v1/docs` when Swagger is enabled (disabled by default in
  production)
- Health check: `GET /api/v1/health`

For endpoint access rules, request behavior, and lifecycle details, start with
the feature guide for the relevant client or role.
