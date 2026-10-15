/** memory tool — model-facing memory operations. */

import { randomUUID } from 'node:crypto';
import type { ToolHandlerFor } from '../types.js';
import type { MemoryArgs, MemoryEntry, MemoryKind, MemoryResult } from '../protocol/tools.js';
import { err, ok } from '../protocol/tools.js';

const VALID_KINDS: MemoryKind[] = ['fact', 'decision', 'preference', 'artifact', 'summary', 'note'];

export const memoryTool: ToolHandlerFor<'memory'> = {
  name: 'memory',
  description:
    'Persistent memory across sessions. Operations: add (save text with kind/tags), search (query, tags, kind), ' +
    'list (recent entries), forget (by id). Use for durable user preferences, decisions, and facts worth keeping.',
  input_schema: {
    type: 'object',
    properties: {
      operation: { type: 'string', enum: ['add', 'search', 'list', 'forget'] },
      text: { type: 'string', description: 'Memory text (required for add)' },
      kind: { type: 'string', enum: VALID_KINDS },
      tags: { type: 'array', items: { type: 'string' } },
      id: { type: 'string', description: 'Entry id (required for forget)' },
      query: { type: 'string', description: 'Search query' },
      limit: { type: 'integer', description: 'Max results (default 8)' },
    },
    required: ['operation'],
  },
  default_permission: 'allow',
  async execute(args: MemoryArgs, ctx) {
    if (!ctx.memory) return err('internal', 'memory store not attached');
    switch (args.operation) {
      case 'add': {
        if (!args.text || args.text.trim().length === 0) return err('invalid_args', 'text is required for add');
        if (args.kind && !VALID_KINDS.includes(args.kind)) return err('invalid_args', `invalid kind: ${args.kind}`);
        const entry = ctx.memory.add({
          text: args.text,
          kind: args.kind,
          tags: args.tags,
          session_id: ctx.session_id,
          source: 'tool',
        });
        const value: MemoryResult = { entries: [entry], message: `saved ${entry.id}` };
        return ok(value);
      }
      case 'search': {
        const entries = ctx.memory.search({ query: args.query, kind: args.kind, tags: args.tags, limit: args.limit });
        const value: MemoryResult = { entries, message: `${entries.length} result(s)` };
        return ok(value);
      }
      case 'list': {
        const entries = ctx.memory.list(args.limit ?? 20);
        const value: MemoryResult = { entries, message: `${entries.length} entr(ies)` };
        return ok(value);
      }
      case 'forget': {
        if (!args.id) return err('invalid_args', 'id is required for forget');
        const removed = ctx.memory.forget(args.id);
        if (!removed) return err('not_found', `memory not found: ${args.id}`);
        const value: MemoryResult = { entries: [], message: `forgot ${args.id}` };
        return ok(value);
      }
    }
  },
};

export function memoryEntryId(): string {
  return randomUUID();
}

export type { MemoryEntry };
