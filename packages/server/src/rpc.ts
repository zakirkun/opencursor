/** RPC methods exposed to the desktop GUI. */

import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import type { ServerContext, RpcRequest } from './types.js';
import type { PermissionDecision } from '@opencursor/core';

function asString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export async function handleRpc(ctx: ServerContext, request: RpcRequest): Promise<unknown> {
  const params = request.params ?? {};
  switch (request.method) {
    case 'status': {
      const runtime = ctx.getRuntime();
      return {
        cwd: ctx.cwd,
        session_id: runtime ? runtime.session_id : null,
        model: { provider: ctx.modelClient.provider, id: ctx.modelClient.id },
        mcp: ctx.mcp.servers(),
        index: ctx.indexer.stats(),
        memory_count: ctx.memory.list(1000).length,
        config: {
          permission_mode: ctx.config.permission_mode,
          max_iterations: ctx.config.max_iterations,
        },
      };
    }

    case 'session.list':
      return { sessions: await ctx.store.list() };

    case 'session.load': {
      const id = asString(params['session_id'], 'session_id');
      const state = await ctx.store.load(id);
      if (!state) throw new Error(`session not found: ${id}`);
      const runtime = await ctx.createRuntime(id);
      ctx.pumpEvents(runtime);
      return { state };
    }

    case 'session.new': {
      const runtime = await ctx.createRuntime();
      ctx.pumpEvents(runtime);
      return { session_id: runtime.session_id, state: runtime.state() };
    }

    case 'session.state': {
      const runtime = ctx.getRuntime();
      if (!runtime) return { state: null };
      return { state: runtime.state() };
    }

    case 'chat.send': {
      const text = asString(params['text'], 'text');
      let runtime = ctx.getRuntime();
      if (!runtime) {
        runtime = await ctx.createRuntime();
        ctx.pumpEvents(runtime);
      }
      void runtime.runTurn(text).catch((error) => {
        ctx.broadcast({ type: 'agent-event', event: { type: 'error', message: String(error) } });
      });
      return { accepted: true, session_id: runtime.session_id };
    }

    case 'chat.abort': {
      ctx.getRuntime()?.abort();
      return { aborted: true };
    }

    case 'permission.respond': {
      const requestId = asString(params['request_id'], 'request_id');
      const decision = asString(params['decision'], 'decision') as PermissionDecision;
      if (decision !== 'allow' && decision !== 'allow_always' && decision !== 'deny') {
        throw new Error(`invalid decision: ${decision}`);
      }
      const pending = ctx.pendingPermissions.get(requestId);
      if (!pending) throw new Error(`unknown permission request: ${requestId}`);
      ctx.pendingPermissions.delete(requestId);
      pending.resolve(decision);
      return { resolved: true };
    }

    case 'question.respond': {
      const requestId = asString(params['request_id'], 'request_id');
      const answers = params['answers'];
      if (!Array.isArray(answers)) throw new Error('answers must be an array');
      const pending = ctx.pendingQuestions.get(requestId);
      if (!pending) throw new Error(`unknown question request: ${requestId}`);
      ctx.pendingQuestions.delete(requestId);
      pending.resolve(
        answers
          .filter((entry): entry is { question: string; answers: string[] } => {
            if (typeof entry !== 'object' || entry === null) return false;
            const record = entry as Record<string, unknown>;
            return typeof record['question'] === 'string' && Array.isArray(record['answers']);
          })
          .map((entry) => ({
            question: entry.question,
            answers: entry.answers.filter((answer): answer is string => typeof answer === 'string'),
          })),
      );
      return { resolved: true };
    }

    case 'todos': {
      const runtime = ctx.getRuntime();
      return { todos: runtime ? runtime.state().todos : [] };
    }

    case 'memory.list': {
      const query = asOptionalString(params['query']);
      const limit = typeof params['limit'] === 'number' ? params['limit'] : 50;
      return { entries: query ? ctx.memory.search({ query, limit }) : ctx.memory.list(limit) };
    }

    case 'memory.add': {
      const text = asString(params['text'], 'text');
      const kind = asOptionalString(params['kind']);
      const entry = ctx.memory.add({ text, kind: kind as never, source: 'gui' });
      return { entry };
    }

    case 'memory.forget': {
      const id = asString(params['id'], 'id');
      return { removed: ctx.memory.forget(id) };
    }

    case 'index.status':
      return ctx.indexer.stats();

    case 'index.run': {
      const result = await ctx.indexer.run();
      return { ...result, stats: ctx.indexer.stats() };
    }

    case 'index.clear': {
      ctx.indexer.clear();
      return { cleared: true };
    }

    case 'mcp.status':
      return { servers: ctx.mcp.servers() };

    case 'checkpoints.list': {
      const runtime = ctx.getRuntime();
      return { checkpoints: runtime ? runtime.checkpoints() : [] };
    }

    case 'checkpoints.undo': {
      const runtime = ctx.getRuntime();
      if (!runtime) return { restored: [] };
      const all = params['all'] === true;
      const restored = await runtime.undo({ all });
      return { restored };
    }

    case 'context.compact': {
      const runtime = ctx.getRuntime();
      if (!runtime) return { archived_messages: 0, summary_chars: 0 };
      return runtime.compact();
    }

    case 'file.read': {
      const relative = asString(params['path'], 'path');
      const absolute = path.isAbsolute(relative) ? relative : path.resolve(ctx.cwd, relative);
      const info = await stat(absolute);
      if (!info.isFile()) throw new Error(`not a file: ${relative}`);
      if (info.size > 2 * 1024 * 1024) throw new Error('file too large for preview (2MB limit)');
      const content = await readFile(absolute, 'utf8');
      return { path: relative, content, size: info.size };
    }

    default:
      throw new Error(`unknown method: ${request.method}`);
  }
}
