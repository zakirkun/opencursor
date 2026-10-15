/** run_terminal_cmd — bounded shell execution with streaming progress. */

import { spawn } from 'node:child_process';
import process from 'node:process';
import type { ToolHandlerFor } from '../types.js';
import { DEFAULT_LIMITS } from '../types.js';
import type { ShellArgs, ShellSuccess } from '../protocol/tools.js';
import { err, ok } from '../protocol/tools.js';
import { resolveInWorkspace } from './paths.js';

const STREAM_LIMIT = 256 * 1024;

function shellInvocation(command: string): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return { file: process.env['COMSPEC'] ?? 'cmd.exe', args: ['/d', '/s', '/c', command] };
  }
  return { file: process.env['SHELL'] ?? '/bin/sh', args: ['-c', command] };
}

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

export const shellTool: ToolHandlerFor<'run_terminal_cmd'> = {
  name: 'run_terminal_cmd',
  description:
    'Run a shell command in the workspace. stdout/stderr are captured (bounded 256KB each). ' +
    'Use for builds, tests, git, and process control. Prefer dedicated tools for file ops.',
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Command line to execute' },
      working_directory: { type: 'string', description: 'Working directory (default: workspace root)' },
      timeout: { type: 'integer', description: 'Timeout ms (default 120000, max 600000)' },
      is_background: { type: 'boolean', description: 'Start detached and return immediately' },
      description: { type: 'string', description: 'Short human description of the command' },
    },
    required: ['command'],
  },
  default_permission: 'ask',
  async execute(args: ShellArgs, ctx) {
    if (args.command.trim().length === 0) return err('invalid_args', 'empty command');

    const cwdResolved = args.working_directory
      ? resolveInWorkspace(ctx.cwd, args.working_directory)
      : ({ ok: true, abs: ctx.cwd } as const);
    if (!cwdResolved.ok) return cwdResolved.outcome;

    const timeout = Math.min(
      Math.max(1_000, args.timeout ?? DEFAULT_LIMITS.shell_default_timeout_ms),
      DEFAULT_LIMITS.shell_max_timeout_ms,
    );
    const { file, args: shellArgs } = shellInvocation(args.command);

    if (args.is_background) {
      if (ctx.shells) {
        const info = ctx.shells.start({ command: args.command, cwd: cwdResolved.abs });
        const value: ShellSuccess = {
          command: args.command,
          stdout: `background shell started: ${info.shell_id}`,
          stderr: '',
          exit_code: 0,
          duration_ms: 0,
          backgrounded: true,
          stdout_truncated: false,
          stderr_truncated: false,
        };
        return ok(value);
      }
      const child = spawn(file, shellArgs, {
        cwd: cwdResolved.abs,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      const value: ShellSuccess = {
        command: args.command,
        stdout: '',
        stderr: '',
        exit_code: 0,
        duration_ms: 0,
        backgrounded: true,
        stdout_truncated: false,
        stderr_truncated: false,
      };
      return ok(value);
    }

    return new Promise((resolve) => {
      const startedAt = Date.now();
      const child = spawn(file, shellArgs, {
        cwd: cwdResolved.abs,
        windowsHide: true,
        detached: process.platform !== 'win32',
      });

      let stdout = '';
      let stderr = '';
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let settled = false;
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child.pid);
      }, timeout);

      const onAbort = (): void => killTree(child.pid);
      ctx.signal.addEventListener('abort', onAbort, { once: true });

      const finish = (exitCode: number): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);

        if (ctx.signal.aborted) {
          resolve(err('cancelled', 'command cancelled'));
          return;
        }
        if (timedOut) {
          resolve(err('timeout', `command timed out after ${timeout}ms`));
          return;
        }
        const value: ShellSuccess = {
          command: args.command,
          stdout,
          stderr,
          exit_code: exitCode,
          duration_ms: Date.now() - startedAt,
          backgrounded: false,
          stdout_truncated: stdoutTruncated,
          stderr_truncated: stderrTruncated,
        };
        resolve(ok(value));
      };

      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        if (stdout.length < STREAM_LIMIT) {
          stdout += text.slice(0, STREAM_LIMIT - stdout.length);
          ctx.onProgress?.('stdout', text);
        } else {
          stdoutTruncated = true;
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        if (stderr.length < STREAM_LIMIT) {
          stderr += text.slice(0, STREAM_LIMIT - stderr.length);
          ctx.onProgress?.('stderr', text);
        } else {
          stderrTruncated = true;
        }
      });
      child.on('error', (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          ctx.signal.removeEventListener('abort', onAbort);
          resolve(err('internal', `spawn failed: ${error.message}`));
        }
      });
      child.on('close', (code) => finish(code ?? -1));
    });
  },
};
