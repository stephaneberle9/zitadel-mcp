/**
 * Named-instance tests: the registry that reads `.env.<name>` files, and the dispatcher that
 * routes each call to the instance it names.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HandlerContext, ToolDefinition, ToolHandler } from '../types/tools.js';
import type { ZitadelConfig } from '../utils/config.js';
import { InstanceRegistry, withInstanceParameter } from '../utils/instances.js';
import { createDispatcher } from '../dispatch.js';
import { INSTANCE_HANDLERS } from '../tools/instances.js';
import { RateLimiter } from '../utils/rate-limiter.js';

const BASE_CONFIG = {
  issuer: 'https://accelerator-gagb8n.eu1.zitadel.cloud',
  serviceAccountUserId: 'sa-default',
  serviceAccountKeyId: 'key-default',
  serviceAccountPrivateKey: 'dGVzdA==',
  orgId: 'org-default',
  readOnly: false,
  loginPolicyWriteEnabled: false,
  logLevel: 'ERROR',
} as ZitadelConfig;

const instanceFile = (issuer: string, extra = '') =>
  [
    `ZITADEL_ISSUER=${issuer}`,
    'ZITADEL_SERVICE_ACCOUNT_USER_ID=sa-named',
    'ZITADEL_SERVICE_ACCOUNT_KEY_ID=key-named',
    'ZITADEL_SERVICE_ACCOUNT_PRIVATE_KEY=dGVzdA==',
    'ZITADEL_ORG_ID=org-named',
    extra,
  ].join('\n');

/** A stand-in client that only remembers which configuration it was built for. */
const fakeClient = (config: ZitadelConfig) => ({ config, request: vi.fn(), getConfig: () => config }) as any;

describe('InstanceRegistry', () => {
  let dir: string;
  let defaultCtx: HandlerContext;
  let registry: InstanceRegistry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'instances-'));
    defaultCtx = { client: fakeClient(BASE_CONFIG), config: BASE_CONFIG };
    registry = new InstanceRegistry(defaultCtx, dir, fakeClient);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves no name, an empty name and "default" to the default instance', () => {
    for (const name of [undefined, '', 'default']) {
      const resolved = registry.resolve(name);
      expect(resolved.name).toBe('default');
      expect(resolved.ctx).toBe(defaultCtx);
    }
  });

  it('builds a named instance from its .env.<name> file and caches it', () => {
    writeFileSync(join(dir, '.env.itemis-preview'), instanceFile('https://itemis-preview-x1.eu1.zitadel.cloud'));

    const first = registry.resolve('itemis-preview');
    expect(first.ctx.config.issuer).toBe('https://itemis-preview-x1.eu1.zitadel.cloud');
    expect(first.ctx.config.orgId).toBe('org-named');
    expect(first.ctx.client.getConfig().serviceAccountUserId).toBe('sa-named');
    expect(registry.resolve('itemis-preview').ctx).toBe(first.ctx);
  });

  it('keeps an instance read-only when either its file or the process says so', () => {
    writeFileSync(join(dir, '.env.itemis'), instanceFile('https://auth.itemis.com', 'ZITADEL_READ_ONLY=true'));
    writeFileSync(join(dir, '.env.itemis-preview'), instanceFile('https://p.zitadel.cloud'));
    expect(registry.resolve('itemis').ctx.config.readOnly).toBe(true);
    expect(registry.resolve('itemis-preview').ctx.config.readOnly).toBe(false);

    const readOnlyProcess = new InstanceRegistry(
      { client: fakeClient(BASE_CONFIG), config: { ...BASE_CONFIG, readOnly: true } },
      dir,
      fakeClient
    );
    expect(readOnlyProcess.resolve('itemis-preview').ctx.config.readOnly).toBe(true);
  });

  it('offers only the default instance when there is no configuration file to sit next to', () => {
    const noFile = new InstanceRegistry(defaultCtx, undefined, fakeClient);

    expect(noFile.resolve(undefined).name).toBe('default');
    expect(() => noFile.resolve('preview')).toThrow(/DOTENV_CONFIG_PATH/);
    expect(noFile.list().map((i) => i.name)).toEqual(['default']);
  });

  it('names the file it looked for when an instance is unknown', () => {
    expect(() => registry.resolve('itemis')).toThrow(/No ZITADEL instance named "itemis".*\.env\.itemis/);
  });

  it('refuses a name that could reach outside the folder', () => {
    for (const name of ['../secrets', 'Itemis', 'a/b', '.env']) {
      expect(() => registry.resolve(name)).toThrow(/lowercase letters, digits and hyphens/);
    }
  });

  it('lists the default and every complete instance file, without secrets', () => {
    writeFileSync(join(dir, '.env'), instanceFile('https://ignored.zitadel.cloud'));
    writeFileSync(join(dir, '.env.itemis'), instanceFile('https://auth.itemis.com', 'ZITADEL_READ_ONLY=true'));
    writeFileSync(join(dir, '.env.itemis-preview'), instanceFile('https://p.zitadel.cloud'));
    writeFileSync(join(dir, '.env.template'), 'ZITADEL_ISSUER=');

    expect(registry.list()).toEqual([
      { name: 'default', issuer: BASE_CONFIG.issuer, orgId: 'org-default', readOnly: false },
      { name: 'itemis', issuer: 'https://auth.itemis.com', orgId: 'org-named', readOnly: true },
      { name: 'itemis-preview', issuer: 'https://p.zitadel.cloud', orgId: 'org-named', readOnly: false },
    ]);
  });
});

describe('withInstanceParameter', () => {
  it('adds an optional instance property and leaves the rest of the schema alone', () => {
    const tool = withInstanceParameter({
      name: 'zitadel_get_branding',
      description: 'x',
      inputSchema: { type: 'object', properties: { level: { type: 'string' } }, required: ['level'] },
    });

    const schema = tool.inputSchema as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(schema.properties)).toEqual(['level', 'instance']);
    expect(schema.required).toEqual(['level']);
  });
});

describe('dispatcher', () => {
  let dir: string;
  let seen: { args: Record<string, unknown>; ctx: HandlerContext }[];
  let dispatch: ReturnType<typeof createDispatcher>;

  const tools: ToolDefinition[] = [
    { name: 'read_tool', description: 'r', inputSchema: {}, _meta: { readOnly: true, domain: 'utility' } },
    { name: 'write_tool', description: 'w', inputSchema: {}, _meta: { readOnly: false, domain: 'utility' } },
    { name: 'zitadel_list_instances', description: 'l', inputSchema: {}, _meta: { readOnly: true, domain: 'utility' } },
  ];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dispatch-'));
    writeFileSync(join(dir, '.env.itemis-preview'), instanceFile('https://itemis-preview-x1.eu1.zitadel.cloud'));
    writeFileSync(join(dir, '.env.itemis'), instanceFile('https://auth.itemis.com', 'ZITADEL_READ_ONLY=true'));
    seen = [];
    const record: ToolHandler = async (args, ctx) => {
      seen.push({ args, ctx });
      return { content: [{ type: 'text', text: 'done' }] };
    };
    const instances = new InstanceRegistry({ client: fakeClient(BASE_CONFIG), config: BASE_CONFIG }, dir, fakeClient);
    dispatch = createDispatcher({
      tools,
      handlers: { read_tool: record, write_tool: record, ...INSTANCE_HANDLERS },
      instances,
      rateLimiters: { read: new RateLimiter({ maxTokens: 100, refillRate: 100 }), write: new RateLimiter({ maxTokens: 100, refillRate: 100 }) },
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs a call on the default instance when it names none, and says so', async () => {
    const result = await dispatch('read_tool', { level: 'instance' });

    expect(result.isError).toBe(false);
    expect(seen[0]!.ctx.config.issuer).toBe(BASE_CONFIG.issuer);
    expect(seen[0]!.args).toEqual({ level: 'instance' });
    expect(result.content[0]!.text).toBe('[ZITADEL instance "default" — accelerator-gagb8n.eu1.zitadel.cloud]\ndone');
  });

  it('routes a named call to that instance and strips the argument before the handler sees it', async () => {
    const result = await dispatch('write_tool', { instance: 'itemis-preview', primaryColor: '#1f3a5f' });

    expect(seen[0]!.ctx.config.issuer).toBe('https://itemis-preview-x1.eu1.zitadel.cloud');
    expect(seen[0]!.args).toEqual({ primaryColor: '#1f3a5f' });
    expect(result.content[0]!.text).toContain('[ZITADEL instance "itemis-preview" — itemis-preview-x1.eu1.zitadel.cloud]');
  });

  it('blocks writes on a read-only instance but allows reads there', async () => {
    const write = await dispatch('write_tool', { instance: 'itemis' });
    expect(write.isError).toBe(true);
    expect(write.content[0]!.text).toContain('Blocked: ZITADEL_READ_ONLY is enabled for this instance');
    expect(seen).toHaveLength(0);

    const read = await dispatch('read_tool', { instance: 'itemis' });
    expect(read.isError).toBe(false);
    expect(seen).toHaveLength(1);
  });

  it('reports an unknown instance without calling the handler', async () => {
    const result = await dispatch('read_tool', { instance: 'nope' });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('No ZITADEL instance named "nope"');
    expect(seen).toHaveLength(0);
  });

  it('lists the reachable instances through the tool', async () => {
    const result = await dispatch('zitadel_list_instances', {});

    const text = result.content[0]!.text;
    expect(text).toContain('3 ZITADEL instance(s)');
    expect(text).toContain('itemis: https://auth.itemis.com (org org-named) — read-only');
    expect(text).toContain('itemis-preview: https://itemis-preview-x1.eu1.zitadel.cloud');
    expect(text).not.toContain('dGVzdA==');
  });
});
