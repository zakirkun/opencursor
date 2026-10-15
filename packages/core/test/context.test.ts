/** Checkpoints, archives, shell registry, compaction and undo tests. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, closeDatabase } from '../src/db/open.js';
import { createCheckpointStore } from '../src/session/checkpoints.js';
import { createArchiveStore } from '../src/session/archives.js';
import { createShellRegistry } from '../src/shells/registry.js';
import { createAgentRuntime } from '../src/runtime/runtime.js';
import { createMemorySessionStore } from '../src/session/memory.js';
import { createPermissionPolicy } from '../src/permissions/policy.js';
import { createRegistry } from '../src/tools/index.js';
import { writeShellStdinTool, readShellOutputTool } from '../src/tools/shell_stdin.js';
import type { AnyToolHandler, ToolContext } from '../src/types.js';
import type { ModelClient, ModelRequest, ModelStreamEvent } from '../src/protocol/models.js';
import type { AgentEvent } from '../src/protocol/events.js';
import type { SessionState } from '../src/protocol/session.js';
import { ok } from '../src/protocol/tools.js';

function tempDb() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'opencursor-ctx-'));
  const db = openDatabase(path.join(dir, 'test.db'));
  return { dir, db };
}

test('checkpoint store captures, lists, gets, and prunes', async () => {
  const { dir, db } = tempDb();
  try {
    const store = createCheckpointStore(db);
    const first = store.capture({
      session_id: 's1',
      tool: 'write_file',
      path: 'a.txt',
      existed: true,
      content: Buffer.from('old a'),
    });
    const second = store.capture({
      session_id: 's1',
      tool: 'delete_file',
      path: 'b.txt',
      existed: false,
      content: null,
    });

    const listed = store.list('s1');
    assert.equal(listed.length, 2);
    assert.equal(listed[0]?.id, second.id);

    const record = store.get(first.id);
    assert.ok(record);
    assert.equal(record.content?.toString('utf8'), 'old a');
    assert.equal(record.existed, true);

    store.prune('s1', 1);
    assert.equal(store.list('s1').length, 1);
    assert.equal(store.list('s1')[0]?.id, second.id);

    store.clearSession('s1');
    assert.equal(store.list('s1').length, 0);
  } finally {
    closeDatabase(db);
    await rm(dir, { recursive: true, force: true });
  }
});

test('archive store round-trips message history', async () => {
  const { dir, db } = tempDb();
  try {
    const store = createArchiveStore(db);
    const messages: SessionState['messages'] = [
      { role: 'user', text: 'one', timestamp: 't1' },
      { role: 'assistant', text: 'two', tool_calls: [], timestamp: 't2' },
    ];
    const info = store.archive('s1', messages);
    assert.equal(info.message_count, 2);

    const listing = store.list('s1');
    assert.equal(listing.length, 1);
    assert.equal(listing[0]?.message_count, 2);

    const loaded = store.get(info.id);
    assert.ok(loaded);
    assert.equal(loaded.messages.length, 2);
    assert.equal(loaded.messages[0]?.role, 'user');

    store.clearSession('s1');
    assert.equal(store.list('s1').length, 0);
  } finally {
    closeDatabase(db);
    await rm(dir, { recursive: true, force: true });
  }
});

test('shell registry runs background commands with stdin and buffered output', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'opencursor-shell-'));
  const registry = createShellRegistry();
  try {
    const echoCommand = process.platform === 'win32' ? 'echo hello-registry' : 'echo hello-registry';
    const info = registry.start({ command: echoCommand, cwd: dir });
    assert.equal(info.running, true);
    assert.equal(registry.list().length, 1);

    await new Promise((resolve) => setTimeout(resolve, 800));
    const snapshot = registry.read(info.shell_id);
    assert.match(snapshot.stdout, /hello-registry/);
    assert.equal(snapshot.running, false);
    assert.equal(snapshot.exit_code, 0);

    const drained = registry.read(info.shell_id, true);
    assert.match(drained.stdout, /hello-registry/);
    const after = registry.read(info.shell_id);
    assert.equal(after.stdout, '');

    assert.equal(registry.kill(info.shell_id), true);
    assert.equal(registry.kill('missing'), false);
  } finally {
    registry.killAll();
    await rm(dir, { recursive: true, force: true });
  }
});

test('shell registry write stdin drives an interactive process', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'opencursor-shell-'));
  const registry = createShellRegistry();
  try {
    const script = path.join(dir, 'reader.cjs');
    writeFileSync(
      script,
      'let data = ""; process.stdin.on("data", (c) => { data += c; }); process.stdin.on("end", () => { console.log("got:" + data.trim()); });\n',
      'utf8',
    );
    const info = registry.start({ command: `"${process.execPath}" "${script}"`, cwd: dir });
    const written = registry.write(info.shell_id, 'ping\n', true);
    assert.equal(written.closed, true);
    assert.ok(written.bytes_written > 0);

    await new Promise((resolve) => setTimeout(resolve, 900));
    const snapshot = registry.read(info.shell_id);
    assert.match(snapshot.stdout, /got:ping/);
  } finally {
    registry.killAll();
    await rm(dir, { recursive: true, force: true });
  }
});

test('write_shell_stdin and read_shell_output tools validate and operate', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'opencursor-shell-'));
  const registry = createShellRegistry();
  try {
    const bare: ToolContext = { cwd: dir, session_id: 's', signal: new AbortController().signal };
    const noRegistry = await writeShellStdinTool.execute({ shell_id: 'x' }, bare);
    assert.equal(noRegistry.kind, 'error');

    const ctx: ToolContext = { ...bare, shells: registry };
    const unknown = await writeShellStdinTool.execute({ shell_id: 'nope', data: 'x' }, ctx);
    assert.equal(unknown.kind, 'error');
    if (unknown.kind === 'error') assert.equal(unknown.code, 'not_found');

    const missingId = await readShellOutputTool.execute({ shell_id: '' }, ctx);
    assert.equal(missingId.kind, 'error');

    const info = registry.start({ command: 'echo tool-check', cwd: dir });
    await new Promise((resolve) => setTimeout(resolve, 700));
    const read = await readShellOutputTool.execute({ shell_id: info.shell_id, drain: true }, ctx);
    assert.equal(read.kind, 'success');
    if (read.kind === 'success') {
      assert.match(read.value.stdout, /tool-check/);
      assert.equal(read.value.running, false);
    }
  } finally {
    registry.killAll();
    await rm(dir, { recursive: true, force: true });
  }
});

interface ScriptStep {
  toolCalls?: Array<{ id: string; name: string; args: unknown }>;
  text?: string;
  stop: 'end_turn' | 'tool_use';
}

class ScriptedModel implements ModelClient {
  readonly provider = 'mock' as const;
  readonly id = 'scripted';
  constructor(private readonly steps: ScriptStep[]) {}
  async *generate(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const step = this.steps.shift();
    if (!step) {
      yield { type: 'stop', reason: 'end_turn' };
      return;
    }
    if (step.text) yield { type: 'text-delta', text: step.text };
    for (const call of step.toolCalls ?? []) {
      yield { type: 'tool-call', call: { ...call, args_raw: JSON.stringify(call.args) } };
    }
    yield { type: 'stop', reason: step.stop };
  }
}

function writingTool(): AnyToolHandler {
  return {
    name: 'write_file',
    description: 'fake writer',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, file_text: { type: 'string' } }, additionalProperties: true },
    default_permission: 'allow',
    async execute(args: { path: string; file_text?: string }) {
      return ok({ path: args.path, bytes_written: 1 });
    },
  } as AnyToolHandler;
}

async function drainEvents(runtime: { events(): AsyncIterable<AgentEvent> }): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  void (async () => {
    for await (const event of runtime.events()) events.push(event);
  })();
  return events;
}

test('runtime checkpoints before mutations and undo restores file content', async () => {
  const { dir, db } = tempDb();
  try {
    const filePath = path.join(dir, 'target.txt');
    writeFileSync(filePath, 'original content', 'utf8');

    const checkpoints = createCheckpointStore(db);
    const model = new ScriptedModel([
      { toolCalls: [{ id: 'c1', name: 'write_file', args: { path: 'target.txt', file_text: 'new' } }], stop: 'tool_use' },
      { text: 'done', stop: 'end_turn' },
    ]);
    const runtime = await createAgentRuntime({
      cwd: dir,
      model_client: model,
      tools: createRegistry([writingTool()]),
      store: createMemorySessionStore(),
      permissions: createPermissionPolicy({ mode: 'yolo' }),
      checkpoints,
    });
    const events = await drainEvents(runtime);
    await runtime.runTurn('edit it');
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.ok(events.some((event) => event.type === 'checkpoint-created'));
    assert.equal(runtime.checkpoints().length, 1);

    writeFileSync(filePath, 'modified by tool', 'utf8');
    const restored = await runtime.undo();
    assert.deepEqual(restored, ['target.txt']);
    assert.equal(readFileSync(filePath, 'utf8'), 'original content');
    assert.equal(runtime.checkpoints().length, 0);
  } finally {
    closeDatabase(db);
    await rm(dir, { recursive: true, force: true });
  }
});

test('runtime undo removes files that were newly created', async () => {
  const { dir, db } = tempDb();
  try {
    const checkpoints = createCheckpointStore(db);
    const model = new ScriptedModel([
      { toolCalls: [{ id: 'c1', name: 'write_file', args: { path: 'brand-new.txt', file_text: 'x' } }], stop: 'tool_use' },
      { text: 'done', stop: 'end_turn' },
    ]);
    const runtime = await createAgentRuntime({
      cwd: dir,
      model_client: model,
      tools: createRegistry([writingTool()]),
      store: createMemorySessionStore(),
      permissions: createPermissionPolicy({ mode: 'yolo' }),
      checkpoints,
    });
    await runtime.runTurn('create it');
    await new Promise((resolve) => setTimeout(resolve, 50));
    writeFileSync(path.join(dir, 'brand-new.txt'), 'created', 'utf8');

    const restored = await runtime.undo();
    assert.deepEqual(restored, ['brand-new.txt']);
    assert.equal(existsSync(path.join(dir, 'brand-new.txt')), false);
  } finally {
    closeDatabase(db);
    await rm(dir, { recursive: true, force: true });
  }
});

test('runtime compact archives messages and keeps a summary', async () => {
  const { dir, db } = tempDb();
  try {
    const archives = createArchiveStore(db);
    const model = new ScriptedModel([
      { text: 'one', stop: 'end_turn' },
      { text: 'two', stop: 'end_turn' },
      { text: 'three', stop: 'end_turn' },
    ]);
    const runtime = await createAgentRuntime({
      cwd: dir,
      model_client: model,
      tools: createRegistry([]),
      store: createMemorySessionStore(),
      permissions: createPermissionPolicy({ mode: 'yolo' }),
      archives,
      context_options: { keep_recent: 2, max_chars: 6000 },
    });
    const events = await drainEvents(runtime);
    await runtime.runTurn('first');
    await runtime.runTurn('second');
    await runtime.runTurn('third');
    await new Promise((resolve) => setTimeout(resolve, 50));

    const before = runtime.state();
    assert.equal(before.messages.length, 6);

    const result = await runtime.compact();
    assert.equal(result.archived_messages, 4);
    assert.ok(result.summary_chars > 0);

    const after = runtime.state();
    assert.equal(after.messages.length, 2);
    assert.ok(after.summary);
    assert.equal(after.summary?.archived_message_count, 4);
    assert.match(after.summary?.text ?? '', /user: first/);

    const archived = archives.list(runtime.session_id);
    assert.equal(archived.length, 1);
    assert.equal(archived[0]?.message_count, 4);

    assert.ok(events.some((event) => event.type === 'compacted'));
  } finally {
    closeDatabase(db);
    await rm(dir, { recursive: true, force: true });
  }
});

test('runtime compact is a no-op with few messages', async () => {
  const { dir, db } = tempDb();
  try {
    const runtime = await createAgentRuntime({
      cwd: dir,
      model_client: new ScriptedModel([{ text: 'only', stop: 'end_turn' }]),
      tools: createRegistry([]),
      store: createMemorySessionStore(),
      permissions: createPermissionPolicy({ mode: 'yolo' }),
      archives: createArchiveStore(db),
      context_options: { keep_recent: 6 },
    });
    await runtime.runTurn('solo');
    const result = await runtime.compact();
    assert.equal(result.archived_messages, 0);
  } finally {
    closeDatabase(db);
    await rm(dir, { recursive: true, force: true });
  }
});

test('summary persists across session reload', async () => {
  const { dir, db } = tempDb();
  try {
    const { createSqliteSessionStore } = await import('../src/session/sqlite.js');
    const store = createSqliteSessionStore(db);
    const archives = createArchiveStore(db);
    const model = new ScriptedModel([
      { text: 'a', stop: 'end_turn' },
      { text: 'b', stop: 'end_turn' },
      { text: 'c', stop: 'end_turn' },
    ]);
    const runtime = await createAgentRuntime({
      cwd: dir,
      model_client: model,
      tools: createRegistry([]),
      store,
      permissions: createPermissionPolicy({ mode: 'yolo' }),
      archives,
      context_options: { keep_recent: 2 },
    });
    await runtime.runTurn('one');
    await runtime.runTurn('two');
    await runtime.runTurn('three');
    await runtime.compact();

    const reloaded = await store.load(runtime.session_id);
    assert.ok(reloaded);
    assert.ok(reloaded.summary);
    assert.ok((reloaded.summary?.text.length ?? 0) > 0);
    assert.equal(reloaded.messages.length, 2);
  } finally {
    closeDatabase(db);
    await rm(dir, { recursive: true, force: true });
  }
});
