/**
 * Tool protocol — clean-room TypeScript mirror of the observable `agent.v1` tool
 * union (shipped-artifact observation; see cursor-re/REPORT.md §2.3).
 *
 * Field names/shape follow the observed schemas closely for interoperability.
 */

import type { TodoItem } from './session.js';

/* ------------------------------------------------------------------ *
 * Outcome envelope — every tool returns exactly one of these kinds.
 * `rejected` (user veto) and `permission_denied` (policy) are distinct
 * from `error`, mirroring the observed per-tool triple.
 * ------------------------------------------------------------------ */

export type ToolErrorCode =
  | 'invalid_args'
  | 'not_found'
  | 'permission_denied'
  | 'rejected'
  | 'timeout'
  | 'cancelled'
  | 'busy'
  | 'internal';

export type ToolOutcome<V> =
  | { kind: 'success'; value: V }
  | { kind: 'error'; code: ToolErrorCode; message: string }
  | { kind: 'rejected'; reason: string };

export const ok = <V>(value: V): ToolOutcome<V> => ({ kind: 'success', value });
export const err = (code: ToolErrorCode, message: string): ToolOutcome<never> => ({
  kind: 'error',
  code,
  message,
});
export const rejected = (reason: string): ToolOutcome<never> => ({ kind: 'rejected', reason });

/* ------------------------------------------------------------------ *
 * Arg schemas (observed fields)
 * ------------------------------------------------------------------ */

export interface ReadArgs {
  path: string;
  offset?: number;
  limit?: number;
  include_line_numbers?: boolean;
}

export interface WriteArgs {
  path: string;
  file_text: string;
  return_file_content_after_write?: boolean;
}

export interface StrReplaceArgs {
  path: string;
  old_text: string;
  new_text: string;
}

export interface EditArgs {
  path: string;
  stream_content?: string;
}

export interface DeleteArgs {
  path: string;
}

export interface GrepArgs {
  pattern: string;
  path?: string;
  glob?: string;
  output_mode?: 'content' | 'files_with_matches' | 'count';
  context_before?: number;
  context_after?: number;
  context?: number;
  case_insensitive?: boolean;
  type?: string;
  head_limit?: number;
  multiline?: boolean;
  offset?: number;
}

export interface GlobToolArgs {
  target_directory?: string;
  glob_pattern: string;
}

export interface LsArgs {
  path: string;
  ignore?: string[];
  timeout_ms?: number;
}

export interface ShellArgs {
  command: string;
  working_directory?: string;
  timeout?: number;
  is_background?: boolean;
  skip_approval?: boolean;
  hard_timeout?: number;
  description?: string;
  close_stdin?: boolean;
}

export interface SemSearchToolArgs {
  query: string;
  target_directories?: string[];
  explanation?: string;
}

export interface WebSearchArgs {
  search_term: string;
}

export interface WebFetchArgs {
  url: string;
}

export interface UpdateTodosArgs {
  todos: TodoItem[];
  merge: boolean;
}

export interface ReadTodosArgs {
  [key: string]: never;
}

export interface PlanPhase {
  name: string;
  todos: TodoItem[];
}

export interface CreatePlanArgs {
  plan: string;
  todos: TodoItem[];
  overview: string;
  name: string;
  is_project?: boolean;
  phases?: PlanPhase[];
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface Question {
  question: string;
  header?: string;
  options?: QuestionOption[];
  multiple?: boolean;
}

export interface AskQuestionArgs {
  title: string;
  questions: Question[];
}

export interface ReadLintsToolArgs {
  paths: string[];
}

export interface TaskArgs {
  description: string;
  prompt: string;
  subagent_type: string;
  model?: string;
  resume?: string;
  agent_id?: string;
  attachments?: string[];
  /** Run detached: returns an agent id immediately; await with subagent_await. */
  run_in_background?: boolean;
}

export interface SwitchModeArgs {
  mode: 'agent' | 'plan';
  explanation?: string;
}

export interface SubagentAwaitArgs {
  agent_id: string;
  timeout_ms?: number;
}

export interface SubagentCancelArgs {
  agent_id: string;
  reason?: string;
}

export interface BrainstormArgs {
  prompt: string;
}

/* ------------------------------------------------------------------ *
 * Result values
 * ------------------------------------------------------------------ */

export interface ReadSuccess {
  path: string;
  content: string;
  total_lines: number;
  truncated: boolean;
  offset: number;
}

export interface WriteSuccess {
  path: string;
  bytes_written: number;
  file_content?: string;
}

export interface StrReplaceSuccess {
  path: string;
  replacements: number;
}

export interface EditSuccess {
  path: string;
  diff_string?: string;
  before_full_file_content?: string;
  after_full_file_content?: string;
  message?: string;
}

export interface DeleteSuccess {
  path: string;
}

export interface GrepContentMatch {
  line_number: number;
  line: string;
  context_before?: string[];
  context_after?: string[];
}

export interface GrepFileMatch {
  path: string;
  matches: GrepContentMatch[];
}

export interface GrepSuccess {
  files: GrepFileMatch[];
  total_matches: number;
  truncated: boolean;
}

export interface GlobToolSuccess {
  files: string[];
  truncated: boolean;
}

export type DirectoryEntryType = 'file' | 'directory' | 'symlink';

export interface DirectoryEntry {
  name: string;
  type: DirectoryEntryType;
  size?: number;
}

export interface LsSuccess {
  path: string;
  entries: DirectoryEntry[];
}

export interface ShellSuccess {
  command: string;
  stdout: string;
  stderr: string;
  exit_code: number;
  duration_ms: number;
  backgrounded: boolean;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
}

export interface SemSearchFileResult {
  path: string;
  lines: string[];
  score?: number;
}

export interface SemSearchToolSuccess {
  results: SemSearchFileResult[];
}

export interface WebSearchReference {
  title: string;
  url: string;
  chunk: string;
}

export interface WebSearchSuccess {
  references: WebSearchReference[];
}

export interface WebFetchSuccess {
  url: string;
  markdown: string;
}

export interface TodosSuccess {
  todos: TodoItem[];
}

export interface PlanSuccess {
  plan: string;
  todos: TodoItem[];
  name: string;
  overview: string;
}

export interface DiagnosticRange {
  start_line: number;
  start_column: number;
  end_line: number;
  end_column: number;
}

export interface Diagnostic {
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  range: DiagnosticRange;
  source?: string;
}

export interface FileDiagnostics {
  path: string;
  diagnostics: Diagnostic[];
}

export interface LintSuccess {
  files: FileDiagnostics[];
}

export interface TaskSuccess {
  summary: string;
  subagent_type: string;
  conversation_id?: string;
  agent_id?: string;
  background?: boolean;
}

export interface SwitchModeSuccess {
  mode: 'agent' | 'plan';
  explanation?: string;
}

export type SubagentStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface SubagentAwaitSuccess {
  agent_id: string;
  subagent_type: string;
  status: SubagentStatus;
  summary?: string;
}

export interface SubagentCancelSuccess {
  agent_id: string;
  cancelled: boolean;
}

export interface BrainstormSuccess {
  ideas: string[];
  text: string;
}

export interface QuestionAnswer {
  question: string;
  answers: string[];
}

export interface AskQuestionSuccess {
  answers: QuestionAnswer[];
  async_pending: boolean;
}

export type MemoryKind = 'fact' | 'decision' | 'preference' | 'artifact' | 'summary' | 'note';

export interface MemoryEntry {
  id: string;
  ts: string;
  kind: MemoryKind;
  text: string;
  tags: string[];
  session_id: string | null;
  source: string;
}

export interface MemoryArgs {
  operation: 'add' | 'search' | 'list' | 'forget';
  text?: string;
  kind?: MemoryKind;
  tags?: string[];
  id?: string;
  query?: string;
  limit?: number;
}

export interface MemoryResult {
  entries: MemoryEntry[];
  message?: string;
}

export interface McpServerToolInfo {
  name: string;
  description?: string;
}

export interface McpServerInfo {
  name: string;
  status: 'connected' | 'failed';
  error?: string;
  tools: McpServerToolInfo[];
}

export interface McpArgs {
  operation: 'list' | 'call';
  server?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
}

export interface McpToolResult {
  servers?: McpServerInfo[];
  content?: string;
  is_error?: boolean;
  message?: string;
}

export interface WriteShellStdinArgs {
  shell_id: string;
  data: string;
  close_stdin?: boolean;
}

export interface WriteShellStdinSuccess {
  shell_id: string;
  bytes_written: number;
  closed: boolean;
}

export interface ReadShellOutputArgs {
  shell_id: string;
  drain?: boolean;
}

export interface ReadShellOutputSuccess {
  shell_id: string;
  running: boolean;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  stdout_bytes: number;
  stderr_bytes: number;
}

export interface IndexArgs {
  operation: 'status' | 'run' | 'clear';
}

export interface IndexResult {
  files: number;
  chunks: number;
  message?: string;
}

/* ------------------------------------------------------------------ *
 * Tool call union (subset implemented in v0; names mirror the observed
 * model-facing literals where they exist)
 * ------------------------------------------------------------------ */

export interface ToolCallBase<K extends string, A> {
  id: string;
  tool: K;
  args: A;
}

export type ToolCall =
  | ToolCallBase<'read_file', ReadArgs>
  | ToolCallBase<'write_file', WriteArgs>
  | ToolCallBase<'str_replace', StrReplaceArgs>
  | ToolCallBase<'edit_file', EditArgs>
  | ToolCallBase<'delete_file', DeleteArgs>
  | ToolCallBase<'grep_search', GrepArgs>
  | ToolCallBase<'file_search', GlobToolArgs>
  | ToolCallBase<'list_dir', LsArgs>
  | ToolCallBase<'run_terminal_cmd', ShellArgs>
  | ToolCallBase<'codebase_search', SemSearchToolArgs>
  | ToolCallBase<'web_search', WebSearchArgs>
  | ToolCallBase<'web_fetch', WebFetchArgs>
  | ToolCallBase<'update_todos', UpdateTodosArgs>
  | ToolCallBase<'read_todos', ReadTodosArgs>
  | ToolCallBase<'create_plan', CreatePlanArgs>
  | ToolCallBase<'read_lints', ReadLintsToolArgs>
  | ToolCallBase<'task', TaskArgs>
  | ToolCallBase<'switch_mode', SwitchModeArgs>
  | ToolCallBase<'subagent_await', SubagentAwaitArgs>
  | ToolCallBase<'subagent_cancel', SubagentCancelArgs>
  | ToolCallBase<'brainstorm', BrainstormArgs>
  | ToolCallBase<'memory', MemoryArgs>
  | ToolCallBase<'mcp', McpArgs>
  | ToolCallBase<'write_shell_stdin', WriteShellStdinArgs>
  | ToolCallBase<'read_shell_output', ReadShellOutputArgs>
  | ToolCallBase<'index', IndexArgs>
  | ToolCallBase<'ask_question', AskQuestionArgs>;

/** Result value keyed by tool name. */
export interface ToolResultValues {
  read_file: ReadSuccess;
  write_file: WriteSuccess;
  str_replace: StrReplaceSuccess;
  edit_file: EditSuccess;
  delete_file: DeleteSuccess;
  grep_search: GrepSuccess;
  file_search: GlobToolSuccess;
  list_dir: LsSuccess;
  run_terminal_cmd: ShellSuccess;
  codebase_search: SemSearchToolSuccess;
  web_search: WebSearchSuccess;
  web_fetch: WebFetchSuccess;
  update_todos: TodosSuccess;
  read_todos: TodosSuccess;
  create_plan: PlanSuccess;
  read_lints: LintSuccess;
  task: TaskSuccess;
  switch_mode: SwitchModeSuccess;
  subagent_await: SubagentAwaitSuccess;
  subagent_cancel: SubagentCancelSuccess;
  brainstorm: BrainstormSuccess;
  memory: MemoryResult;
  mcp: McpToolResult;
  write_shell_stdin: WriteShellStdinSuccess;
  read_shell_output: ReadShellOutputSuccess;
  index: IndexResult;
  ask_question: AskQuestionSuccess;
}

export type ToolName = keyof ToolResultValues;

export type ToolCallResult = {
  [K in ToolName]: { tool: K; call_id: string; outcome: ToolOutcome<ToolResultValues[K]> };
}[ToolName];

/* ------------------------------------------------------------------ *
 * Model-facing tool definition (JSON schema for the provider wire)
 * ------------------------------------------------------------------ */

export interface ModelToolDef {
  name: ToolName;
  description: string;
  input_schema: Record<string, unknown>;
}
