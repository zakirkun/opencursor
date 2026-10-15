/** Shared server types. */

import type { DatabaseSync } from 'node:sqlite';
import type {
  AgentRuntime,
  Homebase,
  Indexer,
  McpManager,
  MemoryAccessor,
  OpenCursorConfig,
  PermissionDecision,
  SessionStore,
  SubagentRunner,
  ToolRegistry,
  ModelClient,
} from '@opencursor/core';

export interface RpcRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface PendingPermission {
  resolve: (decision: PermissionDecision) => void;
  tool: string;
  summary: string;
  args: unknown;
}

export interface PendingQuestion {
  resolve: (answers: Array<{ question: string; answers: string[] }>) => void;
}

export interface ServerContext {
  cwd: string;
  home: Homebase;
  config: OpenCursorConfig;
  db: DatabaseSync;
  store: SessionStore;
  memory: MemoryAccessor;
  mcp: McpManager;
  indexer: Indexer;
  tools: ToolRegistry;
  subagents: SubagentRunner;
  getModelClient: () => ModelClient | null;
  modelStatus: () => { configured: boolean; provider: string | null; model: string | null; reason?: string };
  applyModelConfig: () => Promise<void>;
  getRuntime: () => AgentRuntime | null;
  createRuntime: (sessionId?: string) => Promise<AgentRuntime>;
  /** Mode chosen before a session existed; applied on runtime creation. */
  getPendingMode: () => 'agent' | 'plan' | null;
  setPendingMode: (mode: 'agent' | 'plan' | null) => void;
  pumpEvents: (runtime: AgentRuntime) => void;
  broadcast: (message: unknown) => void;
  pendingPermissions: Map<string, PendingPermission>;
  pendingQuestions: Map<string, PendingQuestion>;
  sseClientCount: () => number;
  updateConfig: (patch: Record<string, unknown>) => Promise<OpenCursorConfig>;
  reloadConfig: () => OpenCursorConfig;
}
