/**
 * Named ZITADEL instances — one server session reaching several instances.
 *
 * The default instance is the one the process environment describes, typically loaded from the
 * file `DOTENV_CONFIG_PATH` names. Every other instance is a sibling of that file, `.env.<name>`
 * — e.g. `/home/me/.config/zitadel-mcp/.env.preview` — holding the same `ZITADEL_*` variables.
 * Without a configuration file there is no folder to look in, and only the default instance
 * exists. Every tool takes an optional `instance` argument naming one; without it
 * the call goes to the default instance, exactly as before.
 *
 * Why a per-call argument rather than a "switch instance" tool: a sync across instances (setting
 * the same texts or branding on preview and live) then names its target on every write, so no
 * call can land on whichever instance happened to be selected last. Every result is prefixed
 * with the instance it ran against for the same reason.
 *
 * Safety: an instance file may set `ZITADEL_READ_ONLY=true` on its own — e.g. to keep a
 * production instance read-only by default while preview stays writable. The process-wide
 * setting still applies to every instance. Server-wide switches that decide which tools exist
 * (`ZITADEL_ENABLE_LOGIN_POLICY_WRITE`) and the log level stay process-wide.
 *
 * Files are read when an instance is first named and cached for the session; edits to an
 * instance file need a server restart, like edits to the default one.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'dotenv';
import { ZitadelClient } from '../auth/client.js';
import type { HandlerContext } from '../types/tools.js';
import { loadConfig, type ZitadelConfig } from './config.js';

/** The name the default instance answers to in results and listings. */
export const DEFAULT_INSTANCE = 'default';

/** Lowercase, digits and hyphens: the name becomes part of a file name, never a path. */
const INSTANCE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

const FILE_PREFIX = '.env.';

export interface ResolvedInstance {
  name: string;
  ctx: HandlerContext;
}

export interface InstanceSummary {
  name: string;
  issuer: string;
  orgId: string;
  readOnly: boolean;
}

export class InstanceRegistry {
  private readonly cache = new Map<string, HandlerContext>();

  constructor(
    private readonly defaultCtx: HandlerContext,
    /** Folder holding the default configuration file and its `.env.<name>` siblings, if any. */
    private readonly dir: string | undefined,
    private readonly createClient: (config: ZitadelConfig) => ZitadelClient = (config) => new ZitadelClient(config)
  ) {}

  /** The instance a call names, or the default one when it names none. */
  resolve(name?: unknown): ResolvedInstance {
    if (name === undefined || name === null || name === '' || name === DEFAULT_INSTANCE) {
      return { name: DEFAULT_INSTANCE, ctx: this.defaultCtx };
    }
    if (typeof name !== 'string' || !INSTANCE_NAME.test(name)) {
      throw new Error('instance must be lowercase letters, digits and hyphens, e.g. "itemis-preview".');
    }

    const cached = this.cache.get(name);
    if (cached) return { name, ctx: cached };

    if (!this.dir) {
      throw new Error(
        `No ZITADEL instance named "${name}": named instances are .env.<name> files next to the ` +
        'configuration file DOTENV_CONFIG_PATH names, and none is set.'
      );
    }
    const file = join(this.dir, `${FILE_PREFIX}${name}`);
    if (!existsSync(file)) {
      throw new Error(`No ZITADEL instance named "${name}": expected its settings in ${file}.`);
    }
    const ctx = this.contextFor(parse(readFileSync(file)));
    this.cache.set(name, ctx);
    return { name, ctx };
  }

  /** The default instance and every `.env.<name>` file next to it — no secrets. */
  list(): InstanceSummary[] {
    const summarize = (name: string, config: ZitadelConfig): InstanceSummary => ({
      name,
      issuer: config.issuer,
      orgId: config.orgId,
      readOnly: config.readOnly,
    });

    const summaries = [summarize(DEFAULT_INSTANCE, this.defaultCtx.config)];
    const names = this.dir && existsSync(this.dir)
      ? readdirSync(this.dir)
          .filter((file) => file.startsWith(FILE_PREFIX))
          .map((file) => file.slice(FILE_PREFIX.length))
          .filter((name) => INSTANCE_NAME.test(name) && name !== DEFAULT_INSTANCE)
          .sort()
      : [];
    for (const name of names) {
      try {
        summaries.push(summarize(name, this.resolve(name).ctx.config));
      } catch {
        // A file that is not a complete instance configuration (a template, a leftover) is
        // skipped rather than failing the listing; naming it in a call still reports why.
      }
    }
    return summaries;
  }

  private contextFor(env: Record<string, string>): HandlerContext {
    const own = loadConfig(env);
    const base = this.defaultCtx.config;
    const config: ZitadelConfig = {
      ...own,
      readOnly: base.readOnly || own.readOnly,
      loginPolicyWriteEnabled: base.loginPolicyWriteEnabled,
      logLevel: base.logLevel,
    };
    return { client: this.createClient(config), config };
  }
}

/** The `instance` argument every tool accepts, added to each tool's input schema. */
export const INSTANCE_PROPERTY = {
  type: 'string',
  description:
    'ZITADEL instance to run against, by name (see zitadel_list_instances), e.g. "itemis-preview". ' +
    'Omit for the default instance.',
};

export function withInstanceParameter<T extends { inputSchema: Record<string, unknown> }>(tool: T): T {
  const schema = tool.inputSchema as { properties?: Record<string, unknown> };
  return {
    ...tool,
    inputSchema: { ...tool.inputSchema, properties: { ...(schema.properties ?? {}), instance: INSTANCE_PROPERTY } },
  };
}

/** The line every result starts with, so a transcript always shows which instance a call changed. */
export function instanceBanner(instance: ResolvedInstance): string {
  return `[ZITADEL instance "${instance.name}" — ${new URL(instance.ctx.config.issuer).host}]`;
}
