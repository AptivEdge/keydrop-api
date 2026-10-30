# Resend email templates

All application email is sent using published templates in Resend. The API
selects a template by message type and supplies only the recipient and
template variables; subject and body content are maintained in Resend.

The initial set of 13 templates below has been created and published in the
configured Resend account. Their aliases are configured in the local
`.env.local`; configure the same `EMAIL_TEMPLATE_*` aliases in Vercel for each
deployment environment.

## Create templates

1. In Resend, open **Templates** and create a template for each type listed
   below. Add the subject, sender design, and content in the editor.
2. Add the listed variables to the template using the editor's variable
   controls. The names are case-sensitive.
3. Send a test email, then publish the template. Draft templates cannot be used
   by the send API.
4. Set the matching `EMAIL_TEMPLATE_*` environment variable to the published
   template's alias or ID. Keep aliases identical between development and
   production where possible; the aliases can point to different template IDs
   per environment.

| Environment variable                                 | Suggested alias                               | Variables                                    |
| ---------------------------------------------------- | --------------------------------------------- | -------------------------------------------- |
| `EMAIL_TEMPLATE_AUTH_VERIFICATION`                   | `keydrop-auth-verification`                   | `CODE`, `EXPIRY_MINUTES`                     |
| `EMAIL_TEMPLATE_PASSWORD_RESET`                      | `keydrop-password-reset`                      | `CODE`, `EXPIRY_MINUTES`                     |
| `EMAIL_TEMPLATE_RECIPIENT_ACCESS`                    | `keydrop-recipient-access`                    | `CODE`, `EXPIRY_MINUTES`                     |
| `EMAIL_TEMPLATE_TEAM_INVITATION`                     | `keydrop-team-invitation`                     | `TEAM_NAME`, `INVITE_URL`, `EXPIRES_AT`      |
| `EMAIL_TEMPLATE_SECRET_REQUEST`                      | `keydrop-secret-request`                      | `REQUEST_TITLE`, `REQUEST_URL`, `EXPIRES_AT` |
| `EMAIL_TEMPLATE_NOTIFICATION_SECRET_CREATED`         | `keydrop-notification-secret-created`         | None                                         |
| `EMAIL_TEMPLATE_NOTIFICATION_SECRET_VIEWED`          | `keydrop-notification-secret-viewed`          | None                                         |
| `EMAIL_TEMPLATE_NOTIFICATION_SECRET_EXPIRING`        | `keydrop-notification-secret-expiring`        | None                                         |
| `EMAIL_TEMPLATE_NOTIFICATION_SECRET_EXPIRED`         | `keydrop-notification-secret-expired`         | None                                         |
| `EMAIL_TEMPLATE_NOTIFICATION_ACCESS_REQUESTED`       | `keydrop-notification-access-requested`       | None                                         |
| `EMAIL_TEMPLATE_NOTIFICATION_ACCESS_GRANTED`         | `keydrop-notification-access-granted`         | None                                         |
| `EMAIL_TEMPLATE_NOTIFICATION_ACCESS_DENIED`          | `keydrop-notification-access-denied`          | None                                         |
| `EMAIL_TEMPLATE_NOTIFICATION_BILLING_PAYMENT_FAILED` | `keydrop-notification-billing-payment-failed` | None                                         |

The `EXPIRES_AT` values are ISO 8601 timestamps. In Resend, include those
variables in text/date content as appropriate. Never use an email template to
expose a secret's plaintext or other credentials.

Email signup confirmation uses a six-digit code. The API only accepts codes
for the matching email and purpose, expires them after 10 minutes, allows up
to five failed attempts, enforces a resend delay, and consumes each code once.
The published `keydrop-auth-verification` template in Resend still needs to be
updated to use `CODE` and `EXPIRY_MINUTES`; the current API key was denied
permission to update or create templates. Until the template is updated in
Resend, signup verification emails will not match this API contract.

## Configure the API

Set these server-side environment values in local `.env.local`, Vercel
development, preview, and production as appropriate:

```env
EMAIL_PROVIDER=resend
EMAIL_API_KEY=
EMAIL_FROM=Keydrop <no-reply@your-verified-domain.example>
EMAIL_TEMPLATE_AUTH_VERIFICATION=keydrop-auth-verification
EMAIL_TEMPLATE_PASSWORD_RESET=keydrop-password-reset
EMAIL_TEMPLATE_RECIPIENT_ACCESS=keydrop-recipient-access
EMAIL_TEMPLATE_TEAM_INVITATION=keydrop-team-invitation
EMAIL_TEMPLATE_SECRET_REQUEST=keydrop-secret-request
EMAIL_TEMPLATE_NOTIFICATION_SECRET_CREATED=keydrop-notification-secret-created
EMAIL_TEMPLATE_NOTIFICATION_SECRET_VIEWED=keydrop-notification-secret-viewed
EMAIL_TEMPLATE_NOTIFICATION_SECRET_EXPIRING=keydrop-notification-secret-expiring
EMAIL_TEMPLATE_NOTIFICATION_SECRET_EXPIRED=keydrop-notification-secret-expired
EMAIL_TEMPLATE_NOTIFICATION_ACCESS_REQUESTED=keydrop-notification-access-requested
EMAIL_TEMPLATE_NOTIFICATION_ACCESS_GRANTED=keydrop-notification-access-granted
EMAIL_TEMPLATE_NOTIFICATION_ACCESS_DENIED=keydrop-notification-access-denied
EMAIL_TEMPLATE_NOTIFICATION_BILLING_PAYMENT_FAILED=keydrop-notification-billing-payment-failed
```

The API fails with a service-unavailable error when credentials or the
template alias for the requested message are missing. It does not fall back to
inline email content. Resend's template subject and body are used; `EMAIL_FROM`
sets the sender for API requests. No Supabase Auth SMTP configuration or
template is involved.

For design/content changes, edit and publish the template in Resend without
changing application code. For new variables or new email purposes, update
the API's typed email message, its tests, and this variable list.

References:

- [Resend: Using Templates](https://resend.com/docs/dashboard/templates/introduction)
- [Resend: Create a Template](https://resend.com/docs/dashboard/templates/create-template)
- [Resend: Working with Variables](https://resend.com/docs/dashboard/templates/template-variables)
- [Resend: Send Email API](https://resend.com/docs/api-reference/emails/send-email)
