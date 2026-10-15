/** Homebase directory + config.json management. */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { McpServerConfig } from './mcp/client.js';
import type { HookConfig } from './hooks/runner.js';
import type { ModelProvider } from './protocol/models.js';
export interface LlmConfig {
  provider: ModelProvider | null;
  model: string | null;
  api_key: string | null;
  base_url: string | null;
  max_tokens: number | null;
  temperature: number | null;
  embeddings: {
    provider: 'local' | 'openai';
    model: string | null;
    base_url: string | null;
    api_key: string | null;
  };
}

export interface OpenCursorConfig {
  version: 1;
  llm: LlmConfig;
  permission_mode: 'ask' | 'yolo';
  max_iterations: number;
  memory: {
    auto_summarize: boolean;
    capture_artifacts: boolean;
    max_digest_chars: number;
    max_search_results: number;
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
  llm: {
    provider: null,
    model: null,
    api_key: null,
    base_url: null,
    max_tokens: null,
    temperature: null,
    embeddings: {
      provider: 'local',
      model: null,
      base_url: null,
      api_key: null,
    },
  },
  permission_mode: 'ask',
  max_iterations: 24,
  memory: {
    auto_summarize: true,
    capture_artifacts: true,
    max_digest_chars: 4000,
    max_search_results: 8,
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

function mergeLlm(partial: Partial<LlmConfig> | null | undefined): LlmConfig {
  const source = partial ?? {};
  return {
    provider: source.provider ?? DEFAULT_CONFIG.llm.provider,
    model: source.model ?? DEFAULT_CONFIG.llm.model,
    api_key: source.api_key ?? DEFAULT_CONFIG.llm.api_key,
    base_url: source.base_url ?? DEFAULT_CONFIG.llm.base_url,
    max_tokens: source.max_tokens ?? DEFAULT_CONFIG.llm.max_tokens,
    temperature: source.temperature ?? DEFAULT_CONFIG.llm.temperature,
    embeddings: { ...DEFAULT_CONFIG.llm.embeddings, ...(source.embeddings ?? {}) },
  };
}

function mergeConfig(partial: Partial<OpenCursorConfig> | null): OpenCursorConfig {
  const source = partial ?? {};
  return {
    ...DEFAULT_CONFIG,
    ...source,
    version: 1,
    llm: mergeLlm(source.llm),
    memory: { ...DEFAULT_CONFIG.memory, ...(source.memory ?? {}) },
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
  const payload = `${JSON.stringify(config, null, 2)}\n`;
  const temp = `${home.config_path}.tmp`;
  writeFileSync(temp, payload, 'utf8');
  try {
    chmodSync(temp, 0o600);
  } catch {
    // permission tightening is best-effort on platforms without POSIX modes
  }
  try {
    renameSync(temp, home.config_path);
  } catch {
    writeFileSync(home.config_path, payload, 'utf8');
  }
  try {
    chmodSync(home.config_path, 0o600);
  } catch {
    // permission tightening is best-effort on platforms without POSIX modes
  }
}

export function redactConfig(config: OpenCursorConfig): OpenCursorConfig {
  const redactKey = (value: string | null): string | null => (value && value.length > 0 ? '***' : null);
  return {
    ...config,
    llm: {
      ...config.llm,
      api_key: redactKey(config.llm.api_key),
      embeddings: { ...config.llm.embeddings, api_key: redactKey(config.llm.embeddings.api_key) },
    },
  };
}

export function updateConfig(
  home: Homebase,
  current: OpenCursorConfig,
  patch: Partial<OpenCursorConfig>,
): OpenCursorConfig {
  const incomingLlm: Partial<LlmConfig> = patch.llm ?? {};
  const mergedLlm: LlmConfig = { ...current.llm, ...incomingLlm };
  if (incomingLlm.api_key === '***') mergedLlm.api_key = current.llm.api_key;
  if (incomingLlm.embeddings) {
    mergedLlm.embeddings = { ...current.llm.embeddings, ...incomingLlm.embeddings };
    if (incomingLlm.embeddings.api_key === '***') mergedLlm.embeddings.api_key = current.llm.embeddings.api_key;
  }
  const merged = mergeConfig({ ...current, ...patch, llm: mergedLlm });
  saveConfig(home, merged);
  return merged;
}
