/** write_file — create/overwrite with parent directory creation. */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ToolHandlerFor } from '../types.js';
import type { WriteArgs, WriteSuccess } from '../protocol/tools.js';
import { err, ok } from '../protocol/tools.js';
import { displayPath, resolveInWorkspace } from './paths.js';

export const writeFileTool: ToolHandlerFor<'write_file'> = {
  name: 'write_file',
  description: 'Write a file (create or overwrite). Creates parent directories as needed.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Target path' },
      file_text: { type: 'string', description: 'Full file content' },
      return_file_content_after_write: { type: 'boolean', description: 'Echo content in the result' },
    },
    required: ['path', 'file_text'],
  },
  default_permission: 'ask',
  async execute(args: WriteArgs, ctx) {
    const resolved = resolveInWorkspace(ctx.cwd, args.path);
    if (!resolved.ok) return resolved.outcome;

    try {
      await mkdir(path.dirname(resolved.abs), { recursive: true });
      const data = Buffer.from(args.file_text, 'utf8');
      await writeFile(resolved.abs, data);
      const value: WriteSuccess = {
        path: displayPath(ctx.cwd, resolved.abs),
        bytes_written: data.byteLength,
      };
      if (args.return_file_content_after_write) value.file_content = args.file_text;
      return ok(value);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EBUSY') {
        return err('busy', `file is locked: ${args.path} (${code})`);
      }
      return err('internal', `write failed: ${String(error)}`);
    }
  },
};
