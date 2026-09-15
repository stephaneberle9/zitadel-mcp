# Changelog

All notable changes to this fork are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

This is a fork of [`takleb3rry/zitadel-mcp`](https://github.com/takleb3rry/zitadel-mcp).
Entries below cover changes made on top of upstream `v1.0.2` (commit `e3bd79c`).

## [Unreleased]

### Added

- **Hosted login translation tools (Login V2 / TypeScript login):**
  - `zitadel_get_hosted_login_translation` — read the Login V2 text overrides for a locale via
    the Settings v2 API (`GET /v2/settings/hosted_login_translation`); returns the merged
    effective file, or only this level's stored overrides with `onlyOverrides: true`.
  - `zitadel_set_hosted_login_translation` — override Login V2 texts for a locale
    (`PUT /v2/settings/hosted_login_translation`). Accepts flat dot-path keys mirroring
    `apps/login/locales/<locale>.json` in `zitadel/zitadel` (e.g.
    `password.errors.couldNotCreateSessionForUser`). Idempotent: reads this level's own
    overrides (`ignoreInheritance=true`), deep-merges the patch, and writes the result — so
    other overrides and untouched defaults are preserved (never writes the full default bundle
    back).
  - **Why a new mechanism:** the legacy Management *Custom Login Texts*
    (`/management/v1/text/login`) feed only the deprecated Login V1 UI; the current Login V2
    ignores them ([zitadel #8608](https://github.com/zitadel/zitadel/issues/8608)) and reads
    Settings-v2 hosted-login translations instead ([#9850](https://github.com/zitadel/zitadel/issues/9850)).
    Defaults to org level (least-privilege, like the login-policy tools); `level: "instance"`
    targets the whole instance. Reuses the `organizations` tool domain.

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
