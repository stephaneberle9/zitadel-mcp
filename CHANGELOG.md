# Changelog

All notable changes to this fork are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

This is a fork of [`takleb3rry/zitadel-mcp`](https://github.com/takleb3rry/zitadel-mcp).
Entries below cover changes made on top of upstream `v1.0.2` (commit `e3bd79c`).

## [Unreleased]

### Added

- **SMTP / email-provider tools (Admin API, IAM-level):**
  - `zitadel_get_smtp_config` — list the instance SMTP notification providers (which one is
    active, its host and sender); secrets are never returned.
  - `zitadel_set_smtp_config` — configure the instance SMTP provider (e.g. switch ZITADEL
    from its built-in dev server to Brevo) and activate it. Idempotent: reuses a matching
    provider (by description, host or sender) via `PUT`, otherwise creates one via `POST`.
    Uses the `SMTPPlainAuth` oneof (`plain: { password }`) and puts the port inside `host`.
  - `zitadel_activate_smtp_config` — activate an existing provider by id.
  - These target the modern `/admin/v1/email/*` endpoints (the `/admin/v1/smtp` family is
    deprecated). **Deliberate exception to the Management-API-only design:** the notification
    provider is an INSTANCE-level resource, so ZITADEL requires `iam.read` / `iam.write` — the
    service account needs an IAM-level manager grant (`ORG_OWNER` alone returns 403). New
    `notifications` tool domain; SMTP secrets/PII added to debug-log redaction.
  - **Leak-safe credentials:** `zitadel_set_smtp_config` reads the relay creds
    (`SMTP_HOST/PORT/USER/PASSWORD/FROM`) from a gitignored file via a non-secret `credsProfile`
    arg — `~/.secrets/smtp/.env.<profile>` (default `~/.secrets/smtp/.env`, base overridable
    with `SMTP_ENV_PATH`) — so the password never enters the conversation. Any field can still be
    passed as an argument (which overrides the file), but passing `password` that way puts it in
    the transcript. `SMTP_FROM` ("Name &lt;addr&gt;") is split into ZITADEL's sender name/address.
- **Login-policy tools (org-scoped, ORG_OWNER):**
  - `zitadel_get_login_policy` — report the current org's login policy: whether
    self-registration (`allowRegister`) is on, and whether the policy is a custom org
    policy or inherited from the instance default.
  - `zitadel_set_self_registration` — enable/disable self-registration for the org by
    setting `allowRegister`. Idempotent (reads first, no-ops if already in the requested
    state); creates a custom org policy via `POST` when the org currently inherits the
    instance default, otherwise `PUT`s the existing one, preserving all other fields.
  - Stays within the server's least-privilege design: Management API only
    (`/management/v1/policies/login`), never the Admin API. Enables the Platform Service
    invitation-accept flow, which requires `allowRegister`
    (see [zitadel/zitadel#11138](https://github.com/zitadel/zitadel/issues/11138)).
- **OIDC application parameters** — `grantTypes`, `responseTypes`, and `accessTokenType`
  on `zitadel_create_oidc_app` / `zitadel_update_app` (e.g. to set the access token type
  to `JWT`). Cherry-picked from
  [luuthanhminh/zitadel-mcp@74ff2e0](https://github.com/luuthanhminh/zitadel-mcp/commit/74ff2e0)
  (authorship preserved).

### Security

- Validate `update_app` redirect / post-logout URIs as URLs (`z.string().url()`), matching
  `create_oidc_app`; widen debug-log redaction to cover `roleKey` / `roleKeys`,
  `accessTokenType`, and `expirationDate`. Ported (manually, minus the dependency churn)
  from [STIFLEUR390/zitadel-mcp@023bf90](https://github.com/STIFLEUR390/zitadel-mcp/commit/023bf90)
  ("Phase 7: Input validation & redaction hardening").
