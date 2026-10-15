/**
 * Runtime events — the UI-facing stream produced by AgentRuntime.
 * Mirrors the observed client-visible update family.
 */

import type { ModelToolCallRecord, SessionMode, TodoItem, TurnSummary } from './session.js';
import type { SubagentStatus, ToolOutcome } from './tools.js';

export interface PermissionRequestView {
  tool: string;
  args: unknown;
  description?: string;
  /** Human-readable summary for the approval prompt. */
  summary: string;
}

export type AgentEvent =
  | { type: 'turn-started'; turn_id: string; user_text: string }
  | { type: 'step-started'; step_index: number }
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-call-started'; call: ModelToolCallRecord }
  | { type: 'tool-progress'; call_id: string; channel: 'stdout' | 'stderr' | 'note'; chunk: string }
  | { type: 'tool-call-completed'; call_id: string; outcome: ToolOutcome<unknown>; duration_ms: number }
  | { type: 'permission-requested'; request: PermissionRequestView }
  | { type: 'permission-resolved'; call_id: string; decision: 'allow' | 'allow_always' | 'deny' }
  | { type: 'todos-updated'; todos: TodoItem[] }
  | { type: 'mode-changed'; mode: SessionMode; explanation?: string }
  | { type: 'subagent-started'; agent_id: string; subagent_type: string; description: string }
  | { type: 'subagent-completed'; agent_id: string; subagent_type: string; status: SubagentStatus; summary?: string }
  | { type: 'step-completed'; step_index: number }
  | { type: 'hook-result'; phase: 'pre' | 'post'; tool: string; decision: 'allow' | 'deny' | 'error'; reason?: string }
  | { type: 'checkpoint-created'; checkpoint_id: string; path: string; tool: string }
  | { type: 'compacted'; archived_messages: number; summary_chars: number }
  | { type: 'undo-completed'; restored: string[] }
  | { type: 'turn-ended'; summary: TurnSummary }
  | { type: 'error'; message: string }
  | { type: 'notice'; message: string };
