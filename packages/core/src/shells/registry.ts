/** Background shell registry — detached processes with stdin and buffered output. */

import { spawn } from 'node:child_process';
import process from 'node:process';
import { randomUUID } from 'node:crypto';

export interface BackgroundShellInfo {
  shell_id: string;
  command: string;
  cwd: string;
  started_at: string;
  running: boolean;
  exit_code: number | null;
  stdout_bytes: number;
  stderr_bytes: number;
}

export interface BackgroundShellSnapshot extends BackgroundShellInfo {
  stdout: string;
  stderr: string;
}

interface ShellEntry {
  id: string;
  command: string;
  cwd: string;
  startedAt: string;
  child: ReturnType<typeof spawn>;
  stdout: string;
  stderr: string;
  running: boolean;
  exitCode: number | null;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface ShellRegistry {
  start(input: { command: string; cwd: string; env?: NodeJS.ProcessEnv }): BackgroundShellInfo;
  write(shell_id: string, data: string, close: boolean): { bytes_written: number; closed: boolean };
  read(shell_id: string, drain?: boolean): BackgroundShellSnapshot;
  list(): BackgroundShellInfo[];
  kill(shell_id: string): boolean;
  killAll(): void;
}

const BUFFER_LIMIT = 512 * 1024;

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

function appendBounded(current: string, chunk: string): { text: string; truncated: boolean } {
  if (current.length >= BUFFER_LIMIT) return { text: current, truncated: true };
  const next = current + chunk;
  if (next.length <= BUFFER_LIMIT) return { text: next, truncated: false };
  return { text: next.slice(next.length - BUFFER_LIMIT), truncated: true };
}

export function createShellRegistry(): ShellRegistry {
  const shells = new Map<string, ShellEntry>();

  const toInfo = (entry: ShellEntry): BackgroundShellInfo => ({
    shell_id: entry.id,
    command: entry.command,
    cwd: entry.cwd,
    started_at: entry.startedAt,
    running: entry.running,
    exit_code: entry.exitCode,
    stdout_bytes: entry.stdout.length,
    stderr_bytes: entry.stderr.length,
  });

  const requireEntry = (shell_id: string): ShellEntry => {
    const entry = shells.get(shell_id);
    if (!entry) throw new Error(`unknown shell: ${shell_id}`);
    return entry;
  };

  return {
    start(input): BackgroundShellInfo {
      const child = spawn(input.command, {
        cwd: input.cwd,
        env: input.env ?? process.env,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true,
      });
      const entry: ShellEntry = {
        id: randomUUID(),
        command: input.command,
        cwd: input.cwd,
        startedAt: new Date().toISOString(),
        child,
        stdout: '',
        stderr: '',
        running: true,
        exitCode: null,
        stdoutTruncated: false,
        stderrTruncated: false,
      };
      child.stdout?.on('data', (chunk: Buffer) => {
        const result = appendBounded(entry.stdout, chunk.toString('utf8'));
        entry.stdout = result.text;
        if (result.truncated) entry.stdoutTruncated = true;
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        const result = appendBounded(entry.stderr, chunk.toString('utf8'));
        entry.stderr = result.text;
        if (result.truncated) entry.stderrTruncated = true;
      });
      child.on('exit', (code) => {
        entry.running = false;
        entry.exitCode = code ?? -1;
      });
      child.on('error', () => {
        entry.running = false;
        entry.exitCode = -1;
      });
      shells.set(entry.id, entry);
      return toInfo(entry);
    },

    write(shell_id, data, close) {
      const entry = requireEntry(shell_id);
      if (!entry.running) throw new Error(`shell ${shell_id} is not running`);
      const stdin = entry.child.stdin;
      if (!stdin) throw new Error(`shell ${shell_id} has no stdin`);
      const bytes = Buffer.byteLength(data, 'utf8');
      if (bytes > 0) stdin.write(data);
      if (close) stdin.end();
      return { bytes_written: bytes, closed: close };
    },

    read(shell_id, drain = false) {
      const entry = requireEntry(shell_id);
      const snapshot: BackgroundShellSnapshot = {
        ...toInfo(entry),
        stdout: entry.stdout,
        stderr: entry.stderr,
      };
      if (drain) {
        entry.stdout = '';
        entry.stderr = '';
        entry.stdoutTruncated = false;
        entry.stderrTruncated = false;
      }
      return snapshot;
    },

    list() {
      return [...shells.values()].map(toInfo);
    },

    kill(shell_id) {
      const entry = shells.get(shell_id);
      if (!entry) return false;
      killTree(entry.child.pid);
      entry.running = false;
      return true;
    },

    killAll() {
      for (const entry of shells.values()) {
        if (entry.running) killTree(entry.child.pid);
        entry.running = false;
      }
    },
  };
}
