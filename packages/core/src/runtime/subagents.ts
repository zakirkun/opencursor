/** Subagent profiles and child-runtime runner. */

import { randomUUID } from 'node:crypto';
import type { SubagentHandle, SubagentProfile, SubagentRunner, ToolRegistry } from '../types.js';
import type { ModelClient } from '../protocol/models.js';
import type { ToolName } from '../protocol/tools.js';
import { createAgentRuntime } from './runtime.js';
import { createMemorySessionStore } from '../session/memory.js';
import { createPermissionPolicy } from '../permissions/policy.js';
import { createShellRegistry } from '../shells/registry.js';

export const SUBAGENT_PROFILES: Record<'general' | 'explore' | 'shell', SubagentProfile> = {
  general: {
    name: 'general',
    description: 'General-purpose subagent for multi-step research and implementation tasks.',
    system_prompt:
      'You are a focused opencursor subagent. Complete the assigned task and finish with a concise summary ' +
      'of findings and changes. Do not ask questions; make reasonable assumptions and note them.',
    tools: [
      'read_file',
      'write_file',
      'str_replace',
      'edit_file',
      'delete_file',
      'grep_search',
      'file_search',
      'list_dir',
      'run_terminal_cmd',
      'codebase_search',
      'web_search',
      'web_fetch',
    ],
    max_iterations: 16,
  },
  explore: {
    name: 'explore',
    description: 'Read-only reconnaissance: locate files, symbols, and behaviors; returns findings.',
    system_prompt:
      'You are an opencursor exploration subagent. Search, read, and report. Never modify files or run ' +
      'destructive commands. Finish with a concise findings list including file paths.',
    tools: ['read_file', 'grep_search', 'file_search', 'list_dir', 'codebase_search'],
    max_iterations: 12,
  },
  shell: {
    name: 'shell',
    description: 'Command-sequence runner: builds, tests, and git operations with output summaries.',
    system_prompt:
      'You are an opencursor shell subagent. Run the requested commands, capture the important output, ' +
      'and summarize results including exit codes and failures.',
    tools: ['run_terminal_cmd', 'read_file', 'list_dir'],
    max_iterations: 8,
  },
};

function filterRegistry(base: ToolRegistry, allowed: ToolName[]): ToolRegistry {
  const allowSet = new Set<string>(allowed);
  return {
    get(name: ToolName) {
      if (!allowSet.has(name)) return undefined;
      return base.get(name);
    },
    list() {
      return base.list().filter((handler) => allowSet.has(handler.name));
    },
    modelTools() {
      return base.modelTools().filter((tool) => allowSet.has(tool.name));
    },
  };
}

export function createSubagentRunner(deps: {
  model_client: ModelClient;
  tools: ToolRegistry;
  max_iterations?: number;
}): SubagentRunner {
  const handles = new Map<string, SubagentHandle>();
  const controllers = new Map<string, AbortController>();
  const waiters = new Map<string, Array<() => void>>();

  const settle = (agentId: string): void => {
    const pending = waiters.get(agentId);
    if (!pending) return;
    waiters.delete(agentId);
    for (const notify of pending) notify();
  };

  const runChild = async (
    profile: SubagentProfile,
    prompt: string,
    opts: { cwd: string; signal?: AbortSignal },
  ): Promise<{ ok: true; summary: string; conversationId: string } | { ok: false; message: string; cancelled: boolean }> => {
    const childRegistry = filterRegistry(deps.tools, profile.tools);
    const childStore = createMemorySessionStore();
    const childShells = createShellRegistry();
    const childRuntime = await createAgentRuntime({
      cwd: opts.cwd,
      model_client: deps.model_client,
      tools: childRegistry,
      store: childStore,
      permissions: createPermissionPolicy({ mode: 'yolo' }),
      system_prompt: profile.system_prompt,
      max_iterations: profile.max_iterations ?? deps.max_iterations ?? 12,
      subagent_profiles: { [profile.name]: profile },
      shells: childShells,
    });

    const abortListener = (): void => childRuntime.abort();
    opts.signal?.addEventListener('abort', abortListener, { once: true });

    const eventsPromise = (async () => {
      for await (const _event of childRuntime.events()) {
        if (opts.signal?.aborted) break;
      }
    })();

    try {
      await childRuntime.runTurn(prompt);
      const summaryState = childRuntime.state();
      const lastAssistant = [...summaryState.messages]
        .reverse()
        .find((message) => message.role === 'assistant');
      const summaryText =
        lastAssistant && lastAssistant.role === 'assistant' && lastAssistant.text.trim().length > 0
          ? lastAssistant.text.trim()
          : '(subagent produced no text output)';
      return { ok: true, summary: summaryText.slice(0, 2000), conversationId: summaryState.id };
    } catch (error) {
      return { ok: false, message: `subagent failed: ${String(error)}`, cancelled: opts.signal?.aborted === true };
    } finally {
      opts.signal?.removeEventListener('abort', abortListener);
      childRuntime.abort();
      childShells.killAll();
      void eventsPromise.catch(() => undefined);
    }
  };

  const requireHandle = (agentId: string): SubagentHandle | null => handles.get(agentId) ?? null;

  return {
    async run(profile, prompt, ctx) {
      const result = await runChild(profile, prompt, {
        cwd: ctx.cwd,
        signal: ctx.signal,
      });
      if (result.ok) {
        return {
          kind: 'success' as const,
          value: {
            summary: result.summary,
            subagent_type: profile.name,
            conversation_id: result.conversationId,
          },
        };
      }
      return { kind: 'error' as const, code: 'internal' as const, message: result.message };
    },

    start(profile, prompt, ctx) {
      const agentId = randomUUID();
      const handle: SubagentHandle = {
        agent_id: agentId,
        subagent_type: profile.name,
        description: ctx.description,
        status: 'running',
        started_at: new Date().toISOString(),
      };
      handles.set(agentId, handle);
      const controller = new AbortController();
      controllers.set(agentId, controller);

      void runChild(profile, prompt, {
        cwd: ctx.cwd,
        signal: controller.signal,
      }).then((result) => {
        const current = handles.get(agentId);
        if (!current) return;
        if (current.status === 'running') {
          if (result.ok) {
            current.status = 'completed';
            current.summary = result.summary;
          } else if (result.cancelled) {
            current.status = 'cancelled';
          } else {
            current.status = 'failed';
            current.summary = result.message;
          }
          current.ended_at = new Date().toISOString();
        }
        controllers.delete(agentId);
        settle(agentId);
      });

      return handle;
    },

    async await(agentId, timeoutMs) {
      const handle = requireHandle(agentId);
      if (!handle) {
        return { agent_id: agentId, subagent_type: 'unknown', status: 'failed' as const, summary: 'unknown agent id' };
      }
      if (handle.status === 'running') {
        await new Promise<void>((resolve) => {
          const pending = waiters.get(agentId) ?? [];
          pending.push(resolve);
          waiters.set(agentId, pending);
          if (timeoutMs !== undefined && timeoutMs > 0) {
            setTimeout(() => {
              const list = waiters.get(agentId);
              if (list) {
                waiters.set(
                  agentId,
                  list.filter((entry) => entry !== resolve),
                );
              }
              resolve();
            }, timeoutMs).unref?.();
          }
        });
      }
      const final = requireHandle(agentId) ?? handle;
      return final.summary === undefined
        ? { agent_id: agentId, subagent_type: final.subagent_type, status: final.status }
        : { agent_id: agentId, subagent_type: final.subagent_type, status: final.status, summary: final.summary };
    },

    cancel(agentId) {
      const handle = requireHandle(agentId);
      if (!handle) return { agent_id: agentId, cancelled: false };
      if (handle.status === 'running') {
        controllers.get(agentId)?.abort();
        controllers.delete(agentId);
        handle.status = 'cancelled';
        handle.ended_at = new Date().toISOString();
        settle(agentId);
      }
      return { agent_id: agentId, cancelled: true };
    },

    list() {
      return [...handles.values()].sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
    },
  };
}
