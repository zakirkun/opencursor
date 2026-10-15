/** Tool subsystem tests — filesystem, search, shell, todos, path safety. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createBuiltinRegistry } from '../src/tools/index.js';
import type { ToolContext } from '../src/types.js';
import type { TodoItem } from '../src/protocol/session.js';

const rgAvailable = spawnSync(process.env['OPENCURSOR_RIPGREP_PATH'] ?? 'rg', ['--version']).status === 0;

function tempWorkspace(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'opencursor-tools-'));
}

function makeCtx(cwd: string, overrides?: Partial<ToolContext>): ToolContext {
  return {
    cwd,
    session_id: 'test-session',
    signal: new AbortController().signal,
    ...overrides,
  };
}

function registry() {
  return createBuiltinRegistry();
}

function handler(name: Parameters<ReturnType<typeof registry>['get']>[0]) {
  const found = registry().get(name);
  assert.ok(found, `handler ${name} exists`);
  return found;
}

test('read_file returns content with line numbers and respects offset/limit', async () => {
  const cwd = tempWorkspace();
  try {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
    writeFileSync(path.join(cwd, 'sample.txt'), lines.join('\n'));
    const tool = handler('read_file');
    const full = await tool.execute({ path: 'sample.txt', include_line_numbers: true }, makeCtx(cwd));
    assert.equal(full.kind, 'success');
    if (full.kind !== 'success') return;
    assert.match(full.value.content, /1: line 1/);
    assert.equal(full.value.total_lines, 10);

    const sliced = await tool.execute({ path: 'sample.txt', offset: 5, limit: 2 }, makeCtx(cwd));
    assert.equal(sliced.kind, 'success');
    if (sliced.kind !== 'success') return;
    assert.equal(sliced.value.content, 'line 5\nline 6');
    assert.equal(sliced.value.truncated, true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('read_file rejects binary and missing files', async () => {
  const cwd = tempWorkspace();
  try {
    writeFileSync(path.join(cwd, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x00]));
    const tool = handler('read_file');
    const binary = await tool.execute({ path: 'bin.dat' }, makeCtx(cwd));
    assert.equal(binary.kind, 'error');

    const missing = await tool.execute({ path: 'nope.txt' }, makeCtx(cwd));
    assert.equal(missing.kind, 'error');
    if (missing.kind === 'error') assert.equal(missing.code, 'not_found');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('read_file rejects workspace escape', async () => {
  const cwd = tempWorkspace();
  try {
    const tool = handler('read_file');
    const outcome = await tool.execute({ path: '../../outside.txt' }, makeCtx(cwd));
    assert.equal(outcome.kind, 'error');
    if (outcome.kind === 'error') assert.equal(outcome.code, 'permission_denied');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('write_file creates directories and writes content', async () => {
  const cwd = tempWorkspace();
  try {
    const tool = handler('write_file');
    const outcome = await tool.execute({ path: 'nested/dir/file.txt', file_text: 'hello' }, makeCtx(cwd));
    assert.equal(outcome.kind, 'success');
    assert.equal(readFileSync(path.join(cwd, 'nested', 'dir', 'file.txt'), 'utf8'), 'hello');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('str_replace requires a unique match', async () => {
  const cwd = tempWorkspace();
  try {
    const file = path.join(cwd, 'code.ts');
    writeFileSync(file, 'const a = 1;\nconst b = 1;\n');
    const tool = handler('str_replace');

    const noMatch = await tool.execute({ path: 'code.ts', old_text: 'zzz', new_text: 'x' }, makeCtx(cwd));
    assert.equal(noMatch.kind, 'error');

    const ambiguous = await tool.execute({ path: 'code.ts', old_text: '= 1;', new_text: '= 2;' }, makeCtx(cwd));
    assert.equal(ambiguous.kind, 'error');
    if (ambiguous.kind === 'error') assert.match(ambiguous.message, /2 matches/);

    const unique = await tool.execute({ path: 'code.ts', old_text: 'const b = 1;', new_text: 'const b = 2;' }, makeCtx(cwd));
    assert.equal(unique.kind, 'success');
    assert.equal(readFileSync(file, 'utf8'), 'const a = 1;\nconst b = 2;\n');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('delete_file refuses directories', async () => {
  const cwd = tempWorkspace();
  try {
    mkdirSync(path.join(cwd, 'adir'));
    const tool = handler('delete_file');
    const outcome = await tool.execute({ path: 'adir' }, makeCtx(cwd));
    assert.equal(outcome.kind, 'error');
    if (outcome.kind === 'error') assert.equal(outcome.code, 'invalid_args');
    assert.equal(existsSync(path.join(cwd, 'adir')), true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('list_dir sorts directories first then files', async () => {
  const cwd = tempWorkspace();
  try {
    writeFileSync(path.join(cwd, 'zfile.txt'), 'z');
    writeFileSync(path.join(cwd, 'afile.txt'), 'a');
    mkdirSync(path.join(cwd, 'bdir'));
    const tool = handler('list_dir');
    const outcome = await tool.execute({ path: '.' }, makeCtx(cwd));
    assert.equal(outcome.kind, 'success');
    if (outcome.kind !== 'success') return;
    const names = outcome.value.entries.map((entry) => entry.name);
    assert.deepEqual(names, ['bdir', 'afile.txt', 'zfile.txt']);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('shell captures stdout and exit code', async () => {
  const cwd = tempWorkspace();
  try {
    const tool = handler('run_terminal_cmd');
    const outcome = await tool.execute({ command: 'echo opencursor-ok' }, makeCtx(cwd));
    assert.equal(outcome.kind, 'success');
    if (outcome.kind !== 'success') return;
    assert.match(outcome.value.stdout, /opencursor-ok/);
    assert.equal(outcome.value.exit_code, 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('shell reports non-zero exits as success with exit_code', async () => {
  const cwd = tempWorkspace();
  try {
    const tool = handler('run_terminal_cmd');
    const outcome = await tool.execute({ command: 'exit 3' }, makeCtx(cwd));
    assert.equal(outcome.kind, 'success');
    if (outcome.kind !== 'success') return;
    assert.equal(outcome.value.exit_code, 3);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('shell honors working_directory', async () => {
  const cwd = tempWorkspace();
  try {
    mkdirSync(path.join(cwd, 'sub'));
    writeFileSync(path.join(cwd, 'sub', 'marker.txt'), 'x');
    const tool = handler('run_terminal_cmd');
    const command = process.platform === 'win32' ? 'dir /b' : 'ls';
    const outcome = await tool.execute({ command, working_directory: 'sub' }, makeCtx(cwd));
    assert.equal(outcome.kind, 'success');
    if (outcome.kind !== 'success') return;
    assert.match(outcome.value.stdout, /marker\.txt/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('update_todos merge=false replaces, merge=true upserts', async () => {
  const cwd = tempWorkspace();
  try {
    let todos: TodoItem[] = [];
    const ctx = makeCtx(cwd, {
      todos: {
        get: () => todos,
        set: (next) => {
          todos = next;
        },
      },
    });
    const update = handler('update_todos');
    const first = await update.execute(
      { merge: false, todos: [{ id: 'a', content: 'one', status: 'pending' }] },
      ctx,
    );
    assert.equal(first.kind, 'success');
    assert.equal(todos.length, 1);

    const merged = await update.execute(
      { merge: true, todos: [{ id: 'a', content: 'one', status: 'completed' }] },
      ctx,
    );
    assert.equal(merged.kind, 'success');
    assert.equal(todos.length, 1);
    assert.equal(todos[0]?.status, 'completed');

    const replaced = await update.execute(
      { merge: false, todos: [{ id: 'b', content: 'two', status: 'in_progress' }] },
      ctx,
    );
    assert.equal(replaced.kind, 'success');
    assert.deepEqual(todos.map((todo) => todo.id), ['b']);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('read_todos errors without an attached store', async () => {
  const cwd = tempWorkspace();
  try {
    const outcome = await handler('read_todos').execute({}, makeCtx(cwd));
    assert.equal(outcome.kind, 'error');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('grep_search finds matches with context', { skip: !rgAvailable }, async () => {
  const cwd = tempWorkspace();
  try {
    writeFileSync(path.join(cwd, 'a.ts'), 'const alpha = 1;\nconst beta = 2;\nconst alpha2 = 3;\n');
    writeFileSync(path.join(cwd, 'b.txt'), 'no match here\n');
    const tool = handler('grep_search');
    const outcome = await tool.execute({ pattern: 'alpha', output_mode: 'content', context: 1 }, makeCtx(cwd));
    assert.equal(outcome.kind, 'success');
    if (outcome.kind !== 'success') return;
    assert.equal(outcome.value.total_matches, 2);
    const file = outcome.value.files.find((entry) => entry.path.includes('a.ts'));
    assert.ok(file);
    assert.ok(file.matches.length === 2);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('file_search glob matches expected files', { skip: !rgAvailable }, async () => {
  const cwd = tempWorkspace();
  try {
    writeFileSync(path.join(cwd, 'one.ts'), '');
    writeFileSync(path.join(cwd, 'two.py'), '');
    const outcome = await handler('file_search').execute({ glob_pattern: '**/*.ts' }, makeCtx(cwd));
    assert.equal(outcome.kind, 'success');
    if (outcome.kind !== 'success') return;
    assert.deepEqual(outcome.value.files, ['one.ts']);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('web_fetch converts local HTML to markdown', async () => {
  const cwd = tempWorkspace();
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<html><body><h1>Title</h1><p>Body <a href="https://x.test">link</a></p><script>bad()</script></body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const url = `http://127.0.0.1:${address.port}/`;
    const outcome = await handler('web_fetch').execute({ url }, makeCtx(cwd));
    assert.equal(outcome.kind, 'success');
    if (outcome.kind !== 'success') return;
    assert.match(outcome.value.markdown, /# Title/);
    assert.match(outcome.value.markdown, /\[link\]\(https:\/\/x\.test\)/);
    assert.doesNotMatch(outcome.value.markdown, /bad\(\)/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(cwd, { recursive: true, force: true });
  }
});

test('web_search errors clearly without OPENCURSOR_SEARCH_URL', async () => {
  const cwd = tempWorkspace();
  const saved = process.env['OPENCURSOR_SEARCH_URL'];
  delete process.env['OPENCURSOR_SEARCH_URL'];
  try {
    const outcome = await handler('web_search').execute({ search_term: 'x' }, makeCtx(cwd));
    assert.equal(outcome.kind, 'error');
    if (outcome.kind === 'error') assert.match(outcome.message, /OPENCURSOR_SEARCH_URL/);
  } finally {
    if (saved !== undefined) process.env['OPENCURSOR_SEARCH_URL'] = saved;
    await rm(cwd, { recursive: true, force: true });
  }
});

test('task errors without subagent runner and with unknown profile', async () => {
  const cwd = tempWorkspace();
  try {
    const noRunner = await handler('task').execute(
      { description: 'x', prompt: 'y', subagent_type: 'explore' },
      makeCtx(cwd),
    );
    assert.equal(noRunner.kind, 'error');

    const withRunner = await handler('task').execute(
      { description: 'x', prompt: 'y', subagent_type: 'nope' },
      makeCtx(cwd, {
        subagents: { run: async () => ({ kind: 'success', value: { summary: 's', subagent_type: 'nope' } }) },
        subagent_profiles: { explore: { name: 'explore', description: '', system_prompt: '', tools: [] } },
      }),
    );
    assert.equal(withRunner.kind, 'error');
    if (withRunner.kind === 'error') assert.match(withRunner.message, /unknown subagent_type/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('ask_question requires interactive surface and validates shape', async () => {
  const cwd = tempWorkspace();
  try {
    const bare = await handler('ask_question').execute({ title: 't', questions: [{ question: 'q' }] }, makeCtx(cwd));
    assert.equal(bare.kind, 'error');

    const wired = await handler('ask_question').execute(
      { title: 't', questions: [{ question: 'q', options: [{ label: 'a' }] }] },
      makeCtx(cwd, { askUser: async (questions) => questions.map((q) => ({ question: q.question, answers: ['a'] })) }),
    );
    assert.equal(wired.kind, 'success');
    if (wired.kind !== 'success') return;
    assert.deepEqual(wired.value.answers[0]?.answers, ['a']);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
