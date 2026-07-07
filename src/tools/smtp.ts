/**
 * SMTP / email-provider tools (3 tools)
 * Instance notification SMTP provider via the Zitadel Admin API v1 (/admin/v1/email/*).
 *
 * ⚠️ Scope note (deliberate exception to the server's least-privilege stance):
 * Unlike every other tool in this server, these use the **Admin API** (/admin/v1/email/*),
 * NOT the org-scoped Management API (see auth/client.ts). The email/SMTP provider is an
 * INSTANCE-level resource shared by every org on the instance, so ZITADEL gates it behind
 * `iam.write` / `iam.read`. The configured service account therefore needs an **IAM-level
 * manager** grant (e.g. IAM_OWNER) — ORG_OWNER alone yields a 403. The `x-zitadel-orgid`
 * header the client always sends is ignored by these instance-scoped endpoints.
 *
 * We target the modern `/admin/v1/email/*` "Email Provider" endpoints (the older
 * `/admin/v1/smtp` family is deprecated). Auth is the SMTPPlainAuth oneof:
 * `plain: { password }`. The `host` field MUST include the port (e.g. "smtp-relay.brevo.com:587").
 */

import { z } from 'zod';
import type { ToolDefinition, ToolHandler } from '../types/tools.js';
import { textResponse, zitadelId } from '../types/tools.js';
import { logger } from '../utils/logger.js';

// ─── Endpoints ───────────────────────────────────────────────────────────────

const EMAIL_SEARCH_PATH = '/admin/v1/email/_search';
const EMAIL_SMTP_PATH = '/admin/v1/email/smtp';
const emailSmtpIdPath = (id: string) => `/admin/v1/email/smtp/${id}`;
const emailActivatePath = (id: string) => `/admin/v1/email/${id}/_activate`;

// ─── Shapes (subset of the settings.v1.EmailProvider message) ────────────────

interface EmailProviderSmtp {
  senderAddress?: string;
  senderName?: string;
  tls?: boolean;
  host?: string;
  user?: string;
}

interface EmailProvider {
  id?: string;
  /** EMAIL_PROVIDER_ACTIVE | EMAIL_PROVIDER_INACTIVE | EMAIL_PROVIDER_STATE_UNSPECIFIED */
  state?: string;
  description?: string;
  smtp?: EmailProviderSmtp;
  http?: unknown;
}

interface ListEmailProvidersResponse {
  result?: EmailProvider[];
}

interface AddEmailProviderSmtpResponse {
  id?: string;
}

const isActive = (p: EmailProvider) => p.state === 'EMAIL_PROVIDER_ACTIVE';

// ─── Tool Definitions ────────────────────────────────────────────────────────

export const SMTP_TOOLS: ToolDefinition[] = [
  {
    name: 'zitadel_get_smtp_config',
    description:
      'List the instance SMTP notification providers (the servers ZITADEL uses to send ' +
      'verification, password-reset and OTP e-mails). Reports each provider id, whether it is ' +
      'the ACTIVE one, its description, host and sender address. Secrets (password) are never ' +
      'returned. Instance-level (Admin API) — needs an IAM-level read grant.',
    inputSchema: { type: 'object', properties: {} },
    _meta: { readOnly: true, domain: 'notifications' },
    annotations: { title: 'Get SMTP Config', readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'zitadel_set_smtp_config',
    description:
      "Configure the instance SMTP notification provider (e.g. switch ZITADEL from its built-in " +
      'dev server to Brevo/Postmark/SES). Idempotent: if a matching SMTP provider already exists ' +
      '(same description, host or sender) it is UPDATED, otherwise a new one is created. By ' +
      'default the provider is then ACTIVATED so users receive mail through it. INSTANCE-level ' +
      '(Admin API) — affects every org on the instance and needs an IAM-level write grant ' +
      '(ORG_OWNER alone yields 403).',
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'SMTP host, e.g. "smtp-relay.brevo.com". Port is added from "port" unless already included as host:port.' },
        port: { type: 'number', description: 'SMTP port (default 587). Ignored if "host" already contains ":port".' },
        senderAddress: { type: 'string', description: 'From address, e.g. "no-reply@example.com" (must be a verified sender at the relay).' },
        senderName: { type: 'string', description: 'From display name, e.g. "itemis Solutions".' },
        user: { type: 'string', description: 'SMTP login / username at the relay.' },
        password: { type: 'string', description: 'SMTP password / API key at the relay. Never logged or returned.' },
        tls: { type: 'boolean', description: 'Use TLS/STARTTLS (default true; true for Brevo on 587).' },
        replyToAddress: { type: 'string', description: 'Optional Reply-To address.' },
        description: { type: 'string', description: 'Human label for the provider (default "Configured via zitadel-mcp"). Also the idempotency match key.' },
        activate: { type: 'boolean', description: 'Activate the provider after saving (default true).' },
      },
      required: ['host', 'senderAddress', 'senderName', 'user', 'password'],
    },
    _meta: { readOnly: false, domain: 'notifications' },
    annotations: { title: 'Set SMTP Config', readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'zitadel_activate_smtp_config',
    description:
      'Activate an existing SMTP provider by its id (POST /admin/v1/email/{id}/_activate), so ' +
      'ZITADEL sends notification e-mails through it. INSTANCE-level (Admin API) — needs an ' +
      'IAM-level write grant. Usually not needed separately: zitadel_set_smtp_config activates ' +
      'by default.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The email-provider id (from zitadel_get_smtp_config).' },
      },
      required: ['id'],
    },
    _meta: { readOnly: false, domain: 'notifications' },
    annotations: { title: 'Activate SMTP Config', readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
];

// ─── Handlers ────────────────────────────────────────────────────────────────

async function listSmtpProviders(ctx: Parameters<ToolHandler>[1]): Promise<EmailProvider[]> {
  const res = await ctx.client.request<ListEmailProvidersResponse>(EMAIL_SEARCH_PATH, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  // Keep only SMTP providers (the instance may also hold HTTP webhook providers).
  return (res.result ?? []).filter((p) => p.smtp);
}

const getSmtpConfigHandler: ToolHandler = async (_params, ctx) => {
  const providers = await listSmtpProviders(ctx);

  if (providers.length === 0) {
    return textResponse(
      'No SMTP notification provider configured on this instance. ' +
      'ZITADEL is using its built-in default notification server.'
    );
  }

  const lines = providers.map((p) => {
    const s = p.smtp ?? {};
    return [
      `- id: ${p.id ?? '(unknown)'}${isActive(p) ? '  [ACTIVE]' : ''}`,
      `    description: ${p.description || '(none)'}`,
      `    host: ${s.host || '(none)'}`,
      `    sender: ${s.senderName ? `${s.senderName} <${s.senderAddress ?? ''}>` : s.senderAddress || '(none)'}`,
      `    tls: ${s.tls ? 'yes' : 'no'}`,
    ].join('\n');
  });

  const active = providers.filter(isActive).length;
  return textResponse(
    `SMTP notification providers (${providers.length}, ${active} active):\n${lines.join('\n')}`
  );
};

const setSmtpConfigHandler: ToolHandler = async (params, ctx) => {
  const input = z
    .object({
      host: z.string().min(1).max(500),
      port: z.number().int().min(1).max(65535).optional(),
      senderAddress: z.string().min(1).max(200),
      senderName: z.string().min(1).max(200),
      user: z.string().min(1).max(200),
      password: z.string().min(1).max(200),
      tls: z.boolean().default(true),
      replyToAddress: z.string().max(200).optional(),
      description: z.string().min(1).max(200).default('Configured via zitadel-mcp'),
      activate: z.boolean().default(true),
    })
    .parse(params);

  // ZITADEL requires the port inside the host field ("host:port").
  const hostAndPort = input.host.includes(':') ? input.host : `${input.host}:${input.port ?? 587}`;

  // Idempotency: reuse an existing SMTP provider that matches on description, host or sender.
  const providers = await listSmtpProviders(ctx);
  const existing = providers.find(
    (p) =>
      p.description === input.description ||
      p.smtp?.host === hostAndPort ||
      p.smtp?.senderAddress === input.senderAddress
  );

  // SMTPPlainAuth oneof — the top-level `password` field is deprecated.
  const configBody = {
    senderAddress: input.senderAddress,
    senderName: input.senderName,
    tls: input.tls,
    host: hostAndPort,
    user: input.user,
    replyToAddress: input.replyToAddress ?? '',
    description: input.description,
    plain: { password: input.password },
  };

  let id: string;
  let created: boolean;
  if (existing?.id) {
    id = existing.id;
    created = false;
    logger.info('Updating SMTP email provider', { id });
    await ctx.client.request(emailSmtpIdPath(id), {
      method: 'PUT',
      body: JSON.stringify({ ...configBody, id }),
    });
  } else {
    logger.info('Adding SMTP email provider');
    const res = await ctx.client.request<AddEmailProviderSmtpResponse>(EMAIL_SMTP_PATH, {
      method: 'POST',
      body: JSON.stringify(configBody),
    });
    if (!res.id) {
      throw new Error('AddEmailProviderSMTP did not return a provider id');
    }
    id = res.id;
    created = true;
  }

  let activated = false;
  if (input.activate) {
    logger.info('Activating SMTP email provider', { id });
    await ctx.client.request(emailActivatePath(id), { method: 'POST', body: JSON.stringify({}) });
    activated = true;
  }

  return textResponse(
    `${created ? 'Created' : 'Updated'} SMTP provider "${input.description}" (id ${id}).\n` +
    `Endpoint: ${hostAndPort} (tls: ${input.tls ? 'yes' : 'no'}), sender: ${input.senderName} <${input.senderAddress}>.\n` +
    `${activated ? 'Activated — ZITADEL now sends notification e-mails through it.' : 'Not activated (activate=false) — call zitadel_activate_smtp_config to switch to it.'}\n\n` +
    `Impact: INSTANCE-level change — affects every org on this ZITADEL instance.`
  );
};

const activateSmtpConfigHandler: ToolHandler = async (params, ctx) => {
  const { id } = z.object({ id: zitadelId('id') }).parse(params);
  logger.info('Activating SMTP email provider', { id });
  await ctx.client.request(emailActivatePath(id), { method: 'POST', body: JSON.stringify({}) });
  return textResponse(`Activated SMTP provider ${id}. ZITADEL now sends notification e-mails through it.`);
};

// ─── Export ──────────────────────────────────────────────────────────────────

export const SMTP_HANDLERS: Record<string, ToolHandler> = {
  zitadel_get_smtp_config: getSmtpConfigHandler,
  zitadel_set_smtp_config: setSmtpConfigHandler,
  zitadel_activate_smtp_config: activateSmtpConfigHandler,
};
