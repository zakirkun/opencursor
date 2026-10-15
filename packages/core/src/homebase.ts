/** Homebase directory + config.json management. */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { McpServerConfig } from './mcp/client.js';
import type { HookConfig } from './hooks/runner.js';

export interface OpenCursorConfig {
  version: 1;
  provider: 'anthropic' | 'openai' | 'mock' | null;
  model: string | null;
  permission_mode: 'ask' | 'yolo';
  max_iterations: number;
  memory: {
    auto_summarize: boolean;
    capture_artifacts: boolean;
    max_digest_chars: number;
    max_search_results: number;
  };
  tui: {
    ascii: boolean;
  };
  mcp_servers: Record<string, McpServerConfig>;
  hooks: {
    pre: HookConfig[];
    post: HookConfig[];
  };
  context: {
    enabled: boolean;
    max_chars: number;
    keep_recent: number;
  };
}

export const DEFAULT_CONFIG: OpenCursorConfig = {
  version: 1,
  provider: null,
  model: null,
  permission_mode: 'ask',
  max_iterations: 24,
  memory: {
    auto_summarize: true,
    capture_artifacts: true,
    max_digest_chars: 4000,
    max_search_results: 8,
  },
  tui: {
    ascii: false,
  },
  mcp_servers: {},
  hooks: {
    pre: [],
    post: [],
  },
  context: {
    enabled: true,
    max_chars: 60_000,
    keep_recent: 6,
  },
};

export interface Homebase {
  root: string;
  config_path: string;
  db_path: string;
  memory_json_path: string;
  memory_md_path: string;
  sessions_dir: string;
}

export function resolveHomebase(rootOverride?: string): Homebase {
  const root =
    rootOverride ??
    process.env['OPENCURSOR_HOME'] ??
    path.join(os.homedir(), '.opencursor');
  return {
    root,
    config_path: path.join(root, 'config.json'),
    db_path: path.join(root, 'opencursor.db'),
    memory_json_path: path.join(root, 'memory.json'),
    memory_md_path: path.join(root, 'MEMORY.md'),
    sessions_dir: path.join(root, 'sessions'),
  };
}

export function ensureHomebase(home: Homebase): void {
  mkdirSync(home.root, { recursive: true });
  mkdirSync(home.sessions_dir, { recursive: true });
}

function mergeConfig(partial: Partial<OpenCursorConfig> | null): OpenCursorConfig {
  const source = partial ?? {};
  return {
    ...DEFAULT_CONFIG,
    ...source,
    version: 1,
    memory: { ...DEFAULT_CONFIG.memory, ...(source.memory ?? {}) },
    tui: { ...DEFAULT_CONFIG.tui, ...(source.tui ?? {}) },
    mcp_servers: { ...DEFAULT_CONFIG.mcp_servers, ...(source.mcp_servers ?? {}) },
    hooks: {
      pre: source.hooks?.pre ?? DEFAULT_CONFIG.hooks.pre,
      post: source.hooks?.post ?? DEFAULT_CONFIG.hooks.post,
    },
    context: { ...DEFAULT_CONFIG.context, ...(source.context ?? {}) },
  };
}

export function loadConfig(home: Homebase): { config: OpenCursorConfig; created: boolean } {
  ensureHomebase(home);
  try {
    const raw = readFileSync(home.config_path, 'utf8');
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed = JSON.parse(text) as Partial<OpenCursorConfig>;
    return { config: mergeConfig(parsed), created: false };
  } catch {
    const config = mergeConfig(null);
    saveConfig(home, config);
    return { config, created: true };
  }
}

export function saveConfig(home: Homebase, config: OpenCursorConfig): void {
  ensureHomebase(home);
  const temp = `${home.config_path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  try {
    renameSync(temp, home.config_path);
  } catch {
    writeFileSync(home.config_path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  }
}
