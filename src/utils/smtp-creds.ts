/**
 * SMTP relay credentials loader.
 *
 * Keeps the SMTP secret OUT of the MCP conversation: instead of passing the relay
 * password as a tool argument (which lands in the transcript), the operator drops it in a
 * gitignored file and the server reads it at tool-call time — the same trust model as the
 * ZITADEL service-account key in ~/.secrets/zitadel/.env.
 *
 * Location: ~/.secrets/smtp/.env by default; a non-secret `profile` selects a sibling
 * ~/.secrets/smtp/.env.<profile> (so several relay creds can coexist, chosen by name, not
 * by pasting the key). SMTP_ENV_PATH overrides the base path entirely.
 *
 * Keys (relay-agnostic):
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM ("Name <addr>")
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { parse } from 'dotenv';

export interface SmtpFileCreds {
  host?: string;
  port?: string;
  user?: string;
  password?: string;
  from?: string;
}

/** Default base file when neither SMTP_ENV_PATH nor a profile is given. */
export function defaultSmtpEnvPath(): string {
  return join(homedir(), '.secrets', 'smtp', '.env');
}

/**
 * Resolve which file to read. `profile` (non-secret, validated) picks a
 * `.env.<profile>` sibling of the base file; `baseEnvPath` (from SMTP_ENV_PATH)
 * overrides the default base.
 */
export function resolveSmtpEnvPath(profile?: string, baseEnvPath?: string): string {
  const base = baseEnvPath && baseEnvPath.trim() ? baseEnvPath : defaultSmtpEnvPath();
  if (!profile) return base;
  if (!/^[A-Za-z0-9._-]+$/.test(profile)) {
    throw new Error(`Invalid credsProfile "${profile}" — use letters, digits, '.', '-', '_' only.`);
  }
  return join(dirname(base), `.env.${profile}`);
}

/**
 * Load SMTP creds from the resolved file. Returns {} when the DEFAULT file is absent (so
 * tool args can still supply everything); throws when an explicitly-named `profile` is
 * missing (the caller clearly intended to use it).
 */
export function loadSmtpCreds(profile?: string, baseEnvPath?: string): SmtpFileCreds {
  const path = resolveSmtpEnvPath(profile, baseEnvPath);
  if (!existsSync(path)) {
    if (profile) {
      throw new Error(`SMTP creds file not found: ${path} (credsProfile="${profile}").`);
    }
    return {};
  }
  const parsed = parse(readFileSync(path));
  return {
    host: parsed['SMTP_HOST'],
    port: parsed['SMTP_PORT'],
    user: parsed['SMTP_USER'],
    password: parsed['SMTP_PASSWORD'],
    from: parsed['SMTP_FROM'],
  };
}
