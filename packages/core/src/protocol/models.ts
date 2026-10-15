/**
 * Model layer protocol — normalized streaming events bridging provider SDKs
 * to the agent runtime. Mirrors the observed stream update family
 * (TextDeltaUpdate / ThinkingDeltaUpdate / ToolCallStartedUpdate / ...).
 */

import type { ModelToolCall, TokenUsage } from './session.js';
import type { ModelToolDef } from './tools.js';

export type ModelProvider = 'anthropic' | 'openai' | 'mock';

export interface ModelConfig {
  provider: ModelProvider;
  id: string;
  api_key?: string;
  base_url?: string;
  max_tokens?: number;
  temperature?: number;
}

export const DEFAULT_MODELS: Record<ModelProvider, string> = {
  anthropic: 'claude-sonnet-4-5',
  openai: 'gpt-5.2',
  mock: 'mock-1',
};

export type ModelStreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-call'; call: ModelToolCall }
  | { type: 'usage'; usage: Partial<TokenUsage> }
  | {
      type: 'stop';
      reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'error';
    };

export interface ModelRequest {
  system?: string;
  /** Normalized conversation history (see protocol/session Message union). */
  messages: unknown[];
  tools: ModelToolDef[];
  signal?: AbortSignal;
  max_tokens?: number;
  temperature?: number;
}

export interface ModelClient {
  readonly provider: ModelProvider;
  readonly id: string;
  /** Stream a single completion. Implementations must be abort-safe. */
  generate(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
}
