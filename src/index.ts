#!/usr/bin/env node
/**
 * Zitadel MCP Server
 * Manage users, projects, apps, roles, and service accounts via the Model Context Protocol
 */

import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// Load secrets from a gitignored .env regardless of the process working directory.
// Existing process env vars take precedence (override: false), so an inline MCP `env`
// block still wins. Precedence between the two files (first one to set a var wins):
//   1. DOTENV_CONFIG_PATH, if set — lets a globally installed `zitadel-mcp` binary read
//      secrets kept outside the package, without a `-r dotenv/config` preload.
//   2. the repo-root .env (one level up from build/ or src/), for running from source.
const envFile = process.env.DOTENV_CONFIG_PATH;
if (envFile) {
  loadDotenv({ path: envFile });
}
loadDotenv({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') });

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from './utils/config.js';
import { ZitadelClient } from './auth/client.js';
import { getTools, getHandlers } from './tools/index.js';
import { logger } from './utils/logger.js';
import { setupErrorHandlers } from './utils/error-handler.js';
import { createRateLimiters } from './utils/rate-limiter.js';
import { InstanceRegistry, withInstanceParameter } from './utils/instances.js';
import { createDispatcher } from './dispatch.js';
import type { HandlerContext } from './types/tools.js';

async function main() {
  setupErrorHandlers();
  logger.info('Starting Zitadel MCP Server...');

  // Load and validate configuration
  const config = loadConfig();
  const client = new ZitadelClient(config);
  const ctx: HandlerContext = { client, config };

  // Get tools and handlers (portal tools included conditionally)
  const tools = getTools(config);
  const handlers = getHandlers(config);

  const server = new Server(
    { name: 'zitadel-mcp-server', version: '2.0.0' },
    { capabilities: { tools: {} } }
  );

  // List tools — strip internal _meta before returning
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const sanitizedTools = tools.map(({ _meta, ...rest }) => withInstanceParameter(rest));
    return { tools: sanitizedTools };
  });

  // Fields that should never appear in debug logs (PII + sensitive URLs)
  const REDACTED_FIELDS = new Set([
    'email', 'firstName', 'lastName', 'userName',
    'name', 'displayName', 'description', 'query',
    'redirectUris', 'postLogoutRedirectUris',
    'appUrl', 'iconUrl', 'slug',
    'roleKey', 'roleKeys',
    'accessTokenType',
    'expirationDate',
  ]);

  function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      safe[key] = REDACTED_FIELDS.has(key) ? '[REDACTED]' : value;
    }
    return safe;
  }

  // Rate limiters: 60 reads/min, 10 writes/min
  const rateLimiters = createRateLimiters();

  // Every other instance is a `.env.<name>` file next to the default one (see utils/instances.ts).
  const instances = new InstanceRegistry(ctx, envFile ? dirname(envFile) : undefined);
  const dispatch = createDispatcher({ tools, handlers, instances, rateLimiters });

  // Call tool
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const rawArgs = (request.params.arguments ?? {}) as Record<string, unknown>;
    logger.debug(`Tool call: ${toolName}`, { args: redactArgs(rawArgs) });
    return dispatch(toolName, rawArgs);
  });

  // Connect to stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const portalStatus = config.portalDatabaseUrl ? ' (portal extension enabled)' : '';
  logger.info(`Zitadel MCP Server running with ${tools.length} tools${portalStatus}`);
}

// Graceful shutdown
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

main().catch((error) => {
  logger.error('Fatal error', { error: error instanceof Error ? error.message : error });
  process.exit(1);
});
