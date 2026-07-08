/**
 * SMTP relay credentials loader.
 *
 * Keeps the SMTP secret OUT of the MCP conversation: instead of passing the relay
 * password as a tool argument (which lands in the transcript), the operator drops it in a
 * gitignored file and the server reads it at tool-call time — the same trust model as the
 * ZITADEL service-account key in ~/.secrets/zitadel/.env.
 *
 * Layout: the operator organises `~/.secrets/` as one sub-folder per service/provider
 * (e.g. `~/.secrets/brevo/`, `~/.secrets/postmark/`), each holding a default `.env` and/or
 * per-target `.env.<profile>` files (e.g. `.env.accelerator`, `.env.staging`). This lets
 * several SMTP relays coexist, selected by name rather than by pasting the key.
 *
 * Resolution of the file to read, in precedence order:
 *   1. SMTP_ENV_PATH (baseEnvPath) — full path to a base .env; a profile picks a sibling
 *      `.env.<profile>`. Explicit escape hatch, unchanged for back-compat.
 *   2. credsDir — an explicit provider folder: a bare name under ~/.secrets (e.g. "brevo")
 *      or an absolute path. Reads `<dir>/.env[.<profile>]`.
 *   3. Discovery — scan each `~/.secrets/<provider>/` for a `.env[.<profile>]` that defines
 *      SMTP_HOST.
 *      Exactly one match is used; several matches or (for a named profile) none is a
 *      clear, actionable error so the caller can pass `credsDir` or create the folder.
 *
 * Keys (relay-agnostic — the folder/profile is the namespace):
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM ("Name <addr>")
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, isAbsolute } from 'node:path';
import { parse } from 'dotenv';

export interface SmtpFileCreds {
  host?: string;
  port?: string;
  user?: string;
  password?: string;
  from?: string;
}

export interface LoadedSmtpCreds extends SmtpFileCreds {
  /** Absolute file the creds were read from, or undefined when none was resolved (lenient default). */
  sourcePath?: string;
}

export interface SmtpCredsOptions {
  /** Non-secret target selector picking a `.env.<profile>` file (omit for the base `.env`). */
  profile?: string;
  /** Explicit provider folder: a bare name under ~/.secrets (e.g. "brevo") or an absolute path. */
  credsDir?: string;
  /** SMTP_ENV_PATH: full path to a base .env file, overriding the default location entirely. */
  baseEnvPath?: string;
}

/** Typical SMTP-provider folder names, suggested when discovery finds nothing. */
export const SMTP_PROVIDER_FOLDER_HINTS = [
  'brevo',
  'amazon-ses',
  'postmark',
  'mailgun',
  'mailjet',
  'sendgrid',
  'google',
  'mailchimp',
  'microsoft-exchange',
  'generic-smtp',
];

/** Root of the per-service secrets tree. */
function secretsRoot(): string {
  return join(homedir(), '.secrets');
}

/** File name for a given profile (`.env` or `.env.<profile>`). */
function envFileName(profile?: string): string {
  return profile ? `.env.${profile}` : '.env';
}

/** Reject profile/dir names that could escape the intended tree. */
function assertSafeSegment(value: string, kind: 'credsProfile' | 'credsDir'): void {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`Invalid ${kind} "${value}" — use letters, digits, '.', '-', '_' only.`);
  }
}

/** Default base file when neither SMTP_ENV_PATH, credsDir nor discovery is used. */
export function defaultSmtpEnvPath(): string {
  return join(secretsRoot(), 'smtp', '.env');
}

/**
 * Resolve which file the SMTP_ENV_PATH base + profile pair points at. `profile`
 * (non-secret, validated) picks a `.env.<profile>` sibling of the base file;
 * `baseEnvPath` (from SMTP_ENV_PATH) overrides the default base.
 */
export function resolveSmtpEnvPath(profile?: string, baseEnvPath?: string): string {
  const base = baseEnvPath && baseEnvPath.trim() ? baseEnvPath : defaultSmtpEnvPath();
  if (!profile) return base;
  assertSafeSegment(profile, 'credsProfile');
  return join(dirname(base), envFileName(profile));
}

/** Does the file at `path` look like an SMTP creds file (defines SMTP_HOST)? */
function looksLikeSmtpEnv(path: string): boolean {
  try {
    return Boolean(parse(readFileSync(path))['SMTP_HOST']);
  } catch {
    return false;
  }
}

/**
 * Scan each `~/.secrets/<provider>/` for a `.env[.<profile>]` file that defines SMTP_HOST.
 * Returns the matching absolute paths (empty when the secrets root is absent).
 */
export function discoverSmtpEnvFiles(profile?: string): string[] {
  const root = secretsRoot();
  if (!existsSync(root)) return [];
  const fname = envFileName(profile);
  const hits: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(root, entry.name, fname);
    if (existsSync(candidate) && looksLikeSmtpEnv(candidate)) hits.push(candidate);
  }
  return hits;
}

/** Turn an absolute env-file path back into its owning `~/.secrets/<folder>` name for messages. */
function folderLabel(path: string): string {
  return dirname(path).split(/[/\\]/).pop() ?? path;
}

/**
 * Resolve the single creds file to read, applying the precedence order documented above.
 * Returns the path, or `undefined` for the lenient default case (no profile / credsDir /
 * base override and nothing discovered — the caller may still supply everything as args).
 * Throws with an actionable message on ambiguity or a missing explicitly-named target.
 */
export function resolveSmtpCredsPath(opts: SmtpCredsOptions = {}): string | undefined {
  const { profile, credsDir, baseEnvPath } = opts;

  // 1. Explicit SMTP_ENV_PATH base (unchanged escape hatch).
  if (baseEnvPath && baseEnvPath.trim()) {
    return resolveSmtpEnvPath(profile, baseEnvPath);
  }

  // 2. Explicit provider folder.
  if (credsDir && credsDir.trim()) {
    let dir: string;
    if (isAbsolute(credsDir)) {
      dir = credsDir;
    } else {
      assertSafeSegment(credsDir, 'credsDir');
      dir = join(secretsRoot(), credsDir);
    }
    if (profile) assertSafeSegment(profile, 'credsProfile');
    return join(dir, envFileName(profile));
  }

  // 3. Discovery across ~/.secrets/*/.
  if (profile) assertSafeSegment(profile, 'credsProfile');
  const matches = discoverSmtpEnvFiles(profile);

  if (matches.length === 1) return matches[0];

  if (matches.length > 1) {
    const folders = matches.map(folderLabel);
    throw new Error(
      `Ambiguous SMTP creds: ${envFileName(profile)} with SMTP_* keys exists in multiple ` +
        `~/.secrets folders (${folders.join(', ')}). Pass credsDir to pick one (e.g. credsDir: "${folders[0]}").`
    );
  }

  // No matches.
  if (profile) {
    throw new Error(
      `No SMTP creds found for profile "${profile}". Expected a ~/.secrets/<provider>/${envFileName(
        profile
      )} file with SMTP_* keys (SMTP_HOST/PORT/USER/PASSWORD/FROM). ` +
        `Create one under a provider folder — typical names: ${SMTP_PROVIDER_FOLDER_HINTS.join(
          ', '
        )} — or pass credsDir to point at an existing folder.`
    );
  }

  // Lenient default: nothing named, nothing found → caller's args may supply everything.
  return undefined;
}

/**
 * Load SMTP creds from the resolved file. See {@link resolveSmtpCredsPath} for how the file
 * is chosen. Returns `{}` (with no sourcePath) only in the lenient default case; throws when
 * a resolved-but-explicit file is missing so a typo in credsDir/credsProfile is not silent.
 *
 * Accepts either the options object (preferred) or the legacy `(profile, baseEnvPath)` args.
 */
export function loadSmtpCreds(
  optsOrProfile?: SmtpCredsOptions | string,
  baseEnvPath?: string
): LoadedSmtpCreds {
  const opts: SmtpCredsOptions =
    typeof optsOrProfile === 'string' || optsOrProfile === undefined
      ? { profile: optsOrProfile, baseEnvPath }
      : optsOrProfile;

  const path = resolveSmtpCredsPath(opts);
  if (!path) return {};

  if (!existsSync(path)) {
    // Reached only via an explicit base/credsDir/profile that named a missing file.
    const via = opts.credsDir
      ? `credsDir="${opts.credsDir}"`
      : opts.profile
        ? `credsProfile="${opts.profile}"`
        : 'SMTP_ENV_PATH';
    throw new Error(`SMTP creds file not found: ${path} (${via}).`);
  }

  const parsed = parse(readFileSync(path));
  return {
    host: parsed['SMTP_HOST'],
    port: parsed['SMTP_PORT'],
    user: parsed['SMTP_USER'],
    password: parsed['SMTP_PASSWORD'],
    from: parsed['SMTP_FROM'],
    sourcePath: path,
  };
}
