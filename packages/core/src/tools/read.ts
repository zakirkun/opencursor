/** read_file — bounded UTF-8 text read with optional line numbers. */

import { open, stat } from 'node:fs/promises';
import type { ToolHandlerFor } from '../types.js';
import { DEFAULT_LIMITS } from '../types.js';
import type { ReadArgs, ReadSuccess } from '../protocol/tools.js';
import { err, ok } from '../protocol/tools.js';
import { displayPath, resolveInWorkspace } from './paths.js';

const BINARY_SNIFF_BYTES = 4096;

async function looksBinary(abs: string): Promise<boolean> {
  const handle = await open(abs, 'r');
  try {
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, BINARY_SNIFF_BYTES, 0);
    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 0) return true;
    }
    return false;
  } finally {
    await handle.close();
  }
}

export const readFileTool: ToolHandlerFor<'read_file'> = {
  name: 'read_file',
  description:
    'Read a text file from the workspace. Returns up to 2000 lines starting at `offset` (1-based). ' +
    'Use file_search/glob to find paths first when unsure. Binary files are rejected.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path (relative to workspace or absolute)' },
      offset: { type: 'integer', description: '1-based first line to read (default 1)' },
      limit: { type: 'integer', description: 'Max lines to return (default/max 2000)' },
      include_line_numbers: { type: 'boolean', description: 'Prefix each line with its number' },
    },
    required: ['path'],
  },
  default_permission: 'allow',
  async execute(args: ReadArgs, ctx) {
    const resolved = resolveInWorkspace(ctx.cwd, args.path);
    if (!resolved.ok) return resolved.outcome;

    let info;
    try {
      info = await stat(resolved.abs);
    } catch {
      return err('not_found', `file not found: ${args.path}`);
    }
    if (info.isDirectory()) {
      return err('invalid_args', `is a directory: ${args.path} (use list_dir)`);
    }
    if (info.isFile() && (await looksBinary(resolved.abs))) {
      return err('invalid_args', `binary file: ${args.path}`);
    }

    const text = await open(resolved.abs, 'r')
      .then(async (handle) => {
        try {
          return await handle.readFile();
        } finally {
          await handle.close();
        }
      })
      .then((buffer) => buffer.toString('utf8'))
      .catch(() => null);
    if (text === null) {
      return err('not_found', `could not read: ${args.path}`);
    }

    const allLines = text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
    // A trailing newline produces one empty final element; drop it for counting.
    if (allLines.length > 1 && allLines[allLines.length - 1] === '') allLines.pop();
    const totalLines = allLines.length;

    const offset = Math.max(1, args.offset ?? 1);
    const limit = Math.min(Math.max(1, args.limit ?? DEFAULT_LIMITS.max_read_lines), DEFAULT_LIMITS.max_read_lines);
    const startIndex = Math.min(offset - 1, totalLines);
    const slice = allLines.slice(startIndex, startIndex + limit);
    const truncated = startIndex + slice.length < totalLines;

    const content = slice
      .map((line, i) =>
        args.include_line_numbers ? `${String(startIndex + i + 1).padStart(4, ' ')}: ${line}` : line,
      )
      .join('\n');

    const value: ReadSuccess = {
      path: displayPath(ctx.cwd, resolved.abs),
      content,
      total_lines: totalLines,
      truncated,
      offset,
    };
    return ok(value);
  },
};
