/** str_replace — exact literal replacement requiring a unique match. */

import { readFile, writeFile } from 'node:fs/promises';
import type { ToolHandlerFor } from '../types.js';
import type { StrReplaceArgs, StrReplaceSuccess } from '../protocol/tools.js';
import { err, ok } from '../protocol/tools.js';
import { displayPath, resolveInWorkspace } from './paths.js';

export const strReplaceTool: ToolHandlerFor<'str_replace'> = {
  name: 'str_replace',
  description:
    'Replace an exact text excerpt in a file. `old_text` must match exactly once — include surrounding ' +
    'context to make it unique. Use edit_file for whole-file rewrites.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path' },
      old_text: { type: 'string', description: 'Exact existing excerpt (must be unique)' },
      new_text: { type: 'string', description: 'Replacement text' },
    },
    required: ['path', 'old_text', 'new_text'],
  },
  default_permission: 'ask',
  async execute(args: StrReplaceArgs, ctx) {
    if (args.old_text.length === 0) {
      return err('invalid_args', 'old_text must not be empty');
    }
    const resolved = resolveInWorkspace(ctx.cwd, args.path);
    if (!resolved.ok) return resolved.outcome;

    let text: string;
    try {
      text = await readFile(resolved.abs, 'utf8');
    } catch {
      return err('not_found', `file not found: ${args.path}`);
    }

    const segments = text.split(args.old_text);
    const matches = segments.length - 1;
    if (matches === 0) return err('invalid_args', `no match for old_text in ${args.path}`);
    if (matches > 1) {
      return err('invalid_args', `${matches} matches for old_text in ${args.path}; provide a unique excerpt`);
    }

    const next = segments[0] + args.new_text + segments[1];
    try {
      await writeFile(resolved.abs, next, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EBUSY') {
        return err('busy', `file is locked: ${args.path} (${code})`);
      }
      return err('internal', `write failed: ${String(error)}`);
    }
    const value: StrReplaceSuccess = { path: displayPath(ctx.cwd, resolved.abs), replacements: 1 };
    return ok(value);
  },
};
