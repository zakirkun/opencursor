/** Agent runtime — turn loop, event stream, tool execution with permissions. */

import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { AgentEvent } from '../protocol/events.js';
import type { ModelStreamEvent } from '../protocol/models.js';
import type {
  AssistantMessage,
  CheckpointInfo,
  ModelToolCallRecord,
  SessionState,
  TodoItem,
  ToolResultMessage,
  TurnSummary,
  UserMessage,
} from '../protocol/session.js';
import type { ToolContext, AgentRuntime, AgentRuntimeConfig } from '../types.js';
import { DEFAULT_LIMITS } from '../types.js';
import type { PlanSuccess, ToolName, ToolOutcome } from '../protocol/tools.js';

const EVENT_BUFFER_LIMIT = 10_000;
const MUTATING_TOOLS = new Set(['write_file', 'str_replace', 'edit_file', 'delete_file']);
const CHECKPOINT_PRUNE_KEEP = 50;

interface ToolCallInternal extends ModelToolCallRecord {
  name: string;
}

function createEventQueue(): {
  push(event: AgentEvent): void;
  events(): AsyncIterable<AgentEvent>;
} {
  const buffer: AgentEvent[] = [];
  let resolveNext: (() => void) | null = null;

  const wake = (): void => {
    if (resolveNext) {
      const resolve = resolveNext;
      resolveNext = null;
      resolve();
    }
  };

  return {
    push(event: AgentEvent): void {
      buffer.push(event);
      if (buffer.length > EVENT_BUFFER_LIMIT) buffer.splice(0, buffer.length - EVENT_BUFFER_LIMIT);
      wake();
    },
    events(): AsyncIterable<AgentEvent> {
      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
          for (;;) {
            while (buffer.length > 0) {
              yield buffer.shift() as AgentEvent;
            }
            await new Promise<void>((resolve) => {
              resolveNext = resolve;
            });
          }
        },
      };
    },
  };
}

function buildSystemPrompt(cwd: string, tools: string[]): string {
  return [
    'You are opencursor, a desktop coding agent.',
    `Workspace root: ${cwd}`,
    `Available tools: ${tools.join(', ')}.`,
    'Rules:',
    '- Make minimal, focused edits. Prefer str_replace for targeted changes and edit_file for rewrites.',
    '- Prefer grep_search/file_search/list_dir over shell equivalents.',
    '- Use update_todos to track multi-step work; keep one item in_progress.',
    '- Use create_plan before large ambiguous tasks.',
    '- Read files before modifying them.',
    '- Keep responses concise; show code and diffs rather than prose.',
  ].join('\n');
}

function summarizeCall(_tool: string, args: unknown): string {
  if (typeof args === 'object' && args !== null) {
    const record = args as Record<string, unknown>;
    if (typeof record['command'] === 'string') return record['command'];
    if (typeof record['path'] === 'string') return record['path'];
    if (typeof record['pattern'] === 'string') return record['pattern'];
    if (typeof record['query'] === 'string') return record['query'];
    if (typeof record['url'] === 'string') return record['url'];
  }
  try {
    return JSON.stringify(args).slice(0, 160);
  } catch {
    return String(args).slice(0, 160);
  }
}

export async function createAgentRuntime(config: AgentRuntimeConfig): Promise<AgentRuntime> {
  const queue = createEventQueue();
  const controller = new AbortController();

  let state: SessionState | null = null;
  if (config.session_id) {
    state = await config.store.load(config.session_id);
  }
  if (!state) {
    state = {
      version: 1,
      id: config.session_id ?? randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      cwd: config.cwd,
      model: { provider: config.model_client.provider, id: config.model_client.id },
      messages: [],
      todos: [],
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }

  let modelClient = config.model_client;
  let running = false;
  const plans = new Map<string, PlanSuccess>();

  const persist = async (): Promise<void> => {
    if (!state) return;
    await config.store.save(state);
  };

  const pushEvent = async (event: AgentEvent): Promise<void> => {
    queue.push(event);
    if (state) {
      await config.store.appendOp(state.id, { ts: new Date().toISOString(), event });
    }
  };

  const todoAccessor = {
    get(): TodoItem[] {
      return state ? [...state.todos] : [];
    },
    set(todos: TodoItem[], merge: boolean): void {
      if (!state) return;
      if (!merge) {
        state.todos = todos;
        return;
      }
      const byId = new Map(state.todos.map((todo) => [todo.id, todo]));
      const order: string[] = state.todos.map((todo) => todo.id);
      for (const todo of todos) {
        if (!byId.has(todo.id)) order.push(todo.id);
        byId.set(todo.id, { ...byId.get(todo.id), ...todo });
      }
      state.todos = order.map((id) => byId.get(id)).filter((todo): todo is TodoItem => todo !== undefined);
    },
  };

  const planAccessor = {
    set(plan: PlanSuccess): void {
      if (!state) return;
      plans.set(state.id, plan);
    },
  };

  const makeContext = (
    signal: AbortSignal,
    onProgress: (channel: 'stdout' | 'stderr' | 'note', chunk: string) => void,
    askUser: ToolContext['askUser'],
    subagents: ToolContext['subagents'],
  ): ToolContext => ({
    cwd: config.cwd,
    session_id: state ? state.id : 'unknown',
    signal,
    onProgress,
    askUser,
    subagents,
    todos: todoAccessor,
    plans: planAccessor,
    memory: config.memory,
    shells: config.shells,
    indexer: config.indexer,
    subagent_profiles: config.subagent_profiles,
  });

  const captureCheckpoint = async (call: ToolCallInternal): Promise<void> => {
    if (!config.checkpoints || !state || !MUTATING_TOOLS.has(call.name)) return;
    const args = call.args as Record<string, unknown> | null;
    const rawPath = args && typeof args['path'] === 'string' ? args['path'] : null;
    if (rawPath === null) return;
    const abs = path.isAbsolute(rawPath) ? rawPath : path.resolve(config.cwd, rawPath);
    try {
      const content = await readFile(abs);
      const info = config.checkpoints.capture({
        session_id: state.id,
        tool: call.name,
        path: rawPath,
        existed: true,
        content,
      });
      config.checkpoints.prune(state.id, CHECKPOINT_PRUNE_KEEP);
      await pushEvent({ type: 'checkpoint-created', checkpoint_id: info.id, path: rawPath, tool: call.name });
    } catch {
      const info = config.checkpoints.capture({
        session_id: state.id,
        tool: call.name,
        path: rawPath,
        existed: false,
        content: null,
      });
      config.checkpoints.prune(state.id, CHECKPOINT_PRUNE_KEEP);
      await pushEvent({ type: 'checkpoint-created', checkpoint_id: info.id, path: rawPath, tool: call.name });
    }
  };

  const executeCall = async (
    call: ToolCallInternal,
    turnSignal: AbortSignal,
  ): Promise<{ outcome: ToolOutcome<unknown>; duration_ms: number }> => {
    const startedAt = Date.now();
    const handler = config.tools.get(call.name as ToolName);
    if (!handler) {
      return {
        outcome: { kind: 'error', code: 'invalid_args', message: `unknown tool: ${call.name}` },
        duration_ms: Date.now() - startedAt,
      };
    }

    const precheck = config.permissions.precheck({ tool: call.name, args: call.args, cwd: config.cwd });
    if (precheck === 'deny') {
      return {
        outcome: { kind: 'error', code: 'permission_denied', message: 'denied by policy' },
        duration_ms: Date.now() - startedAt,
      };
    }

    if (config.hooks) {
      const hookOutcome = await config.hooks.runPre({
        tool_name: call.name,
        tool_input: call.args,
        cwd: config.cwd,
        session_id: state ? state.id : 'unknown',
      });
      if (hookOutcome.decision !== 'allow') {
        await pushEvent({
          type: 'hook-result',
          phase: 'pre',
          tool: call.name,
          decision: hookOutcome.decision,
          reason: hookOutcome.reason,
        });
        return {
          outcome:
            hookOutcome.decision === 'deny'
              ? { kind: 'rejected', reason: hookOutcome.reason ?? 'denied by hook' }
              : { kind: 'error', code: 'internal', message: hookOutcome.reason ?? 'hook error' },
          duration_ms: Date.now() - startedAt,
        };
      }
    }

    if (precheck === 'ask') {
      if (!config.askPermission) {
        return {
          outcome: { kind: 'rejected', reason: 'no approval surface' },
          duration_ms: Date.now() - startedAt,
        };
      }
      await pushEvent({
        type: 'permission-requested',
        request: { tool: call.name, args: call.args, summary: summarizeCall(call.name, call.args) },
      });
      const decision = await config.askPermission({
        tool: call.name,
        args: call.args,
        summary: summarizeCall(call.name, call.args),
      });
      await pushEvent({ type: 'permission-resolved', call_id: call.id, decision });
      if (decision === 'deny') {
        return {
          outcome: { kind: 'rejected', reason: 'user denied' },
          duration_ms: Date.now() - startedAt,
        };
      }
      config.permissions.record(call.name, call.args, decision);
    }

    const onProgress = (channel: 'stdout' | 'stderr' | 'note', chunk: string): void => {
      queue.push({ type: 'tool-progress', call_id: call.id, channel, chunk });
    };

    try {
      const outcome = await handler.execute(call.args as never, makeContext(turnSignal, onProgress, config.askUser, config.subagents));
      const duration_ms = Date.now() - startedAt;
      if (config.hooks) {
        const hookOutcome = await config.hooks.runPost({
          tool_name: call.name,
          tool_input: call.args,
          tool_output: JSON.stringify(outcome).slice(0, 100_000),
          duration_ms,
          cwd: config.cwd,
          session_id: state ? state.id : 'unknown',
        });
        if (hookOutcome.decision !== 'allow') {
          await pushEvent({
            type: 'hook-result',
            phase: 'post',
            tool: call.name,
            decision: hookOutcome.decision,
            reason: hookOutcome.reason,
          });
          return {
            outcome:
              hookOutcome.decision === 'deny'
                ? { kind: 'rejected', reason: hookOutcome.reason ?? 'denied by post hook' }
                : { kind: 'error', code: 'internal', message: hookOutcome.reason ?? 'post hook error' },
            duration_ms,
          };
        }
      }
      return { outcome, duration_ms };
    } catch (error) {
      return {
        outcome: { kind: 'error', code: 'internal', message: String(error) },
        duration_ms: Date.now() - startedAt,
      };
    }
  };

  const runtime: AgentRuntime = {
    get session_id(): string {
      return state ? state.id : 'unknown';
    },

    state(): SessionState {
      return structuredClone(state) as SessionState;
    },

    events(): AsyncIterable<AgentEvent> {
      return queue.events();
    },

    setModelClient(client): void {
      modelClient = client;
      if (state) state.model = { provider: client.provider, id: client.id };
    },

    abort(): void {
      controller.abort();
    },

    checkpoints(): CheckpointInfo[] {
      if (!config.checkpoints || !state) return [];
      return config.checkpoints.list(state.id, 50);
    },

    async undo(opts?: { all?: boolean }): Promise<string[]> {
      if (!config.checkpoints || !state) return [];
      const listed = config.checkpoints.list(state.id, 500);
      const restored: string[] = [];
      const seen = new Set<string>();
      for (const info of listed) {
        if (!opts?.all && seen.has(info.path)) continue;
        const record = config.checkpoints.get(info.id);
        if (!record) continue;
        const abs = path.isAbsolute(record.path) ? record.path : path.resolve(config.cwd, record.path);
        try {
          if (record.existed && record.content) {
            await writeFile(abs, record.content);
          } else {
            await rm(abs, { force: true });
          }
          restored.push(record.path);
          seen.add(record.path);
          config.checkpoints.remove(record.id);
        } catch {
          // a failed restore keeps the checkpoint for a retry
        }
      }
      await pushEvent({ type: 'undo-completed', restored });
      return restored;
    },

    async compact(): Promise<{ archived_messages: number; summary_chars: number }> {
      if (!state) return { archived_messages: 0, summary_chars: 0 };
      const contextOptions = config.context_options ?? {};
      const keepRecent = contextOptions.keep_recent ?? 6;
      const toArchive = state.messages.length - keepRecent;
      if (toArchive <= 0) return { archived_messages: 0, summary_chars: 0 };

      const archived = state.messages.slice(0, toArchive);
      const retained = state.messages.slice(toArchive);
      if (config.archives) config.archives.archive(state.id, archived);

      const priorSummary = state.summary?.text ?? '';
      const lines: string[] = [];
      for (const message of archived) {
        if (message.role === 'user') {
          lines.push(`user: ${message.text.slice(0, 240)}`);
        } else if (message.role === 'assistant') {
          const tools = message.tool_calls.map((call) => call.name).join(', ');
          lines.push(`assistant: ${message.text.slice(0, 200)}${tools.length > 0 ? ` [tools: ${tools}]` : ''}`);
        } else {
          const names = message.results.map((result) => result.name).join(', ');
          lines.push(`tool results: ${names}`);
        }
      }
      const maxChars = contextOptions.max_chars ?? 6000;
      const combined = `${priorSummary}\n${lines.join('\n')}`.trim();
      const summaryText = combined.length > maxChars ? combined.slice(combined.length - maxChars) : combined;
      state.summary = {
        text: summaryText,
        archived_message_count: (state.summary?.archived_message_count ?? 0) + archived.length,
        created_at: new Date().toISOString(),
      };
      state.messages = retained;

      const result = { archived_messages: archived.length, summary_chars: summaryText.length };
      await pushEvent({ type: 'compacted', archived_messages: result.archived_messages, summary_chars: result.summary_chars });
      await persist();
      return result;
    },

    async runTurn(input: string, opts?: { signal?: AbortSignal }): Promise<TurnSummary> {
      if (running) throw new Error('turn already running');
      if (!state) throw new Error('session not initialized');
      running = true;

      const turnId = randomUUID();
      const startedAt = new Date().toISOString();
      const maxIterations = config.max_iterations ?? DEFAULT_LIMITS.max_iterations;
      const turnController = new AbortController();
      const onOuterAbort = (): void => turnController.abort();
      opts?.signal?.addEventListener('abort', onOuterAbort, { once: true });
      const innerAbort = (): void => turnController.abort();
      controller.signal.addEventListener('abort', innerAbort, { once: true });

      const memoryEnabled = config.memory !== undefined;
      const captureArtifacts = memoryEnabled && config.memory_options?.capture_artifacts !== false;
      const autoSummarize = memoryEnabled && config.memory_options?.auto_summarize !== false;
      const capturedPaths = new Set<string>();
      const touchedPaths = new Set<string>();

      const contextOptions = config.context_options ?? {};
      const contextEnabled = contextOptions.enabled !== false;
      if (contextEnabled && config.archives && state.summary) {
        const archivedChars = state.messages.reduce((sum, message) => sum + JSON.stringify(message).length, 0);
        const maxChars = contextOptions.max_chars ?? 60_000;
        if (archivedChars > maxChars) {
          const keepRecent = contextOptions.keep_recent ?? 6;
          const toArchive = state.messages.length - keepRecent;
          if (toArchive > 0) {
            const archived = state.messages.slice(0, toArchive);
            config.archives.archive(state.id, archived);
            const priorSummary = state.summary.text;
            const lines: string[] = [];
            for (const message of archived) {
              if (message.role === 'user') lines.push(`user: ${message.text.slice(0, 240)}`);
              else if (message.role === 'assistant') {
                const tools = message.tool_calls.map((call) => call.name).join(', ');
                lines.push(`assistant: ${message.text.slice(0, 200)}${tools.length > 0 ? ` [tools: ${tools}]` : ''}`);
              } else lines.push(`tool results: ${message.results.map((result) => result.name).join(', ')}`);
            }
            const combined = `${priorSummary}\n${lines.join('\n')}`.trim();
            const summaryText = combined.length > 6000 ? combined.slice(combined.length - 6000) : combined;
            state.summary = {
              text: summaryText,
              archived_message_count: state.summary.archived_message_count + archived.length,
              created_at: new Date().toISOString(),
            };
            state.messages = state.messages.slice(toArchive);
            await pushEvent({ type: 'compacted', archived_messages: archived.length, summary_chars: summaryText.length });
          }
        }
      }

      const summary: TurnSummary = {
        turn_id: turnId,
        started_at: startedAt,
        tool_calls: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
      };

      const userMessage: UserMessage = { role: 'user', text: input, timestamp: new Date().toISOString() };
      state.messages.push(userMessage);
      await pushEvent({ type: 'turn-started', turn_id: turnId, user_text: input });

      try {
        for (let step = 0; step < maxIterations; step++) {
          if (turnController.signal.aborted) {
            summary.reason = 'aborted';
            break;
          }
          await pushEvent({ type: 'step-started', step_index: step });

          const toolDefs = config.tools.modelTools();
          const memoryDigest = config.memory?.digest?.((config.memory_options?.max_digest_chars ?? 4000)) ?? '';
          const basePrompt = config.system_prompt ?? buildSystemPrompt(config.cwd, toolDefs.map((tool) => tool.name));
          const summaryText = state.summary && state.summary.text.length > 0
            ? `Earlier conversation summary (${state.summary.archived_message_count} messages archived):\n${state.summary.text}`
            : '';
          const systemPrompt = [basePrompt, summaryText, memoryDigest].filter((part) => part.length > 0).join('\n\n');
          const stream = modelClient.generate({
            system: systemPrompt,
            messages: state.messages as unknown[],
            tools: toolDefs,
            signal: turnController.signal,
          });

          let assistantText = '';
          let reasoningText = '';
          const collectedCalls: ModelToolCallRecord[] = [];
          let stopReason: ModelStreamEvent & { type: 'stop' } = { type: 'stop', reason: 'end_turn' };

          for await (const event of stream) {
            switch (event.type) {
              case 'text-delta':
                assistantText += event.text;
                await pushEvent({ type: 'text-delta', text: event.text });
                break;
              case 'reasoning-delta':
                reasoningText += event.text;
                await pushEvent({ type: 'reasoning-delta', text: event.text });
                break;
              case 'tool-call':
                collectedCalls.push({
                  id: event.call.id,
                  name: event.call.name,
                  args: event.call.args,
                  args_raw: event.call.args_raw,
                });
                break;
              case 'usage':
                if (event.usage.input_tokens !== undefined) {
                  state.usage.input_tokens += event.usage.input_tokens;
                  summary.usage.input_tokens += event.usage.input_tokens;
                }
                if (event.usage.output_tokens !== undefined) {
                  state.usage.output_tokens += event.usage.output_tokens;
                  summary.usage.output_tokens += event.usage.output_tokens;
                }
                break;
              case 'stop':
                stopReason = event;
                break;
            }
          }

          const assistantMessage: AssistantMessage = {
            role: 'assistant',
            text: assistantText,
            tool_calls: collectedCalls,
            timestamp: new Date().toISOString(),
          };
          if (reasoningText.length > 0) assistantMessage.reasoning = reasoningText;
          state.messages.push(assistantMessage);

          if (collectedCalls.length === 0 || stopReason.reason !== 'tool_use') {
            summary.reason = 'end_turn';
            break;
          }

          const results: ToolResultMessage['results'] = [];
          for (const callRecord of collectedCalls) {
            if (turnController.signal.aborted) break;
            const call: ToolCallInternal = callRecord as ToolCallInternal;
            await pushEvent({ type: 'tool-call-started', call: callRecord });
            await captureCheckpoint(call);
            const { outcome, duration_ms } = await executeCall(call, turnController.signal);
            callRecord.outcome = outcome;
            callRecord.duration_ms = duration_ms;
            summary.tool_calls += 1;
            await pushEvent({ type: 'tool-call-completed', call_id: call.id, outcome: outcome as ToolOutcome<unknown>, duration_ms });
            results.push({ call_id: call.id, name: call.name, outcome });
            if (call.name === 'update_todos' || call.name === 'create_plan') {
              await pushEvent({ type: 'todos-updated', todos: [...state.todos] });
            }
            if (captureArtifacts && config.memory && outcome.kind === 'success') {
              const args = call.args as Record<string, unknown> | null;
              const pathValue = args && typeof args['path'] === 'string' ? args['path'] : null;
              if (pathValue !== null) {
                touchedPaths.add(pathValue);
                if (!capturedPaths.has(pathValue) && (call.name === 'write_file' || call.name === 'edit_file')) {
                  const created = typeof (outcome.value as { message?: string } | undefined)?.message === 'string';
                  capturedPaths.add(pathValue);
                  config.memory.add({
                    text: `${created ? 'created' : 'modified'} ${pathValue}`,
                    kind: 'artifact',
                    tags: [call.name],
                    session_id: state.id,
                    source: 'auto:artifact',
                  });
                }
              }
            }
          }

          const toolMessage: ToolResultMessage = {
            role: 'tool',
            results,
            timestamp: new Date().toISOString(),
          };
          state.messages.push(toolMessage);

          await pushEvent({ type: 'step-completed', step_index: step });
          if (step === maxIterations - 1) {
            summary.reason = 'max_iterations';
          }
        }
      } catch (error) {
        if (turnController.signal.aborted) {
          summary.reason = 'aborted';
        } else {
          summary.reason = 'error';
          await pushEvent({ type: 'error', message: String(error) });
        }
      } finally {
        opts?.signal?.removeEventListener('abort', onOuterAbort);
        controller.signal.removeEventListener('abort', innerAbort);
        summary.ended_at = new Date().toISOString();
        summary.reason = summary.reason ?? 'end_turn';
        if (autoSummarize && config.memory && summary.tool_calls > 0) {
          const touched = [...touchedPaths].slice(0, 6).join(', ');
          const text = `turn in ${config.cwd} (session ${state.id.slice(0, 8)}): ${input.slice(0, 140)} -> ${summary.tool_calls} tool call(s), reason ${summary.reason ?? 'end_turn'}${touched.length > 0 ? `; files: ${touched}` : ''}`;
          try {
            config.memory.add({
              text,
              kind: 'summary',
              tags: [summary.reason ?? 'end_turn'],
              session_id: state.id,
              source: 'auto:turn',
            });
          } catch {
            // memory write failure must not fail the turn
          }
        }
        await pushEvent({ type: 'turn-ended', summary });
        await persist();
        running = false;
      }

      return summary;
    },
  };

  await persist();
  return runtime;
}
