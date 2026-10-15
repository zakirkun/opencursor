/** Semantic index tests — chunker, embeddings, store, indexer, search. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, closeDatabase } from '../src/db/open.js';
import { chunkFile } from '../src/index/chunker.js';
import { LocalHashingEmbeddings, cosineSimilarity } from '../src/index/embeddings.js';
import { createIndexStore } from '../src/index/store.js';
import { createIndexer } from '../src/index/indexer.js';
import { indexTool } from '../src/tools/semantic_index.js';
import type { ToolContext } from '../src/types.js';

test('chunker splits long files with overlap and respects max chars', () => {
  const lines = Array.from({ length: 150 }, (_, i) => `line ${i + 1} of the file`);
  const chunks = chunkFile(lines.join('\n'), { max_lines: 60, overlap_lines: 10 });
  assert.ok(chunks.length >= 3, `expected >=3 chunks, got ${chunks.length}`);
  assert.equal(chunks[0]?.start_line, 1);
  assert.equal(chunks[0]?.end_line, 60);
  assert.equal(chunks[1]?.start_line, 51);
  const last = chunks[chunks.length - 1];
  assert.equal(last?.end_line, 150);

  const tiny = chunkFile('a\nb\nc', { max_lines: 100 });
  assert.equal(tiny.length, 1);
  assert.equal(tiny[0]?.text, 'a\nb\nc');

  const empty = chunkFile('   \n  ');
  assert.equal(empty.length, 0);

  const capped = chunkFile(Array.from({ length: 200 }, () => 'x'.repeat(80)).join('\n'), { max_lines: 60, max_chars: 500 });
  for (const chunk of capped) {
    assert.ok(chunk.text.length <= 500, `chunk exceeds max_chars: ${chunk.text.length}`);
  }
});

test('local hashing embeddings are deterministic, normalized, and semantic-ish', async () => {
  const provider = new LocalHashingEmbeddings(256);
  const [a, b, c] = await provider.embed([
    'parse the config file for settings',
    'parse the config file for options',
    'unrelated zzz qqq',
  ]);
  assert.ok(a && b && c);
  assert.equal(a.length, 256);

  const again = await provider.embed(['parse the config file for settings']);
  assert.deepEqual(Array.from(a), Array.from(again[0] ?? new Float32Array()));

  const norm = Math.sqrt(Array.from(a).reduce((sum, value) => sum + value * value, 0));
  assert.ok(Math.abs(norm - 1) < 0.001, `expected unit norm, got ${norm}`);

  const self = cosineSimilarity(a, a);
  assert.ok(Math.abs(self - 1) < 0.001, `self-similarity should be 1, got ${self}`);

  const related = cosineSimilarity(a, b);
  const unrelated = cosineSimilarity(a, c);
  assert.ok(related > 0.5, `shared-token texts should score high, got ${related}`);
  assert.ok(related > unrelated, `expected related (${related}) > unrelated (${unrelated})`);
});

test('index store persists files and chunks with embeddings', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'opencursor-index-'));
  const db = openDatabase(path.join(dir, 'index.db'));
  try {
    const store = createIndexStore(db);
    const embedding = Float32Array.from([0.1, 0.2, 0.3]);
    store.upsertFile(
      { path: 'a.ts', sha256: 'abc', mtime_ms: 1, size: 10, chunk_count: 1 },
      [{ start_line: 1, end_line: 3, text: 'const a = 1;', embedding }],
    );
    const file = store.getFile('a.ts');
    assert.ok(file);
    assert.equal(file.sha256, 'abc');

    const chunks = store.loadChunks();
    assert.equal(chunks.length, 1);
    const loaded = chunks[0]?.embedding ?? new Float32Array();
    assert.ok(Math.abs((loaded[0] ?? 0) - 0.1) < 0.0001);

    const forFile = store.loadChunksForFile('a.ts');
    assert.equal(forFile.length, 1);

    const stats = store.stats();
    assert.deepEqual(stats, { files: 1, chunks: 1 });

    store.removeFile('a.ts');
    assert.equal(store.getFile('a.ts'), null);
    assert.deepEqual(store.stats(), { files: 0, chunks: 0 });

    store.upsertFile(
      { path: 'b.ts', sha256: 'def', mtime_ms: 2, size: 20, chunk_count: 1 },
      [{ start_line: 1, end_line: 1, text: 'b', embedding }],
    );
    store.clear();
    assert.deepEqual(store.stats(), { files: 0, chunks: 0 });
  } finally {
    closeDatabase(db);
    await rm(dir, { recursive: true, force: true });
  }
});

test('indexer scans workspace, indexes files, skips unchanged, removes deleted', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'opencursor-idx-'));
  const db = openDatabase(path.join(dir, 'index.db'));
  try {
    mkdirSync(path.join(dir, 'src'));
    writeFileSync(path.join(dir, 'src', 'parser.ts'), 'export function parseConfig(input: string) { return JSON.parse(input); }\n');
    writeFileSync(path.join(dir, 'src', 'util.ts'), 'export const add = (a: number, b: number) => a + b;\n');
    writeFileSync(path.join(dir, 'README.md'), '# Project\nConfig parsing utilities.\n');

    const store = createIndexStore(db);
    const embeddings = new LocalHashingEmbeddings(256);
    const indexer = createIndexer({ cwd: dir, store, embeddings });

    const first = await indexer.run();
    assert.equal(first.indexed, 3);
    assert.ok(first.chunks >= 3);
    assert.deepEqual(indexer.stats(), { files: 3, chunks: first.chunks });

    const second = await indexer.run();
    assert.equal(second.indexed, 0);
    assert.equal(second.skipped, 3);

    writeFileSync(path.join(dir, 'src', 'util.ts'), 'export const multiply = (a: number, b: number) => a * b;\n');
    const third = await indexer.run();
    assert.equal(third.indexed, 1);

    await rm(path.join(dir, 'src', 'parser.ts'));
    const fourth = await indexer.run();
    assert.equal(fourth.removed, 1);
    assert.equal(indexer.stats().files, 2);

    const hits = await indexer.search('parse config json', 5);
    assert.ok(hits.length > 0);
    assert.ok(hits[0]!.score > 0);

    indexer.clear();
    assert.deepEqual(indexer.stats(), { files: 0, chunks: 0 });
  } finally {
    closeDatabase(db);
    await rm(dir, { recursive: true, force: true });
  }
});

test('index tool validates and operates through ToolContext', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'opencursor-idxtool-'));
  const db = openDatabase(path.join(dir, 'index.db'));
  try {
    writeFileSync(path.join(dir, 'main.ts'), 'export const hello = "world";\n');
    const store = createIndexStore(db);
    const indexer = createIndexer({ cwd: dir, store, embeddings: new LocalHashingEmbeddings(128) });

    const bare: ToolContext = { cwd: dir, session_id: 's', signal: new AbortController().signal };
    const noIndexer = await indexTool.execute({ operation: 'status' }, bare);
    assert.equal(noIndexer.kind, 'error');

    const ctx: ToolContext = { ...bare, indexer };
    const empty = await indexTool.execute({ operation: 'status' }, ctx);
    assert.equal(empty.kind, 'success');
    if (empty.kind === 'success') assert.equal(empty.value.files, 0);

    const ran = await indexTool.execute({ operation: 'run' }, ctx);
    assert.equal(ran.kind, 'success');
    if (ran.kind === 'success') {
      assert.equal(ran.value.files, 1);
      assert.ok(ran.value.chunks >= 1);
    }

    const status = await indexTool.execute({ operation: 'status' }, ctx);
    assert.equal(status.kind, 'success');
    if (status.kind === 'success') assert.equal(status.value.files, 1);

    const cleared = await indexTool.execute({ operation: 'clear' }, ctx);
    assert.equal(cleared.kind, 'success');
    if (cleared.kind === 'success') assert.equal(cleared.value.files, 0);

    const invalid = await indexTool.execute({ operation: 'bogus' as never }, ctx);
    assert.equal(invalid.kind, 'error');
  } finally {
    closeDatabase(db);
    await rm(dir, { recursive: true, force: true });
  }
});

test('codebase_search uses the semantic index when populated', async () => {
  const { codebaseSearchTool } = await import('../src/tools/codebase_search.js');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'opencursor-semsearch-'));
  const db = openDatabase(path.join(dir, 'index.db'));
  try {
    writeFileSync(
      path.join(dir, 'auth.ts'),
      'export function validateCredentials(username: string, password: string) {\n  return checkPasswordHash(username, password);\n}\n',
    );
    writeFileSync(path.join(dir, 'colors.ts'), 'export const palette = { red: "#ff0000", blue: "#0000ff" };\n');

    const store = createIndexStore(db);
    const indexer = createIndexer({ cwd: dir, store, embeddings: new LocalHashingEmbeddings(256) });
    await indexer.run();

    const ctx: ToolContext = { cwd: dir, session_id: 's', signal: new AbortController().signal, indexer };
    const outcome = await codebaseSearchTool.execute({ query: 'password validation credentials' }, ctx);
    assert.equal(outcome.kind, 'success');
    if (outcome.kind !== 'success') return;
    assert.ok(outcome.value.results.length > 0);
    assert.equal(outcome.value.results[0]?.path, 'auth.ts');
    assert.ok((outcome.value.results[0]?.score ?? 0) > 0);
  } finally {
    closeDatabase(db);
    await rm(dir, { recursive: true, force: true });
  }
});
