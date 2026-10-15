/** Model client tests — request mapping, stream normalization, abort, malformed args. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicClient, toAnthropicMessages } from '../src/models/anthropic.js';
import { OpenAIClient, toOpenAIMessages } from '../src/models/openai.js';
import { MockModelClient } from '../src/models/mock.js';
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

test('mock model scripts tool calls and then summarizes results', async () => {
  const mock = new MockModelClient();
  const first: ModelStreamEvent[] = [];
  for await (const event of mock.generate({ messages: [{ role: 'user', text: 'list files' }], tools: [] })) {
    first.push(event);
  }
  const call = first.find((event) => event.type === 'tool-call');
  assert.ok(call && call.type === 'tool-call');
  assert.equal(call.call.name, 'list_dir');

  const summary: ModelStreamEvent[] = [];
  for await (const event of mock.generate({
    messages: [
      { role: 'user', text: 'list files' },
      { role: 'assistant', text: '', tool_calls: [{ id: call.call.id, name: 'list_dir', args: {} }] },
      { role: 'tool', results: [{ call_id: call.call.id, name: 'list_dir', outcome: { kind: 'success', value: { entries: [] } } }] },
    ],
    tools: [],
  })) {
    summary.push(event);
  }
  const text = summary
    .filter((event) => event.type === 'text-delta')
    .map((event) => (event.type === 'text-delta' ? event.text : ''))
    .join('');
  assert.match(text, /list_dir finished/);
  const stop = summary[summary.length - 1];
  assert.ok(stop && stop.type === 'stop' && stop.reason === 'end_turn');
});

test('mock model greets hello', async () => {
  const mock = new MockModelClient();
  const events: ModelStreamEvent[] = [];
  for await (const event of mock.generate({ messages: [{ role: 'user', text: 'hello there' }], tools: [] })) {
    events.push(event);
  }
  const text = events
    .filter((event) => event.type === 'text-delta')
    .map((event) => (event.type === 'text-delta' ? event.text : ''))
    .join('');
  assert.match(text, /hello/i);
});
