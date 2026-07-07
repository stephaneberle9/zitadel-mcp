/**
 * SMTP creds loader tests (path resolution + file parsing, with mocked fs/os)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs', () => ({ existsSync: vi.fn(), readFileSync: vi.fn() }));
vi.mock('node:os', () => ({ homedir: () => '/home/test' }));

import { existsSync, readFileSync } from 'node:fs';
import { resolveSmtpEnvPath, defaultSmtpEnvPath, loadSmtpCreds } from '../utils/smtp-creds.js';

const norm = (p: string) => p.replace(/\\/g, '/'); // normalize Windows separators

describe('resolveSmtpEnvPath', () => {
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

describe('loadSmtpCreds', () => {
  beforeEach(() => {
    (existsSync as any).mockReset();
    (readFileSync as any).mockReset();
  });

  it('parses SMTP_* keys from the file', () => {
    (existsSync as any).mockReturnValue(true);
    (readFileSync as any).mockReturnValue(
      'SMTP_HOST=smtp-relay.brevo.com\nSMTP_PORT=587\nSMTP_USER=login\nSMTP_PASSWORD=key\nSMTP_FROM=itemis Solutions <no-reply@itemis.com>\n'
    );

    expect(loadSmtpCreds('accelerator')).toEqual({
      host: 'smtp-relay.brevo.com',
      port: '587',
      user: 'login',
      password: 'key',
      from: 'itemis Solutions <no-reply@itemis.com>',
    });
  });

  it('returns {} when the DEFAULT file is absent (args may still supply)', () => {
    (existsSync as any).mockReturnValue(false);
    expect(loadSmtpCreds()).toEqual({});
  });

  it('throws when an explicitly-named profile file is absent', () => {
    (existsSync as any).mockReturnValue(false);
    expect(() => loadSmtpCreds('accelerator')).toThrow(/not found/);
  });
});
