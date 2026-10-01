# Changelog

All notable changes to `zitadel-mcp-server` are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

Fork-only changes on top of upstream `2.0.0`; they are not part of
[`takleb3rry/zitadel-mcp`](https://github.com/takleb3rry/zitadel-mcp).

### Added

- **Default secrets file `~/.secrets/zitadel/.env`** — when `DOTENV_CONFIG_PATH` is not set,
  the server reads its variables from `~/.secrets/zitadel/.env` (upstream reads a `.env`
  file outside the package only when `DOTENV_CONFIG_PATH` names one). A globally installed
  or linked `zitadel-mcp` binary therefore starts from an MCP config that carries no `env`
  block and no machine-specific path. Precedence is unchanged: variables already in the
  process environment win, then this file, then the repo-root `.env`.
- **SMTP / email-provider tools (Admin API, IAM-level):**
  - `zitadel_get_smtp_config` — list the instance SMTP notification providers (which one is
    active, its host and sender); secrets are never returned.
  - `zitadel_set_smtp_config` — configure the instance SMTP provider (e.g. switch ZITADEL
    from its built-in dev server to Brevo) and activate it. Idempotent: reuses a matching
    provider (by description, host or sender) via `PUT`, otherwise creates one via `POST`.
    Sends a flat request body (no `plain` wrapper) and puts the port inside `host`.
  - `zitadel_activate_smtp_config` — activate an existing provider by id. Idempotent: an
    already-active provider counts as success.
  - `zitadel_test_smtp_config` — send a real test e-mail through a provider (the active one
    when no id is given) and report the relay's own rejection reason on failure. This is the
    authoritative delivery check: an active provider with a wrong SMTP key still rejects
    mail. It reuses the stored password, so no secret enters the conversation.
  - These target the `/admin/v1/smtp/*` endpoints, which ZITADEL marks deprecated in favor of
    `/admin/v1/email/*`. The choice is deliberate and time-bound: on a real ZITADEL Cloud
    instance (2026-07-09) the newer family's test endpoint returned `501 not implemented`
    and its list did not reflect updates, while the deprecated family worked end to end.
  - **Deliberate exception to the Management-API-only design:** the notification provider is
    an INSTANCE-level resource, so ZITADEL requires `iam.read` / `iam.write` — the service
    account needs an IAM-level manager grant (`ORG_OWNER` alone returns 403). New
    `notifications` tool domain; SMTP secrets/PII added to debug-log redaction.
  - **Leak-safe credentials:** `zitadel_set_smtp_config` reads the relay creds
    (`SMTP_HOST/PORT/USER/PASSWORD/FROM`) from a gitignored file, so the password never
    enters the conversation. The file is `~/.secrets/<provider>/.env`, or
    `~/.secrets/<provider>/.env.<profile>` when the non-secret `credsProfile` argument names
    a profile. The provider folder is auto-discovered: the server uses the one folder whose
    file defines `SMTP_HOST`, and asks for `credsDir` when several match. `SMTP_ENV_PATH`
    overrides the location entirely. Any field can still be passed as an argument (which
    overrides the file), but passing `password` that way puts it in the transcript.
    `SMTP_FROM` ("Name &lt;addr&gt;") is split into ZITADEL's sender name/address.

### Changed

- **The npm package is named `@stephaneberle9/zitadel-mcp-server`** instead of
  `zitadel-mcp-server`, the name upstream publishes to the npm registry. Under the shared
  name, a global npm update replaced an installed fork with upstream's build. The
  `zitadel-mcp` binary name and the MCP server name `zitadel-mcp-server` are unchanged, so
  MCP configs need no edit. Before installing the fork, remove an unscoped global install
  with `npm uninstall -g zitadel-mcp-server`, because both packages provide the
  `zitadel-mcp` binary.

## [2.0.0] - 2026-09-27

First release since `1.0.2` (February 2026). It collects seven months of changes, several of
which can break a setup that works on `1.0.2` — read **Breaking changes** before upgrading.

### Breaking changes

- **Node.js 20 or later is required** (`engines: >=20.0.0`). Node 18 is end-of-life and is no
  longer tested in CI.
- **`ZITADEL_ISSUER` must use `https://`.** `http://` is accepted only for `localhost`,
  `127.0.0.1` and `[::1]`; any other `http://` issuer is rejected at startup.
- **`zitadel_list_orgs` has been removed.** It used the Admin API, which conflicts with the
  server's least-privilege design (it runs as an org-scoped service account).
- **Rate limiting.** Tool calls are limited to 60 reads and 10 writes per minute; calls over
  the limit are refused until the window clears.
- **Error responses are generic.** Tool errors no longer echo ZITADEL API internals; the
  detail goes to the server log instead (see *Fixed* for the logging improvement).
- **Errors that were silently absorbed now surface.** `portal_setup_full_app` treats only a
  409 as "role already exists" and fails on anything else (e.g. a 403), instead of reporting
  a skip and writing a portal row for a role that was never created. The provisioning user
  lookup treats only a 404 as "no such user", so a 403 or 5xx no longer leads
  `zitadel_provision_user` to create a duplicate or `zitadel_offboard_user` to report an
  existing user as missing.
- **Stricter input validation.** Project IDs (from tool parameters and `ZITADEL_PROJECT_ID`)
  must match ZITADEL's ID format; string inputs have maximum lengths; `update_app` redirect
  and post-logout URIs must be valid URLs; `PORTAL_DATABASE_URL` must be a `postgres://` URL.
- **`zitadel_set_self_registration` is off by default.** It is registered only when
  `ZITADEL_ENABLE_LOGIN_POLICY_WRITE` is set, because it can open an org to public sign-up.
  `zitadel_get_login_policy` is always available.

### Added

- **`DOTENV_CONFIG_PATH`** — load the server's variables from a `.env` file at a configurable
  path, read before the repo-root `.env`. A globally installed `zitadel-mcp` binary can now
  find secrets kept outside the package without a `-r dotenv/config` preload or an inline
  `env` block of secrets. Variables already in the process environment still win.
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

- **SSO/RBAC provisioning tools:**
  - `zitadel_provision_user` — atomic, idempotent: create a human user, assign an
    `admin` or `standard` project role and, for admins, grant `ORG_USER_MANAGER`.
  - `zitadel_offboard_user` — remove the role, revoke manager rights and deactivate the
    user, with last-admin and self-demotion guards.
  - `zitadel_grant_org_manager`, `zitadel_revoke_org_manager` (guards the last
    `ORG_OWNER`), `zitadel_list_org_managers`, `zitadel_list_org_manager_roles`.
  - Role assignment prefers the v2 `POST /v2/authorizations` API and falls back to v1 user
    grants where v2 is unavailable. `zitadel_create_user` accepts a caller-supplied `userId`
    for idempotency.
- **`.env` loading** — the server loads `.env` from the repo root regardless of the working
  directory.
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

### Fixed

- **`zitadel_get_user` reports email verification correctly.** It read `isEmailVerified`,
  but the v2 API names the field `isVerified` and omits it when false, so every user showed
  `Email Verified: N/A`. It now shows `true` or `false` for any user with an email.
  Thanks to [@stephaneberle9](https://github.com/stephaneberle9)
  ([#23](https://github.com/takleb3rry/zitadel-mcp/pull/23)).
- **`zitadel_update_app` no longer resets the access token type.** Editing redirect URIs
  (or any managed field) silently reverted JWT apps to opaque bearer tokens; the update now
  preserves `accessTokenType`, `clockSkew` and `additionalOrigins`.
- **Service-account keys supplied as a raw PEM now work**, including a single-line PEM with
  literal `\n` escapes. Previously a raw PEM was corrupted by an unconditional base64 decode.
- **Token-exchange and API failures log ZITADEL's error message** (`error` /
  `error_description` or `message`) instead of only the HTTP status.
- Performance: the signing key is imported once instead of on every token request, and the
  portal database uses a shared connection pool.

### Security

- Validate `update_app` redirect / post-logout URIs as URLs (`z.string().url()`), matching
  `create_oidc_app`; widen debug-log redaction to cover `roleKey` / `roleKeys`,
  `accessTokenType`, and `expirationDate`. Ported (manually, minus the dependency churn)
  from [STIFLEUR390/zitadel-mcp@023bf90](https://github.com/STIFLEUR390/zitadel-mcp/commit/023bf90)
  ("Phase 7: Input validation & redaction hardening").
- `npm audit fix`: 16 advisories (1 critical, 11 high) reduced to 1 low; esbuild and tsx
  updated.
- Debug-log redaction covers more fields, and PII was removed from handler logging.

### Documentation

- README: corrected claims that `zitadel_create_oidc_app` returns the client secret and that
  `zitadel_create_service_user_key` returns the private key (neither does); documented the
  accepted private-key formats and `ZITADEL_ENABLE_LOGIN_POLICY_WRITE`.

## [1.0.2] - 2026-02-17

Last release before 2.0.0.
