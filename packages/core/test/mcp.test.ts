/** MCP client + manager tests — fake stdio server, no network. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMcpManager } from '../src/mcp/manager.js';
import { McpClient } from '../src/mcp/client.js';

const FAKE_SERVER = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\\n'); }
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '1' } } });
  } else if (msg.method === 'notifications/initialized') {
    // notification: no response
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [
      { name: 'echo', description: 'echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
      { name: 'fail_tool', description: 'always errors', inputSchema: {} }
    ] } });
  } else if (msg.method === 'tools/call') {
    if (msg.params.name === 'echo') {
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'echo:' + (msg.params.arguments.text || '') }] } });
    } else if (msg.params.name === 'fail_tool') {
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'boom' }], isError: true } });
    } else {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown tool ' + msg.params.name } });
    }
  } else if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found: ' + msg.method } });
  }
});
`;

function writeFakeServer(dir: string): string {
  const file = path.join(dir, 'fake-mcp.cjs');
  writeFileSync(file, FAKE_SERVER, 'utf8');
  return file;
}

test('mcp client connects, lists tools, calls tools, and handles errors', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'opencursor-mcp-'));
  const serverPath = writeFakeServer(dir);
  const client = new McpClient('fake', { command: process.execPath, args: [serverPath], timeout_ms: 5000 });
  try {
    await client.connect();
    const tools = await client.listTools();
    assert.equal(tools.length, 2);
    assert.equal(tools[0]?.name, 'echo');

    const echoed = await client.callTool('echo', { text: 'hi' });
    assert.equal(echoed.isError, false);
    assert.equal(echoed.content, 'echo:hi');

    const failed = await client.callTool('fail_tool', {});
    assert.equal(failed.isError, true);
    assert.equal(failed.content, 'boom');

    await assert.rejects(() => client.callTool('missing', {}), /unknown tool/);
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('mcp manager reports failed servers without throwing', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'opencursor-mcp-'));
  try {
    const manager = createMcpManager({
      good: { command: process.execPath, args: [writeFakeServer(dir)], timeout_ms: 5000 },
      bad: { command: 'definitely-not-a-real-binary-xyz', timeout_ms: 2000 },
      disabled: { command: process.execPath, enabled: false },
    });
    const infos = await manager.connectAll();
    assert.equal(infos.length, 2);
    const good = infos.find((info) => info.name === 'good');
    assert.ok(good);
    assert.equal(good.status, 'connected');
    assert.equal(good.tools.length, 2);
    const bad = infos.find((info) => info.name === 'bad');
    assert.ok(bad);
    assert.equal(bad.status, 'failed');
    assert.ok(bad.error && bad.error.length > 0);

    assert.equal(manager.servers().length, 2);

    const result = await manager.call('good', 'echo', { text: 'x' });
    assert.equal(result.content, 'echo:x');

    await assert.rejects(() => manager.call('bad', 'echo', {}), /not connected/);
    await assert.rejects(() => manager.call('nope', 'echo', {}), /unknown MCP server/);

    await manager.closeAll();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('mcp client times out unresponsive servers', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'opencursor-mcp-'));
  const silent = path.join(dir, 'silent.cjs');
  writeFileSync(silent, 'setInterval(() => {}, 1000);\n', 'utf8');
  const client = new McpClient('silent', { command: process.execPath, args: [silent], timeout_ms: 300 });
  try {
    await assert.rejects(() => client.connect(), /timed out after 300ms/);
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
