/**
 * SMTP creds loader tests (path resolution, provider-folder discovery, file parsing)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs', () => ({ existsSync: vi.fn(), readFileSync: vi.fn(), readdirSync: vi.fn() }));
vi.mock('node:os', () => ({ homedir: () => '/home/test' }));

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import {
  resolveSmtpEnvPath,
  defaultSmtpEnvPath,
  resolveSmtpCredsPath,
  discoverSmtpEnvFiles,
  loadSmtpCreds,
} from '../utils/smtp-creds.js';

const norm = (p?: string) => (p ? p.replace(/\\/g, '/') : p); // normalize Windows separators

/** Build a directory listing as (withFileTypes) dirents of sub-folders. */
const dirents = (names: string[]) =>
  names.map((name) => ({ name, isDirectory: () => true }));

const SMTP_BODY = 'SMTP_HOST=smtp-relay.brevo.com\nSMTP_USER=login\nSMTP_PASSWORD=key\n';

beforeEach(() => {
  (existsSync as any).mockReset();
  (readFileSync as any).mockReset();
  (readdirSync as any).mockReset();
});

describe('resolveSmtpEnvPath (SMTP_ENV_PATH base + profile)', () => {
  it('defaults to ~/.secrets/smtp/.env', () => {
    expect(norm(defaultSmtpEnvPath())).toBe('/home/test/.secrets/smtp/.env');
    expect(norm(resolveSmtpEnvPath())).toBe('/home/test/.secrets/smtp/.env');
  });

  it('maps a profile to a .env.<profile> sibling', () => {
    expect(norm(resolveSmtpEnvPath('accelerator'))).toBe('/home/test/.secrets/smtp/.env.accelerator');
  });

  it('honors SMTP_ENV_PATH as the base', () => {
    expect(norm(resolveSmtpEnvPath(undefined, '/custom/relay.env'))).toBe('/custom/relay.env');
    expect(norm(resolveSmtpEnvPath('staging', '/custom/relay.env'))).toBe('/custom/.env.staging');
  });

  it('rejects a profile with path-traversal characters', () => {
    expect(() => resolveSmtpEnvPath('../../etc/passwd')).toThrow(/Invalid credsProfile/);
    expect(() => resolveSmtpEnvPath('a/b')).toThrow(/Invalid credsProfile/);
  });
});

describe('resolveSmtpCredsPath (credsDir + discovery)', () => {
  it('reads a named provider folder under ~/.secrets via credsDir', () => {
    expect(norm(resolveSmtpCredsPath({ credsDir: 'brevo', profile: 'accelerator' }))).toBe(
      '/home/test/.secrets/brevo/.env.accelerator'
    );
    expect(norm(resolveSmtpCredsPath({ credsDir: 'brevo' }))).toBe('/home/test/.secrets/brevo/.env');
  });

  it('accepts an absolute credsDir', () => {
    expect(norm(resolveSmtpCredsPath({ credsDir: '/abs/relay', profile: 'p' }))).toBe('/abs/relay/.env.p');
  });

  it('SMTP_ENV_PATH base wins over discovery', () => {
    expect(norm(resolveSmtpCredsPath({ profile: 'staging', baseEnvPath: '/custom/relay.env' }))).toBe(
      '/custom/.env.staging'
    );
  });

  it('discovers the single provider folder holding a matching SMTP env file', () => {
    (existsSync as any).mockReturnValue(true);
    (readdirSync as any).mockReturnValue(dirents(['brevo', 'zitadel', 'curaibo']));
    // Only brevo/.env.accelerator exists and looks like SMTP.
    (existsSync as any).mockImplementation((p: string) => norm(p)!.endsWith('/brevo/.env.accelerator') || norm(p)!.endsWith('/.secrets'));
    (readFileSync as any).mockReturnValue(SMTP_BODY);

    expect(norm(resolveSmtpCredsPath({ profile: 'accelerator' }))).toBe(
      '/home/test/.secrets/brevo/.env.accelerator'
    );
  });

  it('throws an actionable error when several provider folders match', () => {
    (readdirSync as any).mockReturnValue(dirents(['brevo', 'postmark']));
    (existsSync as any).mockImplementation((p: string) => {
      const n = norm(p)!;
      return n.endsWith('/.secrets') || n.endsWith('.env.accelerator');
    });
    (readFileSync as any).mockReturnValue(SMTP_BODY);

    expect(() => resolveSmtpCredsPath({ profile: 'accelerator' })).toThrow(/Ambiguous SMTP creds/);
    expect(() => resolveSmtpCredsPath({ profile: 'accelerator' })).toThrow(/credsDir/);
  });

  it('throws with provider-name hints when a named profile finds nothing', () => {
    (existsSync as any).mockImplementation((p: string) => norm(p)!.endsWith('/.secrets'));
    (readdirSync as any).mockReturnValue(dirents(['zitadel']));

    expect(() => resolveSmtpCredsPath({ profile: 'accelerator' })).toThrow(/No SMTP creds found/);
    expect(() => resolveSmtpCredsPath({ profile: 'accelerator' })).toThrow(/brevo/);
  });

  it('is lenient (returns undefined) when nothing is named and nothing is discovered', () => {
    (existsSync as any).mockReturnValue(false); // no ~/.secrets at all
    expect(resolveSmtpCredsPath({})).toBeUndefined();
  });
});

describe('discoverSmtpEnvFiles', () => {
  it('returns [] when ~/.secrets is absent', () => {
    (existsSync as any).mockReturnValue(false);
    expect(discoverSmtpEnvFiles('accelerator')).toEqual([]);
  });

  it('skips folders whose env file lacks SMTP_HOST', () => {
    (existsSync as any).mockReturnValue(true);
    (readdirSync as any).mockReturnValue(dirents(['brevo', 'zitadel']));
    (readFileSync as any).mockImplementation((p: string) =>
      norm(p)!.includes('/brevo/') ? SMTP_BODY : 'ZITADEL_TOKEN=abc\n'
    );
    expect(discoverSmtpEnvFiles('accelerator').map(norm)).toEqual([
      '/home/test/.secrets/brevo/.env.accelerator',
    ]);
  });
});

describe('loadSmtpCreds', () => {
  it('parses SMTP_* keys and reports the source path (legacy positional profile arg)', () => {
    (existsSync as any).mockReturnValue(true);
    (readdirSync as any).mockReturnValue(dirents(['brevo']));
    (existsSync as any).mockImplementation((p: string) => {
      const n = norm(p)!;
      return n.endsWith('/.secrets') || n.endsWith('/brevo/.env.accelerator');
    });
    (readFileSync as any).mockReturnValue(
      'SMTP_HOST=smtp-relay.brevo.com\nSMTP_PORT=587\nSMTP_USER=login\nSMTP_PASSWORD=key\nSMTP_FROM=itemis Solutions <no-reply@itemis.com>\n'
    );

    const creds = loadSmtpCreds('accelerator');
    expect({ ...creds, sourcePath: norm(creds.sourcePath) }).toEqual({
      host: 'smtp-relay.brevo.com',
      port: '587',
      user: 'login',
      password: 'key',
      from: 'itemis Solutions <no-reply@itemis.com>',
      sourcePath: '/home/test/.secrets/brevo/.env.accelerator',
    });
  });

  it('returns {} when nothing is named and nothing is discovered (args may still supply)', () => {
    (existsSync as any).mockReturnValue(false);
    expect(loadSmtpCreds()).toEqual({});
  });

  it('throws when an explicit credsDir names a missing file', () => {
    (existsSync as any).mockReturnValue(false);
    expect(() => loadSmtpCreds({ credsDir: 'brevo', profile: 'accelerator' })).toThrow(/not found/);
  });
});
