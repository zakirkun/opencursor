/** index tool — build, inspect, and clear the semantic codebase index. */

import type { ToolHandlerFor } from '../types.js';
import type { IndexArgs, IndexResult } from '../protocol/tools.js';
import { err, ok } from '../protocol/tools.js';

export const indexTool: ToolHandlerFor<'index'> = {
  name: 'index',
  description:
    'Manage the semantic codebase index used by codebase_search. ' +
    'operation=status shows indexed file/chunk counts; operation=run rebuilds incrementally; ' +
    'operation=clear removes all indexed data.',
  input_schema: {
    type: 'object',
    properties: {
      operation: { type: 'string', enum: ['status', 'run', 'clear'] },
    },
    required: ['operation'],
  },
  default_permission: 'ask',
  async execute(args: IndexArgs, ctx) {
    if (!ctx.indexer) return err('internal', 'indexer not attached');
    if (args.operation === 'status') {
      const stats = ctx.indexer.stats();
      const value: IndexResult = {
        files: stats.files,
        chunks: stats.chunks,
        message: stats.files === 0 ? 'index is empty; run operation=run to build it' : 'index ready',
      };
      return ok(value);
    }
    if (args.operation === 'run') {
      try {
        const result = await ctx.indexer.run();
        const stats = ctx.indexer.stats();
        const value: IndexResult = {
          files: stats.files,
          chunks: stats.chunks,
          message: `indexed ${result.indexed} file(s) (${result.skipped} unchanged, ${result.removed} removed)`,
        };
        return ok(value);
      } catch (error) {
        return err('internal', `index run failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (args.operation === 'clear') {
      ctx.indexer.clear();
      const value: IndexResult = { files: 0, chunks: 0, message: 'index cleared' };
      return ok(value);
    }
    return err('invalid_args', `unknown operation: ${String(args.operation)}`);
  },
};
