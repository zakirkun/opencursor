/** MCP stdio client — JSON-RPC 2.0 over newline-delimited stdio. */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  enabled?: boolean;
  timeout_ms?: number;
}

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpCallResult {
  content: string;
  isError: boolean;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const PROTOCOL_VERSION = '2024-11-05';
const DEFAULT_TIMEOUT_MS = 30_000;
const STDERR_LIMIT = 16 * 1024;

function spawnServer(command: string, args: string[], env: Record<string, string> | undefined, cwd: string | undefined): ChildProcess {
  const mergedEnv = { ...process.env, ...(env ?? {}) };
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    const quoted = command.includes(' ') ? `"${command}"` : command;
    return spawn(quoted, args, { env: mergedEnv, cwd, shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  }
  return spawn(command, args, { env: mergedEnv, cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
}

export class McpClient {
  readonly name: string;
  private readonly config: McpServerConfig;
  private child: ChildProcess | null = null;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private stderrText = '';
  private closed = false;
  private exitReason: string | null = null;

  constructor(name: string, config: McpServerConfig) {
    this.name = name;
    this.config = config;
  }

  get lastStderr(): string {
    return this.stderrText.trim();
  }

  get timeoutMs(): number {
    return this.config.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  }

  async connect(): Promise<void> {
    if (this.child) throw new Error(`mcp ${this.name}: already connected`);
    this.closed = false;
    this.exitReason = null;
    this.child = spawnServer(this.config.command, this.config.args ?? [], this.config.env, this.config.cwd);

    this.child.on('error', (error) => {
      this.exitReason = `spawn failed: ${error.message}`;
      this.rejectAll(new Error(this.exitReason));
    });
    this.child.on('exit', (code, signal) => {
      if (!this.closed) {
        this.exitReason = `server exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`;
        this.rejectAll(new Error(this.exitReason));
      }
    });

    const stdout = this.child.stdout;
    const stderr = this.child.stderr;
    if (!stdout || !stderr) throw new Error(`mcp ${this.name}: stdio unavailable`);

    stderr.on('data', (chunk: Buffer) => {
      if (this.stderrText.length < STDERR_LIMIT) this.stderrText += chunk.toString('utf8');
    });

    const lines = createInterface({ input: stdout });
    lines.on('line', (line) => this.handleLine(line));

    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'opencursor', version: '0.1.0' },
    });
    this.notify('notifications/initialized', {});
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(trimmed) as JsonRpcResponse;
    } catch {
      return;
    }
    if (message.id === undefined || message.id === null) return;
    const id = typeof message.id === 'number' ? message.id : Number(message.id);
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new Error(`mcp ${this.name}: ${message.error.message}`));
    } else {
      pending.resolve(message.result);
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (!this.child || this.exitReason) {
      return Promise.reject(new Error(`mcp ${this.name}: ${this.exitReason ?? 'not connected'}`));
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mcp ${this.name}: ${method} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const payload = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
      this.child?.stdin?.write(payload, (error) => {
        if (error) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(new Error(`mcp ${this.name}: write failed: ${error.message}`));
        }
      });
    });
  }

  private notify(method: string, params: unknown): void {
    if (!this.child || this.exitReason) return;
    this.child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    const result = (await this.request('tools/list', {})) as {
      tools?: Array<{ name?: string; description?: string; inputSchema?: unknown }>;
    };
    return (result.tools ?? [])
      .filter((tool): tool is { name: string; description?: string; inputSchema?: unknown } => typeof tool.name === 'string')
      .map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const result = (await this.request('tools/call', { name, arguments: args })) as {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    };
    const text = (result.content ?? [])
      .filter((item) => item.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text ?? '')
      .join('\n');
    return { content: text, isError: result.isError === true };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.rejectAll(new Error(`mcp ${this.name}: closed`));
    const child = this.child;
    this.child = null;
    if (!child) return;
    child.stdin?.end();
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        child.kill();
        resolve();
      }, 1000);
      child.once('exit', () => {
        clearTimeout(killTimer);
        resolve();
      });
      child.kill();
    });
  }
}
