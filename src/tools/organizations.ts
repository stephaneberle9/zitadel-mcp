/**
 * Organization tools (1 tool)
 * Org-level operations via Zitadel Management API v1
 *
 * Note: zitadel_list_orgs was removed — it used the Admin API (/admin/v1/orgs/_search)
 * which requires IAM-level admin permissions. This violates least-privilege; the MCP
 * server should stay on org-scoped Management API endpoints for org administration. Use
 * the Zitadel Console for cross-org administration. (The SMTP tools in src/tools/smtp.ts
 * are a deliberate, documented exception that does use the Admin API for the instance-level
 * notification provider.)
 */

import type { ToolDefinition, ToolHandler } from '../types/tools.js';
import { textResponse } from '../types/tools.js';
import type { GetOrgResponse } from '../types/zitadel.js';

// ─── Tool Definitions ───────────────────────────────────────────────────────

export const ORG_TOOLS: ToolDefinition[] = [
  {
    name: 'zitadel_get_org',
    description: 'Get details of the current organization (based on the configured ZITADEL_ORG_ID).',
    inputSchema: { type: 'object', properties: {} },
    _meta: { readOnly: true, domain: 'organizations' },
    annotations: { title: 'Get Organization', readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
];

// ─── Handlers ────────────────────────────────────────────────────────────────

const getOrgHandler: ToolHandler = async (_params, ctx) => {
  const response = await ctx.client.request<GetOrgResponse>('/management/v1/orgs/me');
  const org = response.org;

  const lines = [
    `Organization: ${org.name}`,
    `ID: ${org.id}`,
    `State: ${org.state?.replace('ORG_STATE_', '') || 'UNKNOWN'}`,
    `Primary Domain: ${org.primaryDomain || 'N/A'}`,
    `Created: ${org.details?.creationDate || 'N/A'}`,
  ];

  return textResponse(lines.join('\n'));
};

// ─── Export ──────────────────────────────────────────────────────────────────

export const ORG_HANDLERS: Record<string, ToolHandler> = {
  zitadel_get_org: getOrgHandler,
};
