/** edit_file — full-body rewrite plus computed diff. */

import { readFile, stat, writeFile } from 'node:fs/promises';
import type { ToolHandlerFor } from '../types.js';
import type { EditArgs, EditSuccess } from '../protocol/tools.js';
import { err, ok } from '../protocol/tools.js';
import { displayPath, resolveInWorkspace } from './paths.js';
import { lineDiff, splitLines } from './diff.js';

const BEFORE_CONTENT_LIMIT = 1024 * 1024;
const DIFF_LINE_LIMIT = 2000;

export const editFileTool: ToolHandlerFor<'edit_file'> = {
  name: 'edit_file',
  description:
    'Replace the entire contents of a file with `stream_content`. Returns a unified diff of the change. ' +
    'For targeted changes prefer str_replace.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path' },
      stream_content: { type: 'string', description: 'Complete new file content' },
    },
    required: ['path', 'stream_content'],
  },
  default_permission: 'ask',
  async execute(args: EditArgs, ctx) {
    if (typeof args.stream_content !== 'string') {
      return err('invalid_args', 'stream_content is required');
    }
    const resolved = resolveInWorkspace(ctx.cwd, args.path);
    if (!resolved.ok) return resolved.outcome;

    let before: string | null = null;
    let beforeSize = 0;
    try {
      const info = await stat(resolved.abs);
      beforeSize = info.size;
      if (info.isFile()) before = await readFile(resolved.abs, 'utf8');
    } catch {
      before = null;
    }

    try {
      await writeFile(resolved.abs, args.stream_content, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EBUSY') {
        return err('busy', `file is locked: ${args.path} (${code})`);
      }
      return err('internal', `write failed: ${String(error)}`);
    }

    const value: EditSuccess = {
      path: displayPath(ctx.cwd, resolved.abs),
      after_full_file_content: args.stream_content,
    };
    if (before !== null && beforeSize < BEFORE_CONTENT_LIMIT) {
      value.before_full_file_content = before;
      const oldLines = splitLines(before);
      const newLines = splitLines(args.stream_content);
      if (oldLines.length + newLines.length <= DIFF_LINE_LIMIT) {
        const diff = lineDiff(oldLines, newLines);
        if (diff !== null) value.diff_string = diff;
      }
    } else if (before === null) {
      value.message = 'created new file';
    }
    return ok(value);
  },
};
