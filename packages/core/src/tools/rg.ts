/** ripgrep spawn helpers shared by search tools. */

import { spawn } from 'node:child_process';

export function ripgrepBinary(): string {
  return process.env['OPENCURSOR_RIPGREP_PATH'] ?? 'rg';
}

export interface RgRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError: NodeJS.ErrnoException | null;
}

export function runRipgrep(args: string[], cwd: string, signal: AbortSignal, maxBytes = 32 * 1024 * 1024): Promise<RgRunResult> {
  return new Promise((resolve) => {
    const child = spawn(ripgrepBinary(), args, { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let killTimer: NodeJS.Timeout | null = null;

    const onAbort = (): void => {
      child.kill();
    };
    signal.addEventListener('abort', onAbort, { once: true });

    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort);
      if (killTimer) clearTimeout(killTimer);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < maxBytes) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      cleanup();
      resolve({ code: null, stdout, stderr, spawnError: error as NodeJS.ErrnoException });
    });
    child.on('close', (code) => {
      cleanup();
      resolve({ code, stdout, stderr, spawnError: null });
    });

    killTimer = setTimeout(() => child.kill(), 60_000);
  });
}

export const RG_MISSING_HINT = 'ripgrep not found; install rg or set OPENCURSOR_RIPGREP_PATH';
