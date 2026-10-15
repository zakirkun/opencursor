/** mcp tool — list connected MCP servers and invoke their tools. */

import type { ToolHandlerFor } from '../types.js';
import type { McpArgs, McpToolResult } from '../protocol/tools.js';
import { err, ok } from '../protocol/tools.js';
import type { McpManager } from '../mcp/manager.js';

export function createMcpTool(manager: McpManager): ToolHandlerFor<'mcp'> {
  return {
    name: 'mcp',
    description:
      'Use MCP (Model Context Protocol) servers configured on this machine. ' +
      'operation=list shows servers and their tools; operation=call invokes a tool with arguments.',
    input_schema: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['list', 'call'] },
        server: { type: 'string', description: 'Server name (required for call)' },
        tool: { type: 'string', description: 'Tool name (required for call)' },
        arguments: { type: 'object', description: 'Tool arguments (call only)' },
      },
      required: ['operation'],
    },
    default_permission: 'ask',
    async execute(args: McpArgs) {
      const servers = manager.servers();
      if (args.operation === 'list') {
        if (servers.length === 0) {
          const value: McpToolResult = { servers: [], message: 'no MCP servers configured' };
          return ok(value);
        }
        const value: McpToolResult = { servers };
        return ok(value);
      }
      if (args.operation === 'call') {
        if (!args.server || !args.tool) {
          return err('invalid_args', 'server and tool are required for call');
        }
        const server = servers.find((entry) => entry.name === args.server);
        if (!server) {
          const available = servers.map((entry) => entry.name).join(', ') || 'none';
          return err('invalid_args', `unknown MCP server '${args.server}'; available: ${available}`);
        }
        if (server.status !== 'connected') {
          return err('internal', `MCP server '${args.server}' is not connected: ${server.error ?? 'unknown error'}`);
        }
        try {
          const result = await manager.call(args.server, args.tool, args.arguments ?? {});
          const value: McpToolResult = {
            content: result.content,
            is_error: result.isError,
            message: `${args.server}/${args.tool} ${result.isError ? 'reported an error' : 'completed'}`,
          };
          return ok(value);
        } catch (error) {
          return err('internal', String(error instanceof Error ? error.message : error));
        }
      }
      return err('invalid_args', `unknown operation: ${String(args.operation)}`);
    },
  };
}
