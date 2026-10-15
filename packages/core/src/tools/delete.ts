/** delete_file — regular files only. */

import { rm, stat } from 'node:fs/promises';
import type { ToolHandlerFor } from '../types.js';
import type { DeleteArgs, DeleteSuccess } from '../protocol/tools.js';
import { err, ok } from '../protocol/tools.js';
import { displayPath, resolveInWorkspace } from './paths.js';

export const deleteFileTool: ToolHandlerFor<'delete_file'> = {
  name: 'delete_file',
  description: 'Delete a regular file. Directory removal is rejected; empty them with shell commands instead.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to delete' },
    },
    required: ['path'],
  },
  default_permission: 'ask',
  async execute(args: DeleteArgs, ctx) {
    const resolved = resolveInWorkspace(ctx.cwd, args.path);
    if (!resolved.ok) return resolved.outcome;

    let info;
    try {
      info = await stat(resolved.abs);
    } catch {
      return err('not_found', `file not found: ${args.path}`);
    }
    if (!info.isFile()) {
      return err('invalid_args', `not a regular file: ${args.path}`);
    }

    try {
      await rm(resolved.abs);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EBUSY') {
        return err('busy', `file is locked: ${args.path} (${code})`);
      }
      return err('internal', `delete failed: ${String(error)}`);
    }
    const value: DeleteSuccess = { path: displayPath(ctx.cwd, resolved.abs) };
    return ok(value);
  },
};
