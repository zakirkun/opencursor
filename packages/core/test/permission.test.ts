/** Permission policy tests — hard denies, safe allows, rule persistence. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPermissionPolicy } from '../src/permissions/policy.js';

test('hard-denies destructive commands even in yolo mode', () => {
  const policy = createPermissionPolicy({ mode: 'yolo' });
  assert.equal(policy.precheck({ tool: 'run_terminal_cmd', args: { command: 'rm -rf /' }, cwd: '.' }), 'deny');
  assert.equal(policy.precheck({ tool: 'run_terminal_cmd', args: { command: 'shutdown now' }, cwd: '.' }), 'deny');
});

test('safe commands and read family are allowed without asking', () => {
  const policy = createPermissionPolicy({ mode: 'ask' });
  assert.equal(policy.precheck({ tool: 'run_terminal_cmd', args: { command: 'git status' }, cwd: '.' }), 'allow');
  assert.equal(policy.precheck({ tool: 'run_terminal_cmd', args: { command: 'ls -la' }, cwd: '.' }), 'allow');
  assert.equal(policy.precheck({ tool: 'read_file', args: { path: 'a.ts' }, cwd: '.' }), 'allow');
  assert.equal(policy.precheck({ tool: 'grep_search', args: { pattern: 'x' }, cwd: '.' }), 'allow');
});

test('unknown mutating commands ask by default', () => {
  const policy = createPermissionPolicy({ mode: 'ask' });
  assert.equal(policy.precheck({ tool: 'run_terminal_cmd', args: { command: 'npm install left-pad' }, cwd: '.' }), 'ask');
  assert.equal(policy.precheck({ tool: 'write_file', args: { path: 'x.ts' }, cwd: '.' }), 'ask');
  assert.equal(policy.precheck({ tool: 'web_fetch', args: { url: 'https://example.com' }, cwd: '.' }), 'ask');
});

test('allow_always records a command prefix and skips later asks', () => {
  const policy = createPermissionPolicy({ mode: 'ask' });
  policy.record('run_terminal_cmd', { command: 'npm install left-pad' }, 'allow_always');
  assert.equal(policy.precheck({ tool: 'run_terminal_cmd', args: { command: 'npm install other' }, cwd: '.' }), 'allow');
  assert.equal(policy.precheck({ tool: 'run_terminal_cmd', args: { command: 'rm -rf /' }, cwd: '.' }), 'deny');
});

test('allow_always for file writes records the directory', () => {
  const policy = createPermissionPolicy({ mode: 'ask' });
  policy.record('write_file', { path: 'src/deep/file.ts' }, 'allow_always');
  const rules = policy.rules();
  assert.ok(rules.some((rule) => rule.tool === 'write_file' && rule.pattern === 'src/deep'));
  assert.equal(policy.precheck({ tool: 'write_file', args: { path: 'src/deep/other.ts' }, cwd: '.' }), 'allow');
  assert.equal(policy.precheck({ tool: 'write_file', args: { path: 'elsewhere/file.ts' }, cwd: '.' }), 'ask');
});

test('rules persist across policy instances', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'opencursor-perm-'));
  const persistPath = path.join(dir, 'rules.json');
  try {
    const first = createPermissionPolicy({ persist_path: persistPath });
    first.record('run_terminal_cmd', { command: 'cargo build' }, 'allow_always');

    const second = createPermissionPolicy({ persist_path: persistPath });
    assert.equal(second.precheck({ tool: 'run_terminal_cmd', args: { command: 'cargo test' }, cwd: '.' }), 'allow');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('web fetch allow_always records the origin', () => {
  const policy = createPermissionPolicy({ mode: 'ask' });
  policy.record('web_fetch', { url: 'https://docs.example.com/page' }, 'allow_always');
  assert.equal(policy.precheck({ tool: 'web_fetch', args: { url: 'https://docs.example.com/other' }, cwd: '.' }), 'allow');
  assert.equal(policy.precheck({ tool: 'web_fetch', args: { url: 'https://evil.example.net/' }, cwd: '.' }), 'ask');
});
