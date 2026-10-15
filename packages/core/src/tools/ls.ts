/** list_dir — directory listing with optional name filters. */

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ToolHandlerFor } from '../types.js';
import type { DirectoryEntry, LsArgs, LsSuccess } from '../protocol/tools.js';
import { err, ok } from '../protocol/tools.js';
import { displayPath, resolveInWorkspace } from './paths.js';

const ENTRY_LIMIT = 2000;

export const listDirTool: ToolHandlerFor<'list_dir'> = {
  name: 'list_dir',
  description: 'List directory entries (directories first, then files, alphabetically).',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory to list' },
      ignore: { type: 'array', items: { type: 'string' }, description: 'Name substrings to skip' },
    },
    required: ['path'],
  },
  default_permission: 'allow',
  async execute(args: LsArgs, ctx) {
    const resolved = resolveInWorkspace(ctx.cwd, args.path);
    if (!resolved.ok) return resolved.outcome;

    let dirents;
    try {
      dirents = await readdir(resolved.abs, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return err('not_found', `directory not found: ${args.path}`);
      if (code === 'ENOTDIR') return err('invalid_args', `not a directory: ${args.path}`);
      return err('internal', `list failed: ${String(error)}`);
    }

    const ignore = args.ignore ?? [];
    const entries: DirectoryEntry[] = [];
    for (const dirent of dirents) {
      if (ignore.some((pattern) => dirent.name.includes(pattern))) continue;
      const type: DirectoryEntry['type'] = dirent.isDirectory()
        ? 'directory'
        : dirent.isSymbolicLink()
          ? 'symlink'
          : 'file';
      const entry: DirectoryEntry = { name: dirent.name, type };
      if (type === 'file') {
        try {
          const info = await stat(path.join(resolved.abs, dirent.name));
          entry.size = info.size;
        } catch {
          delete entry.size;
        }
      }
      entries.push(entry);
      if (entries.length >= ENTRY_LIMIT) break;
    }

    entries.sort((a, b) => {
      const dirRank = (e: DirectoryEntry): number => (e.type === 'directory' ? 0 : 1);
      if (dirRank(a) !== dirRank(b)) return dirRank(a) - dirRank(b);
      return a.name.localeCompare(b.name);
    });

    const value: LsSuccess = { path: displayPath(ctx.cwd, resolved.abs), entries };
    return ok(value);
  },
};
