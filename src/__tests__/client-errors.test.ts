/**
 * Client error-logging tests.
 *
 * Both failure paths deliberately return a generic message to the MCP client, so the server
 * log is the only place the actual reason can appear. These tests pin that it does.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';

vi.mock('../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { ZitadelClient } from '../auth/client.js';
import { logger } from '../utils/logger.js';
import type { ZitadelConfig } from '../utils/config.js';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const CONFIG = {
  issuer: 'https://example.zitadel.cloud',
  serviceAccountUserId: '123456789012345678',
  serviceAccountKeyId: '987654321098765432',
  serviceAccountPrivateKey: privateKey,
  orgId: '111111111111111111',
  readOnly: false,
  loginPolicyWriteEnabled: false,
  logLevel: 'INFO',
} as ZitadelConfig;

/** Meta objects passed to logger.error, where the failure detail has to show up. */
const errorMeta = (): unknown[] => (logger.error as ReturnType<typeof vi.fn>).mock.calls.map(c => c[1]);

const jsonResponse = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const tokenGranted = () => jsonResponse({ access_token: 'test-token', expires_in: 3600 }, 200);

describe('client error logging', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let client: ZitadelClient;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    client = new ZitadelClient(CONFIG);
  });

  describe('token exchange', () => {
    it('logs the OAuth error and description', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ error: 'invalid_grant', error_description: 'invalid assertion' }, 400)
      );

      await expect(client.request('/management/v1/orgs/me')).rejects.toThrow(/HTTP 400/);

      expect(errorMeta()).toContainEqual(
        expect.objectContaining({
          status: 400,
          error: 'invalid_grant',
          errorDescription: 'invalid assertion',
        })
      );
    });

    it('logs a non-JSON body as a truncated snippet', async () => {
      const html = `<html><body>${'x'.repeat(500)}</body></html>`;
      fetchMock.mockResolvedValueOnce(new Response(html, { status: 502 }));

      await expect(client.request('/management/v1/orgs/me')).rejects.toThrow(/HTTP 502/);

      const meta = errorMeta().at(-1) as { body?: string };
      expect(meta.body?.startsWith('<html>')).toBe(true);
      expect(meta.body!.length).toBeLessThanOrEqual(301);
    });
  });

  describe('API errors', () => {
    it("logs Zitadel's message while the thrown message stays generic", async () => {
      fetchMock
        .mockResolvedValueOnce(tokenGranted())
        .mockResolvedValueOnce(jsonResponse({ code: 7, message: 'No permission to read org' }, 403));

      await expect(client.request('/management/v1/orgs/me')).rejects.toThrow(
        'Permission denied for this operation.'
      );

      expect(errorMeta()).toContainEqual(
        expect.objectContaining({
          status: 403,
          path: '/management/v1/orgs/me',
          message: 'No permission to read org',
        })
      );
    });

    it('logs nothing extra when the error body is empty', async () => {
      fetchMock
        .mockResolvedValueOnce(tokenGranted())
        .mockResolvedValueOnce(new Response('', { status: 500 }));

      await expect(client.request('/management/v1/orgs/me')).rejects.toThrow(/HTTP 500/);

      const meta = errorMeta().at(-1) as Record<string, unknown>;
      expect(Object.keys(meta).sort()).toEqual(['path', 'status']);
    });
  });
});
