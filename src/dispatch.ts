/**
 * Tool-call dispatch — everything between the MCP request and a tool handler: instance
 * resolution, the read-only guard, rate limiting and error shaping. Kept apart from index.ts so
 * it can be tested without a transport.
 */

import type { ToolDefinition, ToolHandler } from './types/tools.js';
import type { RateLimiter } from './utils/rate-limiter.js';
import { instanceBanner, type InstanceRegistry } from './utils/instances.js';
import { logger } from './utils/logger.js';

// A type alias, not an interface: the MCP SDK's result type has an index signature, which only an
// alias satisfies structurally.
export type DispatchResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError: boolean;
};

export interface DispatcherOptions {
  tools: ToolDefinition[];
  handlers: Record<string, ToolHandler>;
  instances: InstanceRegistry;
  rateLimiters: { read: RateLimiter; write: RateLimiter };
}

const failure = (text: string): DispatchResult => ({ content: [{ type: 'text', text }], isError: true });

export function createDispatcher({ tools, handlers, instances, rateLimiters }: DispatcherOptions) {
  const readOnlyToolNames = new Set(tools.filter((t) => t._meta?.readOnly).map((t) => t.name));

  return async function dispatch(toolName: string, rawArgs: Record<string, unknown>): Promise<DispatchResult> {
    try {
      const handler = handlers[toolName];
      if (!handler) {
        return failure(`Unknown tool: ${toolName}`);
      }

      // `instance` is the dispatcher's argument, never the handler's: handlers keep their own
      // strict schemas and only ever see the context of the instance named here.
      const { instance: instanceName, ...args } = rawArgs;
      let instance;
      try {
        instance = instances.resolve(instanceName);
      } catch (error) {
        // The reason (an unknown name, the file it was looked for in) is the user's to fix and
        // carries no secret, so it is returned rather than replaced by the generic message.
        return failure(error instanceof Error ? error.message : String(error));
      }
      const banner = instanceBanner(instance);

      // Block write operations on a read-only instance (process-wide or per instance file).
      const isReadOnly = readOnlyToolNames.has(toolName);
      if (instance.ctx.config.readOnly && !isReadOnly) {
        return failure(`${banner}\nBlocked: ZITADEL_READ_ONLY is enabled for this instance. Tool "${toolName}" requires write access.`);
      }

      // Rate limiting: separate buckets for read vs write, shared across instances
      const limiter = isReadOnly ? rateLimiters.read : rateLimiters.write;
      if (!limiter.tryAcquire()) {
        const kind = isReadOnly ? 'read' : 'write';
        logger.warn(`Rate limit exceeded for ${kind} operation: ${toolName}`);
        return failure(`Rate limit exceeded for ${kind} operations. Please wait before trying again.`);
      }

      const result = await handler(args, { ...instance.ctx, instances });
      const [first, ...rest] = result.content;
      const content = first
        ? [{ ...first, text: `${banner}\n${first.text}` }, ...rest]
        : [{ type: 'text' as const, text: banner }];
      return { content, isError: result.isError || false };
    } catch (error) {
      // Log full error details internally but return generic message to MCP client
      logger.error(`Error in ${toolName}`, { error: error instanceof Error ? error.message : error });
      return failure(`An error occurred while executing ${toolName}. Check server logs for details.`);
    }
  };
}
