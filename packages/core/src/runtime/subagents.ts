/** Subagent profiles and child-runtime runner. */

import type {
  SubagentProfile,
  SubagentRunner,
  ToolRegistry,
} from '../types.js';
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
  return {
    async run(profile, prompt, ctx) {
      const childRegistry = filterRegistry(deps.tools, profile.tools);
      const childStore = createMemorySessionStore();
      const childShells = createShellRegistry();
      const childRuntime = await createAgentRuntime({
        cwd: ctx.cwd,
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
      ctx.signal.addEventListener('abort', abortListener, { once: true });

      const eventsPromise = (async () => {
        for await (const _event of childRuntime.events()) {
          if (ctx.signal.aborted) break;
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
        return {
          kind: 'success' as const,
          value: {
            summary: summaryText.slice(0, 2000),
            subagent_type: profile.name,
            conversation_id: summaryState.id,
          },
        };
      } catch (error) {
        return { kind: 'error' as const, code: 'internal' as const, message: `subagent failed: ${String(error)}` };
      } finally {
        ctx.signal.removeEventListener('abort', abortListener);
        childRuntime.abort();
        childShells.killAll();
        void eventsPromise.catch(() => undefined);
      }
    },
  };
}
