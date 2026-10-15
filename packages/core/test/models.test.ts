/** Model client tests — request mapping, stream normalization, abort, malformed args. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicClient, toAnthropicMessages } from '../src/models/anthropic.js';
import { OpenAIClient, toOpenAIMessages } from '../src/models/openai.js';
import { normalizeModelEntry, formatPricing } from '../src/models/listing.js';
import { matchPrice } from '../src/models/prices.js';
import type { PriceCatalog } from '../src/models/prices.js';
import type { ModelStreamEvent } from '../src/protocol/models.js';

function sseResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function drain(client: { generate(request: never): AsyncIterable<ModelStreamEvent> }): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of client.generate({ messages: [], tools: [] } as never)) events.push(event);
  return events;
}

async function withFetchStub<T>(
  handler: (url: string, init: RequestInit) => Response,
  run: () => Promise<T>,
): Promise<T & { calls?: Array<{ url: string; init: RequestInit }> }> {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as typeof fetch;
  try {
    const result = await run();
    if (result !== null && result !== undefined && typeof result === 'object') {
      Object.assign(result as object, { calls });
    }
    return result as T & { calls?: Array<{ url: string; init: RequestInit }> };
  } finally {
    globalThis.fetch = original;
  }
}

test('anthropic stream normalizes text, tool call, usage, stop', async () => {
  const client = new AnthropicClient({ provider: 'anthropic', id: 'claude-test', api_key: 'k' });
  const captured = await withFetchStub(
    () =>
      sseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":11}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_1","name":"read_file"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a.ts\\"}"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    () => drain(client as never),
  );

  const types = captured.map((event) => event.type);
  assert.deepEqual(types, ['usage', 'text-delta', 'text-delta', 'tool-call', 'usage', 'stop']);
  const toolCall = captured.find((event) => event.type === 'tool-call');
  assert.ok(toolCall && toolCall.type === 'tool-call');
  assert.equal(toolCall.call.name, 'read_file');
  assert.deepEqual(toolCall.call.args, { path: 'a.ts' });
  const stop = captured[captured.length - 1];
  assert.ok(stop && stop.type === 'stop' && stop.reason === 'tool_use');

  const call = captured.calls?.[0];
  assert.ok(call);
  assert.match(call.url, /\/v1\/messages$/);
  const body = JSON.parse(String(call.init.body)) as { stream: boolean; tools: unknown[] };
  assert.equal(body.stream, true);
  assert.equal(body.tools.length, 0);
});

test('anthropic request mapping groups tool results into one user message', () => {
  const mapped = toAnthropicMessages([
    { role: 'user', text: 'do it' },
    {
      role: 'assistant',
      text: 'working',
      tool_calls: [
        { id: 'c1', name: 'read_file', args: { path: 'a.ts' } },
        { id: 'c2', name: 'list_dir', args: { path: '.' } },
      ],
    },
    {
      role: 'tool',
      results: [
        { call_id: 'c1', name: 'read_file', outcome: { kind: 'success', value: {} } },
        { call_id: 'c2', name: 'list_dir', outcome: { kind: 'success', value: {} } },
      ],
    },
  ]);
  assert.equal(mapped.length, 3);
  const toolMessage = mapped[2];
  assert.ok(toolMessage && Array.isArray(toolMessage.content));
  assert.equal(toolMessage.content.length, 2);
  assert.equal(toolMessage.role, 'user');
});

test('anthropic malformed tool args throw', async () => {
  const client = new AnthropicClient({ provider: 'anthropic', id: 'claude-test', api_key: 'k' });
  await withFetchStub(
    () =>
      sseResponse([
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu","name":"read_file"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{bad"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      ]),
    async () => {
      await assert.rejects(async () => {
        for await (const _event of client.generate({ messages: [], tools: [] })) {
          void _event;
        }
      }, /malformed tool args/);
    },
  );
});

test('anthropic abort mid-stream rejects with aborted', async () => {
  const client = new AnthropicClient({ provider: 'anthropic', id: 'claude-test', api_key: 'k' });
  const controller = new AbortController();
  const encoder = new TextEncoder();
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(encoder.encode('event: message_start\ndata: {"type":"message_start","message":{}}\n\n'));
        setTimeout(() => {
          controller.abort();
          streamController.error(new Error('aborted by test'));
        }, 10);
      },
    });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  try {
    await assert.rejects(async () => {
      for await (const _event of client.generate({ messages: [], tools: [], signal: controller.signal })) {
        void _event;
      }
    }, /aborted/);
  } finally {
    globalThis.fetch = original;
  }
});

test('openai stream normalizes deltas, reasoning, tool calls, stop', async () => {
  const client = new OpenAIClient({ provider: 'openai', id: 'gpt-test', api_key: 'k' });
  const captured = await withFetchStub(
    () =>
      sseResponse([
        'data: {"choices":[{"delta":{"reasoning_content":"think "}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"grep_search","arguments":"{\\"pat"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"tern\\":\\"x\\"}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        'data: {"usage":{"prompt_tokens":9,"completion_tokens":4}}\n\n',
        'data: [DONE]\n\n',
      ]),
    () => drain(client as never),
  );

  const textDeltas = captured.filter((event) => event.type === 'text-delta');
  const reasoning = captured.filter((event) => event.type === 'reasoning-delta');
  const toolCalls = captured.filter((event) => event.type === 'tool-call');
  assert.equal(textDeltas.length, 1);
  assert.equal(reasoning.length, 1);
  assert.equal(toolCalls.length, 1);
  const call = toolCalls[0];
  assert.ok(call && call.type === 'tool-call');
  assert.deepEqual(call.call.args, { pattern: 'x' });
  const stop = captured[captured.length - 1];
  assert.ok(stop && stop.type === 'stop' && stop.reason === 'tool_use');

  const request = captured.calls?.[0];
  assert.ok(request);
  const body = JSON.parse(String(request.init.body)) as { model: string; messages: unknown[] };
  assert.equal(body.model, 'gpt-test');
});

test('openai message mapping emits tool role entries per result', () => {
  const mapped = toOpenAIMessages(
    [
      { role: 'user', text: 'q' },
      { role: 'assistant', text: '', tool_calls: [{ id: 'c1', name: 'read_file', args: { path: 'a' } }] },
      { role: 'tool', results: [{ call_id: 'c1', name: 'read_file', outcome: { kind: 'success', value: {} } }] },
    ],
    'sys',
  );
  assert.equal(mapped[0]?.role, 'system');
  const assistant = mapped[2];
  assert.ok(assistant && assistant.tool_calls && assistant.tool_calls[0]);
  assert.equal(assistant.tool_calls[0].id, 'c1');
  const tool = mapped[3];
  assert.equal(tool?.role, 'tool');
  assert.equal(tool?.tool_call_id, 'c1');
});

test('normalizeModelEntry parses pricing shapes and metadata', () => {
  const openrouter = normalizeModelEntry({
    id: 'vendor/model-x',
    name: 'Model X',
    pricing: { prompt: '0.000003', completion: '0.000015' },
    context_length: 128000,
  });
  assert.ok(openrouter);
  assert.equal(openrouter.id, 'vendor/model-x');
  assert.equal(openrouter.context_length, 128000);
  assert.ok(Math.abs((openrouter.pricing?.input_per_million ?? 0) - 3) < 0.0001);
  assert.ok(Math.abs((openrouter.pricing?.output_per_million ?? 0) - 15) < 0.0001);

  const direct = normalizeModelEntry({ id: 'direct-model', input_cost_per_token: 0.000002, output_cost_per_token: 0.000008 });
  assert.ok(direct?.pricing);
  assert.ok(Math.abs((direct.pricing.input_per_million ?? 0) - 2) < 0.0001);

  const plain = normalizeModelEntry({ id: 'plain-model' });
  assert.ok(plain);
  assert.equal(plain.pricing, undefined);

  assert.equal(normalizeModelEntry({}), null);
});

test('formatPricing renders human-readable per-million prices', () => {
  assert.equal(formatPricing({ input_per_million: 3, output_per_million: 15 }), '$3.00/M in · $15.00/M out');
  assert.equal(formatPricing({ input_per_million: 0.25 }), '$0.25/M in');
  assert.equal(formatPricing(undefined), null);
});

test('matchPrice finds catalog entries by id, name, and prefix', () => {
  const catalog: PriceCatalog = {
    updated_at: '2026-01-01',
    fetched_at: new Date().toISOString(),
    source: 'cache',
    stale: false,
    prices: [
      { id: 'claude-sonnet-4-5', vendor: 'anthropic', name: 'Claude Sonnet 4.5', input: 3, output: 15, input_cached: 0.3 },
      { id: 'gpt-5', vendor: 'openai', name: 'GPT-5', input: 1.25, output: 10, input_cached: null },
    ],
  };

  const exact = matchPrice(catalog, 'claude-sonnet-4-5');
  assert.ok(exact);
  assert.equal(exact.input_per_million, 3);

  const byName = matchPrice(catalog, 'unknown-id', 'GPT-5');
  assert.ok(byName);
  assert.equal(byName.output_per_million, 10);

  const byPrefix = matchPrice(catalog, 'gpt-5-turbo-preview');
  assert.ok(byPrefix);
  assert.equal(byPrefix.input_per_million, 1.25);

  assert.equal(matchPrice(catalog, 'totally-unrelated-model'), undefined);
  assert.equal(matchPrice(null, 'claude-sonnet-4-5'), undefined);
});

test('openai client lists models and prices from a live stub endpoint', async () => {
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          data: [
            { id: 'z-model', created: 1700000000 },
            { id: 'a-model', pricing: { prompt: '0.000001', completion: '0.000002' } },
          ],
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const client = new OpenAIClient({
      provider: 'openai',
      id: 'unused',
      api_key: 'stub-key',
      base_url: `http://127.0.0.1:${address.port}/v1`,
    });
    const models = await client.listModels();
    assert.deepEqual(models.map((model) => model.id), ['a-model', 'z-model']);
    const priced = models.find((model) => model.id === 'a-model');
    assert.ok(priced?.pricing);
    assert.ok(Math.abs((priced.pricing.input_per_million ?? 0) - 1) < 0.0001);
    assert.ok(Math.abs((priced.pricing.output_per_million ?? 0) - 2) < 0.0001);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('anthropic client lists models from a live stub endpoint', async () => {
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/v1/models')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'claude-test-1', display_name: 'Claude Test' }] }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const client = new AnthropicClient({
      provider: 'anthropic',
      id: 'unused',
      api_key: 'stub-key',
      base_url: `http://127.0.0.1:${address.port}`,
    });
    const models = await client.listModels();
    assert.equal(models.length, 1);
    assert.equal(models[0]?.id, 'claude-test-1');
    assert.equal(models[0]?.display_name, 'Claude Test');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('openai client surfaces provider errors from the models endpoint', async () => {
  const { createServer } = await import('node:http');
  const server = createServer((_req, res) => {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: { message: 'invalid key' } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const client = new OpenAIClient({
      provider: 'openai',
      id: 'unused',
      api_key: 'bad',
      base_url: `http://127.0.0.1:${address.port}/v1`,
    });
    await assert.rejects(() => client.listModels(), /401/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
