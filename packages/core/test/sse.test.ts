/** SSE parser tests — chunk boundaries, CRLF, comments, multi-line data. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSSEStream } from '../src/models/sse.js';

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function collect(chunks: Uint8Array[]): Promise<Array<{ event?: string; data: string }>> {
  const events: Array<{ event?: string; data: string }> = [];
  for await (const event of parseSSEStream(streamFromChunks(chunks))) events.push(event);
  return events;
}

test('parses simple data events split at event boundaries', async () => {
  const encoder = new TextEncoder();
  const events = await collect([encoder.encode('data: one\n\ndata: two\n\n')]);
  assert.deepEqual(events, [{ data: 'one' }, { data: 'two' }]);
});

test('handles chunk split mid-multibyte-character', async () => {
  const encoder = new TextEncoder();
  const payload = encoder.encode('data: héllo ✓\n\n');
  const mid = Math.floor(payload.length / 2);
  const events = await collect([payload.slice(0, mid), payload.slice(mid)]);
  assert.deepEqual(events, [{ data: 'héllo ✓' }]);
});

test('handles CRLF line endings', async () => {
  const encoder = new TextEncoder();
  const events = await collect([encoder.encode('event: delta\r\ndata: payload\r\n\r\n')]);
  assert.deepEqual(events, [{ event: 'delta', data: 'payload' }]);
});

test('joins multi-line data with newline', async () => {
  const encoder = new TextEncoder();
  const events = await collect([encoder.encode('data: line1\ndata: line2\n\n')]);
  assert.deepEqual(events, [{ data: 'line1\nline2' }]);
});

test('ignores comment lines and keeps event names', async () => {
  const encoder = new TextEncoder();
  const events = await collect([encoder.encode(': keep-alive\n\nevent: custom\ndata: x\n\n')]);
  assert.deepEqual(events, [{ event: 'custom', data: 'x' }]);
});

test('flushes trailing event without final blank line', async () => {
  const encoder = new TextEncoder();
  const events = await collect([encoder.encode('event: stop\ndata: final')]);
  assert.deepEqual(events, [{ event: 'stop', data: 'final' }]);
});

test('ignores retry and id fields', async () => {
  const encoder = new TextEncoder();
  const events = await collect([encoder.encode('retry: 1000\nid: 42\ndata: payload\n\n')]);
  assert.deepEqual(events, [{ data: 'payload' }]);
});
