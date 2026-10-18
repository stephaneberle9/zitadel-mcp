/**
 * User management tools (8 tools)
 * CRUD operations for human users via Zitadel v2 API
 */

import { z } from 'zod';
import type { ToolDefinition, ToolHandler, HandlerContext } from '../types/tools.js';
import { textResponse, errorResponse, zitadelId } from '../types/tools.js';
import type { ListUsersResponse, CreateUserResponse, ZitadelUserDetails, GetUserResponse } from '../types/zitadel.js';
import { logger } from '../utils/logger.js';

// ─── Authentication setup ───────────────────────────────────────────────────

/**
 * How a new human user gets their first credential — the options of the Console's
 * "Create a new user" form:
 *   invite   — ZITADEL mails an invitation (CreateInviteCode with sendCode): the user sets
 *              up authentication and thereby verifies the e-mail address.
 *   later    — "Setup authentication later for this User": nothing is mailed.
 *   password — an initial password is set; nothing is mailed.
 */
export const USER_SETUP_MODES = ['invite', 'later', 'password'] as const;
export type UserSetupMode = (typeof USER_SETUP_MODES)[number];

/** JSON-schema properties shared by every tool that creates a human user. */
export const USER_SETUP_PROPERTIES = {
  setupMode: {
    type: 'string',
    enum: [...USER_SETUP_MODES],
    description:
      'How the user sets up authentication (default "invite"). "invite": ZITADEL is asked to mail an invitation ' +
      '(authentication setup + e-mail verification). "later": no mail; the user cannot sign in until a credential ' +
      'is set up. "password": set an initial password (requires `password`); no mail.',
  },
  password: { type: 'string', description: 'Initial password; required for setupMode "password", rejected otherwise. Never echoed back.' },
  passwordChangeRequired: { type: 'boolean', description: 'For setupMode "password": force a password change at first login (default: true)' },
  emailVerified: { type: 'boolean', description: 'Mark the e-mail address as already verified (default: false)' },
};

/** Zod shape matching USER_SETUP_PROPERTIES. Combine with `refineUserSetup`. */
export const userSetupShape = {
  setupMode: z.enum(USER_SETUP_MODES).default('invite'),
  password: z.string().min(1).max(200).optional(),
  passwordChangeRequired: z.boolean().default(true),
  emailVerified: z.boolean().default(false),
};

export function refineUserSetup(input: { setupMode: UserSetupMode; password?: string }, ctx: z.RefinementCtx): void {
  if (input.setupMode === 'password' && !input.password) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['password'], message: 'setupMode "password" requires a password' });
  }
  if (input.setupMode !== 'password' && input.password !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['password'], message: 'password is only accepted with setupMode "password"' });
  }
}

// ─── Tool Definitions ───────────────────────────────────────────────────────

export const USER_TOOLS: ToolDefinition[] = [
  {
    name: 'zitadel_list_users',
    description: 'List or search users in the Zitadel instance. Returns user details including name, email, status, and login names.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Optional search query to filter users by email, name, or username',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of users to return (default: 50)',
        },
      },
    },
    _meta: { readOnly: true, domain: 'users' },
    annotations: { title: 'List Users', readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'zitadel_get_user',
    description: 'Get detailed information about a specific user by their user ID.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'The Zitadel user ID' },
      },
      required: ['userId'],
    },
    _meta: { readOnly: true, domain: 'users' },
    annotations: { title: 'Get User', readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'zitadel_create_user',
    description: 'Create a new human user in Zitadel. `setupMode` picks how the user gets a first credential, as in the Console: "invite" (default) asks ZITADEL to mail an invitation, "later" mails nothing, "password" sets an initial password and mails nothing. The result reports only what ZITADEL was asked to do; delivery of a mail is never confirmed. Optionally supply your own userId for idempotent retries (a re-create then conflicts cleanly).',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Email address for the new user' },
        firstName: { type: 'string', description: 'First name' },
        lastName: { type: 'string', description: 'Last name' },
        userId: { type: 'string', description: 'Optional client-supplied user ID for idempotency (Zitadel generates one if omitted)' },
        ...USER_SETUP_PROPERTIES,
      },
      required: ['email', 'firstName', 'lastName'],
    },
    _meta: { readOnly: false, domain: 'users' },
    annotations: { title: 'Create User', readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'zitadel_deactivate_user',
    description: 'Deactivate a user account. The user will no longer be able to log in. Requires confirm: true.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'The Zitadel user ID to deactivate' },
        confirm: { type: 'boolean', description: 'Must be true to execute. Omit to preview the action.' },
      },
      required: ['userId'],
    },
    _meta: { readOnly: false, domain: 'users' },
    annotations: { title: 'Deactivate User', readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  },
  {
    name: 'zitadel_reactivate_user',
    description: 'Reactivate a previously deactivated user account.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'The Zitadel user ID to reactivate' },
      },
      required: ['userId'],
    },
    _meta: { readOnly: false, domain: 'users' },
    annotations: { title: 'Reactivate User', readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'zitadel_lock_user',
    description: 'Lock a user account. The user will not be able to log in until unlocked. Requires confirm: true.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'The Zitadel user ID to lock' },
        confirm: { type: 'boolean', description: 'Must be true to execute. Omit to preview the action.' },
      },
      required: ['userId'],
    },
    _meta: { readOnly: false, domain: 'users' },
    annotations: { title: 'Lock User', readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  },
  {
    name: 'zitadel_unlock_user',
    description: 'Unlock a previously locked user account.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'The Zitadel user ID to unlock' },
      },
      required: ['userId'],
    },
    _meta: { readOnly: false, domain: 'users' },
    annotations: { title: 'Unlock User', readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'zitadel_delete_user',
    description: 'Permanently delete a user. This action cannot be undone. Requires confirm: true. Consider using zitadel_deactivate_user instead (reversible).',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'The Zitadel user ID to delete' },
        confirm: { type: 'boolean', description: 'Must be true to execute. Omit to preview the action.' },
      },
      required: ['userId'],
    },
    _meta: { readOnly: false, domain: 'users' },
    annotations: { title: 'Delete User', readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
];

// ─── Handlers ────────────────────────────────────────────────────────────────

function formatUser(u: ZitadelUserDetails): string {
  const name = u.human?.profile
    ? `${u.human.profile.givenName} ${u.human.profile.familyName}`.trim()
    : u.username;
  const email = u.human?.email?.email || 'N/A';
  const state = u.state.replace('USER_STATE_', '');
  return `- ${name} (${email}) [${state}] ID: ${u.userId}`;
}

const listUsersHandler: ToolHandler = async (params, ctx) => {
  const input = z.object({
    query: z.string().max(200).optional(),
    limit: z.number().min(1).max(500).default(50),
  }).parse(params);

  const queries: unknown[] = [];
  if (input.query) {
    queries.push({
      emailQuery: { emailAddress: input.query, method: 'TEXT_QUERY_METHOD_CONTAINS_IGNORE_CASE' },
    });
  }

  const response = await ctx.client.request<ListUsersResponse>('/v2/users', {
    method: 'POST',
    body: JSON.stringify({
      query: { offset: '0', limit: input.limit },
      ...(queries.length > 0 ? { queries } : {}),
    }),
  });

  const users = response.result || [];
  if (users.length === 0) {
    return textResponse('No users found.');
  }

  const total = response.details?.totalResult || users.length;
  const lines = users.map(formatUser);
  return textResponse(`Found ${total} user(s):\n\n${lines.join('\n')}`);
};

const getUserHandler: ToolHandler = async (params, ctx) => {
  const { userId } = z.object({ userId: zitadelId('userId') }).parse(params);

  const response = await ctx.client.request<GetUserResponse>(`/v2/users/${userId}`);
  const u = response.user;
  const name = u.human?.profile
    ? `${u.human.profile.givenName} ${u.human.profile.familyName}`.trim()
    : u.username;

  const lines = [
    `User: ${name}`,
    `ID: ${u.userId}`,
    `Email: ${u.human?.email?.email || 'N/A'}`,
    // The v2 API names the flag `isVerified`, and omits it when false (proto3 JSON).
    `Email Verified: ${u.human?.email ? u.human.email.isVerified === true : 'N/A'}`,
    `State: ${u.state.replace('USER_STATE_', '')}`,
    `Username: ${u.username}`,
    `Login Names: ${(u.loginNames || []).join(', ')}`,
    `Created: ${u.details?.creationDate || 'N/A'}`,
  ];

  return textResponse(lines.join('\n'));
};

/**
 * Find a human user by exact email address. Returns the first match or null.
 * Used for idempotent provisioning (pre-check by email before create).
 */
export async function findUserByEmail(ctx: HandlerContext, email: string): Promise<ZitadelUserDetails | null> {
  const response = await ctx.client.request<ListUsersResponse>('/v2/users', {
    method: 'POST',
    body: JSON.stringify({
      query: { offset: '0', limit: 2 },
      queries: [{ emailQuery: { emailAddress: email, method: 'TEXT_QUERY_METHOD_EQUALS_IGNORE_CASE' } }],
    }),
  });
  const users = response.result || [];
  return users.find((u) => u.human?.email?.email?.toLowerCase() === email.toLowerCase()) || users[0] || null;
}

export interface CreateHumanUserArgs {
  email: string;
  firstName: string;
  lastName: string;
  userId?: string;
  setupMode: UserSetupMode;
  password?: string;
  passwordChangeRequired: boolean;
  emailVerified: boolean;
}

export interface CreateHumanUserResult {
  userId: string;
  /** Set when setupMode "invite" created the user but the invitation request failed. */
  inviteError?: string;
}

/**
 * Create a human user via the v2 API the way the Console does: AddHumanUser with
 * `email.isVerified` set explicitly (so ZITADEL sends no verification mail of its own) and,
 * for setupMode "password", an initial password; then, for setupMode "invite", CreateInviteCode
 * with `sendCode`. Supports a client-supplied userId.
 *
 * A failed invitation does not undo the creation: the user id is returned with `inviteError`.
 */
export async function createHumanUser(ctx: HandlerContext, args: CreateHumanUserArgs): Promise<CreateHumanUserResult> {
  const body: Record<string, unknown> = {
    profile: { givenName: args.firstName, familyName: args.lastName },
    email: { email: args.email, isVerified: args.emailVerified },
  };
  if (args.userId) body['userId'] = args.userId;
  if (args.setupMode === 'password') {
    body['password'] = { password: args.password, changeRequired: args.passwordChangeRequired };
  }

  const response = await ctx.client.request<CreateUserResponse>('/v2/users/human', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const userId = response.userId;

  if (args.setupMode === 'invite') {
    try {
      await ctx.client.request(`/v2/users/${userId}/invite_code`, {
        method: 'POST',
        body: JSON.stringify({ sendCode: {} }),
      });
    } catch (e) {
      const status = (e as { status?: number }).status;
      const message = e instanceof Error ? e.message : String(e);
      return { userId, inviteError: status ? `${message} (HTTP ${status})` : message };
    }
  }
  return { userId };
}

/** What a user-creating tool reports about mail for the given setupMode. Never claims delivery. */
export function describeUserSetup(args: CreateHumanUserArgs, result: CreateHumanUserResult): string {
  const emailState = args.emailVerified ? 'marked verified' : 'not verified';
  switch (args.setupMode) {
    case 'invite':
      if (result.inviteError) {
        return (
          `⚠ The user was created, but the invitation request failed: ${result.inviteError}. No mail was sent. ` +
          `The user was kept; send the invitation from the Console (or POST /v2/users/${result.userId}/invite_code).`
        );
      }
      return (
        `Invitation mail requested: ZITADEL accepted the request to mail ${args.email} an invitation ` +
        `(authentication setup + e-mail verification). Delivery is not confirmed; if nothing arrives, check the SMTP provider.`
      );
    case 'later':
      return (
        `No mail sent: authentication setup was left for later (e-mail ${emailState}). ` +
        `The user cannot sign in until a credential is set up, e.g. by an invitation from the Console.`
      );
    case 'password':
      return (
        `No mail sent: an initial password was set (change required at first login: ${args.passwordChangeRequired ? 'yes' : 'no'}; ` +
        `e-mail ${emailState}).`
      );
  }
}

const createUserHandler: ToolHandler = async (params, ctx) => {
  const input = z.object({
    email: z.string().email().max(320),
    firstName: z.string().min(1).max(200),
    lastName: z.string().min(1).max(200),
    userId: zitadelId('userId').optional(),
    ...userSetupShape,
  }).superRefine(refineUserSetup).parse(params);

  logger.info('Creating user', { setupMode: input.setupMode });

  const result = await createHumanUser(ctx, input);
  const text =
    `User created.\n` +
    `User ID: ${result.userId}\n` +
    `Email: ${input.email}\n` +
    `Name: ${input.firstName} ${input.lastName}\n\n` +
    describeUserSetup(input, result);

  return result.inviteError ? errorResponse(text) : textResponse(text);
};

const deactivateUserHandler: ToolHandler = async (params, ctx) => {
  const { userId, confirm } = z.object({ userId: zitadelId('userId'), confirm: z.boolean().optional() }).parse(params);

  if (!confirm) {
    const user = await ctx.client.request<GetUserResponse>(`/v2/users/${userId}`);
    const name = user.user.human?.profile
      ? `${user.user.human.profile.givenName} ${user.user.human.profile.familyName}`.trim()
      : user.user.username;
    return textResponse(
      `⚠ CONFIRM: Deactivate user "${name}" (${userId})?\n` +
      `This will prevent the user from logging in.\n\n` +
      `To proceed, call zitadel_deactivate_user again with confirm: true.`
    );
  }

  await ctx.client.request(`/v2/users/${userId}/deactivate`, { method: 'POST' });
  return textResponse(`User ${userId} has been deactivated.`);
};

const reactivateUserHandler: ToolHandler = async (params, ctx) => {
  const { userId } = z.object({ userId: zitadelId('userId') }).parse(params);

  await ctx.client.request(`/v2/users/${userId}/reactivate`, { method: 'POST' });
  return textResponse(`User ${userId} has been reactivated.`);
};

const lockUserHandler: ToolHandler = async (params, ctx) => {
  const { userId, confirm } = z.object({ userId: zitadelId('userId'), confirm: z.boolean().optional() }).parse(params);

  if (!confirm) {
    const user = await ctx.client.request<GetUserResponse>(`/v2/users/${userId}`);
    const name = user.user.human?.profile
      ? `${user.user.human.profile.givenName} ${user.user.human.profile.familyName}`.trim()
      : user.user.username;
    return textResponse(
      `⚠ CONFIRM: Lock user "${name}" (${userId})?\n` +
      `This will prevent the user from logging in until unlocked.\n\n` +
      `To proceed, call zitadel_lock_user again with confirm: true.`
    );
  }

  await ctx.client.request(`/v2/users/${userId}/lock`, { method: 'POST' });
  return textResponse(`User ${userId} has been locked.`);
};

const unlockUserHandler: ToolHandler = async (params, ctx) => {
  const { userId } = z.object({ userId: zitadelId('userId') }).parse(params);

  await ctx.client.request(`/v2/users/${userId}/unlock`, { method: 'POST' });
  return textResponse(`User ${userId} has been unlocked.`);
};

const deleteUserHandler: ToolHandler = async (params, ctx) => {
  const { userId, confirm } = z.object({ userId: zitadelId('userId'), confirm: z.boolean().optional() }).parse(params);

  if (!confirm) {
    const user = await ctx.client.request<GetUserResponse>(`/v2/users/${userId}`);
    const name = user.user.human?.profile
      ? `${user.user.human.profile.givenName} ${user.user.human.profile.familyName}`.trim()
      : user.user.username;
    return textResponse(
      `⚠ CONFIRM: PERMANENTLY DELETE user "${name}" (${userId})?\n` +
      `This action CANNOT be undone. The user will lose access to ALL federated applications.\n` +
      `Consider using zitadel_deactivate_user instead (reversible).\n\n` +
      `To proceed, call zitadel_delete_user again with confirm: true.`
    );
  }

  await ctx.client.request(`/v2/users/${userId}`, { method: 'DELETE' });
  return textResponse(`User ${userId} has been permanently deleted.`);
};

// ─── Export ──────────────────────────────────────────────────────────────────

export const USER_HANDLERS: Record<string, ToolHandler> = {
  zitadel_list_users: listUsersHandler,
  zitadel_get_user: getUserHandler,
  zitadel_create_user: createUserHandler,
  zitadel_deactivate_user: deactivateUserHandler,
  zitadel_reactivate_user: reactivateUserHandler,
  zitadel_lock_user: lockUserHandler,
  zitadel_unlock_user: unlockUserHandler,
  zitadel_delete_user: deleteUserHandler,
};
