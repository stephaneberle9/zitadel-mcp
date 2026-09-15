/**
 * Service account (machine user) tools (3 tools)
 * Create machine users and manage their keys via Management API v1
 */

import { z } from 'zod';
import { writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ToolDefinition, ToolHandler } from '../types/tools.js';
import { textResponse, zitadelId } from '../types/tools.js';
import type { CreateMachineUserResponse, CreateMachineKeyResponse, ListMachineKeysResponse } from '../types/zitadel.js';
import { logger } from '../utils/logger.js';

// ─── Tool Definitions ───────────────────────────────────────────────────────

export const SERVICE_ACCOUNT_TOOLS: ToolDefinition[] = [
  {
    name: 'zitadel_create_service_user',
    description: 'Create a new service account (machine user) for API access. Service accounts authenticate via JWT keys, not passwords.',
    inputSchema: {
      type: 'object',
      properties: {
        userName: { type: 'string', description: 'Unique username for the service account' },
        name: { type: 'string', description: 'Display name' },
        description: { type: 'string', description: 'Optional description of what this service account is used for' },
        accessTokenType: {
          type: 'string',
          enum: ['ACCESS_TOKEN_TYPE_BEARER', 'ACCESS_TOKEN_TYPE_JWT'],
          description: 'Token type (default: ACCESS_TOKEN_TYPE_BEARER)',
        },
      },
      required: ['userName', 'name'],
    },
    _meta: { readOnly: false, domain: 'service-accounts' },
    annotations: { title: 'Create Service User', readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'zitadel_create_service_user_key',
    description: 'Generate a new key pair for a service account. The private key is returned ONLY at creation time — save it immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'The service account user ID' },
        expirationDate: { type: 'string', description: 'Optional expiration date (ISO 8601 format)' },
      },
      required: ['userId'],
    },
    _meta: { readOnly: false, domain: 'service-accounts' },
    annotations: { title: 'Create Service User Key', readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'zitadel_list_service_user_keys',
    description: 'List existing keys for a service account. Shows key metadata only (not private keys).',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'The service account user ID' },
      },
      required: ['userId'],
    },
    _meta: { readOnly: true, domain: 'service-accounts' },
    annotations: { title: 'List Service User Keys', readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
];

// ─── Handlers ────────────────────────────────────────────────────────────────

const createServiceUserHandler: ToolHandler = async (params, ctx) => {
  const input = z.object({
    userName: z.string().min(1).max(200),
    name: z.string().min(1).max(200),
    description: z.string().max(500).optional(),
    accessTokenType: z.string().max(50).default('ACCESS_TOKEN_TYPE_BEARER'),
  }).parse(params);

  logger.info('Creating service user');

  const response = await ctx.client.request<CreateMachineUserResponse>(
    '/management/v1/users/machine',
    {
      method: 'POST',
      body: JSON.stringify({
        userName: input.userName,
        name: input.name,
        description: input.description || '',
        accessTokenType: input.accessTokenType,
      }),
    }
  );

  return textResponse(
    `Service account created successfully.\n` +
    `User ID: ${response.userId}\n` +
    `Username: ${input.userName}\n` +
    `Name: ${input.name}\n\n` +
    `Next step: Generate a key with zitadel_create_service_user_key using this User ID.`
  );
};

const createServiceUserKeyHandler: ToolHandler = async (params, ctx) => {
  const input = z.object({
    userId: zitadelId('userId'),
    expirationDate: z.string().max(30).optional(),
  }).parse(params);

  logger.info('Creating service user key', { userId: input.userId });

  const body: Record<string, unknown> = { type: 'KEY_TYPE_JSON' };
  if (input.expirationDate) {
    body['expirationDate'] = input.expirationDate;
  }

  const response = await ctx.client.request<CreateMachineKeyResponse>(
    `/management/v1/users/${input.userId}/keys`,
    { method: 'POST', body: JSON.stringify(body) }
  );

  // Write key to local file instead of returning in MCP response
  const keysDir = join(homedir(), '.zitadel-mcp', 'keys');
  await mkdir(keysDir, { recursive: true, mode: 0o700 });

  const keyFilePath = join(keysDir, `${input.userId}-${response.keyId}.json`);
  await writeFile(keyFilePath, response.keyDetails, { mode: 0o600 });

  return textResponse(
    `Service account key created.\n` +
    `Key ID: ${response.keyId}\n\n` +
    `Private key saved to: ${keyFilePath}\n` +
    `(File permissions: 600 — owner read/write only)\n\n` +
    `Use this key file to configure ZITADEL_SERVICE_ACCOUNT_KEY_ID and ZITADEL_SERVICE_ACCOUNT_PRIVATE_KEY.`
  );
};

const listServiceUserKeysHandler: ToolHandler = async (params, ctx) => {
  const { userId } = z.object({ userId: zitadelId('userId') }).parse(params);

  const response = await ctx.client.request<ListMachineKeysResponse>(
    `/management/v1/users/${userId}/keys/_search`,
    {
      method: 'POST',
      body: JSON.stringify({ query: { offset: '0', limit: 100 } }),
    }
  );

  const keys = response.result || [];
  if (keys.length === 0) {
    return textResponse(`No keys found for service account ${userId}.`);
  }

  const lines = keys.map(k => {
    const expiry = k.expirationDate || 'never';
    return `- Key ${k.id}: type=${k.type}, expires=${expiry}, created=${k.details?.creationDate || 'N/A'}`;
  });

  return textResponse(`Found ${keys.length} key(s) for service account ${userId}:\n\n${lines.join('\n')}`);
};

// ─── Export ──────────────────────────────────────────────────────────────────

export const SERVICE_ACCOUNT_HANDLERS: Record<string, ToolHandler> = {
  zitadel_create_service_user: createServiceUserHandler,
  zitadel_create_service_user_key: createServiceUserKeyHandler,
  zitadel_list_service_user_keys: listServiceUserKeysHandler,
};
