/**
 * Portal connection tests: with several instances (utils/instances.ts) whose files name
 * different portal databases, each call must reach its own instance's database.
 */

import { describe, it, expect, vi } from 'vitest';

const pools: { url: string; queries: string[] }[] = [];

vi.mock('postgres', () => ({
  default: vi.fn((url: string) => {
    const pool = { url, queries: [] as string[] };
    pools.push(pool);
    const sql = (strings: TemplateStringsArray) => {
      pool.queries.push(strings.join('?'));
      return Promise.resolve(strings[0]!.trim().startsWith('SELECT') ? [] : [{ id: 1, slug: 's', name: 'n' }]);
    };
    return Object.assign(sql, { end: vi.fn(() => Promise.resolve()) });
  }),
}));

import { PORTAL_HANDLERS } from '../tools/portal.js';

const ctxFor = (portalDatabaseUrl: string) => ({ client: {} as any, config: { portalDatabaseUrl } as any });
const register = (url: string) =>
  PORTAL_HANDLERS['portal_register_app']!({ slug: 'app', name: 'App', appUrl: 'https://app.example.org' }, ctxFor(url));

describe('portal database per instance', () => {
  it('opens one pool per database and sends each call to its own', async () => {
    await register('postgres://preview/portal');
    await register('postgres://live/portal');
    await register('postgres://preview/portal');

    expect(pools.map((p) => p.url)).toEqual(['postgres://preview/portal', 'postgres://live/portal']);
    expect(pools[0]!.queries.filter((q) => q.includes('INSERT'))).toHaveLength(2);
    expect(pools[1]!.queries.filter((q) => q.includes('INSERT'))).toHaveLength(1);
  });
});
