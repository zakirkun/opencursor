/**
 * Runtime contracts — the frozen interface layer every subsystem compiles
 * against. Owners: tools/*, models/*, runtime/*, session/*, permissions/*.
 */

import type { AgentEvent, PermissionRequestView } from './protocol/events.js';
import type {
  MemoryEntry,
  MemoryKind,
  ModelToolDef,
  PlanSuccess,
  Question,
  QuestionAnswer,
  SubagentAwaitSuccess,
  SubagentCancelSuccess,
  SubagentStatus,
  SwitchModeSuccess,
  ToolCall,
  ToolName,
  ToolOutcome,
  ToolResultValues,
} from './protocol/tools.js';
import type { SessionMode, SessionState, TodoItem, TurnSummary, CheckpointInfo } from './protocol/session.js';
import type { ModelClient, ModelConfig } from './protocol/models.js';
import type { HookRunner } from './hooks/runner.js';
import type { ShellRegistry } from './shells/registry.js';
import type { CheckpointStore } from './session/checkpoints.js';
import type { MessageArchiveStore } from './session/archives.js';

/* ------------------------------------------------------------------ *
 * Tools
 * ------------------------------------------------------------------ */

export type ToolArgsFor<K extends ToolName> = Extract<ToolCall, { tool: K }>['args'];

export interface SubagentRunResult {
  summary: string;
  subagent_type: string;
  conversation_id?: string;
}

export interface TodoAccessor {
  get(): TodoItem[];
  set(todos: TodoItem[], merge: boolean): void;
}

export interface PlanAccessor {
  set(plan: PlanSuccess): void;
}

export interface MemoryAccessor {
  add(input: { text: string; kind?: MemoryKind; tags?: string[]; session_id?: string | null; source: string }): MemoryEntry;
  search(options: { query?: string; kind?: MemoryKind; tags?: string[]; limit?: number }): MemoryEntry[];
  list(limit?: number): MemoryEntry[];
  forget(id: string): boolean;
  digest(maxChars: number): string;
}

export interface IndexerAccessor {
  run(): Promise<{ scanned: number; indexed: number; skipped: number; removed: number; chunks: number }>;
  search(query: string, limit?: number): Promise<Array<{ path: string; start_line: number; end_line: number; text: string; score: number }>>;
  stats(): { files: number; chunks: number };
  clear(): void;
}

export interface ToolContext {
  /** Workspace root for relative path resolution and shell cwd default. */
  cwd: string;
  session_id: string;
  /** Abort signal for the whole turn; tools must observe it. */
  signal: AbortSignal;
  /** Streaming progress for long tools (shell stdout/stderr etc.). */
  onProgress?: (channel: 'stdout' | 'stderr' | 'note', chunk: string) => void;
  /** Interactive question surface (wired by the host UI). */
  askUser?: (questions: Question[]) => Promise<QuestionAnswer[]>;
  /** Subagent runner (wired by AgentRuntime when available). */
  subagents?: SubagentRunner;
  todos?: TodoAccessor;
  plans?: PlanAccessor;
  mode?: ModeAccessor;
  memory?: MemoryAccessor;
  shells?: ShellRegistry;
  indexer?: IndexerAccessor;
  subagent_profiles?: Record<string, SubagentProfile>;
}

export interface ToolHandlerFor<K extends ToolName> {
  readonly name: K;
  readonly description: string;
  /** JSON schema for the provider wire format. */
  readonly input_schema: Record<string, unknown>;
  /** Default gate evaluated by the permission engine when no rule matches. */
  readonly default_permission: 'allow' | 'ask';
  execute(args: ToolArgsFor<K>, ctx: ToolContext): Promise<ToolOutcome<ToolResultValues[K]>>;
}

export type AnyToolHandler = { [K in ToolName]: ToolHandlerFor<K> }[ToolName];

export interface ToolRegistry {
  get(name: ToolName): AnyToolHandler | undefined;
  list(): AnyToolHandler[];
  /** Definitions advertised to the model for this registry. */
  modelTools(): ModelToolDef[];
}

/* ------------------------------------------------------------------ *
 * Permissions
 * ------------------------------------------------------------------ */

export type PermissionDecision = 'allow' | 'allow_always' | 'deny';

export interface PermissionRule {
  tool: string;
  /** Literal prefix the primary arg must match, e.g. shell command prefix. */
  pattern?: string;
}

export interface PermissionPolicy {
  /** 'ask' delegates to the interactive surface. */
  precheck(input: { tool: string; args: unknown; cwd: string }): PermissionDecision | 'ask';
  /** Record a user decision; 'allow_always' persists a rule. */
  record(tool: string, args: unknown, decision: PermissionDecision): void;
  rules(): PermissionRule[];
}

/* ------------------------------------------------------------------ *
 * Session store
 * ------------------------------------------------------------------ */

export interface SessionOpRecord {
  ts: string;
  event: AgentEvent;
}

export interface SessionListing {
  id: string;
  updated_at: string;
  message_count: number;
}

export interface SessionStore {
  load(id: string): Promise<SessionState | null>;
  save(state: SessionState): Promise<void>;
  appendOp(id: string, op: SessionOpRecord): Promise<void>;
  latestId(): Promise<string | null>;
  list(): Promise<SessionListing[]>;
}

/* ------------------------------------------------------------------ *
 * Subagents
 * ------------------------------------------------------------------ */

export interface SubagentProfile {
  name: string;
  description: string;
  system_prompt: string;
  /** Tool names available to the child runtime. */
  tools: ToolName[];
  model?: ModelConfig;
  max_iterations?: number;
}

export interface SubagentHandle {
  agent_id: string;
  subagent_type: string;
  description: string;
  status: SubagentStatus;
  summary?: string;
  started_at: string;
  ended_at?: string;
}

export interface SubagentRunner {
  run(
    profile: SubagentProfile,
    prompt: string,
    ctx: { cwd: string; signal: AbortSignal; parent_session_id: string },
  ): Promise<ToolOutcome<SubagentRunResult>>;
  /** Start a detached run and return its handle immediately. */
  start(
    profile: SubagentProfile,
    prompt: string,
    ctx: { cwd: string; parent_session_id: string; description: string },
  ): SubagentHandle;
  /** Wait for a detached run to finish (bounded by timeout_ms when given). */
  await(agentId: string, timeoutMs?: number): Promise<SubagentAwaitSuccess>;
  /** Cancel a detached run. */
  cancel(agentId: string, reason?: string): SubagentCancelSuccess;
  /** Handles for detached runs started in this process (newest first). */
  list(): SubagentHandle[];
}

export interface ModeAccessor {
  get(): SessionMode;
  set(mode: SessionMode, explanation?: string): SwitchModeSuccess;
}

/* ------------------------------------------------------------------ *
 * Agent runtime
 * ------------------------------------------------------------------ */

export interface AgentRuntimeConfig {
  cwd: string;
  model_client: ModelClient;
  tools: ToolRegistry;
  store: SessionStore;
  permissions: PermissionPolicy;
  /** Interactive approval surface; required unless policy fully pre-decides. */
  askPermission?: (view: PermissionRequestView) => Promise<PermissionDecision>;
  /** Interactive question surface passed through to tools. */
  askUser?: (questions: Question[]) => Promise<QuestionAnswer[]>;
  subagents?: SubagentRunner;
  subagent_profiles?: Record<string, SubagentProfile>;
  system_prompt?: string;
  max_iterations?: number;
  /** Resume an existing session id, or create fresh when omitted. */
  session_id?: string;
  memory?: MemoryAccessor;
  memory_options?: {
    auto_summarize?: boolean;
    capture_artifacts?: boolean;
    max_digest_chars?: number;
  };
  hooks?: HookRunner;
  shells?: ShellRegistry;
  checkpoints?: CheckpointStore;
  archives?: MessageArchiveStore;
  indexer?: IndexerAccessor;
  context_options?: {
    enabled?: boolean;
    max_chars?: number;
    keep_recent?: number;
  };
}

export interface AgentRuntime {
  readonly session_id: string;
  state(): SessionState;
  /** Single-consumer event stream for the host UI. */
  events(): AsyncIterable<AgentEvent>;
  runTurn(input: string, opts?: { signal?: AbortSignal }): Promise<TurnSummary>;
  abort(): void;
  /** Swap the model client (provider switch mid-session). */
  setModelClient(client: ModelClient): void;
  /** Switch between agent and plan mode; emits a mode-changed event. */
  setMode(mode: SessionMode, explanation?: string): Promise<SwitchModeSuccess>;
  /** Restore files from the most recent checkpoint for each path (optionally all session checkpoints). */
  undo(opts?: { all?: boolean }): Promise<string[]>;
  /** Compact the conversation: archive messages, keep a summary + recent tail. */
  compact(): Promise<{ archived_messages: number; summary_chars: number }>;
  /** Checkpoints captured in this session (newest first). */
  checkpoints(): CheckpointInfo[];
}

/* ------------------------------------------------------------------ *
 * Shared limits
 * ------------------------------------------------------------------ */

export const DEFAULT_LIMITS = {
  max_read_lines: 2000,
  max_grep_matches: 250,
  shell_default_timeout_ms: 120_000,
  shell_max_timeout_ms: 600_000,
  max_iterations: 24,
} as const;
