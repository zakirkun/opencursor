/** Server RPC tests — full stack against a live server and a live stub LLM provider. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const repoRoot = path.resolve(serverRoot, '..', '..');
const serverEntry = path.join(serverRoot, 'dist', 'main.js');

interface RpcResponse {
  id: number;
  result?: unknown;
  error?: string;
}

function sseChunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

async function startStubProvider(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    const url = req.url ?? '';
    if (url.startsWith('/v1/models')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'stub-model-1' }, { id: 'stub-model-2' }] }));
      return;
    }
    if (url.startsWith('/v1/chat/completions')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sseChunk({ choices: [{ delta: { content: 'stub reply' } }] }));
      res.write(sseChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
      res.write(sseChunk({ usage: { prompt_tokens: 3, completion_tokens: 2 } }));
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('stub provider failed to bind');
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1` };
}

async function startServer(
  home: string,
  cwd: string,
  providerBaseUrl: string,
): Promise<{ child: ChildProcess; port: number }> {
  const child = spawn(process.execPath, ['--no-warnings', serverEntry, '--port', '0', '--cwd', cwd], {
    cwd: repoRoot,
    env: {
      ...process.env,
      OPENCURSOR_HOME: home,
      OPENCURSOR_PROVIDER: 'openai',
      OPENCURSOR_MODEL: 'stub-model-1',
      OPENAI_API_KEY: 'stub-key',
      OPENAI_BASE_URL: providerBaseUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const port = await new Promise<number>((resolve, reject) => {
    let buffered = '';
    const timer = setTimeout(() => reject(new Error(`server did not report a port; output: ${buffered.slice(0, 500)}`)), 20_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      const match = /OPENCURSOR_SERVER_PORT=(\d+)/.exec(buffered);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve(Number.parseInt(match[1], 10));
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early with code ${code}; output: ${buffered.slice(0, 500)}`));
    });
  });

  return { child, port };
}

function makeClient(port: number): {
  call: <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
} {
  let nextId = 1;
  return {
    async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      const response = await fetch(`http://127.0.0.1:${port}/api/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: nextId++, method, params: params ?? {} }),
      });
      const payload = (await response.json()) as RpcResponse;
      if (payload.error) throw new Error(payload.error);
      return payload.result as T;
    },
  };
}

async function waitForEvent(
  port: number,
  predicate: (message: Record<string, unknown>) => boolean,
  timeoutMs = 30_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error('timed out waiting for event'));
    }, timeoutMs);

    void (async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/events`, { signal: controller.signal });
        const reader = response.body?.getReader();
        if (!reader) throw new Error('no event stream body');
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index = buffer.indexOf('\n\n');
          while (index >= 0) {
            const frame = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
            if (dataLine) {
              try {
                const message = JSON.parse(dataLine.slice(6)) as Record<string, unknown>;
                if (predicate(message)) {
                  clearTimeout(timer);
                  controller.abort();
                  resolve(message);
                  return;
                }
              } catch {
                // ignore malformed frames
              }
            }
            index = buffer.indexOf('\n\n');
          }
        }
        clearTimeout(timer);
        reject(new Error('event stream ended before predicate matched'));
      } catch (error) {
        clearTimeout(timer);
        if ((error as Error).name === 'AbortError') return;
        reject(error);
      }
    })();
  });
}

test('server exposes status, sessions, chat, and events end to end', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'opencursor-srv-'));
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'opencursor-srvcwd-'));
  let server: { child: ChildProcess; port: number } | null = null;
  let stub: { server: Server; baseUrl: string } | null = null;
  try {
    stub = await startStubProvider();
    server = await startServer(home, cwd, stub.baseUrl);
    const client = makeClient(server.port);

    const status = await client.call<{
      cwd: string;
      model: { provider: string | null; id: string | null };
      model_configured: boolean;
    }>('status');
    assert.equal(status.model.provider, 'openai');
    assert.equal(status.model.id, 'stub-model-1');
    assert.equal(status.model_configured, true);

    const models = await client.call<{
      provider: string;
      models: Array<{ id: string; pricing?: { input_per_million?: number } }>;
      catalog: { source: string } | null;
    }>('models.list');
    assert.equal(models.provider, 'openai');
    assert.deepEqual(models.models.map((model) => model.id).sort(), ['stub-model-1', 'stub-model-2']);

    const configGet = await client.call<{ config: { llm: { api_key: string | null } } }>('config.get');
    assert.equal(configGet.config.llm.api_key, null);

    const configWithKey = await client.call<{ config: { llm: { api_key: string | null } } }>('config.set', {
      patch: { llm: { api_key: 'sk-test-secret-value' } },
    });
    assert.equal(configWithKey.config.llm.api_key, '***');

    const configGetAfterKey = await client.call<{ config: { llm: { api_key: string | null } } }>('config.get');
    assert.equal(configGetAfterKey.config.llm.api_key, '***');

    const configSet = await client.call<{ model: { configured: boolean } }>('config.set', {
      patch: { llm: { model: 'stub-model-2' } },
    });
    assert.equal(configSet.model.configured, true);
    const statusAfter = await client.call<{ model: { id: string | null } }>('status');
    assert.equal(statusAfter.model.id, 'stub-model-2');

    const created = await client.call<{ session_id: string }>('session.new');
    assert.ok(created.session_id.length > 0);

    const eventPromise = waitForEvent(server.port, (message) => {
      if (message['type'] !== 'agent-event') return false;
      const event = message['event'] as Record<string, unknown> | undefined;
      return event?.['type'] === 'turn-ended';
    });

    await client.call('chat.send', { text: 'hello' });
    const ended = await eventPromise;
    const event = ended['event'] as Record<string, unknown>;
    assert.equal(event['type'], 'turn-ended');

    const state = await client.call<{ state: { messages: Array<{ role: string }>; model: { provider: string; id: string } } }>(
      'session.state',
    );
    assert.ok(state.state.messages.length >= 2);
    assert.equal(state.state.model.id, 'stub-model-2');

    await client.call('config.set', { patch: { llm: { model: 'stub-model-1' } } });
    const switched = await client.call<{ state: { model: { provider: string; id: string } } }>('session.state');
    assert.equal(switched.state.model.id, 'stub-model-1');

    const sessions = await client.call<{ sessions: Array<{ id: string }> }>('session.list');
    assert.ok(sessions.sessions.some((session) => session.id === created.session_id));

    const index = await client.call<{ files: number; chunks: number }>('index.status');
    assert.equal(typeof index.files, 'number');

    const memory = await client.call<{ entry: { id: string } }>('memory.add', { text: 'gui test memory', kind: 'note' });
    const listed = await client.call<{ entries: Array<{ id: string }> }>('memory.list', { query: 'gui test' });
    assert.ok(listed.entries.some((entry) => entry.id === memory.entry.id));
    const forgotten = await client.call<{ removed: boolean }>('memory.forget', { id: memory.entry.id });
    assert.equal(forgotten.removed, true);

    const unknown = await client.call('does.not.exist').then(
      () => 'resolved',
      (error: Error) => error.message,
    );
    assert.match(String(unknown), /unknown method/);
  } finally {
    if (server) {
      server.child.kill();
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (stub) {
      await new Promise<void>((resolve) => stub.server.close(() => resolve()));
    }
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
