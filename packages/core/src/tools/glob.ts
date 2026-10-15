/** file_search — glob file discovery via rg --files. */

import path from 'node:path';
import type { ToolHandlerFor } from '../types.js';
import type { GlobToolArgs, GlobToolSuccess } from '../protocol/tools.js';
import { err, ok } from '../protocol/tools.js';
import { resolveInWorkspace } from './paths.js';
import { RG_MISSING_HINT, runRipgrep } from './rg.js';

const FILE_LIMIT = 5000;

export const fileSearchTool: ToolHandlerFor<'file_search'> = {
  name: 'file_search',
  description: 'Find files by glob pattern (e.g. "**/*.ts", "src/**/test_*.py") using ripgrep.',
  input_schema: {
    type: 'object',
    properties: {
      glob_pattern: { type: 'string', description: 'Glob pattern to match file paths' },
      target_directory: { type: 'string', description: 'Directory to search (default: workspace root)' },
    },
    required: ['glob_pattern'],
  },
  default_permission: 'allow',
  async execute(args: GlobToolArgs, ctx) {
    if (!args.glob_pattern || args.glob_pattern.trim().length === 0) {
      return err('invalid_args', 'empty glob_pattern');
    }
    const target = args.target_directory
      ? resolveInWorkspace(ctx.cwd, args.target_directory)
      : ({ ok: true, abs: ctx.cwd } as const);
    if (!target.ok) return target.outcome;

    const result = await runRipgrep(['--files', '--glob', args.glob_pattern, '--no-messages'], target.abs, ctx.signal);
    if (result.spawnError) {
      if (result.spawnError.code === 'ENOENT') return err('internal', RG_MISSING_HINT);
      return err('internal', `rg failed: ${result.spawnError.message}`);
    }
    if (result.code === 2 && result.stdout.length === 0) {
      return err('invalid_args', result.stderr.trim() || 'invalid glob pattern');
    }

    const files = result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((file) => (path.isAbsolute(file) ? file : path.relative(target.abs, path.resolve(target.abs, file))))
      .map((file) => file.split(path.sep).join('/'));

    const value: GlobToolSuccess = {
      files: files.slice(0, FILE_LIMIT),
      truncated: files.length > FILE_LIMIT,
    };
    return ok(value);
  },
};
