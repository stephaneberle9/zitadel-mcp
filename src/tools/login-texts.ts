/**
 * Hosted Login Translation tools (2 tools)
 * Customize the texts of the NEW login UI (Login V2 / "TypeScript login") via the
 * Zitadel Settings API v2 (/v2/settings/hosted_login_translation).
 *
 * ⚠️ Why this exists — and why it is NOT the same as the legacy "Custom Login Texts":
 * Zitadel has TWO different login UIs and TWO unrelated text-customization mechanisms:
 *   - Login V1 (legacy, Angular hosted login) reads the Management API "Custom Login Texts"
 *     (`/management/v1/text/login/{lang}`). That family does NOT feed Login V2 at all — the
 *     TypeScript login ignores it (zitadel/zitadel #8608). This server deliberately does not
 *     wrap it, because every itemis instance runs Login V2.
 *   - Login V2 (the current default; `loginV2.required` instance feature / per-app
 *     `loginVersion.loginV2`) reads its strings from i18n bundles shipped inside the login app
 *     and lets you OVERRIDE individual keys via this Settings v2 endpoint. Overrides are merged
 *     onto the shipped defaults key-by-key, so you send only the keys you want to change and
 *     upstream fixes to every other key still flow through (#9850).
 *
 * The override keys mirror the login app's locale files
 * (github.com/zitadel/zitadel → apps/login/locales/<lang>.json), e.g.
 * `password.errors.couldNotCreateSessionForUser`. Pass them as flat dot-paths for convenience;
 * this module expands them into the nested shape the API expects.
 *
 * Scope: like login-policy.ts, this defaults to the configured org (ORG_ID) so it stays within
 * the server's least-privilege stance. Org-level overrides apply to every app whose login
 * resolves to that org. `level: "instance"` targets the whole instance (all orgs) and needs an
 * IAM-level grant. For a single-org instance with `loginDefaultOrg` enabled the two are
 * effectively equivalent; prefer org-level unless you explicitly want instance-wide reach.
 *
 * Idempotency / safety: SET first reads the target level's OWN overrides
 * (`ignoreInheritance=true` → returns only what's stored at this level, not the merged
 * defaults), deep-merges the requested keys, then PUTs the result. This preserves previously
 * set overrides and never writes the full default bundle back (which would freeze translations
 * and block upstream fixes).
 */

import { z } from 'zod';
import type { ToolDefinition, ToolHandler } from '../types/tools.js';
import { textResponse } from '../types/tools.js';
import { logger } from '../utils/logger.js';

const HLT_PATH = '/v2/settings/hosted_login_translation';

// ─── Shapes ──────────────────────────────────────────────────────────────────

interface HostedLoginTranslationResponse {
  etag?: string;
  translations?: Record<string, unknown>;
}

type Nested = Record<string, unknown>;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Expand flat dot-path keys ("a.b.c": v) into a nested object ({a:{b:{c:v}}}).
 * Keys without a dot are copied as-is, so a caller may also pass an already-nested object.
 */
function expandDotPaths(input: Nested): Nested {
  const out: Nested = {};
  for (const [key, value] of Object.entries(input)) {
    if (!key.includes('.')) {
      // Already-nested branch (or a top-level leaf) — merge recursively so mixing styles works.
      if (isPlainObject(value) && isPlainObject(out[key])) {
        out[key] = deepMerge(out[key] as Nested, expandDotPaths(value as Nested));
      } else {
        out[key] = isPlainObject(value) ? expandDotPaths(value as Nested) : value;
      }
      continue;
    }
    const parts = key.split('.');
    let cursor = out;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]!;
      if (!isPlainObject(cursor[part])) cursor[part] = {};
      cursor = cursor[part] as Nested;
    }
    cursor[parts[parts.length - 1]!] = value;
  }
  return out;
}

function isPlainObject(v: unknown): v is Nested {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep-merge `patch` onto `base` (patch wins on leaves), returning a new object. */
function deepMerge(base: Nested, patch: Nested): Nested {
  const out: Nested = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key] as Nested, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Flatten a nested object back to dot-path leaves, for a compact human summary. */
function flattenLeaves(obj: Nested, prefix = ''): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value)) {
      rows.push(...flattenLeaves(value, path));
    } else {
      rows.push([path, String(value)]);
    }
  }
  return rows;
}

/** Build the `?instance=true` / `?organizationId=…` scope query shared by GET. */
function scopeQuery(level: 'organization' | 'instance', orgId: string): string {
  return level === 'instance' ? 'instance=true' : `organizationId=${encodeURIComponent(orgId)}`;
}

// ─── Tool Definitions ────────────────────────────────────────────────────────

export const LOGIN_TEXTS_TOOLS: ToolDefinition[] = [
  {
    name: 'zitadel_get_hosted_login_translation',
    description:
      'Read the Login V2 (new "hosted login" / TypeScript login) text overrides for a locale, ' +
      'via the Settings v2 API. This is the ONLY text-customization that affects the new login — ' +
      'the legacy Management "Custom Login Texts" do not. By default returns the merged, effective ' +
      'file (your overrides on top of the shipped defaults); pass onlyOverrides=true to see just ' +
      'what is stored at this level. Defaults to the configured org; pass level:"instance" for the ' +
      'whole instance. Override keys mirror apps/login/locales/<locale>.json in zitadel/zitadel ' +
      '(e.g. "password.errors.couldNotCreateSessionForUser").',
    inputSchema: {
      type: 'object',
      properties: {
        locale: { type: 'string', description: 'BCP-47 language tag, e.g. "de", "en", "fr-CH" (default "en").' },
        level: { type: 'string', enum: ['organization', 'instance'], description: 'Scope to read: "organization" (default, the configured ORG_ID) or "instance".' },
        onlyOverrides: { type: 'boolean', description: 'true → return only the overrides stored at this level (ignoreInheritance). false (default) → the merged effective file.' },
      },
    },
    _meta: { readOnly: true, domain: 'organizations' },
    annotations: { title: 'Get Hosted Login Translation', readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'zitadel_set_hosted_login_translation',
    description:
      'Override texts of the Login V2 (new "hosted login" / TypeScript login) for a locale, via ' +
      'the Settings v2 API — the correct lever for the new login (the legacy Management "Custom ' +
      'Login Texts" are ignored by it). Pass `translations` as flat dot-path keys mirroring ' +
      'apps/login/locales/<locale>.json in zitadel/zitadel, e.g. ' +
      '{"password.errors.couldNotCreateSessionForUser":"Benutzername oder Passwort falsch."}. ' +
      'Only the keys you send are changed: the tool reads this level\'s existing overrides, ' +
      'deep-merges yours in, and writes the result — so other overrides and untouched defaults ' +
      'stay intact (idempotent). Defaults to the configured org (ORG-LEVEL — affects every app ' +
      'whose login resolves to this org); pass level:"instance" for the whole instance (needs an ' +
      'IAM-level grant). Set one locale per call; repeat for each language you support.',
    inputSchema: {
      type: 'object',
      properties: {
        locale: { type: 'string', description: 'BCP-47 language tag to write, e.g. "de" or "en".' },
        translations: {
          type: 'object',
          description: 'Map of override keys to text. Keys are flat dot-paths mirroring the login locale file (e.g. "password.errors.couldNotCreateSessionForUser"); an already-nested object is also accepted. Values may contain login-app placeholders like {failedAttempts}.',
          additionalProperties: true,
        },
        level: { type: 'string', enum: ['organization', 'instance'], description: 'Scope to write: "organization" (default) or "instance".' },
      },
      required: ['locale', 'translations'],
    },
    _meta: { readOnly: false, domain: 'organizations' },
    annotations: { title: 'Set Hosted Login Translation', readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
];

// ─── Handlers ────────────────────────────────────────────────────────────────

const getHostedLoginTranslationHandler: ToolHandler = async (params, ctx) => {
  const { locale, level, onlyOverrides } = z
    .object({
      locale: z.string().min(2).max(35).default('en'),
      level: z.enum(['organization', 'instance']).default('organization'),
      onlyOverrides: z.boolean().default(false),
    })
    .parse(params);

  const orgId = ctx.client.getConfig().orgId;
  const query = `${scopeQuery(level, orgId)}&locale=${encodeURIComponent(locale)}&ignoreInheritance=${onlyOverrides}`;
  const res = await ctx.client.request<HostedLoginTranslationResponse>(`${HLT_PATH}?${query}`);

  const translations = res.translations ?? {};
  const scope = level === 'instance' ? 'instance' : `org ${orgId}`;

  if (onlyOverrides) {
    const rows = flattenLeaves(translations);
    if (rows.length === 0) {
      return textResponse(`No Login V2 text overrides stored at ${scope} level for locale "${locale}" (inheriting the shipped defaults).`);
    }
    const body = rows.map(([k, v]) => `  ${k} = ${v}`).join('\n');
    return textResponse(`Login V2 text overrides at ${scope} level, locale "${locale}" (${rows.length}):\n${body}`);
  }

  const leafCount = flattenLeaves(translations).length;
  return textResponse(
    `Effective (merged) Login V2 translation for ${scope}, locale "${locale}" — ${leafCount} keys` +
    `${res.etag ? ` (etag ${res.etag})` : ''}.\n` +
    `To see only what THIS level overrides, call again with onlyOverrides:true.\n\n` +
    `${JSON.stringify(translations, null, 2)}`
  );
};

const setHostedLoginTranslationHandler: ToolHandler = async (params, ctx) => {
  const { locale, translations, level } = z
    .object({
      locale: z.string().min(2).max(35),
      translations: z.record(z.unknown()).refine((t) => Object.keys(t).length > 0, 'translations must not be empty'),
      level: z.enum(['organization', 'instance']).default('organization'),
    })
    .parse(params);

  const orgId = ctx.client.getConfig().orgId;
  const scope = level === 'instance' ? 'instance' : `org ${orgId}`;

  // Expand caller's dot-paths into the nested shape the API stores.
  const patch = expandDotPaths(translations as Nested);
  const changed = flattenLeaves(patch);

  // Read this level's EXISTING overrides only (not the merged defaults), so we preserve prior
  // overrides and never write the full default bundle back.
  const existing = await ctx.client.request<HostedLoginTranslationResponse>(
    `${HLT_PATH}?${scopeQuery(level, orgId)}&locale=${encodeURIComponent(locale)}&ignoreInheritance=true`
  );
  const merged = deepMerge(existing.translations ?? {}, patch);

  const body: Record<string, unknown> = {
    locale,
    translations: merged,
    ...(level === 'instance' ? { instance: true } : { organizationId: orgId }),
  };

  logger.info('Setting hosted login translation', { level, locale, keys: changed.length });
  const res = await ctx.client.request<HostedLoginTranslationResponse>(HLT_PATH, {
    method: 'PUT',
    body: JSON.stringify(body),
  });

  const summary = changed.map(([k, v]) => `  ${k} = ${v}`).join('\n');
  return textResponse(
    `Updated ${changed.length} Login V2 text override(s) at ${scope} level for locale "${locale}"` +
    `${res.etag ? ` (etag ${res.etag})` : ''}:\n${summary}\n\n` +
    `These apply to the NEW login (Login V2). Merged onto the shipped defaults, so untouched keys ` +
    `still follow upstream.\n` +
    `Impact: ${level === 'instance' ? 'INSTANCE-level — affects every org on this instance.' : 'ORG-level — affects every app whose login resolves to this org.'}\n` +
    `Verify by opening the hosted login and triggering the affected screen; changes are live immediately.`
  );
};

// ─── Export ──────────────────────────────────────────────────────────────────

export const LOGIN_TEXTS_HANDLERS: Record<string, ToolHandler> = {
  zitadel_get_hosted_login_translation: getHostedLoginTranslationHandler,
  zitadel_set_hosted_login_translation: setHostedLoginTranslationHandler,
};
