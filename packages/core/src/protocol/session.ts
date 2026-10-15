/**
 * Session state — turn/message model mirroring the observed
 * `ConversationStateStructure` (turns, todos, token details, file states).
 */

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

/**
 * Session mode — mirrors the observed `TASK_MODE_AGENT` / `TASK_MODE_PLAN`.
 * Plan mode is read-only: it researches and produces a plan without editing.
 */
export type SessionMode = 'agent' | 'plan';

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
  priority?: 'high' | 'medium' | 'low';
}

/** A single model tool call inside an assistant message. */
export interface ModelToolCall {
  id: string;
  name: string;
  args: unknown;
  /** Raw JSON string as received from the provider (kept for audit). */
  args_raw?: string;
}

export interface ModelToolCallRecord extends ModelToolCall {
  /** Serializable outcome after execution. */
  outcome?: unknown;
  duration_ms?: number;
}

export interface UserMessage {
  role: 'user';
  text: string;
  timestamp: string;
}

export interface AssistantMessage {
  role: 'assistant';
  text: string;
  reasoning?: string;
  tool_calls: ModelToolCallRecord[];
  timestamp: string;
}

export interface ToolResultMessage {
  role: 'tool';
  results: Array<{
    call_id: string;
    name: string;
    outcome: unknown;
  }>;
  timestamp: string;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface ConversationSummary {
  text: string;
  archived_message_count: number;
  created_at: string;
}

export interface SessionState {
  version: 1;
  id: string;
  created_at: string;
  updated_at: string;
  cwd: string;
  model: { provider: string; id: string };
  mode?: SessionMode;
  messages: Message[];
  todos: TodoItem[];
  usage: TokenUsage;
  summary?: ConversationSummary;
}

export interface CheckpointInfo {
  id: string;
  session_id: string;
  created_at: string;
  tool: string;
  path: string;
  existed: boolean;
  bytes: number;
}

/** Turn result summary exposed to the UI. */
export interface TurnSummary {
  turn_id: string;
  started_at: string;
  ended_at?: string;
  reason?: 'end_turn' | 'max_iterations' | 'aborted' | 'error';
  tool_calls: number;
  usage: TokenUsage;
}
