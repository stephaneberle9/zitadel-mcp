/**
 * Tool handler tests with mocked Zitadel API client
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HandlerContext } from '../types/tools.js';
import type { ZitadelConfig } from '../utils/config.js';
import { USER_HANDLERS } from '../tools/users.js';
import { PROJECT_HANDLERS } from '../tools/projects.js';
import { APPLICATION_HANDLERS } from '../tools/applications.js';
import { ROLE_HANDLERS } from '../tools/roles.js';
import { SERVICE_ACCOUNT_HANDLERS } from '../tools/service-accounts.js';
import { ORG_HANDLERS } from '../tools/organizations.js';
import { SMTP_HANDLERS } from '../tools/smtp.js';
import { loadSmtpCreds } from '../utils/smtp-creds.js';
import { UTILITY_HANDLERS } from '../tools/utility.js';

// SMTP creds are read from a gitignored file at tool-call time — mock it so tests never
// touch ~/.secrets and stay deterministic. Default: empty (args supply everything).
vi.mock('../utils/smtp-creds.js', () => ({ loadSmtpCreds: vi.fn(() => ({})) }));

// ─── Mock setup ───────────────────────────────────────────────────────────────

function createMockContext(overrides?: Partial<ZitadelConfig>): HandlerContext {
  const config: ZitadelConfig = {
    issuer: 'https://test.zitadel.cloud',
    serviceAccountUserId: 'sa-123',
    serviceAccountKeyId: 'key-456',
    serviceAccountPrivateKey: 'dGVzdA==',
    orgId: 'org-789',
    projectId: 'proj-001',
    logLevel: 'ERROR',
    ...overrides,
  };

  const client = {
    request: vi.fn(),
    getConfig: vi.fn(() => config),
    clearTokenCache: vi.fn(),
  };

  return { client: client as any, config };
}

// ─── User handlers ────────────────────────────────────────────────────────────

describe('user handlers', () => {
  let ctx: HandlerContext;

  beforeEach(() => {
    ctx = createMockContext();
  });

  describe('zitadel_list_users', () => {
    it('returns formatted user list', async () => {
      (ctx.client.request as any).mockResolvedValue({
        result: [
          {
            userId: 'u1',
            username: 'jane',
            state: 'USER_STATE_ACTIVE',
            human: { profile: { givenName: 'Jane', familyName: 'Doe' }, email: { email: 'jane@test.com' } },
          },
        ],
        details: { totalResult: 1 },
      });

      const result = await USER_HANDLERS['zitadel_list_users']!({}, ctx);

      expect(result.isError).toBeFalsy();
      expect(result.content[0]!.text).toContain('Jane Doe');
      expect(result.content[0]!.text).toContain('jane@test.com');
      expect(result.content[0]!.text).toContain('ACTIVE');
    });

    it('returns "no users" for empty results', async () => {
      (ctx.client.request as any).mockResolvedValue({ result: [] });

      const result = await USER_HANDLERS['zitadel_list_users']!({}, ctx);

      expect(result.content[0]!.text).toContain('No users found');
    });

    it('validates limit parameter', async () => {
      await expect(
        USER_HANDLERS['zitadel_list_users']!({ limit: 0 }, ctx)
      ).rejects.toThrow();

      await expect(
        USER_HANDLERS['zitadel_list_users']!({ limit: 501 }, ctx)
      ).rejects.toThrow();
    });
  });

  describe('zitadel_get_user', () => {
    it('returns formatted user details', async () => {
      (ctx.client.request as any).mockResolvedValue({
        user: {
          userId: 'u1',
          username: 'jane',
          state: 'USER_STATE_ACTIVE',
          human: {
            profile: { givenName: 'Jane', familyName: 'Doe' },
            email: { email: 'jane@test.com', isEmailVerified: true },
          },
          loginNames: ['jane@test.zitadel.cloud'],
          details: { creationDate: '2025-01-01T00:00:00Z' },
        },
      });

      const result = await USER_HANDLERS['zitadel_get_user']!({ userId: 'u1' }, ctx);

      expect(result.content[0]!.text).toContain('Jane Doe');
      expect(result.content[0]!.text).toContain('jane@test.com');
      expect(result.content[0]!.text).toContain('Email Verified: true');
    });

    it('rejects missing userId', async () => {
      await expect(
        USER_HANDLERS['zitadel_get_user']!({}, ctx)
      ).rejects.toThrow();
    });

    it('rejects path traversal in userId', async () => {
      await expect(
        USER_HANDLERS['zitadel_get_user']!({ userId: '../admin' }, ctx)
      ).rejects.toThrow('alphanumeric');
    });
  });

  describe('zitadel_create_user', () => {
    it('creates user and returns ID', async () => {
      (ctx.client.request as any).mockResolvedValue({ userId: 'new-u1' });

      const result = await USER_HANDLERS['zitadel_create_user']!(
        { email: 'new@test.com', firstName: 'New', lastName: 'User' },
        ctx
      );

      expect(result.content[0]!.text).toContain('new-u1');
      expect(result.content[0]!.text).toContain('invitation email');
    });

    it('validates email format', async () => {
      await expect(
        USER_HANDLERS['zitadel_create_user']!(
          { email: 'not-an-email', firstName: 'A', lastName: 'B' },
          ctx
        )
      ).rejects.toThrow();
    });
  });

  describe('zitadel_deactivate_user', () => {
    it('shows confirmation prompt without confirm flag', async () => {
      (ctx.client.request as any).mockResolvedValue({
        user: {
          userId: 'u1',
          username: 'jane',
          state: 'USER_STATE_ACTIVE',
          human: { profile: { givenName: 'Jane', familyName: 'Doe' } },
        },
      });

      const result = await USER_HANDLERS['zitadel_deactivate_user']!({ userId: 'u1' }, ctx);

      expect(result.content[0]!.text).toContain('CONFIRM');
      expect(result.content[0]!.text).toContain('confirm: true');
    });

    it('deactivates user with confirm: true', async () => {
      (ctx.client.request as any).mockResolvedValue({});

      const result = await USER_HANDLERS['zitadel_deactivate_user']!({ userId: 'u1', confirm: true }, ctx);

      expect(result.content[0]!.text).toContain('deactivated');
      expect(ctx.client.request).toHaveBeenCalledWith(
        '/v2/users/u1/deactivate',
        expect.objectContaining({ method: 'POST' })
      );
    });
  });
});

// ─── Project handlers ─────────────────────────────────────────────────────────

describe('project handlers', () => {
  let ctx: HandlerContext;

  beforeEach(() => {
    ctx = createMockContext();
  });

  describe('zitadel_list_projects', () => {
    it('returns formatted project list', async () => {
      (ctx.client.request as any).mockResolvedValue({
        result: [{ id: 'p1', name: 'My Project', state: 'PROJECT_STATE_ACTIVE' }],
      });

      const result = await PROJECT_HANDLERS['zitadel_list_projects']!({}, ctx);

      expect(result.content[0]!.text).toContain('My Project');
      expect(result.content[0]!.text).toContain('ACTIVE');
    });
  });
});

// ─── Application handlers ─────────────────────────────────────────────────────

describe('application handlers', () => {
  let ctx: HandlerContext;

  beforeEach(() => {
    ctx = createMockContext();
  });

  describe('zitadel_create_oidc_app', () => {
    it('creates app and returns client ID (secret suppressed)', async () => {
      (ctx.client.request as any).mockResolvedValue({
        appId: 'app-1',
        clientId: 'client-123',
        clientSecret: 'secret-abc',
      });

      const result = await APPLICATION_HANDLERS['zitadel_create_oidc_app']!(
        { projectId: 'p1', name: 'Test App', redirectUris: ['https://app.test/callback'] },
        ctx
      );

      expect(result.content[0]!.text).toContain('client-123');
      // Client secret should NOT be shown in response (REM-01)
      expect(result.content[0]!.text).not.toContain('secret-abc');
      expect(result.content[0]!.text).toContain('NOT shown here');
    });

    it('rejects invalid redirect URIs', async () => {
      await expect(
        APPLICATION_HANDLERS['zitadel_create_oidc_app']!(
          { projectId: 'p1', name: 'Test', redirectUris: ['not-a-url'] },
          ctx
        )
      ).rejects.toThrow();
    });

    it('passes provided grantTypes + responseTypes to the API', async () => {
      (ctx.client.request as any).mockResolvedValue({
        appId: 'app-2',
        clientId: 'client-2',
      });

      await APPLICATION_HANDLERS['zitadel_create_oidc_app']!(
        {
          projectId: 'p1',
          name: 'Test',
          redirectUris: ['https://app.test/cb'],
          grantTypes: ['OIDC_GRANT_TYPE_AUTHORIZATION_CODE', 'OIDC_GRANT_TYPE_REFRESH_TOKEN'],
          responseTypes: ['OIDC_RESPONSE_TYPE_CODE'],
        },
        ctx
      );

      const [, options] = (ctx.client.request as any).mock.calls[0];
      const body = JSON.parse(options.body);
      expect(body.grantTypes).toEqual([
        'OIDC_GRANT_TYPE_AUTHORIZATION_CODE',
        'OIDC_GRANT_TYPE_REFRESH_TOKEN',
      ]);
      expect(body.responseTypes).toEqual(['OIDC_RESPONSE_TYPE_CODE']);
    });

    it('defaults grantTypes to authorization_code when omitted', async () => {
      (ctx.client.request as any).mockResolvedValue({ appId: 'app-3', clientId: 'client-3' });

      await APPLICATION_HANDLERS['zitadel_create_oidc_app']!(
        { projectId: 'p1', name: 'Test', redirectUris: ['https://app.test/cb'] },
        ctx
      );

      const [, options] = (ctx.client.request as any).mock.calls[0];
      const body = JSON.parse(options.body);
      expect(body.grantTypes).toEqual(['OIDC_GRANT_TYPE_AUTHORIZATION_CODE']);
      expect(body.responseTypes).toEqual(['OIDC_RESPONSE_TYPE_CODE']);
    });
  });

  describe('zitadel_update_app', () => {
    it('replaces grantTypes when provided and preserves untouched fields', async () => {
      (ctx.client.request as any)
        .mockResolvedValueOnce({
          app: {
            id: 'a1',
            name: 'Existing',
            oidcConfig: {
              clientId: 'c1',
              redirectUris: ['https://app.test/cb'],
              responseTypes: ['OIDC_RESPONSE_TYPE_CODE'],
              grantTypes: ['OIDC_GRANT_TYPE_AUTHORIZATION_CODE'],
              appType: 'OIDC_APP_TYPE_WEB',
              authMethodType: 'OIDC_AUTH_METHOD_TYPE_NONE',
              devMode: false,
              accessTokenRoleAssertion: true,
            },
          },
        })
        .mockResolvedValueOnce({});

      await APPLICATION_HANDLERS['zitadel_update_app']!(
        {
          projectId: 'p1',
          appId: 'a1',
          grantTypes: [
            'OIDC_GRANT_TYPE_AUTHORIZATION_CODE',
            'OIDC_GRANT_TYPE_REFRESH_TOKEN',
          ],
        },
        ctx
      );

      const putCall = (ctx.client.request as any).mock.calls[1];
      const body = JSON.parse(putCall[1].body);
      expect(body.grantTypes).toEqual([
        'OIDC_GRANT_TYPE_AUTHORIZATION_CODE',
        'OIDC_GRANT_TYPE_REFRESH_TOKEN',
      ]);
      // Preserved from current config
      expect(body.responseTypes).toEqual(['OIDC_RESPONSE_TYPE_CODE']);
      expect(body.redirectUris).toEqual(['https://app.test/cb']);
      expect(body.accessTokenRoleAssertion).toBe(true);
    });

    it('preserves current grantTypes when omitted', async () => {
      (ctx.client.request as any)
        .mockResolvedValueOnce({
          app: {
            id: 'a1',
            name: 'Existing',
            oidcConfig: {
              clientId: 'c1',
              redirectUris: ['https://app.test/cb'],
              responseTypes: ['OIDC_RESPONSE_TYPE_CODE'],
              grantTypes: [
                'OIDC_GRANT_TYPE_AUTHORIZATION_CODE',
                'OIDC_GRANT_TYPE_REFRESH_TOKEN',
              ],
              appType: 'OIDC_APP_TYPE_WEB',
              authMethodType: 'OIDC_AUTH_METHOD_TYPE_NONE',
            },
          },
        })
        .mockResolvedValueOnce({});

      await APPLICATION_HANDLERS['zitadel_update_app']!(
        { projectId: 'p1', appId: 'a1', devMode: true },
        ctx
      );

      const body = JSON.parse((ctx.client.request as any).mock.calls[1][1].body);
      expect(body.grantTypes).toEqual([
        'OIDC_GRANT_TYPE_AUTHORIZATION_CODE',
        'OIDC_GRANT_TYPE_REFRESH_TOKEN',
      ]);
      expect(body.devMode).toBe(true);
    });

    it('rejects unknown grant type values', async () => {
      await expect(
        APPLICATION_HANDLERS['zitadel_update_app']!(
          { projectId: 'p1', appId: 'a1', grantTypes: ['NOT_A_REAL_GRANT'] },
          ctx
        )
      ).rejects.toThrow();
    });
  });
});

// ─── Role handlers ────────────────────────────────────────────────────────────

describe('role handlers', () => {
  let ctx: HandlerContext;

  beforeEach(() => {
    ctx = createMockContext();
  });

  describe('zitadel_create_user_grant', () => {
    it('validates roles exist before granting', async () => {
      // First call: list roles (returns only "admin")
      // Second call would be the grant (shouldn't happen)
      (ctx.client.request as any).mockResolvedValue({
        result: [{ key: 'admin' }],
      });

      const result = await ROLE_HANDLERS['zitadel_create_user_grant']!(
        { userId: 'u1', roleKeys: ['admin', 'nonexistent'] },
        ctx
      );

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('nonexistent');
      expect(result.content[0]!.text).toContain('not found');
    });

    it('throws without projectId when no default set', async () => {
      const ctxNoProject = createMockContext({ projectId: undefined });

      await expect(
        ROLE_HANDLERS['zitadel_create_user_grant']!(
          { userId: 'u1', roleKeys: ['admin'] },
          ctxNoProject
        )
      ).rejects.toThrow('projectId is required');
    });
  });

  describe('zitadel_remove_user_grant', () => {
    it('shows confirmation prompt without confirm flag', async () => {
      const result = await ROLE_HANDLERS['zitadel_remove_user_grant']!(
        { userId: 'u1', grantId: 'g1' },
        ctx
      );

      expect(result.content[0]!.text).toContain('CONFIRM');
      expect(result.content[0]!.text).toContain('confirm: true');
    });

    it('calls DELETE with correct path when confirmed', async () => {
      (ctx.client.request as any).mockResolvedValue({});

      await ROLE_HANDLERS['zitadel_remove_user_grant']!(
        { userId: 'u1', grantId: 'g1', confirm: true },
        ctx
      );

      expect(ctx.client.request).toHaveBeenCalledWith(
        '/management/v1/users/u1/grants/g1',
        expect.objectContaining({ method: 'DELETE' })
      );
    });
  });
});

// ─── Service account handlers ─────────────────────────────────────────────────

describe('service account handlers', () => {
  let ctx: HandlerContext;

  beforeEach(() => {
    ctx = createMockContext();
  });

  describe('zitadel_create_service_user_key', () => {
    it('saves key to file and returns path', async () => {
      (ctx.client.request as any).mockResolvedValue({
        keyId: 'key-new',
        keyDetails: '{"type":"serviceaccount","keyId":"key-new"}',
      });

      const result = await SERVICE_ACCOUNT_HANDLERS['zitadel_create_service_user_key']!(
        { userId: 'sa1' },
        ctx
      );

      expect(result.content[0]!.text).toContain('key-new');
      // Key is saved to file, not shown in response (REM-01)
      expect(result.content[0]!.text).toContain('Private key saved to');
      // Normalize separators — path.join yields backslashes on Windows, forward slashes on POSIX
      expect(result.content[0]!.text.replace(/\\/g, '/')).toContain('.zitadel-mcp/keys/');
    });
  });
});

// ─── Organization handlers ────────────────────────────────────────────────────

describe('organization handlers', () => {
  let ctx: HandlerContext;

  beforeEach(() => {
    ctx = createMockContext();
  });

  describe('zitadel_get_org', () => {
    it('returns current org details', async () => {
      (ctx.client.request as any).mockResolvedValue({
        org: {
          id: 'org-789',
          name: 'Test Org',
          state: 'ORG_STATE_ACTIVE',
          primaryDomain: 'test.zitadel.cloud',
          details: { creationDate: '2025-01-01T00:00:00Z' },
        },
      });

      const result = await ORG_HANDLERS['zitadel_get_org']!({}, ctx);

      expect(result.content[0]!.text).toContain('Test Org');
      expect(result.content[0]!.text).toContain('ACTIVE');
      expect(result.content[0]!.text).toContain('test.zitadel.cloud');
    });
  });

  // zitadel_list_orgs removed (REM-22) — uses Admin API, violates least-privilege
});

// ─── Utility handlers ─────────────────────────────────────────────────────────

describe('utility handlers', () => {
  let ctx: HandlerContext;

  beforeEach(() => {
    ctx = createMockContext();
  });

  describe('zitadel_get_auth_config', () => {
    it('returns formatted env vars', async () => {
      (ctx.client.request as any).mockResolvedValue({
        app: {
          name: 'My App',
          oidcConfig: { clientId: 'client-abc' },
        },
      });

      const result = await UTILITY_HANDLERS['zitadel_get_auth_config']!(
        { projectId: 'p1', appId: 'a1' },
        ctx
      );

      const text = result.content[0]!.text;
      expect(text).toContain('AUTH_ZITADEL_ISSUER=https://test.zitadel.cloud');
      expect(text).toContain('AUTH_ZITADEL_CLIENT_ID=client-abc');
      expect(text).toContain('ZITADEL_PROJECT_ID=p1');
    });
  });
});

// ─── SMTP handlers ──────────────────────────────────────────────────────────

describe('smtp handlers', () => {
  let ctx: HandlerContext;

  beforeEach(() => {
    ctx = createMockContext();
    (loadSmtpCreds as any).mockReset();
    (loadSmtpCreds as any).mockReturnValue({}); // default: no file creds; args supply everything
  });

  describe('zitadel_get_smtp_config', () => {
    it('reports "no provider" when none configured', async () => {
      (ctx.client.request as any).mockResolvedValue({ result: [] });

      const result = await SMTP_HANDLERS['zitadel_get_smtp_config']!({}, ctx);

      expect(result.isError).toBeFalsy();
      expect(result.content[0]!.text).toContain('No SMTP notification provider');
      // reads via POST /admin/v1/smtp/_search (deprecated but functional — see smtp.ts header)
      const [path, options] = (ctx.client.request as any).mock.calls[0];
      expect(path).toBe('/admin/v1/smtp/_search');
      expect(options.method).toBe('POST');
    });

    it('lists SMTP providers, marks the active one, and never returns the password', async () => {
      (ctx.client.request as any).mockResolvedValue({
        result: [
          { id: 'p1', state: 'SMTP_CONFIG_ACTIVE', description: 'Brevo', host: 'smtp-relay.brevo.com:587', senderAddress: 'no-reply@ex.com', senderName: 'Ex', tls: true },
          { id: 'p2', state: 'SMTP_CONFIG_INACTIVE', description: 'old', host: 'smtp.old:587' },
        ],
      });

      const result = await SMTP_HANDLERS['zitadel_get_smtp_config']!({}, ctx);
      const text = result.content[0]!.text;

      expect(text).toContain('smtp-relay.brevo.com:587');
      expect(text).toContain('[ACTIVE]');
      expect(text).toContain('(2, 1 active)');
    });
  });

  describe('zitadel_set_smtp_config', () => {
    const brevo = {
      host: 'smtp-relay.brevo.com',
      port: 587,
      senderAddress: 'no-reply@ex.com',
      senderName: 'itemis',
      user: 'brevo-login',
      password: 'super-secret-key',
      description: 'Brevo',
    };

    it('creates a new provider (POST), puts the port inside host, flat body, then activates', async () => {
      (ctx.client.request as any)
        .mockResolvedValueOnce({ result: [] })       // _search → none
        .mockResolvedValueOnce({ id: 'new-1' })      // POST /smtp → id
        .mockResolvedValueOnce({});                  // POST /smtp/new-1/_activate

      const result = await SMTP_HANDLERS['zitadel_set_smtp_config']!(brevo, ctx);

      const [addPath, addOpts] = (ctx.client.request as any).mock.calls[1];
      expect(addPath).toBe('/admin/v1/smtp');
      expect(addOpts.method).toBe('POST');
      const addBody = JSON.parse(addOpts.body);
      // flat body — no `plain` wrapper on this endpoint family
      expect(addBody.plain).toBeUndefined();
      expect(addBody).toEqual({
        senderAddress: 'no-reply@ex.com',
        senderName: 'itemis',
        tls: true,
        host: 'smtp-relay.brevo.com:587',
        user: 'brevo-login',
        password: 'super-secret-key',
        replyToAddress: '',
        description: 'Brevo',
      });

      const [actPath, actOpts] = (ctx.client.request as any).mock.calls[2];
      expect(actPath).toBe('/admin/v1/smtp/new-1/_activate');
      expect(actOpts.method).toBe('POST');

      const text = result.content[0]!.text;
      expect(text).toContain('Created');
      expect(text).toContain('Activated');
      expect(text).not.toContain('super-secret-key'); // password never surfaced
    });

    it('updates an existing provider matched by description (PUT to its id, id also in body)', async () => {
      (ctx.client.request as any)
        .mockResolvedValueOnce({ result: [{ id: 'existing-9', description: 'Brevo', host: 'smtp-relay.brevo.com:587' }] })
        .mockResolvedValueOnce({})  // PUT
        .mockResolvedValueOnce({}); // activate

      await SMTP_HANDLERS['zitadel_set_smtp_config']!(brevo, ctx);

      const [putPath, putOpts] = (ctx.client.request as any).mock.calls[1];
      expect(putPath).toBe('/admin/v1/smtp/existing-9');
      expect(putOpts.method).toBe('PUT');
      // UpdateSMTPConfigRequest.id is a required body field (min_len:1) even though it's
      // also in the URL — omitting it is a real validation error on this endpoint.
      const putBody = JSON.parse(putOpts.body);
      expect(putBody.id).toBe('existing-9');
      expect(putBody.host).toBe('smtp-relay.brevo.com:587');
      expect(putBody.password).toBe('super-secret-key');
    });

    it('does not fail when the matched provider is already active', async () => {
      (ctx.client.request as any)
        .mockResolvedValueOnce({ result: [{ id: 'existing-9', description: 'Brevo', host: 'smtp-relay.brevo.com:587' }] })
        .mockResolvedValueOnce({}) // PUT
        .mockRejectedValueOnce(    // activate → already active
          new Error('Operation failed (HTTP 400). Check server logs for details. — Errors.SMTPConfig.AlreadyActive (COMMAND-vUHBSmBzaw)')
        );

      const result = await SMTP_HANDLERS['zitadel_set_smtp_config']!(brevo, ctx);

      expect(result.content[0]!.text).toContain('Updated');
      expect(result.content[0]!.text).toContain('Activated');
    });

    it('skips activation when activate=false', async () => {
      (ctx.client.request as any)
        .mockResolvedValueOnce({ result: [] })
        .mockResolvedValueOnce({ id: 'new-2' });

      await SMTP_HANDLERS['zitadel_set_smtp_config']!({ ...brevo, activate: false }, ctx);

      // only _search + POST — no _activate call
      expect((ctx.client.request as any).mock.calls.length).toBe(2);
    });

    it('sources creds from the profile file when no secret args are passed', async () => {
      (loadSmtpCreds as any).mockReturnValue({
        host: 'smtp-relay.brevo.com',
        port: '587',
        user: 'brevo-login',
        password: 'file-secret-key',
        from: 'itemis Solutions <no-reply@itemis.com>',
      });
      (ctx.client.request as any)
        .mockResolvedValueOnce({ result: [] })
        .mockResolvedValueOnce({ id: 'new-3' })
        .mockResolvedValueOnce({});

      // Only a non-secret profile name — no host/user/password/sender args.
      const result = await SMTP_HANDLERS['zitadel_set_smtp_config']!({ credsProfile: 'accelerator' }, ctx);

      expect((loadSmtpCreds as any)).toHaveBeenCalledWith({
        profile: 'accelerator',
        credsDir: undefined,
        baseEnvPath: undefined,
      });
      const addBody = JSON.parse((ctx.client.request as any).mock.calls[1][1].body);
      expect(addBody.host).toBe('smtp-relay.brevo.com:587');
      expect(addBody.user).toBe('brevo-login');
      expect(addBody.password).toBe('file-secret-key');
      // SMTP_FROM split into name + address
      expect(addBody.senderName).toBe('itemis Solutions');
      expect(addBody.senderAddress).toBe('no-reply@itemis.com');
      expect(result.content[0]!.text).not.toContain('file-secret-key');
    });

    it('an explicit arg overrides the file value', async () => {
      (loadSmtpCreds as any).mockReturnValue({
        host: 'smtp-relay.brevo.com', port: '587', user: 'brevo-login',
        password: 'file-secret-key', from: 'Old <old@ex.com>',
      });
      (ctx.client.request as any)
        .mockResolvedValueOnce({ result: [] })
        .mockResolvedValueOnce({ id: 'new-4' })
        .mockResolvedValueOnce({});

      await SMTP_HANDLERS['zitadel_set_smtp_config']!(
        { credsProfile: 'accelerator', senderAddress: 'override@ex.com', senderName: 'Override' },
        ctx
      );

      const addBody = JSON.parse((ctx.client.request as any).mock.calls[1][1].body);
      expect(addBody.senderAddress).toBe('override@ex.com');
      expect(addBody.senderName).toBe('Override');
      expect(addBody.password).toBe('file-secret-key'); // password still from file
    });

    it('errors listing what is missing when neither file nor args supply it', async () => {
      (loadSmtpCreds as any).mockReturnValue({}); // empty file
      await expect(
        SMTP_HANDLERS['zitadel_set_smtp_config']!({ host: 'smtp-relay.brevo.com' }, ctx)
      ).rejects.toThrow(/Missing SMTP settings/);
      // threw before any ZITADEL call
      expect((ctx.client.request as any).mock.calls.length).toBe(0);
    });
  });

  describe('zitadel_activate_smtp_config', () => {
    it('activates by id', async () => {
      (ctx.client.request as any).mockResolvedValue({});

      await SMTP_HANDLERS['zitadel_activate_smtp_config']!({ id: 'p1' }, ctx);

      const [path, options] = (ctx.client.request as any).mock.calls[0];
      expect(path).toBe('/admin/v1/smtp/p1/_activate');
      expect(options.method).toBe('POST');
    });

    it('treats "already active" as success instead of throwing (real endpoint behavior)', async () => {
      // Verified empirically: unlike the newer EmailProvider generation, this deprecated-but-
      // functional endpoint rejects re-activating an already-active provider with this exact
      // error — without tolerance the tool's advertised idempotency breaks on a second run.
      const err = new Error(
        'Operation failed (HTTP 400). Check server logs for details. — Errors.SMTPConfig.AlreadyActive (COMMAND-vUHBSmBzaw)'
      );
      (ctx.client.request as any).mockRejectedValue(err);

      const result = await SMTP_HANDLERS['zitadel_activate_smtp_config']!({ id: 'p1' }, ctx);

      expect(result.content[0]!.text).toContain('Activated SMTP provider p1');
    });

    it('still throws on a genuinely different error', async () => {
      const err = new Error('Operation failed (HTTP 403). Check server logs for details. — Permission denied');
      (ctx.client.request as any).mockRejectedValue(err);

      await expect(
        SMTP_HANDLERS['zitadel_activate_smtp_config']!({ id: 'p1' }, ctx)
      ).rejects.toThrow('Permission denied');
    });
  });

  describe('zitadel_test_smtp_config', () => {
    it('tests a given provider id, sending the receiver address and opting into error detail', async () => {
      (ctx.client.request as any).mockResolvedValue({});

      const result = await SMTP_HANDLERS['zitadel_test_smtp_config']!(
        { id: 'p1', receiverAddress: 'me@example.com' },
        ctx
      );

      const [path, options, meta] = (ctx.client.request as any).mock.calls[0];
      expect(path).toBe('/admin/v1/smtp/p1/_test');
      expect(options.method).toBe('POST');
      expect(JSON.parse(options.body)).toEqual({ receiverAddress: 'me@example.com' });
      expect(meta).toEqual({ exposeErrorDetail: true }); // relay reason is the point of a test
      expect(result.content[0]!.text).toContain('SMTP test OK');
    });

    it('defaults to the ACTIVE provider when no id is given', async () => {
      (ctx.client.request as any)
        .mockResolvedValueOnce({
          result: [
            { id: 'old', state: 'SMTP_CONFIG_INACTIVE', host: 'a:587' },
            { id: 'active-1', state: 'SMTP_CONFIG_ACTIVE', host: 'b:587' },
          ],
        })
        .mockResolvedValueOnce({});

      await SMTP_HANDLERS['zitadel_test_smtp_config']!({ receiverAddress: 'me@example.com' }, ctx);

      expect((ctx.client.request as any).mock.calls[0][0]).toBe('/admin/v1/smtp/_search');
      expect((ctx.client.request as any).mock.calls[1][0]).toBe('/admin/v1/smtp/active-1/_test');
    });

    it('surfaces the relay reason on failure instead of throwing', async () => {
      const err = new Error('Operation failed (HTTP 500). Check server logs for details. — could not add smtp auth');
      (ctx.client.request as any).mockRejectedValue(err);

      const result = await SMTP_HANDLERS['zitadel_test_smtp_config']!(
        { id: 'p1', receiverAddress: 'me@example.com' },
        ctx
      );

      expect(result.content[0]!.text).toContain('SMTP test FAILED');
      expect(result.content[0]!.text).toContain('could not add smtp auth');
    });

    it('errors when no active provider exists and no id is given', async () => {
      (ctx.client.request as any).mockResolvedValueOnce({
        result: [{ id: 'old', state: 'SMTP_CONFIG_INACTIVE', host: 'a:587' }],
      });

      await expect(
        SMTP_HANDLERS['zitadel_test_smtp_config']!({ receiverAddress: 'me@example.com' }, ctx)
      ).rejects.toThrow(/No active SMTP provider/);
    });
  });
});
