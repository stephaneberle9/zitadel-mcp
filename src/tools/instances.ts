/**
 * Instance tools (1 tool)
 * Which ZITADEL instances this session can reach — see utils/instances.ts for how they are named.
 */

import type { ToolDefinition, ToolHandler } from '../types/tools.js';
import { textResponse } from '../types/tools.js';

// ─── Tool Definitions ───────────────────────────────────────────────────────

export const INSTANCE_TOOLS: ToolDefinition[] = [
  {
    name: 'zitadel_list_instances',
    description:
      'List the ZITADEL instances this server can reach: the default one and every ' +
      '.env.<name> file next to its configuration file, with issuer, org id and whether the ' +
      'instance is read-only. Pass a listed name as `instance` to any other tool to run it there.',
    inputSchema: { type: 'object', properties: {} },
    _meta: { readOnly: true, domain: 'utility' },
    annotations: { title: 'List Instances', readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
];

// ─── Handlers ────────────────────────────────────────────────────────────────

const listInstancesHandler: ToolHandler = async (_params, ctx) => {
  if (!ctx.instances) {
    throw new Error('No instance registry available.');
  }
  const lines = ctx.instances.list().map(
    (i) => `  ${i.name}: ${i.issuer} (org ${i.orgId})${i.readOnly ? ' — read-only' : ''}`
  );
  return textResponse(`${lines.length} ZITADEL instance(s):\n${lines.join('\n')}`);
};

// ─── Export ──────────────────────────────────────────────────────────────────

export const INSTANCE_HANDLERS: Record<string, ToolHandler> = {
  zitadel_list_instances: listInstancesHandler,
};
