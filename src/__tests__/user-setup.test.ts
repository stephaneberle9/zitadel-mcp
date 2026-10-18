/**
 * Authentication setup of new human users (zitadel_create_user, zitadel_provision_user).
 *
 * Pins the exact request bodies per `setupMode` value, mirroring the Console's "Create a new user"
 * form, and that no result claims a mail ZITADEL was never asked to send.
 */

import { describe, it, expect, vi } from 'vitest';
import type { HandlerContext } from '../types/tools.js';
import type { ZitadelConfig } from '../utils/config.js';

vi.mock('postgres', () => ({ default: vi.fn(() => () => Promise.resolve([])) }));

import { USER_HANDLERS } from '../tools/users.js';
import { PROVISIONING_HANDLERS } from '../tools/provisioning.js';

const PASSWORD = 'S3cret-Initial!';
/** Any phrase that would tell the caller a mail went out. */
const MAIL_CLAIM = /(invitation|e-?mail|mail)[^.]*\b(sent|delivered)\b|\bsent to\b|mail requested/i;

/** Error shaped like the one ZitadelClient.request throws (generic message + numeric status). */
const apiError = (status: number, message: string) => Object.assign(new Error(message), { status });

interface Call { method: string; path: string; body: unknown }
type Dispatch = (call: Call) => unknown;

function ctxWith(dispatch: Dispatch): { ctx: HandlerContext; calls: Call[] } {
  const config = {
    issuer: 'https://test.zitadel.cloud',
    serviceAccountUserId: 'sa-123',
    serviceAccountKeyId: 'key-456',
    serviceAccountPrivateKey: 'dGVzdA==',
    orgId: 'org-789',
    projectId: 'proj-001',
    logLevel: 'ERROR',
  } as ZitadelConfig;
  const calls: Call[] = [];
  const request = vi.fn((path: string, opts: { method?: string; body?: string } = {}) => {
    const call = { method: opts.method || 'GET', path, body: opts.body ? JSON.parse(opts.body) : undefined };
    calls.push(call);
    try {
      return Promise.resolve(dispatch(call));
    } catch (e) {
      return Promise.reject(e);
    }
  });
  return { ctx: { client: { request, getConfig: () => config, clearTokenCache: vi.fn() } as never, config }, calls };
}

const NEW_USER = { email: 'jane@example.com', firstName: 'Jane', lastName: 'Doe' };
const PROFILE = { givenName: 'Jane', familyName: 'Doe' };

/** A ZITADEL that creates every user as `u-new` and accepts every invitation. */
const zitadel = (overrides: Dispatch = () => undefined): Dispatch => (call) => {
  const o = overrides(call);
  if (o !== undefined) return o;
  if (call.path === '/v2/users/human') return { userId: 'u-new' };
  if (call.path.endsWith('/invite_code')) return { details: {} };
  throw new Error(`unmocked ${call.method} ${call.path}`);
};

const writes = (calls: Call[]) => calls.filter((c) => c.method === 'POST' && (c.path === '/v2/users/human' || c.path.endsWith('/invite_code')));

// ─── zitadel_create_user ──────────────────────────────────────────────────────

describe('zitadel_create_user — setupMode', () => {
  it('invite (the default): creates the user unverified, then requests the invitation mail', async () => {
    const { ctx, calls } = ctxWith(zitadel());

    const res = await USER_HANDLERS['zitadel_create_user']!({ ...NEW_USER, userId: 'u-new' }, ctx);

    expect(writes(calls)).toEqual([
      {
        method: 'POST',
        path: '/v2/users/human',
        body: { profile: PROFILE, email: { email: 'jane@example.com', isVerified: false }, userId: 'u-new' },
      },
      { method: 'POST', path: '/v2/users/u-new/invite_code', body: { sendCode: {} } },
    ]);
    expect(res.isError).toBeFalsy();
    expect(res.content[0]!.text).toContain('Invitation mail requested');
    expect(res.content[0]!.text).toContain('Delivery is not confirmed');
    expect(res.content[0]!.text).not.toMatch(/\b(sent|delivered)\b/i);
  });

  it('later: creates the user and requests nothing else', async () => {
    const { ctx, calls } = ctxWith(zitadel());

    const res = await USER_HANDLERS['zitadel_create_user']!({ ...NEW_USER, setupMode: 'later', emailVerified: true }, ctx);

    expect(writes(calls)).toEqual([
      { method: 'POST', path: '/v2/users/human', body: { profile: PROFILE, email: { email: 'jane@example.com', isVerified: true } } },
    ]);
    expect(res.content[0]!.text).toContain('No mail sent');
    expect(res.content[0]!.text.replace('No mail sent', '')).not.toMatch(MAIL_CLAIM);
  });

  it('password: sets the initial password (change required by default) and never echoes it', async () => {
    const { ctx, calls } = ctxWith(zitadel());

    const res = await USER_HANDLERS['zitadel_create_user']!({ ...NEW_USER, setupMode: 'password', password: PASSWORD }, ctx);

    expect(writes(calls)).toEqual([
      {
        method: 'POST',
        path: '/v2/users/human',
        body: {
          profile: PROFILE,
          email: { email: 'jane@example.com', isVerified: false },
          password: { password: PASSWORD, changeRequired: true },
        },
      },
    ]);
    expect(res.content[0]!.text).toContain('No mail sent');
    expect(res.content[0]!.text.replace('No mail sent', '')).not.toMatch(MAIL_CLAIM);
    expect(res.content[0]!.text).not.toContain(PASSWORD);
  });

  it('password: passes passwordChangeRequired: false through', async () => {
    const { ctx, calls } = ctxWith(zitadel());

    await USER_HANDLERS['zitadel_create_user']!(
      { ...NEW_USER, setupMode: 'password', password: PASSWORD, passwordChangeRequired: false },
      ctx
    );

    expect((writes(calls)[0]!.body as { password: unknown }).password).toEqual({ password: PASSWORD, changeRequired: false });
  });

  it('rejects setupMode "password" without a password, and a password with any other setupMode', async () => {
    const { ctx, calls } = ctxWith(zitadel());

    await expect(USER_HANDLERS['zitadel_create_user']!({ ...NEW_USER, setupMode: 'password' }, ctx)).rejects.toThrow('requires a password');
    await expect(USER_HANDLERS['zitadel_create_user']!({ ...NEW_USER, password: PASSWORD }, ctx)).rejects.toThrow('only accepted');
    expect(calls).toEqual([]);
  });

  it('invite failure: keeps the user, reports its id and the failed invitation, claims no mail', async () => {
    const { ctx, calls } = ctxWith(
      zitadel((c) => {
        if (c.path.endsWith('/invite_code')) throw apiError(412, 'Precondition failed.');
      })
    );

    const res = await USER_HANDLERS['zitadel_create_user']!(NEW_USER, ctx);

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('User ID: u-new');
    expect(res.content[0]!.text).toContain('invitation request failed: Precondition failed. (HTTP 412)');
    expect(res.content[0]!.text).toContain('No mail was sent');
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });
});

// ─── zitadel_provision_user ───────────────────────────────────────────────────

/** Project defines both roles; the user does not exist yet; every grant succeeds. */
const provisioning = (overrides: Dispatch = () => undefined): Dispatch =>
  zitadel((c) => {
    const o = overrides(c);
    if (o !== undefined) return o;
    if (c.path.includes('/roles/_search')) return { result: [{ key: 'admin' }, { key: 'standard' }] };
    if (c.path === '/v2/users' && c.method === 'POST') return { result: [] };
    if (c.path.includes('/grants/_search')) return { result: [] };
    if (c.path === '/v2/authorizations') return { id: 'auth-1' };
    if (c.path.includes('members')) return { result: [] };
    return undefined;
  });

const provision = (args: Record<string, unknown>, ctx: HandlerContext) =>
  PROVISIONING_HANDLERS['zitadel_provision_user']!({ ...NEW_USER, role: 'standard', ...args }, ctx);

describe('zitadel_provision_user — setupMode', () => {
  it('invite (the default): requests the invitation mail and reports it as requested', async () => {
    const { ctx, calls } = ctxWith(provisioning());

    const res = await provision({}, ctx);

    expect(writes(calls)).toEqual([
      { method: 'POST', path: '/v2/users/human', body: { profile: PROFILE, email: { email: 'jane@example.com', isVerified: false } } },
      { method: 'POST', path: '/v2/users/u-new/invite_code', body: { sendCode: {} } },
    ]);
    expect(res.content[0]!.text).toContain('"invitation": "requested"');
    expect(res.content[0]!.text).toContain('Invitation mail requested');
    expect(res.content[0]!.text).not.toMatch(/\b(sent|delivered)\b/i);
  });

  it('later: no invitation request and no mail claimed', async () => {
    const { ctx, calls } = ctxWith(provisioning());

    const res = await provision({ setupMode: 'later' }, ctx);

    expect(writes(calls).map((c) => c.path)).toEqual(['/v2/users/human']);
    expect(res.content[0]!.text).toContain('"invitation": "none"');
    expect(res.content[0]!.text.replace('No mail sent', '')).not.toMatch(MAIL_CLAIM);
  });

  it('password: sets the initial password, claims no mail and never echoes it', async () => {
    const { ctx, calls } = ctxWith(provisioning());

    const res = await provision({ setupMode: 'password', password: PASSWORD, emailVerified: true }, ctx);

    expect(writes(calls)).toEqual([
      {
        method: 'POST',
        path: '/v2/users/human',
        body: {
          profile: PROFILE,
          email: { email: 'jane@example.com', isVerified: true },
          password: { password: PASSWORD, changeRequired: true },
        },
      },
    ]);
    expect(res.content[0]!.text.replace('No mail sent', '')).not.toMatch(MAIL_CLAIM);
    expect(res.content[0]!.text).not.toContain(PASSWORD);
  });

  it('invite failure: still assigns the role, keeps the user and reports the failure', async () => {
    const { ctx, calls } = ctxWith(
      provisioning((c) => {
        if (c.path.endsWith('/invite_code')) throw apiError(500, 'Internal error.');
      })
    );

    const res = await provision({}, ctx);

    expect(res.isError).toBeFalsy();
    expect(res.content[0]!.text).toContain('"zitadelUserId": "u-new"');
    expect(res.content[0]!.text).toContain('"invitation": "failed"');
    expect(res.content[0]!.text).toContain('invitation request failed: Internal error. (HTTP 500)');
    expect(calls.some((c) => c.path === '/v2/authorizations')).toBe(true);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('reuses an existing user without creating, inviting or claiming a mail', async () => {
    const { ctx, calls } = ctxWith(
      provisioning((c) => {
        if (c.path === '/v2/users' && c.method === 'POST') return { result: [{ userId: 'u-old', human: { email: { email: 'jane@example.com' } } }] };
      })
    );

    const res = await provision({}, ctx);

    expect(writes(calls)).toEqual([]);
    expect(res.content[0]!.text).toContain('"invitation": "none"');
    expect(res.content[0]!.text).toContain('no mail was sent');
  });
});
