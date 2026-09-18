/**
 * Unexpected errors must surface, not be absorbed into a success or a "not found".
 *
 * Both paths below catch an expected, benign failure (a role that already exists, a user that
 * does not exist). The tests pin that everything else — a permission problem, an outage —
 * still reaches the caller.
 */

import { describe, it, expect, vi } from 'vitest';
import type { HandlerContext } from '../types/tools.js';
import type { ZitadelConfig } from '../utils/config.js';

const sqlCalls: string[] = [];
const sqlStub = (strings: TemplateStringsArray) => {
  sqlCalls.push(strings.join('?').trim().split('\n')[0]!.trim());
  return Promise.resolve([] as unknown[]);
};

vi.mock('postgres', () => ({ default: vi.fn(() => sqlStub) }));

import { PROVISIONING_HANDLERS } from '../tools/provisioning.js';
import { PORTAL_HANDLERS } from '../tools/portal.js';

const PROJECT = 'proj-001';
const ORG = 'org-789';

/** Error shaped like the one ZitadelClient.request throws (generic message + numeric status). */
const apiError = (status: number, message: string) =>
  Object.assign(new Error(message), { status });

type Dispatch = (path: string, method: string, body: unknown) => unknown;

function ctxWith(dispatch: Dispatch, configOverrides: Partial<ZitadelConfig> = {}): HandlerContext {
  const config = {
    issuer: 'https://test.zitadel.cloud',
    serviceAccountUserId: 'sa-123',
    serviceAccountKeyId: 'key-456',
    serviceAccountPrivateKey: 'dGVzdA==',
    orgId: ORG,
    projectId: PROJECT,
    logLevel: 'ERROR',
    ...configOverrides,
  } as ZitadelConfig;

  const request = vi.fn((path: string, opts: { method?: string; body?: string } = {}) => {
    try {
      return Promise.resolve(dispatch(path, opts.method || 'GET', opts.body ? JSON.parse(opts.body) : undefined));
    } catch (e) {
      return Promise.reject(e); // mirror the real client (rejected promise, not sync throw)
    }
  });

  return { client: { request, getConfig: () => config, clearTokenCache: vi.fn() } as never, config };
}

const isRoleSearch = (p: string) => p.includes('/roles/_search') && p.includes('/projects/');

// ─── provisioning: getUserById ────────────────────────────────────────────────

describe('zitadel_provision_user — user lookup', () => {
  it('propagates a 403 from the user lookup instead of treating the user as missing', async () => {
    const ctx = ctxWith((path) => {
      if (isRoleSearch(path)) return { result: [{ key: 'admin' }, { key: 'standard' }] };
      if (path === '/v2/users/123456789012345678') throw apiError(403, 'Permission denied for this operation.');
      throw new Error(`unmocked ${path}`);
    });

    await expect(
      PROVISIONING_HANDLERS['zitadel_provision_user']!(
        { userId: '123456789012345678', email: 'jane@example.com', firstName: 'Jane', lastName: 'Doe', role: 'admin' },
        ctx
      )
    ).rejects.toThrow('Permission denied for this operation.');
  });

  it('still falls back to the email lookup on 404', async () => {
    const seen: string[] = [];
    const ctx = ctxWith((path, method) => {
      seen.push(`${method} ${path}`);
      if (isRoleSearch(path)) return { result: [{ key: 'admin' }, { key: 'standard' }] };
      if (path === '/v2/users/123456789012345678') throw apiError(404, 'The requested resource was not found.');
      if (path.startsWith('/v2/users') && method === 'POST') return { result: [{ userId: 'u-existing' }] };
      if (path === '/v2/authorizations') return { id: 'auth-1' };
      if (path.includes('/grants/_search')) return { result: [] };
      if (path.includes('members/_search')) return { result: [] };
      if (path.includes('members')) return {};
      return {};
    });

    const res = await PROVISIONING_HANDLERS['zitadel_provision_user']!(
      { userId: '123456789012345678', email: 'jane@example.com', firstName: 'Jane', lastName: 'Doe', role: 'admin' },
      ctx
    );

    expect(res.isError).toBeFalsy();
    expect(seen.some(s => s.includes('/v2/users/123456789012345678'))).toBe(true);
  });
});

// ─── portal: project-role creation ────────────────────────────────────────────

describe('portal_setup_full_app — project role creation', () => {
  const input = {
    name: 'Proposal Rodeo',
    slug: 'proposal-rodeo',
    appUrl: 'https://proposals.example.org',
    projectId: PROJECT,
  };
  const withPortalDb = { portalDatabaseUrl: 'postgres://localhost/portal' };

  const dispatchUntilRoles = (onRoles: () => unknown): Dispatch => (path, method) => {
    if (path.includes('/apps/oidc') && method === 'POST') return { clientId: 'client-1', appId: 'app-1' };
    if (path.endsWith('/roles') && method === 'POST') return onRoles();
    return {};
  };

  it('fails loudly when the role cannot be created, instead of reporting a skip', async () => {
    sqlCalls.length = 0;
    const ctx = ctxWith(
      dispatchUntilRoles(() => { throw apiError(403, 'Permission denied for this operation.'); }),
      withPortalDb
    );

    await expect(PORTAL_HANDLERS['portal_setup_full_app']!(input, ctx))
      .rejects.toThrow('Permission denied for this operation.');

    // The portal row must not be written for an app whose role was never created.
    expect(sqlCalls).toEqual([]);
  });

  it('still treats an existing role (409) as an idempotent skip', async () => {
    sqlCalls.length = 0;
    const ctx = ctxWith(
      dispatchUntilRoles(() => { throw apiError(409, 'A conflict occurred — the resource may already exist.'); }),
      withPortalDb
    );

    const res = await PORTAL_HANDLERS['portal_setup_full_app']!(input, ctx);

    expect(res.isError).toBeFalsy();
    expect(res.content[0]!.text).toContain('already exists (skipped)');
    expect(sqlCalls.length).toBeGreaterThan(0);
  });
});
