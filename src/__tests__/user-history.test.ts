/**
 * zitadel_get_user_history — the request ListUserChanges gets, the line format, `since`/`limit`,
 * and that nothing beyond the allow-listed fields (codes, payloads) reaches the output.
 */

import { describe, it, expect, vi } from 'vitest';
import type { HandlerContext } from '../types/tools.js';
import type { ZitadelConfig } from '../utils/config.js';
import type { UserChange } from '../types/zitadel.js';

vi.mock('postgres', () => ({ default: vi.fn(() => () => Promise.resolve([])) }));

import { USER_HANDLERS, formatUserChange } from '../tools/users.js';

const USER_ID = '300000000000000001';
const CODE = 'XK7QPZ';

interface Call { method: string; path: string; body: unknown }

function ctxWith(result: unknown[]): { ctx: HandlerContext; calls: Call[] } {
  const config = { issuer: 'https://test.zitadel.cloud', orgId: 'org-789', logLevel: 'ERROR' } as ZitadelConfig;
  const calls: Call[] = [];
  const request = vi.fn((path: string, opts: { method?: string; body?: string } = {}) => {
    calls.push({ method: opts.method || 'GET', path, body: opts.body ? JSON.parse(opts.body) : undefined });
    return Promise.resolve({ result });
  });
  return { ctx: { client: { request, getConfig: () => config, clearTokenCache: vi.fn() } as never, config }, calls };
}

const change = (changeDate: string, type: string, editor: Partial<UserChange> = {}): UserChange => ({
  changeDate,
  eventType: { key: `EventTypes.${type}`, localizedMessage: `localized ${type}` },
  sequence: '1',
  resourceOwnerId: 'org-789',
  ...editor,
});

const ADMIN = { editorId: '300000000000000099', editorDisplayName: 'Ops Admin' };
const SELF = { editorId: USER_ID, editorDisplayName: 'Jane Doe' };

/** As ListUserChanges returns them: newest first. */
const NEWEST_FIRST = [
  change('2026-10-20T09:05:00.123456Z', 'user.human.invite.check.failed', SELF),
  change('2026-10-20T09:00:00Z', 'user.human.invite.code.sent', {}),
  change('2026-10-20T08:59:59Z', 'user.human.invite.code.added', ADMIN),
  change('2026-10-19T12:00:00Z', 'user.human.added', ADMIN),
];

const run = (args: Record<string, unknown>, result: unknown[] = NEWEST_FIRST) => {
  const { ctx, calls } = ctxWith(result);
  return USER_HANDLERS['zitadel_get_user_history']!({ userId: USER_ID, ...args }, ctx).then((res) => ({
    res,
    calls,
    text: res.content[0]!.text,
  }));
};

describe('zitadel_get_user_history — request', () => {
  it('asks ListUserChanges for the newest 100 events by default', async () => {
    const { calls } = await run({});
    expect(calls).toEqual([
      { method: 'POST', path: `/management/v1/users/${USER_ID}/changes/_search`, body: { query: { limit: 100, asc: false } } },
    ]);
  });

  it('passes limit through', async () => {
    const { calls } = await run({ limit: 7 });
    expect(calls[0]!.body).toEqual({ query: { limit: 7, asc: false } });
  });

  it('rejects an out-of-range limit and an unparsable since', async () => {
    await expect(run({ limit: 0 })).rejects.toThrow();
    await expect(run({ limit: 1001 })).rejects.toThrow();
    await expect(run({ since: 'yesterday' })).rejects.toThrow();
  });
});

describe('zitadel_get_user_history — formatting', () => {
  it('prints one line per event, oldest first, with UTC timestamp, type, gloss and editor', async () => {
    const { text, res } = await run({});
    expect(res.isError).toBeFalsy();
    const lines = text.split('\n').filter((l) => /^\d{4}-/.test(l));
    expect(lines).toEqual([
      '2026-10-19T12:00:00.000Z  user.human.added — user created  [by Ops Admin]',
      '2026-10-20T08:59:59.000Z  user.human.invite.code.added — invite code issued; replaces any earlier invite code  [by Ops Admin]',
      '2026-10-20T09:00:00.000Z  user.human.invite.code.sent — invite mail handed to the mail provider  [by system]',
      '2026-10-20T09:05:00.123Z  user.human.invite.check.failed — invite code rejected (wrong, superseded, already used or expired)  [by Jane Doe (the user)]',
    ]);
    expect(text).toContain(`History of user ${USER_ID}: 4 event(s), oldest first`);
  });

  it('falls back to ZITADEL\'s localized message, then to the login name or id of the editor', () => {
    expect(formatUserChange(change('2026-10-20T09:00:00Z', 'user.human.phone.changed', { editorPreferredLoginName: 'sa@org' }), USER_ID))
      .toBe('2026-10-20T09:00:00.000Z  user.human.phone.changed — localized user.human.phone.changed  [by sa@org]');
    expect(formatUserChange({ changeDate: '2026-10-20T09:00:00Z', eventType: { key: 'EventTypes.user.v2.foo' }, editorId: 'svc-1' }, USER_ID))
      .toBe('2026-10-20T09:00:00.000Z  user.v2.foo  [by svc-1]');
  });

  it('reports an empty history', async () => {
    const { text } = await run({}, []);
    expect(text).toBe(`No events found for user ${USER_ID}.`);
  });
});

describe('zitadel_get_user_history — secrets', () => {
  it('never prints a code or payload field the API returns', async () => {
    const leaky = {
      ...change('2026-10-20T08:59:59Z', 'user.human.invite.code.added', ADMIN),
      payload: {
        code: { cryptoType: 0, algorithm: 'aes', keyId: 'codeKey', crypted: Buffer.from(CODE).toString('base64') },
        plainCode: CODE,
        urlTemplate: `https://login.example.com/verify?code=${CODE}`,
      },
      code: CODE,
    };
    const { text } = await run({}, [leaky]);
    expect(text).toContain('user.human.invite.code.added');
    expect(text).not.toContain(CODE);
    expect(text).not.toContain(Buffer.from(CODE).toString('base64'));
    expect(text).not.toMatch(/crypted|payload|urlTemplate|codeKey/);
  });
});

describe('zitadel_get_user_history — since and limit', () => {
  it('drops events before since', async () => {
    const { text } = await run({ since: '2026-10-20T09:00:00Z' });
    expect(text).toContain('since 2026-10-20T09:00:00.000Z: 2 event(s)');
    expect(text).toContain('user.human.invite.code.sent');
    expect(text).toContain('user.human.invite.check.failed');
    expect(text).not.toContain('user.human.invite.code.added');
    expect(text).not.toContain('user.human.added');
  });

  it('accepts a bare date', async () => {
    const { text } = await run({ since: '2026-10-20' });
    expect(text).toContain('3 event(s)');
  });

  it('says so when no event is at or after since', async () => {
    const { text } = await run({ since: '2026-10-21' });
    expect(text).toBe(`No events found for user ${USER_ID} since 2026-10-21T00:00:00.000Z.`);
  });

  it('warns that older events may be cut off when the limit is reached', async () => {
    const { text } = await run({ limit: 4 });
    expect(text).toContain('Limit reached: these are the 4 most recent events');
  });

  it('does not warn when since already excluded older events', async () => {
    const { text } = await run({ limit: 4, since: '2026-10-20' });
    expect(text).not.toContain('Limit reached');
  });

  it('does not warn below the limit', async () => {
    const { text } = await run({});
    expect(text).not.toContain('Limit reached');
  });
});
