/** MCP manager — connects configured servers and routes tool calls. */

import type { McpServerInfo } from '../protocol/tools.js';
import type { McpCallResult, McpServerConfig, McpToolDescriptor } from './client.js';
import { McpClient } from './client.js';

export interface McpManager {
  connectAll(): Promise<McpServerInfo[]>;
  servers(): McpServerInfo[];
  call(server: string, tool: string, args: Record<string, unknown>): Promise<McpCallResult>;
  closeAll(): Promise<void>;
}

interface ServerState {
  info: McpServerInfo;
  client: McpClient | null;
  tools: McpToolDescriptor[];
}

export function createMcpManager(config: Record<string, McpServerConfig>): McpManager {
  const states = new Map<string, ServerState>();
  for (const [name, serverConfig] of Object.entries(config)) {
    if (serverConfig.enabled === false) continue;
    states.set(name, {
      info: { name, status: 'failed', tools: [] },
      client: null,
      tools: [],
    });
  }

  return {
    async connectAll(): Promise<McpServerInfo[]> {
      const results: McpServerInfo[] = [];
      for (const [name, state] of states) {
        const configForName = config[name];
        if (!configForName) continue;
        const client = new McpClient(name, configForName);
        try {
          await client.connect();
          const tools = await client.listTools();
          state.client = client;
          state.tools = tools;
          state.info = {
            name,
            status: 'connected',
            tools: tools.map((tool) => ({ name: tool.name, description: tool.description })),
          };
        } catch (error) {
          await client.close().catch(() => undefined);
          const detail = error instanceof Error ? error.message : String(error);
          const stderr = client.lastStderr;
          state.client = null;
          state.tools = [];
          state.info = {
            name,
            status: 'failed',
            error: stderr.length > 0 ? `${detail} — stderr: ${stderr.slice(0, 300)}` : detail,
            tools: [],
          };
        }
        results.push(state.info);
      }
      return results;
    },

    servers(): McpServerInfo[] {
      return [...states.values()].map((state) => state.info);
    },

    async call(server: string, tool: string, args: Record<string, unknown>): Promise<McpCallResult> {
      const state = states.get(server);
      if (!state) throw new Error(`unknown MCP server: ${server}`);
      if (!state.client) throw new Error(`MCP server not connected: ${server}`);
      return state.client.callTool(tool, args);
    },

    async closeAll(): Promise<void> {
      for (const state of states.values()) {
        if (state.client) {
          await state.client.close().catch(() => undefined);
          state.client = null;
        }
      }
    },
  };
}

export { McpClient } from './client.js';
export type { McpServerConfig, McpToolDescriptor, McpCallResult } from './client.js';
