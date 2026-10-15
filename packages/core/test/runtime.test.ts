/** Runtime + session tests â€” loop, permissions, persistence, abort, subagents. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentRuntime } from '../src/runtime/runtime.js';
import { createFileSessionStore } from '../src/session/store.js';
import { createPermissionPolicy } from '../src/permissions/policy.js';
import { createRegistry } from '../src/tools/index.js';
import type { AgentRuntime } from '../src/types.js';
import type { ModelClient, ModelRequest, ModelStreamEvent } from '../src/protocol/models.js';
import type { AnyToolHandler, PermissionPolicy } from '../src/types.js';
import type { AgentEvent } from '../src/protocol/events.js';
import { err, ok } from '../src/protocol/tools.js';

interface ScriptStep {
  text?: string;
  toolCalls?: Array<{ id: string; name: string; args: unknown }>;
  stop: 'end_turn' | 'tool_use';
}

class ScriptedModel implements ModelClient {
  readonly provider = 'openai' as const;
  readonly id = 'scripted';
  requests: ModelRequest[] = [];
  constructor(private readonly steps: ScriptStep[]) {}

  async *generate(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(structuredClone(request));
    const step = this.steps.shift();
    if (!step) {
      yield { type: 'stop', reason: 'end_turn' };
      return;
    }
    if (step.text) yield { type: 'text-delta', text: step.text };
    for (const call of step.toolCalls ?? []) {
      yield { type: 'tool-call', call: { ...call, args_raw: JSON.stringify(call.args) } };
    }
    yield { type: 'usage', usage: { input_tokens: 5, output_tokens: 3 } };
    yield { type: 'stop', reason: step.stop };
  }
}

function echoTool(): AnyToolHandler {
  return {
    name: 'read_file',
    description: 'fake reader',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    default_permission: 'allow',
    async execute(args: { path: string }) {
      return ok({ path: args.path, content: 'fake', total_lines: 1, truncated: false, offset: 1 });
    },
  };
}

function failingTool(): AnyToolHandler {
  return {
    name: 'run_terminal_cmd',
    description: 'fake shell',
    input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    default_permission: 'ask',
    async execute() {
      return err('internal', 'boom');
    },
  };
}

async function collectEvents(runtime: AgentRuntime): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const iterator = runtime.events()[Symbol.asyncIterator]();
  const pump = (async () => {
    for (;;) {
      const { done, value } = await iterator.next();
      if (done) return;
      events.push(value);
    }
  })();
  return Object.assign(events, { done: pump }) as AgentEvent[] & { done: Promise<void> };
}

async function waitForTurn(runtime: AgentRuntime, promise: Promise<unknown>, events: AgentEvent[]): Promise<void> {
  let done = false;
  void promise.finally(() => {
    done = true;
  });
  for (let i = 0; i < 500 && !done; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  void events;
}

function runtimeDeps(overrides: {
  dir: string;
  model: ModelClient;
  tools: AnyToolHandler[];
  permissions?: PermissionPolicy;
  askPermission?: (view: { tool: string }) => Promise<'allow' | 'allow_always' | 'deny'>;
  maxIterations?: number;
}) {
  return {
    cwd: overrides.dir,
    model_client: overrides.model,
    tools: createRegistry(overrides.tools),
    store: createFileSessionStore(path.join(overrides.dir, 'sessions')),
    permissions: overrides.permissions ?? createPermissionPolicy({ mode: 'yolo' }),
    askPermission: overrides.askPermission as never,
    max_iterations: overrides.maxIterations,
    subagent_profiles: {},
  };
}

test('simple text turn ends with end_turn and persists', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'opencursor-rt-'));
  try {
    const model = new ScriptedModel([{ text: 'hi there', stop: 'end_turn' }]);
    const runtime = await createAgentRuntime(runtimeDeps({ dir, model, tools: [echoTool()] }));
    const events = await collectEvents(runtime);
    const summary = await runtime.runTurn('hello');
    await waitForTurn(runtime, Promise.resolve(summary), events);

    assert.equal(summary.reason, 'end_turn');
    assert.equal(summary.tool_calls, 0);
    const kinds = events.map((event) => event.type);
    assert.ok(kinds.includes('turn-started'));
    assert.ok(kinds.includes('text-delta'));
    assert.ok(kinds.includes('turn-ended'));

    const store = createFileSessionStore(path.join(dir, 'sessions'));
    const latest = await store.latestId();
    assert.equal(latest, runtime.session_id);
    const reloaded = await store.load(runtime.session_id);
    assert.ok(reloaded);
    assert.equal(reloaded.messages.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('tool_use turn executes tool, feeds result back, then finishes', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'opencursor-rt-'));
  try {
    const model = new ScriptedModel([
      { toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'a.ts' } }], stop: 'tool_use' },
      { text: 'done reading', stop: 'end_turn' },
    ]);
    const runtime = await createAgentRuntime(runtimeDeps({ dir, model, tools: [echoTool()] }));
    const events = await collectEvents(runtime);
    const summary = await runtime.runTurn('read it');
    await waitForTurn(runtime, Promise.resolve(summary), events);

    assert.equal(summary.tool_calls, 1);
    assert.equal(summary.reason, 'end_turn');
    assert.equal(model.requests.length, 2);

    const secondRequest = model.requests[1];
    assert.ok(secondRequest);
    const messages = secondRequest.messages as Array<{ role: string }>;
    assert.ok(messages.some((message) => message.role === 'tool'));

    const completed = events.find((event) => event.type === 'tool-call-completed');
    assert.ok(completed && completed.type === 'tool-call-completed');
    assert.equal(completed.outcome.kind, 'success');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('policy deny blocks execution without asking', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'opencursor-rt-'));
  try {
    let asked = 0;
    const model = new ScriptedModel([
      { toolCalls: [{ id: 'c1', name: 'run_terminal_cmd', args: { command: 'rm -rf /' } }], stop: 'tool_use' },
      { text: 'ok', stop: 'end_turn' },
    ]);
    const runtime = await createAgentRuntime(
      runtimeDeps({
        dir,
        model,
        tools: [failingTool()],
        askPermission: async () => {
          asked += 1;
          return 'allow';
        },
      }),
    );
    const events = await collectEvents(runtime);
    const summary = await runtime.runTurn('danger');
    await waitForTurn(runtime, Promise.resolve(summary), events);

    assert.equal(asked, 0);
    const completed = events.find((event) => event.type === 'tool-call-completed');
    assert.ok(completed && completed.type === 'tool-call-completed');
    assert.equal(completed.outcome.kind, 'error');
    if (completed.outcome.kind === 'error') assert.equal(completed.outcome.code, 'permission_denied');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ask flow denies on user deny and records allow_always', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'opencursor-rt-'));
  try {
    const decisions: Array<'allow' | 'allow_always' | 'deny'> = ['deny', 'allow_always'];
    const asked: string[] = [];
    const policy = createPermissionPolicy({ mode: 'ask' });
    const model = new ScriptedModel([
      { toolCalls: [{ id: 'c1', name: 'run_terminal_cmd', args: { command: 'npm install x' } }], stop: 'tool_use' },
      { toolCalls: [{ id: 'c2', name: 'run_terminal_cmd', args: { command: 'npm install y' } }], stop: 'tool_use' },
      { text: 'done', stop: 'end_turn' },
    ]);
    const runtime = await createAgentRuntime(
      runtimeDeps({
        dir,
        model,
        tools: [failingTool()],
        permissions: policy,
        askPermission: async (view) => {
          asked.push(view.tool);
          return decisions.shift() ?? 'deny';
        },
      }),
    );
    const events = await collectEvents(runtime);
    const summary = await runtime.runTurn('install');
    await waitForTurn(runtime, Promise.resolve(summary), events);

    assert.equal(asked.length, 2);
    const completions = events.filter((event) => event.type === 'tool-call-completed');
    assert.equal(completions.length, 2);
    const first = completions[0];
    assert.ok(first && first.type === 'tool-call-completed');
    assert.equal(first.outcome.kind, 'rejected');
    assert.ok(policy.rules().some((rule) => rule.tool === 'run_terminal_cmd' && rule.pattern === 'npm'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('max_iterations stops the loop', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'opencursor-rt-'));
  try {
    const steps: ScriptStep[] = Array.from({ length: 4 }, (_, i) => ({
      toolCalls: [{ id: `c${i}`, name: 'read_file', args: { path: `${i}.ts` } }],
      stop: 'tool_use' as const,
    }));
    const model = new ScriptedModel(steps);
    const runtime = await createAgentRuntime(runtimeDeps({ dir, model, tools: [echoTool()], maxIterations: 2 }));
    const events = await collectEvents(runtime);
    const summary = await runtime.runTurn('loop');
    await waitForTurn(runtime, Promise.resolve(summary), events);
    assert.equal(summary.reason, 'max_iterations');
    assert.equal(summary.tool_calls, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('abort mid-turn produces aborted summary', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'opencursor-rt-'));
  try {
    const model: ModelClient = {
      provider: 'openai',
      id: 'slow',
      async *generate(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 5000);
          request.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(new Error('aborted'));
            },
            { once: true },
          );
        });
        yield { type: 'stop', reason: 'end_turn' };
      },
    };
    const runtime = await createAgentRuntime(runtimeDeps({ dir, model, tools: [echoTool()] }));
    const events = await collectEvents(runtime);
    const promise = runtime.runTurn('hang');
    setTimeout(() => runtime.abort(), 50);
    const summary = await promise;
    await waitForTurn(runtime, Promise.resolve(summary), events);
    assert.equal(summary.reason, 'aborted');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('concurrent runTurn throws', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'opencursor-rt-'));
  try {
    const model = new ScriptedModel([{ text: 'one', stop: 'end_turn' }, { text: 'two', stop: 'end_turn' }]);
    const runtime = await createAgentRuntime(runtimeDeps({ dir, model, tools: [echoTool()] }));
    const events = await collectEvents(runtime);
    const first = runtime.runTurn('a');
    await assert.rejects(() => runtime.runTurn('b'), /turn already running/);
    const summary = await first;
    await waitForTurn(runtime, Promise.resolve(summary), events);
    assert.equal(summary.reason, 'end_turn');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('session store round-trip lists sessions by recency', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'opencursor-rt-'));
  try {
    const store = createFileSessionStore(path.join(dir, 'sessions'));
    const base = {
      version: 1 as const,
      cwd: dir,
      model: { provider: 'openai', id: 'm' },
      messages: [],
      todos: [],
      usage: { input_tokens: 0, output_tokens: 0 },
    };
    await store.save({ ...base, id: 's1', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await store.save({ ...base, id: 's2', created_at: '2026-01-02T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' });
    const latest = await store.latestId();
    assert.equal(latest, 's2');
    const listing = await store.list();
    assert.deepEqual(listing.map((item) => item.id), ['s2', 's1']);
    assert.equal(await store.load('missing'), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('todo updates flow through events and session state', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'opencursor-rt-'));
  try {
    const todoTool: AnyToolHandler = {
      name: 'update_todos',
      description: 'fake todos',
      input_schema: { type: 'object', properties: {}, additionalProperties: true },
      default_permission: 'allow',
      async execute(_args, ctx) {
        ctx.todos?.set([{ id: 't1', content: 'do it', status: 'in_progress' }], false);
        return ok({ todos: ctx.todos?.get() ?? [] });
      },
    };
    const model = new ScriptedModel([
      { toolCalls: [{ id: 'c1', name: 'update_todos', args: {} }], stop: 'tool_use' },
      { text: 'ok', stop: 'end_turn' },
    ]);
    const runtime = await createAgentRuntime(runtimeDeps({ dir, model, tools: [todoTool] }));
    const events = await collectEvents(runtime);
    const summary = await runtime.runTurn('track');
    await waitForTurn(runtime, Promise.resolve(summary), events);
    assert.ok(events.some((event) => event.type === 'todos-updated'));
    assert.equal(runtime.state().todos.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
