/**
 * Branding (label policy) handler tests with a mocked Zitadel API client
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { HandlerContext } from '../types/tools.js';
import type { ZitadelConfig } from '../utils/config.js';
import { BRANDING_HANDLERS } from '../tools/branding.js';

function createMockContext(): HandlerContext {
  const config = {
    issuer: 'https://test.zitadel.cloud',
    serviceAccountUserId: 'sa-123',
    serviceAccountKeyId: 'key-456',
    serviceAccountPrivateKey: 'dGVzdA==',
    orgId: 'org-789',
    logLevel: 'ERROR',
  } as ZitadelConfig;

  const client = {
    request: vi.fn(),
    getConfig: vi.fn(() => config),
    clearTokenCache: vi.fn(),
  };

  return { client: client as any, config };
}

/** What an org that has no label policy of its own reads back: the instance default. */
const inherited = {
  isDefault: true,
  primaryColor: '#5469d4',
  backgroundColor: '#fafafa',
  warnColor: '#cd3d56',
  fontColor: '#000000',
  themeMode: 'THEME_MODE_AUTO',
  hideLoginNameSuffix: false,
  disableWatermark: false,
};
const own = { ...inherited, isDefault: false };

describe('branding handlers', () => {
  let ctx: HandlerContext;
  let dir: string;
  const request = () => ctx.client.request as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ctx = createMockContext();
    dir = mkdtempSync(join(tmpdir(), 'branding-'));
    process.env['ZITADEL_ASSETS_DIR'] = dir;
  });

  afterEach(() => {
    delete process.env['ZITADEL_ASSETS_DIR'];
    rmSync(dir, { recursive: true, force: true });
  });

  /** A file of the given size whose first bytes are the signature its extension promises. */
  const SIGNATURES: Record<string, Buffer> = {
    '.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    '.svg': Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">'),
  };
  const file = (name: string, bytes: number, content?: Buffer) => {
    const path = join(dir, name);
    const signature = content ?? SIGNATURES[name.slice(name.lastIndexOf('.'))] ?? Buffer.alloc(0);
    const body = Buffer.alloc(Math.max(bytes, signature.length), 0x20);
    signature.copy(body);
    writeFileSync(path, body);
    return path;
  };

  describe('zitadel_get_branding', () => {
    it('reports draft changes that are not yet activated', async () => {
      request()
        .mockResolvedValueOnce({ policy: own })
        .mockResolvedValueOnce({ policy: { ...own, primaryColor: '#1f3a5f' } });

      const result = await BRANDING_HANDLERS['zitadel_get_branding']!({}, ctx);

      expect(request().mock.calls.map((c) => c[0])).toEqual([
        '/management/v1/policies/label',
        '/management/v1/policies/label/_preview',
      ]);
      expect(result.content[0]!.text).toContain('The draft differs from the active policy');
      expect(result.content[0]!.text).toContain('primaryColor = #1f3a5f');
    });

    it('says when the org inherits the instance default', async () => {
      request().mockResolvedValueOnce({ policy: inherited }).mockResolvedValueOnce({ policy: inherited });

      const result = await BRANDING_HANDLERS['zitadel_get_branding']!({}, ctx);

      expect(result.content[0]!.text).toContain('inherits the instance default');
      expect(result.content[0]!.text).toContain('The draft matches the active policy');
    });
  });

  describe('zitadel_set_branding', () => {
    it('creates the org policy from the inherited one, keeping fields the caller leaves alone', async () => {
      request().mockResolvedValueOnce({ policy: inherited }).mockResolvedValueOnce({});

      const result = await BRANDING_HANDLERS['zitadel_set_branding']!({ primaryColor: '#1f3a5f' }, ctx);

      const [path, opts] = request().mock.calls[1]!;
      expect(path).toBe('/management/v1/policies/label');
      expect(opts.method).toBe('POST');
      const body = JSON.parse(opts.body);
      expect(body.primaryColor).toBe('#1f3a5f');
      expect(body.warnColor).toBe('#cd3d56');
      expect(body.themeMode).toBe('THEME_MODE_AUTO');
      expect(body).not.toHaveProperty('isDefault');
      expect(result.content[0]!.text).toContain('Created a label policy');
      expect(result.content[0]!.text).toContain('zitadel_activate_branding');
    });

    it('updates an existing instance policy with PUT', async () => {
      request().mockResolvedValueOnce({ policy: own }).mockResolvedValueOnce({});

      await BRANDING_HANDLERS['zitadel_set_branding']!({ level: 'instance', themeMode: 'THEME_MODE_LIGHT' }, ctx);

      const [path, opts] = request().mock.calls[1]!;
      expect(path).toBe('/admin/v1/policies/label');
      expect(opts.method).toBe('PUT');
      expect(JSON.parse(opts.body).themeMode).toBe('THEME_MODE_LIGHT');
    });

    it('skips the write when the draft already has the values, which ZITADEL would reject with 400', async () => {
      request().mockResolvedValueOnce({ policy: own });

      const result = await BRANDING_HANDLERS['zitadel_set_branding']!({ primaryColor: '#5469d4' }, ctx);

      expect(request().mock.calls.length).toBe(1);
      expect(result.content[0]!.text).toContain('nothing to change');
    });

    it('still creates the org policy when the inherited values are passed unchanged', async () => {
      request().mockResolvedValueOnce({ policy: inherited }).mockResolvedValueOnce({});

      await BRANDING_HANDLERS['zitadel_set_branding']!({ primaryColor: '#5469d4' }, ctx);

      expect(request().mock.calls[1]![1].method).toBe('POST');
    });

    it('refuses a call that names no field', async () => {
      expect(await BRANDING_HANDLERS['zitadel_set_branding']!({}, ctx)).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/at least one/) }] });
      expect(request().mock.calls.length).toBe(0);
    });
  });

  describe('zitadel_upload_branding_asset', () => {
    it('uploads a dark-mode logo as multipart to the org asset endpoint', async () => {
      request().mockResolvedValueOnce({ policy: own }).mockResolvedValueOnce({});

      const result = await BRANDING_HANDLERS['zitadel_upload_branding_asset']!(
        { asset: 'logo', mode: 'dark', filePath: file('logo.png', 1024) },
        ctx
      );

      const [path, opts] = request().mock.calls[1]!;
      expect(path).toBe('/assets/v1/org/policy/label/logo/dark');
      expect(opts.method).toBe('POST');
      const uploaded = (opts.body as FormData).get('file') as File;
      expect(uploaded.name).toBe('logo.png');
      expect(uploaded.type).toBe('image/png');
      expect(uploaded.size).toBe(1024);
      expect(result.content[0]!.text).toContain('logo (dark mode)');
    });

    it('creates the org policy first when the org still inherits', async () => {
      request().mockResolvedValueOnce({ policy: inherited }).mockResolvedValueOnce({}).mockResolvedValueOnce({});

      await BRANDING_HANDLERS['zitadel_upload_branding_asset']!({ asset: 'icon', filePath: file('icon.png', 10) }, ctx);

      const calls = request().mock.calls;
      expect(calls[1]![0]).toBe('/management/v1/policies/label');
      expect(calls[1]![1].method).toBe('POST');
      expect(calls[2]![0]).toBe('/assets/v1/org/policy/label/icon');
    });

    it('targets the instance asset endpoint without creating a policy', async () => {
      request().mockResolvedValueOnce({ policy: inherited }).mockResolvedValueOnce({});

      await BRANDING_HANDLERS['zitadel_upload_branding_asset']!(
        { asset: 'logo', level: 'instance', filePath: file('logo.png', 10) },
        ctx
      );

      const calls = request().mock.calls;
      expect(calls.length).toBe(2);
      expect(calls[1]![0]).toBe('/assets/v1/instance/policy/label/logo');
    });

    it("rejects a file over ZITADEL's 512 KiB limit before calling the API", async () => {
      expect(
        await BRANDING_HANDLERS['zitadel_upload_branding_asset']!({ asset: 'logo', filePath: file('big.png', (1 << 19) + 1) }, ctx)
      ).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/at most 524288 bytes/) }] });
      expect(request().mock.calls.length).toBe(0);
    });

    it('refuses every upload while ZITADEL_ASSETS_DIR is unset', async () => {
      const logo = file('logo.png', 10);
      delete process.env['ZITADEL_ASSETS_DIR'];

      expect(await BRANDING_HANDLERS['zitadel_upload_branding_asset']!({ asset: 'logo', filePath: logo }, ctx)).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/Uploads are disabled/) }] });
      expect(request().mock.calls.length).toBe(0);
    });

    it('refuses a file outside ZITADEL_ASSETS_DIR, also when reached through ..', async () => {
      const outside = mkdtempSync(join(tmpdir(), 'outside-'));
      try {
        const png = join(outside, 'logo.png');
        writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

        for (const filePath of [png, join(dir, '..', basename(outside), 'logo.png')]) {
          expect(await BRANDING_HANDLERS['zitadel_upload_branding_asset']!({ asset: 'logo', filePath }, ctx)).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/No uploadable file at that path/) }] });
        }
        expect(request().mock.calls.length).toBe(0);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it('answers a missing file exactly like one outside the folder, naming no folder', async () => {
      const refusal = async (filePath: string) =>
        (await BRANDING_HANDLERS['zitadel_upload_branding_asset']!({ asset: 'logo', filePath }, ctx)).content[0]!.text;

      const missing = await refusal(join(dir, 'missing.png'));
      const outside = await refusal(join(tmpdir(), 'logo.png'));

      expect(missing).toBe(outside);
      expect(missing).not.toContain(dir);
      expect(request().mock.calls.length).toBe(0);
    });

    it('refuses UNC and device paths before touching the filesystem', async () => {
      for (const filePath of ['\\\\attacker.example\\share\\logo.png', '//attacker.example/share/logo.png', '\\\\?\\C:\\logo.png']) {
        expect(
          await BRANDING_HANDLERS['zitadel_upload_branding_asset']!({ asset: 'logo', filePath }, ctx)
        ).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/No uploadable file at that path/) }] });
      }
      process.env['ZITADEL_ASSETS_DIR'] = '\\\\attacker.example\\share';
      expect(
        await BRANDING_HANDLERS['zitadel_upload_branding_asset']!({ asset: 'logo', filePath: 'logo.png' }, ctx)
      ).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/must be a local folder/) }] });
      expect(request().mock.calls.length).toBe(0);
    });

    it('resolves a relative path against ZITADEL_ASSETS_DIR', async () => {
      file('logo.png', 16);
      request().mockResolvedValueOnce({ policy: own }).mockResolvedValueOnce({});

      const result = await BRANDING_HANDLERS['zitadel_upload_branding_asset']!({ asset: 'logo', filePath: 'logo.png' }, ctx);

      expect(result.isError).toBeFalsy();
      expect(request().mock.calls[1]![0]).toBe('/assets/v1/org/policy/label/logo');
    });

    it('refuses a symlink inside ZITADEL_ASSETS_DIR that points outside it', async (testCtx) => {
      const outside = mkdtempSync(join(tmpdir(), 'outside-'));
      try {
        const target = join(outside, 'secret.png');
        writeFileSync(target, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        const link = join(dir, 'logo.png');
        try {
          symlinkSync(target, link);
        } catch {
          testCtx.skip(); // creating symlinks needs a privilege on Windows
        }

        expect(await BRANDING_HANDLERS['zitadel_upload_branding_asset']!({ asset: 'logo', filePath: link }, ctx)).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/No uploadable file at that path/) }] });
        expect(request().mock.calls.length).toBe(0);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it('refuses a file whose content is not what its extension claims, before calling the API', async () => {
      const secret = file('logo.png', 64, Buffer.from('ZITADEL_SERVICE_ACCOUNT_PRIVATE_KEY=...'));

      expect(await BRANDING_HANDLERS['zitadel_upload_branding_asset']!({ asset: 'logo', filePath: secret }, ctx)).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/content is not image\/png/) }] });
      expect(request().mock.calls.length).toBe(0);
    });

    it('rejects a file type that does not fit the slot', async () => {
      expect(await BRANDING_HANDLERS['zitadel_upload_branding_asset']!({ asset: 'font', filePath: file('logo.png', 10) }, ctx)).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/must be one of/) }] });
      expect(request().mock.calls.length).toBe(0);
    });

    it('warns that an SVG logo will not show in mail clients', async () => {
      request().mockResolvedValueOnce({ policy: own }).mockResolvedValueOnce({});

      const result = await BRANDING_HANDLERS['zitadel_upload_branding_asset']!(
        { asset: 'logo', filePath: file('logo.svg', 10) },
        ctx
      );

      expect(result.content[0]!.text).toContain('Prefer a PNG');
    });
  });

  describe('zitadel_activate_branding', () => {
    it('activates the draft at the chosen level', async () => {
      request().mockResolvedValueOnce({});

      await BRANDING_HANDLERS['zitadel_activate_branding']!({ level: 'instance' }, ctx);

      const [path, opts] = request().mock.calls[0]!;
      expect(path).toBe('/admin/v1/policies/label/_activate');
      expect(opts.method).toBe('POST');
    });
  });
});
