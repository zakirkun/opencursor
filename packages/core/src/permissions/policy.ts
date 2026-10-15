/** Permission policy — hard rules, safe allowlist, persistent allow_always rules. */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { PermissionDecision, PermissionPolicy, PermissionRule } from '../types.js';

const HARD_DENY = [
  /\brm\s+-rf\s+\/(\s|$)/i,
  /\bformat\s+[a-z]:/i,
  /\bshutdown\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=.*of=\/dev\//i,
  /:\(\)\s*\{\s*:\|:&\s*\}/,
];

const SAFE_COMMAND = /^(ls|dir|pwd|cd|cat|head|tail|wc|rg|findstr|type|tree|git (status|diff|log|branch|show)|node --version|npm (test|run|--version)|pnpm (test|run|--version)|yarn (test|run|--version)|echo|whoami|hostname|where|which)\b/i;

/** True when a shell command is on the read-only allowlist (used by plan-mode gating). */
export function isSafeCommand(command: string): boolean {
  return SAFE_COMMAND.test(command.trim());
}

const READ_FAMILY = new Set([
  'read_file',
  'grep_search',
  'file_search',
  'list_dir',
  'codebase_search',
  'read_todos',
  'read_lints',
]);

interface PrecheckInput {
  tool: string;
  args: unknown;
  cwd: string;
}

function primaryArg(tool: string, args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const record = args as Record<string, unknown>;
  if (tool === 'run_terminal_cmd') return typeof record['command'] === 'string' ? record['command'] : undefined;
  if (tool === 'web_fetch' || tool === 'web_search') {
    return typeof record['url'] === 'string' ? record['url'] : typeof record['search_term'] === 'string' ? record['search_term'] : undefined;
  }
  if (tool === 'task') return typeof record['subagent_type'] === 'string' ? record['subagent_type'] : undefined;
  return typeof record['path'] === 'string' ? record['path'] : undefined;
}

function derivePattern(tool: string, args: unknown): string | undefined {
  const primary = primaryArg(tool, args);
  if (primary === undefined) return undefined;
  if (tool === 'run_terminal_cmd') return primary.trim().split(/\s+/)[0];
  if (tool === 'web_fetch' || tool === 'web_search') {
    try {
      return new URL(primary).origin;
    } catch {
      return undefined;
    }
  }
  if (tool === 'task') return primary;
  const dir = path.dirname(primary.split(path.sep).join('/'));
  return dir === '.' ? undefined : dir;
}

export function createPermissionPolicy(opts?: {
  mode?: 'ask' | 'yolo';
  rules?: PermissionRule[];
  persist_path?: string;
}): PermissionPolicy {
  const mode = opts?.mode ?? (process.env['OPENCURSOR_PERMISSION_MODE'] === 'yolo' ? 'yolo' : 'ask');
  const persistPath = opts?.persist_path;
  const rules: PermissionRule[] = [...(opts?.rules ?? [])];

  if (persistPath) {
    try {
      const text = readFileSync(persistPath, 'utf8');
      const stored = JSON.parse(text) as PermissionRule[];
      if (Array.isArray(stored)) {
        const known = new Set(rules.map((rule) => `${rule.tool}\u0000${rule.pattern ?? ''}`));
        for (const rule of stored) {
          const key = `${rule.tool}\u0000${rule.pattern ?? ''}`;
          if (!known.has(key)) {
            rules.push(rule);
            known.add(key);
          }
        }
      }
    } catch {
      // no persisted rules yet
    }
  }

  const persist = (): void => {
    if (!persistPath) return;
    try {
      mkdirSync(path.dirname(persistPath), { recursive: true });
      const temp = `${persistPath}.tmp`;
      writeFileSync(temp, JSON.stringify(rules, null, 2), 'utf8');
      renameSync(temp, persistPath);
    } catch {
      // persistence failure must not block execution
    }
  };

  return {
    precheck(input: PrecheckInput): PermissionDecision | 'ask' {
      const command = input.tool === 'run_terminal_cmd' ? primaryArg('run_terminal_cmd', input.args) : undefined;
      if (command !== undefined && HARD_DENY.some((pattern) => pattern.test(command))) {
        return 'deny';
      }
      if (mode === 'yolo') return 'allow';
      if (READ_FAMILY.has(input.tool)) return 'allow';
      if (input.tool === 'mcp') {
        const record = input.args as Record<string, unknown> | null;
        if (record && record['operation'] === 'list') return 'allow';
      }
      if (input.tool === 'run_terminal_cmd') {
        const record = input.args as Record<string, unknown> | null;
        if (record && record['skip_approval'] === true) return 'allow';
        if (command !== undefined && SAFE_COMMAND.test(command.trim())) return 'allow';
      }
      const primary = primaryArg(input.tool, input.args);
      for (const rule of rules) {
        if (rule.tool !== input.tool) continue;
        if (rule.pattern === undefined) return 'allow';
        if (primary !== undefined && primary.startsWith(rule.pattern)) return 'allow';
      }
      return 'ask';
    },

    record(tool: string, args: unknown, decision: PermissionDecision): void {
      if (decision !== 'allow_always') return;
      const pattern = derivePattern(tool, args);
      const exists = rules.some((rule) => rule.tool === tool && rule.pattern === pattern);
      if (exists) return;
      const rule: PermissionRule = pattern === undefined ? { tool } : { tool, pattern };
      rules.push(rule);
      persist();
    },

    rules(): PermissionRule[] {
      return [...rules];
    },
  };
}
