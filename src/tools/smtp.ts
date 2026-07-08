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
import { loadSmtpCreds } from '../utils/smtp-creds.js';

// ─── Endpoints ───────────────────────────────────────────────────────────────

const EMAIL_SEARCH_PATH = '/admin/v1/email/_search';
const EMAIL_SMTP_PATH = '/admin/v1/email/smtp';
const emailSmtpIdPath = (id: string) => `/admin/v1/email/smtp/${id}`;
const emailActivatePath = (id: string) => `/admin/v1/email/${id}/_activate`;
const emailSmtpTestPath = (id: string) => `/admin/v1/email/smtp/${id}/_test`;

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
      '(ORG_OWNER alone yields 403).\n\n' +
      'CREDENTIALS: prefer `credsProfile` — the relay creds (SMTP_HOST/PORT/USER/PASSWORD/FROM) ' +
      'are read from a gitignored file so the password never enters the conversation. The file ' +
      'lives under a per-provider folder `~/.secrets/<provider>/.env[.<profile>]` (e.g. ' +
      '`~/.secrets/brevo/.env.accelerator`); the server auto-discovers the one folder holding ' +
      'a matching `.env[.<profile>]` with SMTP_* keys. If several providers match, pass ' +
      '`credsDir` to disambiguate. Any field passed as an argument overrides the file; passing ' +
      '`password` as an argument DOES put it in the transcript — use `credsProfile` instead.',
    inputSchema: {
      type: 'object',
      properties: {
        credsProfile: { type: 'string', description: 'Non-secret profile selecting the `.env.<profile>` file inside the provider folder (omit for the folder\'s base `.env`), e.g. "accelerator". The relay creds are read from that file — preferred over passing them as args.' },
        credsDir: { type: 'string', description: 'Provider folder to read creds from: a bare name under ~/.secrets (e.g. "brevo") or an absolute path. Needed only to disambiguate when several folders hold a matching .env — otherwise the folder is auto-discovered.' },
        host: { type: 'string', description: 'SMTP host, e.g. "smtp-relay.brevo.com". Overrides SMTP_HOST from the creds file. Port is added from "port" unless already included as host:port.' },
        port: { type: 'number', description: 'SMTP port (default 587). Overrides SMTP_PORT. Ignored if host already contains ":port".' },
        senderAddress: { type: 'string', description: 'From address (verified sender at the relay). Overrides the address parsed from SMTP_FROM.' },
        senderName: { type: 'string', description: 'From display name. Overrides the name parsed from SMTP_FROM.' },
        user: { type: 'string', description: 'SMTP login. Overrides SMTP_USER.' },
        password: { type: 'string', description: 'SMTP password / API key. Overrides SMTP_PASSWORD — but NOTE this puts the secret in the transcript; prefer credsProfile. Never logged or returned.' },
        tls: { type: 'boolean', description: 'Use TLS/STARTTLS (default true; true for Brevo on 587).' },
        replyToAddress: { type: 'string', description: 'Optional Reply-To address.' },
        description: { type: 'string', description: 'Human label for the provider (default "Configured via zitadel-mcp"). Also the idempotency match key.' },
        activate: { type: 'boolean', description: 'Activate the provider after saving (default true).' },
      },
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
  {
    name: 'zitadel_test_smtp_config',
    description:
      'Send a real test e-mail through an instance SMTP provider to verify it actually works ' +
      '(the authoritative check that a set/activate took — a provider can be ACTIVE yet reject ' +
      'mail because of a wrong SMTP key or unverified sender). Tests by provider id and reuses ' +
      'the stored password, so no secret enters the conversation. Reports the relay\'s own reason ' +
      'on failure (e.g. "could not add smtp auth" → bad user/password). Defaults to the currently ' +
      'ACTIVE provider when no id is given. INSTANCE-level (Admin API) — needs an IAM-level write grant.',
    inputSchema: {
      type: 'object',
      properties: {
        receiverAddress: { type: 'string', description: 'Where to send the test mail (a mailbox you can check), e.g. "you@example.com".' },
        id: { type: 'string', description: 'Provider id to test (from zitadel_get_smtp_config). Omit to test the currently ACTIVE provider.' },
      },
      required: ['receiverAddress'],
    },
    _meta: { readOnly: false, domain: 'notifications' },
    annotations: { title: 'Test SMTP Config', readOnlyHint: false, destructiveHint: false, idempotentHint: false },
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
      credsProfile: z.string().max(100).optional(),
      credsDir: z.string().max(300).optional(),
      host: z.string().min(1).max(500).optional(),
      port: z.number().int().min(1).max(65535).optional(),
      senderAddress: z.string().min(1).max(200).optional(),
      senderName: z.string().min(1).max(200).optional(),
      user: z.string().min(1).max(200).optional(),
      password: z.string().min(1).max(200).optional(),
      tls: z.boolean().default(true),
      replyToAddress: z.string().max(200).optional(),
      description: z.string().min(1).max(200).default('Configured via zitadel-mcp'),
      activate: z.boolean().default(true),
    })
    .parse(params);

  // Read relay creds from the gitignored file (keeps the password out of the transcript);
  // any explicit arg overrides the file value. The provider folder under ~/.secrets is
  // auto-discovered unless credsDir/SMTP_ENV_PATH pin it.
  const file = loadSmtpCreds({
    profile: input.credsProfile,
    credsDir: input.credsDir,
    baseEnvPath: process.env['SMTP_ENV_PATH'],
  });

  // SMTP_FROM is a combined "Name <addr>"; split it for ZITADEL's separate name/address fields.
  let senderAddress = input.senderAddress;
  let senderName = input.senderName;
  if ((!senderAddress || !senderName) && file.from) {
    const m = file.from.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
    if (m) {
      senderName = senderName ?? (m[1] || undefined);
      senderAddress = senderAddress ?? m[2];
    } else {
      senderAddress = senderAddress ?? file.from.trim();
    }
  }

  const host = input.host ?? file.host;
  const port = input.port ?? (file.port ? Number(file.port) : undefined);
  const user = input.user ?? file.user;
  const password = input.password ?? file.password;

  const missing: string[] = [];
  if (!host) missing.push('host (SMTP_HOST)');
  if (!senderAddress) missing.push('senderAddress (from SMTP_FROM)');
  if (!senderName) missing.push('senderName (from SMTP_FROM)');
  if (!user) missing.push('user (SMTP_USER)');
  if (!password) missing.push('password (SMTP_PASSWORD)');
  if (missing.length > 0) {
    const where = file.sourcePath
      ? `the creds file ${file.sourcePath}`
      : `a ~/.secrets/<provider>/.env${input.credsProfile ? `.${input.credsProfile}` : ''} file`;
    throw new Error(
      `Missing SMTP settings: ${missing.join(', ')}. Add the SMTP_* keys to ${where} or pass them as arguments.`
    );
  }

  // All five are guaranteed present by the guard above — narrow for TypeScript.
  const smtpHost = host as string;
  const smtpUser = user as string;
  const smtpPassword = password as string;
  const smtpSenderAddress = senderAddress as string;
  const smtpSenderName = senderName as string;

  // ZITADEL requires the port inside the host field ("host:port").
  const hostAndPort = smtpHost.includes(':') ? smtpHost : `${smtpHost}:${port ?? 587}`;

  // Idempotency: reuse an existing SMTP provider that matches on description, host or sender.
  const providers = await listSmtpProviders(ctx);
  const existing = providers.find(
    (p) =>
      p.description === input.description ||
      p.smtp?.host === hostAndPort ||
      p.smtp?.senderAddress === smtpSenderAddress
  );

  // SMTPPlainAuth oneof — the top-level `password` field is deprecated.
  const configBody = {
    senderAddress: smtpSenderAddress,
    senderName: smtpSenderName,
    tls: input.tls,
    host: hostAndPort,
    user: smtpUser,
    replyToAddress: input.replyToAddress ?? '',
    description: input.description,
    plain: { password: smtpPassword },
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
    `Endpoint: ${hostAndPort} (tls: ${input.tls ? 'yes' : 'no'}), sender: ${smtpSenderName} <${smtpSenderAddress}>.\n` +
    `${file.sourcePath ? `Creds read from ${file.sourcePath}.\n` : ''}` +
    `${activated ? 'Activated — ZITADEL now sends notification e-mails through it.' : 'Not activated (activate=false) — call zitadel_activate_smtp_config to switch to it.'}\n\n` +
    `Next: verify it actually delivers with zitadel_test_smtp_config({ receiverAddress: "you@example.com" }) — ` +
    `ACTIVE only means selected, not that the relay accepts the key.\n` +
    `Impact: INSTANCE-level change — affects every org on this ZITADEL instance.`
  );
};

const activateSmtpConfigHandler: ToolHandler = async (params, ctx) => {
  const { id } = z.object({ id: zitadelId('id') }).parse(params);
  logger.info('Activating SMTP email provider', { id });
  await ctx.client.request(emailActivatePath(id), { method: 'POST', body: JSON.stringify({}) });
  return textResponse(`Activated SMTP provider ${id}. ZITADEL now sends notification e-mails through it.`);
};

const testSmtpConfigHandler: ToolHandler = async (params, ctx) => {
  const input = z
    .object({
      receiverAddress: z.string().email('receiverAddress must be a valid e-mail address').max(200),
      id: z.string().min(1).max(100).optional(),
    })
    .parse(params);

  // Default to the ACTIVE provider when no id is given.
  let id = input.id;
  if (!id) {
    const providers = await listSmtpProviders(ctx);
    const active = providers.find(isActive);
    if (!active?.id) {
      throw new Error(
        'No active SMTP provider to test. Pass an id (from zitadel_get_smtp_config) or set one first with zitadel_set_smtp_config.'
      );
    }
    id = active.id;
  }

  logger.info('Testing SMTP email provider', { id });
  try {
    // Test-by-id reuses the stored password (no secret in the request). Expose the relay's
    // rejection reason on failure — that reason is the whole point of a test.
    await ctx.client.request(
      emailSmtpTestPath(id),
      { method: 'POST', body: JSON.stringify({ receiverAddress: input.receiverAddress }) },
      { exposeErrorDetail: true }
    );
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return textResponse(
      `SMTP test FAILED for provider ${id} → ${input.receiverAddress}.\n${detail}\n\n` +
      `Common causes: wrong SMTP_USER/SMTP_PASSWORD (for Brevo the password must be an SMTP key, ` +
      `not the account password), an unverified sender, or a blocked port/TLS setting.`
    );
  }

  return textResponse(
    `SMTP test OK — a test e-mail was sent via provider ${id} to ${input.receiverAddress}. ` +
    `Confirm it arrives (and check the relay's transactional log if it doesn't).`
  );
};

// ─── Export ──────────────────────────────────────────────────────────────────

export const SMTP_HANDLERS: Record<string, ToolHandler> = {
  zitadel_get_smtp_config: getSmtpConfigHandler,
  zitadel_set_smtp_config: setSmtpConfigHandler,
  zitadel_activate_smtp_config: activateSmtpConfigHandler,
  zitadel_test_smtp_config: testSmtpConfigHandler,
};
