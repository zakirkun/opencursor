/** Tool hooks — PreToolUse / PostToolUse shell interception (agent.v1 hook model). */

import { spawn } from 'node:child_process';

export interface HookConfig {
  matcher?: string;
  command: string;
  timeout_ms?: number;
}

export interface HookOutcome {
  decision: 'allow' | 'deny' | 'error';
  reason?: string;
}

export interface HookPayloadBase {
  tool_name: string;
  tool_input: unknown;
  cwd: string;
  session_id: string;
}

export interface PostHookPayload extends HookPayloadBase {
  tool_output: string;
  duration_ms: number;
}

export interface HookRunner {
  runPre(payload: HookPayloadBase): Promise<HookOutcome>;
  runPost(payload: PostHookPayload): Promise<HookOutcome>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const OUTPUT_LIMIT = 16 * 1024;

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).on('error', () => undefined);
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already dead
    }
  }
}

function matches(matcher: string | undefined, toolName: string): boolean {
  if (!matcher || matcher.trim().length === 0 || matcher === '*') return true;
  const parts = matcher.split('|').map((part) => part.trim()).filter((part) => part.length > 0);
  return parts.includes(toolName);
}

function runHookCommand(
  config: HookConfig,
  payload: unknown,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string; spawnError: Error | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(config.command, { shell: true, env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, config.timeout_ms ?? DEFAULT_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < OUTPUT_LIMIT) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < OUTPUT_LIMIT) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, spawnError: error, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, spawnError: null, timedOut });
    });

    const payloadText = JSON.stringify(payload);
    child.stdin?.write(payloadText);
    child.stdin?.end();
  });
}

function parseHookOutput(stdout: string): { decision?: string; reason?: string; additionalContext?: string } | null {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return null;
  const lastLine = trimmed.split('\n').filter((line) => line.trim().length > 0).pop() ?? '';
  try {
    const parsed = JSON.parse(lastLine) as { decision?: string; reason?: string; additionalContext?: string };
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // non-JSON output is treated as absent
  }
  return null;
}

export function createHookRunner(hooks: { pre?: HookConfig[]; post?: HookConfig[] } | undefined): HookRunner | null {
  const preHooks = hooks?.pre ?? [];
  const postHooks = hooks?.post ?? [];
  if (preHooks.length === 0 && postHooks.length === 0) return null;

  const buildEnv = (payload: HookPayloadBase): NodeJS.ProcessEnv => ({
    ...process.env,
    OPENCURSOR_HOOK_TOOL: payload.tool_name,
    OPENCURSOR_HOOK_CWD: payload.cwd,
    OPENCURSOR_HOOK_SESSION: payload.session_id,
  });

  return {
    async runPre(payload: HookPayloadBase): Promise<HookOutcome> {
      for (const hook of preHooks) {
        if (!matches(hook.matcher, payload.tool_name)) continue;
        const result = await runHookCommand(hook, payload, buildEnv(payload));
        if (result.spawnError) {
          return { decision: 'error', reason: `hook failed to run: ${result.spawnError.message}` };
        }
        if (result.timedOut) {
          return { decision: 'error', reason: `hook timed out after ${hook.timeout_ms ?? DEFAULT_TIMEOUT_MS}ms` };
        }
        const parsed = parseHookOutput(result.stdout);
        if (parsed?.decision === 'deny') {
          return { decision: 'deny', reason: parsed.reason ?? 'denied by pre-tool hook' };
        }
        if (parsed?.decision === 'allow') continue;
        if (result.code === 2) {
          return { decision: 'deny', reason: result.stderr.trim() || parsed?.reason || 'denied by pre-tool hook (exit 2)' };
        }
        if (result.code !== 0) {
          return { decision: 'error', reason: `hook exited with code ${result.code ?? 'null'}: ${result.stderr.trim().slice(0, 300)}` };
        }
      }
      return { decision: 'allow' };
    },

    async runPost(payload: PostHookPayload): Promise<HookOutcome> {
      for (const hook of postHooks) {
        if (!matches(hook.matcher, payload.tool_name)) continue;
        const result = await runHookCommand(hook, payload, buildEnv(payload));
        if (result.spawnError) {
          return { decision: 'error', reason: `hook failed to run: ${result.spawnError.message}` };
        }
        if (result.timedOut) {
          return { decision: 'error', reason: `hook timed out after ${hook.timeout_ms ?? DEFAULT_TIMEOUT_MS}ms` };
        }
        const parsed = parseHookOutput(result.stdout);
        if (parsed?.decision === 'deny') {
          return { decision: 'deny', reason: parsed.reason ?? 'denied by post-tool hook' };
        }
        if (result.code === 2) {
          return { decision: 'deny', reason: result.stderr.trim() || 'denied by post-tool hook (exit 2)' };
        }
        if (result.code !== 0) {
          return { decision: 'error', reason: `hook exited with code ${result.code ?? 'null'}: ${result.stderr.trim().slice(0, 300)}` };
        }
      }
      return { decision: 'allow' };
    },
  };
}
