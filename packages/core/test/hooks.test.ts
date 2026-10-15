/** Hook runner + runtime integration tests â€” fake hook scripts, no network. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHookRunner } from '../src/hooks/runner.js';
import { createAgentRuntime } from '../src/runtime/runtime.js';
import { createMemorySessionStore } from '../src/session/memory.js';
import { createPermissionPolicy } from '../src/permissions/policy.js';
import { createRegistry } from '../src/tools/index.js';
import type { AnyToolHandler } from '../src/types.js';
import type { ModelClient, ModelRequest, ModelStreamEvent } from '../src/protocol/models.js';
import type { AgentEvent } from '../src/protocol/events.js';
import { ok } from '../src/protocol/tools.js';

function hookScript(dir: string, name: string, body: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, body, 'utf8');
  return file;
}

function nodeCommand(script: string): string {
  return `"${process.execPath}" "${script}"`;
}

const basePayload = { tool_name: 'run_terminal_cmd', tool_input: { command: 'ls' }, cwd: '.', session_id: 's1' };

test('pre hook allows by default and on explicit allow', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'opencursor-hooks-'));
  try {
    const allowScript = hookScript(dir, 'allow.cjs', "console.log(JSON.stringify({decision:'allow'}));\n");
    const silentScript = hookScript(dir, 'silent.cjs', 'process.exit(0);\n');
    const runner = createHookRunner({
      pre: [{ matcher: 'run_terminal_cmd', command: nodeCommand(allowScript) }, { command: nodeCommand(silentScript) }],
    });
    assert.ok(runner);
    const outcome = await runner.runPre(basePayload);
    assert.equal(outcome.decision, 'allow');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pre hook denies via JSON decision and via exit code 2', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'opencursor-hooks-'));
  try {
    const jsonDeny = hookScript(dir, 'deny.cjs', "console.log(JSON.stringify({decision:'deny',reason:'blocked by policy'}));\n");
    const runner = createHookRunner({ pre: [{ command: nodeCommand(jsonDeny) }] });
    assert.ok(runner);
    const denied = await runner.runPre(basePayload);
    assert.equal(denied.decision, 'deny');
    assert.equal(denied.reason, 'blocked by policy');

    const exitTwo = hookScript(dir, 'exit2.cjs', "console.error('nope'); process.exit(2);\n");
    const runner2 = createHookRunner({ pre: [{ command: nodeCommand(exitTwo) }] });
    assert.ok(runner2);
    const denied2 = await runner2.runPre(basePayload);
    assert.equal(denied2.decision, 'deny');
    assert.match(denied2.reason ?? '', /nope/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('matcher filters which tools run hooks', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'opencursor-hooks-'));
  try {
    const denyAll = hookScript(dir, 'deny.cjs', "console.log(JSON.stringify({decision:'deny',reason:'x'}));\n");
    const runner = createHookRunner({ pre: [{ matcher: 'write_file|str_replace', command: nodeCommand(denyAll) }] });
    assert.ok(runner);
    const other = await runner.runPre({ ...basePayload, tool_name: 'read_file' });
    assert.equal(other.decision, 'allow');
    const matched = await runner.runPre({ ...basePayload, tool_name: 'write_file' });
    assert.equal(matched.decision, 'deny');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('post hook receives tool_output and can deny', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'opencursor-hooks-'));
  try {
    const inspect = hookScript(
      dir,
      'inspect.cjs',
      [
        'let data = "";',
        'process.stdin.on("data", (chunk) => { data += chunk; });',
        'process.stdin.on("end", () => {',
        '  const payload = JSON.parse(data);',
        '  if (String(payload.tool_output).includes("secret")) {',
        "    console.log(JSON.stringify({decision:'deny',reason:'output contained secret'}));",
        '  } else {',
        "    console.log(JSON.stringify({decision:'allow'}));",
        '  }',
        '});',
      ].join('\n'),
    );
    const runner = createHookRunner({ post: [{ command: nodeCommand(inspect) }] });
    assert.ok(runner);
    const clean = await runner.runPost({ ...basePayload, tool_output: '{"kind":"success"}', duration_ms: 5 });
    assert.equal(clean.decision, 'allow');
    const dirty = await runner.runPost({ ...basePayload, tool_output: '{"value":"secret-token"}', duration_ms: 5 });
    assert.equal(dirty.decision, 'deny');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('hook timeout yields error decision', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'opencursor-hooks-'));
  try {
    const hang = hookScript(dir, 'hang.cjs', 'setInterval(() => {}, 1000);\n');
    const runner = createHookRunner({ pre: [{ command: nodeCommand(hang), timeout_ms: 300 }] });
    assert.ok(runner);
    const outcome = await runner.runPre(basePayload);
    assert.equal(outcome.decision, 'error');
    assert.match(outcome.reason ?? '', /timed out/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

interface ScriptStep {
  toolCalls?: Array<{ id: string; name: string; args: unknown }>;
  text?: string;
  stop: 'end_turn' | 'tool_use';
}

class ScriptedModel implements ModelClient {
  readonly provider = 'openai' as const;
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

function fakeTool(name: string): AnyToolHandler {
  return {
    name: name as never,
    description: 'fake',
    input_schema: { type: 'object', properties: {}, additionalProperties: true },
    default_permission: 'allow',
    async execute() {
      return ok({ note: 'executed' });
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

test('runtime denies tool execution when pre hook denies', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'opencursor-hooks-'));
  try {
    const deny = hookScript(dir, 'deny.cjs', "console.log(JSON.stringify({decision:'deny',reason:'blocked'}));\n");
    const hooks = createHookRunner({ pre: [{ command: nodeCommand(deny) }] });
    assert.ok(hooks);
    const model = new ScriptedModel([
      { toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'a.ts' } }], stop: 'tool_use' },
      { text: 'done', stop: 'end_turn' },
    ]);
    const runtime = await createAgentRuntime({
      cwd: dir,
      model_client: model,
      tools: createRegistry([fakeTool('read_file')]),
      store: createMemorySessionStore(),
      permissions: createPermissionPolicy({ mode: 'yolo' }),
      hooks,
    });
    const events = await drainEvents(runtime);
    const summary = await runtime.runTurn('go');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(summary.tool_calls, 1);
    const completed = events.find((event) => event.type === 'tool-call-completed');
    assert.ok(completed && completed.type === 'tool-call-completed');
    assert.equal(completed.outcome.kind, 'rejected');
    const hookEvent = events.find((event) => event.type === 'hook-result');
    assert.ok(hookEvent && hookEvent.type === 'hook-result');
    assert.equal(hookEvent.phase, 'pre');
    assert.equal(hookEvent.decision, 'deny');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runtime allows execution when hooks pass', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'opencursor-hooks-'));
  try {
    const allow = hookScript(dir, 'allow.cjs', "console.log(JSON.stringify({decision:'allow'}));\n");
    const hooks = createHookRunner({ pre: [{ command: nodeCommand(allow) }], post: [{ command: nodeCommand(allow) }] });
    assert.ok(hooks);
    const model = new ScriptedModel([
      { toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'a.ts' } }], stop: 'tool_use' },
      { text: 'done', stop: 'end_turn' },
    ]);
    const runtime = await createAgentRuntime({
      cwd: dir,
      model_client: model,
      tools: createRegistry([fakeTool('read_file')]),
      store: createMemorySessionStore(),
      permissions: createPermissionPolicy({ mode: 'yolo' }),
      hooks,
    });
    const events = await drainEvents(runtime);
    const summary = await runtime.runTurn('go');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(summary.tool_calls, 1);
    const completed = events.find((event) => event.type === 'tool-call-completed');
    assert.ok(completed && completed.type === 'tool-call-completed');
    assert.equal(completed.outcome.kind, 'success');
    assert.equal(events.filter((event) => event.type === 'hook-result').length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
