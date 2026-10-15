/** Homebase + SQLite + memory store tests. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveHomebase, ensureHomebase, loadConfig, saveConfig, DEFAULT_CONFIG } from '../src/homebase.js';
import { openDatabase, closeDatabase } from '../src/db/open.js';
import { createMemoryStore } from '../src/memory/store.js';
import { createSqliteSessionStore } from '../src/session/sqlite.js';
import { memoryTool } from '../src/tools/memory.js';
import type { SessionState } from '../src/protocol/session.js';
import type { ToolContext } from '../src/types.js';

function tempHome() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'opencursor-home-'));
  const home = resolveHomebase(root);
  ensureHomebase(home);
  return home;
}

test('resolveHomebase derives all paths from root', () => {
  const home = resolveHomebase('C:/x/y');
  assert.equal(home.config_path, path.join('C:/x/y', 'config.json'));
  assert.equal(home.db_path, path.join('C:/x/y', 'opencursor.db'));
  assert.equal(home.memory_json_path, path.join('C:/x/y', 'memory.json'));
  assert.equal(home.memory_md_path, path.join('C:/x/y', 'MEMORY.md'));
});

test('loadConfig creates defaults on first run and round-trips edits', async () => {
  const home = tempHome();
  try {
    const first = loadConfig(home);
    assert.equal(first.created, true);
    assert.deepEqual(first.config, DEFAULT_CONFIG);
    assert.equal(existsSync(home.config_path), true);

    const edited = { ...first.config, provider: 'openai' as const, max_iterations: 7 };
    saveConfig(home, edited);
    const second = loadConfig(home);
    assert.equal(second.created, false);
    assert.equal(second.config.provider, 'openai');
    assert.equal(second.config.max_iterations, 7);
    assert.equal(second.config.memory.auto_summarize, true);
  } finally {
    await rm(home.root, { recursive: true, force: true });
  }
});

test('loadConfig repairs corrupt config with defaults', async () => {
  const home = tempHome();
  try {
    writeFileSync(home.config_path, '{not json', 'utf8');
    const { config, created } = loadConfig(home);
    assert.equal(created, true);
    assert.equal(config.permission_mode, 'ask');
  } finally {
    await rm(home.root, { recursive: true, force: true });
  }
});

test('memory store add writes sqlite + json + markdown mirrors', async () => {
  const home = tempHome();
  const db = openDatabase(home.db_path);
  try {
    const memory = createMemoryStore(db, home);
    const entry = memory.add({ text: 'prefers pnpm over npm', kind: 'preference', tags: ['tooling'], source: 'test' });
    assert.equal(memory.count(), 1);

    const json = JSON.parse(readFileSync(home.memory_json_path, 'utf8')) as { entries: Array<{ id: string }> };
    assert.equal(json.entries.length, 1);
    assert.equal(json.entries[0]?.id, entry.id);

    const markdown = readFileSync(home.memory_md_path, 'utf8');
    assert.match(markdown, /## preference/);
    assert.match(markdown, /prefers pnpm over npm/);
  } finally {
    closeDatabase(db);
    await rm(home.root, { recursive: true, force: true });
  }
});

test('memory search matches text via FTS and filters by kind and tags', async () => {
  const home = tempHome();
  const db = openDatabase(home.db_path);
  try {
    const memory = createMemoryStore(db, home);
    memory.add({ text: 'the build uses turbo with remote cache', kind: 'fact', tags: ['build'], source: 'test' });
    memory.add({ text: 'user dislikes verbose commit messages', kind: 'preference', tags: ['git'], source: 'test' });

    const byQuery = memory.search({ query: 'turbo cache' });
    assert.equal(byQuery.length, 1);
    assert.match(byQuery[0]?.text ?? '', /turbo/);

    const byKind = memory.search({ query: 'commit', kind: 'preference' });
    assert.equal(byKind.length, 1);

    const byTag = memory.search({ query: 'build', tags: ['build'] });
    assert.equal(byTag.length, 1);

    const noMatch = memory.search({ query: 'zzz-nonexistent', kind: 'decision' });
    assert.equal(noMatch.length, 0);
  } finally {
    closeDatabase(db);
    await rm(home.root, { recursive: true, force: true });
  }
});

test('memory forget removes entry and updates mirrors', async () => {
  const home = tempHome();
  const db = openDatabase(home.db_path);
  try {
    const memory = createMemoryStore(db, home);
    const entry = memory.add({ text: 'temporary note', kind: 'note', source: 'test' });
    assert.equal(memory.forget(entry.id), true);
    assert.equal(memory.forget(entry.id), false);
    assert.equal(memory.count(), 0);
    const json = JSON.parse(readFileSync(home.memory_json_path, 'utf8')) as { entries: unknown[] };
    assert.equal(json.entries.length, 0);
  } finally {
    closeDatabase(db);
    await rm(home.root, { recursive: true, force: true });
  }
});

test('memory digest respects maxChars and skips notes', async () => {
  const home = tempHome();
  const db = openDatabase(home.db_path);
  try {
    const memory = createMemoryStore(db, home);
    memory.add({ text: 'important decision: use node:sqlite', kind: 'decision', source: 'test' });
    memory.add({ text: 'scratch note that should not appear', kind: 'note', source: 'test' });
    const digest = memory.digest(10_000);
    assert.match(digest, /node:sqlite/);
    assert.doesNotMatch(digest, /scratch note/);

    const tiny = memory.digest(10);
    assert.equal(tiny, '');
  } finally {
    closeDatabase(db);
    await rm(home.root, { recursive: true, force: true });
  }
});

test('memory tool add/search/list/forget through ToolContext', async () => {
  const home = tempHome();
  const db = openDatabase(home.db_path);
  try {
    const memory = createMemoryStore(db, home);
    const ctx: ToolContext = {
      cwd: home.root,
      session_id: 'sess-1',
      signal: new AbortController().signal,
      memory,
    };

    const added = await memoryTool.execute(
      { operation: 'add', text: 'project uses ESM with NodeNext', kind: 'fact', tags: ['node'] },
      ctx,
    );
    assert.equal(added.kind, 'success');

    const searched = await memoryTool.execute({ operation: 'search', query: 'ESM NodeNext' }, ctx);
    assert.equal(searched.kind, 'success');
    if (searched.kind !== 'success') return;
    assert.equal(searched.value.entries.length, 1);

    const listed = await memoryTool.execute({ operation: 'list', limit: 5 }, ctx);
    assert.equal(listed.kind, 'success');
    if (listed.kind !== 'success') return;
    assert.equal(listed.value.entries.length, 1);

    const id = searched.value.entries[0]?.id ?? '';
    const forgotten = await memoryTool.execute({ operation: 'forget', id }, ctx);
    assert.equal(forgotten.kind, 'success');

    const missing = await memoryTool.execute({ operation: 'forget', id: 'nope' }, ctx);
    assert.equal(missing.kind, 'error');

    const badKind = await memoryTool.execute({ operation: 'add', text: 'x', kind: 'bogus' as never }, ctx);
    assert.equal(badKind.kind, 'error');
  } finally {
    closeDatabase(db);
    await rm(home.root, { recursive: true, force: true });
  }
});

test('memory tool errors without a memory store', async () => {
  const ctx: ToolContext = { cwd: '.', session_id: 's', signal: new AbortController().signal };
  const outcome = await memoryTool.execute({ operation: 'list' }, ctx);
  assert.equal(outcome.kind, 'error');
});

test('sqlite session store round-trips state, todos, and ops', async () => {
  const home = tempHome();
  const db = openDatabase(home.db_path);
  try {
    const store = createSqliteSessionStore(db);
    const state: SessionState = {
      version: 1,
      id: 'sess-a',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      cwd: home.root,
      model: { provider: 'openai', id: 'gpt-test' },
      messages: [
        { role: 'user', text: 'hello', timestamp: '2026-01-01T00:00:01.000Z' },
        {
          role: 'assistant',
          text: 'hi',
          tool_calls: [],
          timestamp: '2026-01-01T00:00:02.000Z',
        },
      ],
      todos: [{ id: 't1', content: 'do it', status: 'pending' }],
      usage: { input_tokens: 3, output_tokens: 4 },
    };
    await store.save(state);
    await store.appendOp('sess-a', { ts: '2026-01-01T00:00:03.000Z', event: { type: 'notice', message: 'x' } });

    const loaded = await store.load('sess-a');
    assert.ok(loaded);
    assert.equal(loaded.messages.length, 2);
    assert.equal(loaded.todos.length, 1);
    assert.deepEqual(loaded.usage, { input_tokens: 3, output_tokens: 4 });
    assert.equal(loaded.model.provider, 'openai');

    assert.equal(await store.latestId(), 'sess-a');
    const listing = await store.list();
    assert.equal(listing[0]?.message_count, 2);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = { ...state, id: 'sess-b', updated_at: '2026-01-01T00:00:00.000Z' };
    await store.save(second);
    assert.equal(await store.latestId(), 'sess-b');

    assert.equal(await store.load('missing'), null);
  } finally {
    closeDatabase(db);
    await rm(home.root, { recursive: true, force: true });
  }
});
