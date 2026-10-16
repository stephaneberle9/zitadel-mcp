/**
 * Branding tools (4 tools)
 * The label policy — colors, theme mode, logo, icon and font — that ZITADEL applies to the
 * hosted login and to every notification it sends, via the Management API (org level) or the
 * Admin API (instance level): `/{management|admin}/v1/policies/label`, plus the asset endpoints
 * `/assets/v1/{org|instance}/policy/label/{logo|icon|font}[/dark]` for the files.
 *
 * Why this matters: without it, the login and every identity mail carry ZITADEL's own logo. The
 * logo also goes into the mails, so a PNG is the safe choice — mail clients do not render SVG.
 *
 * Draft and activation: every write — colors and uploads alike — lands in the policy's
 * *preview*. Nothing changes for users until `zitadel_activate_branding` promotes the preview to
 * the active policy, which is what the Console's "Apply settings" does. Set everything, check it,
 * then activate once.
 *
 * Inheritance: an org without its own label policy inherits the instance default. The first org
 * write therefore creates the org's own policy, seeded from what it inherits, so colors the
 * caller does not mention keep their inherited values instead of falling back to blanks. Uploads
 * need that policy too, and create it the same way.
 *
 * Idempotency / safety: the update endpoints replace the whole policy, so SET reads the preview
 * first, merges the requested fields in and writes the result.
 *
 * Scope: defaults to the configured org (ORG_ID), like login-texts.ts. `level: "instance"`
 * targets the instance default for every org and needs an IAM-level grant.
 */

import { constants } from 'node:fs';
import { open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import type { HandlerContext, ToolDefinition, ToolHandler } from '../types/tools.js';
import { errorResponse, textResponse } from '../types/tools.js';
import { logger } from '../utils/logger.js';

// ─── Shapes ──────────────────────────────────────────────────────────────────

const COLOR_FIELDS = [
  'primaryColor',
  'backgroundColor',
  'warnColor',
  'fontColor',
  'primaryColorDark',
  'backgroundColorDark',
  'warnColorDark',
  'fontColorDark',
] as const;
const FLAG_FIELDS = ['hideLoginNameSuffix', 'disableWatermark'] as const;
const THEME_MODES = ['THEME_MODE_AUTO', 'THEME_MODE_LIGHT', 'THEME_MODE_DARK'] as const;

type ColorField = (typeof COLOR_FIELDS)[number];
type FlagField = (typeof FLAG_FIELDS)[number];

type PolicySettings = Partial<Record<ColorField, string>> &
  Partial<Record<FlagField, boolean>> & { themeMode?: string };

interface LabelPolicy extends PolicySettings {
  isDefault?: boolean;
  logoUrl?: string;
  iconUrl?: string;
  logoUrlDark?: string;
  iconUrlDark?: string;
  fontUrl?: string;
}

interface LabelPolicyResponse {
  policy?: LabelPolicy;
}

const ASSETS = ['logo', 'icon', 'font'] as const;
type Asset = (typeof ASSETS)[number];

/** ZITADEL's own limit for every label-policy asset (`1 << 19`). */
const MAX_ASSET_BYTES = 1 << 19;

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};
const FONT_TYPES: Record<string, string> = {
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

type Level = 'organization' | 'instance';

/**
 * An upload refused for a reason the caller can fix. Returned as the tool's error result rather
 * than thrown, because the dispatcher replaces thrown messages with a generic one.
 */
class UploadRefused extends Error {}

/** The one answer for a path that is missing, outside the folder or swapped — no existence oracle. */
const NOT_UPLOADABLE = 'No uploadable file at that path: it must be an existing file inside ZITADEL_ASSETS_DIR.';

/** `\\server\share`, `//server/share`, `\\?\…`, `\\.\…`: resolving one already opens a network connection. */
const isUncOrDevicePath = (path: string) => /^[\\/]{2}/.test(path);

const isWithin = (root: string, path: string) => {
  const inside = relative(root, path);
  return inside !== '' && !inside.startsWith('..') && !isAbsolute(inside);
};

/**
 * Open the file an upload may read: one inside the folder ZITADEL_ASSETS_DIR names. An upload
 * publishes the file at a public asset URL, so the tool must not reach the rest of the disk —
 * not through a path, not through a symlink in the folder, and not by racing a symlink swap
 * between check and read. Without the variable there is no such folder and uploads are refused.
 *
 * 1. The path is checked lexically first, before any filesystem call: UNC and device paths are
 *    refused outright, since on Windows even resolving one opens an SMB connection that can
 *    leak the user's NTLM hash to the server it names.
 * 2. The resolved path must still lie inside the resolved folder (symlinks).
 * 3. The file is opened once and read only through that handle; resolving the path again after
 *    opening must give the same file (device and inode) inside the folder, so a swap between
 *    check and open is caught.
 */
async function openAssetFile(filePath: string): Promise<{ handle: FileHandle; name: string }> {
  const dir = process.env['ZITADEL_ASSETS_DIR'];
  if (!dir) {
    throw new UploadRefused(
      'Uploads are disabled: set ZITADEL_ASSETS_DIR to the folder branding assets may be uploaded from.'
    );
  }
  if (isUncOrDevicePath(dir)) {
    throw new UploadRefused('ZITADEL_ASSETS_DIR must be a local folder, not a network or device path.');
  }
  const lexicalRoot = resolve(dir);
  const lexical = resolve(lexicalRoot, filePath);
  if (isUncOrDevicePath(filePath) || !isWithin(lexicalRoot, lexical)) {
    throw new UploadRefused(NOT_UPLOADABLE);
  }

  let handle: FileHandle | undefined;
  try {
    const root = await realpath(lexicalRoot);
    const target = await realpath(lexical);
    if (!isWithin(root, target)) throw new UploadRefused(NOT_UPLOADABLE);

    handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    const again = await realpath(lexical);
    const current = isWithin(root, again) ? await stat(again) : undefined;
    if (!opened.isFile() || !current || current.dev !== opened.dev || current.ino !== opened.ino) {
      throw new UploadRefused(NOT_UPLOADABLE);
    }
    return { handle, name: basename(target) };
  } catch (error) {
    await handle?.close();
    throw error instanceof UploadRefused ? error : new UploadRefused(NOT_UPLOADABLE);
  }
}

/**
 * Whether the bytes are what the content type claims. The upload publishes the file at a public
 * asset URL, so the extension alone must not decide it: a secret renamed to `.png`, or reached
 * through a symlink that is, would otherwise go out as a "logo".
 */
function contentMatches(contentType: string, bytes: Buffer): boolean {
  const ascii = (start: number, text: string) => bytes.subarray(start, start + text.length).toString('latin1') === text;
  switch (contentType) {
    case 'image/png':
      return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/jpeg':
      return bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
    case 'image/gif':
      return ascii(0, 'GIF87a') || ascii(0, 'GIF89a');
    case 'image/webp':
      return ascii(0, 'RIFF') && ascii(8, 'WEBP');
    case 'image/svg+xml': {
      // Text, not binary, and an <svg> root near the start (after an optional XML declaration).
      const head = bytes.subarray(0, 4096);
      return !head.includes(0) && /<svg[\s>]/.test(head.toString('utf8'));
    }
    case 'font/ttf':
      return bytes.subarray(0, 4).equals(Buffer.from([0x00, 0x01, 0x00, 0x00])) || ascii(0, 'true');
    case 'font/otf':
      return ascii(0, 'OTTO');
    case 'font/woff':
      return ascii(0, 'wOFF');
    case 'font/woff2':
      return ascii(0, 'wOF2');
    default:
      return false;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function policyPath(level: Level, suffix = ''): string {
  const api = level === 'instance' ? 'admin' : 'management';
  return `/${api}/v1/policies/label${suffix}`;
}

function assetPath(level: Level, asset: Asset, dark: boolean): string {
  const owner = level === 'instance' ? 'instance' : 'org';
  return `/assets/v1/${owner}/policy/label/${asset}${dark ? '/dark' : ''}`;
}

function scopeLabel(level: Level, orgId: string): string {
  return level === 'instance' ? 'instance' : `org ${orgId}`;
}

/** The writable settings of a policy, with every field present — the update bodies replace the whole policy. */
function settingsOf(policy: LabelPolicy): PolicySettings {
  const out: PolicySettings = {};
  for (const field of COLOR_FIELDS) out[field] = policy[field] ?? '';
  for (const field of FLAG_FIELDS) out[field] = policy[field] ?? false;
  out.themeMode = policy.themeMode ?? 'THEME_MODE_AUTO';
  return out;
}

async function readPreview(ctx: HandlerContext, level: Level): Promise<LabelPolicy> {
  const res = await ctx.client.request<LabelPolicyResponse>(policyPath(level, '/_preview'));
  return res.policy ?? {};
}

/**
 * Make sure the org has a label policy of its own, so writes and uploads have one to land in.
 * Seeded from the inherited policy, so nothing the caller leaves alone changes. A no-op at
 * instance level, which always has one. Returns whether it created one.
 */
async function ensureOwnPolicy(ctx: HandlerContext, level: Level, preview: LabelPolicy): Promise<boolean> {
  if (level === 'instance' || !preview.isDefault) return false;
  logger.info('Creating org label policy from the inherited one');
  await ctx.client.request(policyPath(level), {
    method: 'POST',
    body: JSON.stringify(settingsOf(preview)),
  });
  return true;
}

function describePolicy(policy: LabelPolicy): string {
  const lines: string[] = [];
  for (const field of COLOR_FIELDS) lines.push(`  ${field} = ${policy[field] || '(unset)'}`);
  lines.push(`  themeMode = ${policy.themeMode ?? '(unset)'}`);
  for (const field of FLAG_FIELDS) lines.push(`  ${field} = ${policy[field] ?? false}`);
  lines.push(`  logo = ${policy.logoUrl || '(none)'}`);
  lines.push(`  logo (dark) = ${policy.logoUrlDark || '(none)'}`);
  lines.push(`  icon = ${policy.iconUrl || '(none)'}`);
  lines.push(`  icon (dark) = ${policy.iconUrlDark || '(none)'}`);
  lines.push(`  font = ${policy.fontUrl || '(none)'}`);
  return lines.join('\n');
}

/** Asset URLs carry a generated name per upload, so the URLs differ whenever the files do. */
function differs(a: LabelPolicy, b: LabelPolicy): boolean {
  const keys = [...COLOR_FIELDS, ...FLAG_FIELDS, 'themeMode', 'logoUrl', 'logoUrlDark', 'iconUrl', 'iconUrlDark', 'fontUrl'] as const;
  return keys.some((key) => (a[key] ?? '') !== (b[key] ?? ''));
}

const levelSchema = z.enum(['organization', 'instance']).default('organization');
const LEVEL_PROPERTY = {
  type: 'string',
  enum: ['organization', 'instance'],
  description: 'Scope: "organization" (default, the configured ORG_ID) or "instance" (the default for every org; needs an IAM-level grant).',
};

// ─── Tool Definitions ────────────────────────────────────────────────────────

export const BRANDING_TOOLS: ToolDefinition[] = [
  {
    name: 'zitadel_get_branding',
    description:
      'Read the branding (label policy) the hosted login and the identity mails use: colors for ' +
      'light and dark mode, theme mode, and the logo, icon and font URLs. Shows the active policy ' +
      'and says whether the draft (preview) holds changes not yet activated. Defaults to the ' +
      'configured org; pass level:"instance" for the instance default.',
    inputSchema: {
      type: 'object',
      properties: { level: LEVEL_PROPERTY },
    },
    _meta: { readOnly: true, domain: 'organizations' },
    annotations: { title: 'Get Branding', readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'zitadel_set_branding',
    description:
      'Set branding colors, theme mode and flags in the DRAFT (preview) label policy. Pass only ' +
      'the fields to change — the tool reads the draft, merges yours in and writes the result ' +
      '(idempotent). Colors are hex values such as "#1f3a5f". Nothing changes for users until ' +
      'zitadel_activate_branding runs. At org level, an org still inheriting the instance default ' +
      'first gets its own policy, seeded from the inherited one. Defaults to the configured org; ' +
      'pass level:"instance" for the instance default (needs an IAM-level grant).',
    inputSchema: {
      type: 'object',
      properties: {
        primaryColor: { type: 'string', description: 'Primary (button/link) color, light mode.' },
        backgroundColor: { type: 'string', description: 'Background color, light mode.' },
        warnColor: { type: 'string', description: 'Warning/error color, light mode.' },
        fontColor: { type: 'string', description: 'Text color, light mode.' },
        primaryColorDark: { type: 'string', description: 'Primary color, dark mode.' },
        backgroundColorDark: { type: 'string', description: 'Background color, dark mode.' },
        warnColorDark: { type: 'string', description: 'Warning/error color, dark mode.' },
        fontColorDark: { type: 'string', description: 'Text color, dark mode.' },
        themeMode: { type: 'string', enum: [...THEME_MODES], description: 'THEME_MODE_AUTO follows the visitor\'s browser; LIGHT or DARK force one.' },
        hideLoginNameSuffix: { type: 'boolean', description: 'Hide the org domain suffix on the login form.' },
        disableWatermark: { type: 'boolean', description: 'Hide the "Powered by ZITADEL" watermark (plan-dependent).' },
        level: LEVEL_PROPERTY,
      },
    },
    _meta: { readOnly: false, domain: 'organizations' },
    annotations: { title: 'Set Branding', readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'zitadel_upload_branding_asset',
    description:
      'Upload a logo, icon or font from a local file into the DRAFT (preview) label policy. The ' +
      'file must sit inside the folder ZITADEL_ASSETS_DIR names; without it, uploads are refused. ' +
      'Logo and icon have separate light- and dark-mode slots (mode); with THEME_MODE_AUTO fill ' +
      'both. Use PNG for logo and icon: the logo also goes into the identity mails, and mail ' +
      'clients do not render SVG. Sizes that work: logo about 512 px square, icon about 128 px ' +
      '(the Console\'s organization switcher), both with a transparent background and ' +
      'anti-aliased alpha edges — a raster flattened onto white keeps a light rim on the dark ' +
      'login. ZITADEL\'s limit is 512 KiB. Nothing changes for users until ' +
      'zitadel_activate_branding runs. Defaults to the configured org; pass level:"instance" for ' +
      'the instance default (needs an IAM-level grant).',
    inputSchema: {
      type: 'object',
      properties: {
        asset: { type: 'string', enum: [...ASSETS], description: 'Which slot: "logo", "icon" or "font".' },
        filePath: { type: 'string', description: 'Path of the local file to upload, inside the folder ZITADEL_ASSETS_DIR names (.png/.jpg/.gif/.webp/.svg for logo and icon; .ttf/.otf/.woff/.woff2 for font).' },
        mode: { type: 'string', enum: ['light', 'dark'], description: 'Logo and icon only: the light-mode (default) or dark-mode slot.' },
        level: LEVEL_PROPERTY,
      },
      required: ['asset', 'filePath'],
    },
    _meta: { readOnly: false, domain: 'organizations' },
    annotations: { title: 'Upload Branding Asset', readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'zitadel_activate_branding',
    description:
      'Activate the DRAFT (preview) label policy, so the hosted login and the identity mails use ' +
      'it — the Console\'s "Apply settings". Run it once after zitadel_set_branding and ' +
      'zitadel_upload_branding_asset. Defaults to the configured org; pass level:"instance" for ' +
      'the instance default (needs an IAM-level grant).',
    inputSchema: {
      type: 'object',
      properties: { level: LEVEL_PROPERTY },
    },
    _meta: { readOnly: false, domain: 'organizations' },
    annotations: { title: 'Activate Branding', readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
];

// ─── Handlers ────────────────────────────────────────────────────────────────

const getBrandingHandler: ToolHandler = async (params, ctx) => {
  const { level } = z.object({ level: levelSchema }).parse(params);
  const scope = scopeLabel(level, ctx.client.getConfig().orgId);

  const active = (await ctx.client.request<LabelPolicyResponse>(policyPath(level))).policy ?? {};
  const preview = await readPreview(ctx, level);

  const inherits = level === 'organization' && active.isDefault
    ? 'This org has no label policy of its own and inherits the instance default.\n'
    : '';
  const pending = differs(active, preview)
    ? `\nThe draft differs from the active policy (not yet activated):\n${describePolicy(preview)}`
    : '\nThe draft matches the active policy.';

  return textResponse(`${inherits}Active branding at ${scope} level:\n${describePolicy(active)}\n${pending}`);
};

const setBrandingHandler: ToolHandler = async (params, ctx) => {
  const color = z.string().max(50).optional();
  const parsed = z
    .object({
      level: levelSchema,
      primaryColor: color,
      backgroundColor: color,
      warnColor: color,
      fontColor: color,
      primaryColorDark: color,
      backgroundColorDark: color,
      warnColorDark: color,
      fontColorDark: color,
      themeMode: z.enum(THEME_MODES).optional(),
      hideLoginNameSuffix: z.boolean().optional(),
      disableWatermark: z.boolean().optional(),
    })
    .parse(params);
  const { level } = parsed;

  const patch: PolicySettings = {};
  for (const field of COLOR_FIELDS) if (parsed[field] !== undefined) patch[field] = parsed[field];
  for (const field of FLAG_FIELDS) if (parsed[field] !== undefined) patch[field] = parsed[field];
  if (parsed.themeMode !== undefined) patch.themeMode = parsed.themeMode;
  const changed = Object.keys(patch);
  if (changed.length === 0) {
    return errorResponse(`Pass at least one of: ${[...COLOR_FIELDS, 'themeMode', ...FLAG_FIELDS].join(', ')}.`);
  }

  const scope = scopeLabel(level, ctx.client.getConfig().orgId);
  const preview = await readPreview(ctx, level);
  const current = settingsOf(preview);
  const merged = { ...current, ...patch };
  const created = level === 'organization' && !!preview.isDefault;

  // ZITADEL answers an update that changes nothing with 400 ("… has not been changed"), so a
  // repeated call — a sync run over an instance that is already in step — must not send one.
  if (!created && changed.every((f) => merged[f as keyof PolicySettings] === current[f as keyof PolicySettings])) {
    return textResponse(`The DRAFT branding at ${scope} level already has these values; nothing to change.`);
  }

  logger.info('Setting branding', { level, fields: changed.length });
  // An org still inheriting gets its own policy straight from the merged settings; everything
  // else updates the policy it already has.
  await ctx.client.request(policyPath(level), {
    method: created ? 'POST' : 'PUT',
    body: JSON.stringify(merged),
  });

  const summary = changed.map((f) => `  ${f} = ${String(patch[f as keyof PolicySettings])}`).join('\n');
  return textResponse(
    `${created ? `Created a label policy for ${scope}, seeded from the inherited one. ` : ''}` +
    `Updated ${changed.length} field(s) of the DRAFT branding at ${scope} level:\n${summary}\n\n` +
    `Not live yet: run zitadel_activate_branding${level === 'instance' ? ' with level:"instance"' : ''} to apply it.`
  );
};

const uploadBrandingAssetHandler: ToolHandler = async (params, ctx) => {
  try {
    return await uploadBrandingAsset(params, ctx);
  } catch (error) {
    if (error instanceof UploadRefused) return errorResponse(error.message);
    throw error;
  }
};

const uploadBrandingAsset: ToolHandler = async (params, ctx) => {
  const { asset, filePath, mode, level } = z
    .object({
      asset: z.enum(ASSETS),
      filePath: z.string().min(1),
      mode: z.enum(['light', 'dark']).default('light'),
      level: levelSchema,
    })
    .parse(params);

  if (asset === 'font' && mode === 'dark') {
    throw new UploadRefused('Fonts have a single slot; omit mode or pass "light".');
  }

  const { handle, name } = await openAssetFile(filePath);
  let size: number;
  let bytes: Buffer;
  let contentType: string;
  try {
    const extension = extname(name).toLowerCase();
    const types = asset === 'font' ? FONT_TYPES : IMAGE_TYPES;
    const type = types[extension];
    if (!type) {
      throw new UploadRefused(`A ${asset} must be one of: ${Object.keys(types).join(', ')} (got "${extension || 'no extension'}").`);
    }
    contentType = type;

    size = (await handle.stat()).size;
    if (size > MAX_ASSET_BYTES) {
      throw new UploadRefused(`The file is ${size} bytes; ZITADEL accepts at most ${MAX_ASSET_BYTES} bytes (512 KiB).`);
    }

    bytes = await handle.readFile();
    if (!contentMatches(contentType, bytes)) {
      throw new UploadRefused(`The file's content is not ${contentType}, whatever its name says; refusing to publish it.`);
    }
  } finally {
    await handle.close();
  }

  const scope = scopeLabel(level, ctx.client.getConfig().orgId);
  const created = await ensureOwnPolicy(ctx, level, await readPreview(ctx, level));

  const form = new FormData();
  form.append('file', new Blob([bytes], { type: contentType }), name);

  const slot = asset === 'font' ? 'font' : `${asset} (${mode} mode)`;
  logger.info('Uploading branding asset', { level, asset, mode, bytes: size });
  await ctx.client.request(assetPath(level, asset, mode === 'dark'), { method: 'POST', body: form });

  const svgWarning = contentType === 'image/svg+xml'
    ? '\n\nWarning: SVG renders on the login but not in most mail clients, and the logo also goes into the identity mails. Prefer a PNG.'
    : '';
  return textResponse(
    `${created ? `Created a label policy for ${scope}, seeded from the inherited one. ` : ''}` +
    `Uploaded ${name} (${size} bytes) as the ${slot} of the DRAFT branding at ${scope} level.\n\n` +
    `Not live yet: run zitadel_activate_branding${level === 'instance' ? ' with level:"instance"' : ''} to apply it.` +
    svgWarning
  );
};

const activateBrandingHandler: ToolHandler = async (params, ctx) => {
  const { level } = z.object({ level: levelSchema }).parse(params);
  const scope = scopeLabel(level, ctx.client.getConfig().orgId);

  logger.info('Activating branding', { level });
  await ctx.client.request(policyPath(level, '/_activate'), { method: 'POST', body: '{}' });

  return textResponse(
    `Activated the draft branding at ${scope} level.\n\n` +
    `Impact: ${level === 'instance' ? 'INSTANCE-level — the default for every org without its own policy.' : 'ORG-level — the login and mails of this org\'s users.'}\n` +
    'Verify on the real login (sign in from an app) and by triggering a notification, not in the Console preview.'
  );
};

// ─── Export ──────────────────────────────────────────────────────────────────

export const BRANDING_HANDLERS: Record<string, ToolHandler> = {
  zitadel_get_branding: getBrandingHandler,
  zitadel_set_branding: setBrandingHandler,
  zitadel_upload_branding_asset: uploadBrandingAssetHandler,
  zitadel_activate_branding: activateBrandingHandler,
};
