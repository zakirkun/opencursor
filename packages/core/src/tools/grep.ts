/** grep_search — ripgrep-backed content search over the workspace. */

import type { ToolHandlerFor } from '../types.js';
import { DEFAULT_LIMITS } from '../types.js';
import type { GrepArgs, GrepContentMatch, GrepFileMatch, GrepSuccess } from '../protocol/tools.js';
import { err, ok } from '../protocol/tools.js';
import { resolveInWorkspace } from './paths.js';
import { RG_MISSING_HINT, runRipgrep } from './rg.js';

interface RgJsonMatch {
  type: 'match' | 'context';
  data: {
    path: { text: string };
    line_number: number;
    lines: { text: string };
  };
}

function buildArgs(args: GrepArgs, searchPath: string): string[] {
  const cli: string[] = ['--json', '--no-messages'];
  if (args.case_insensitive) cli.push('-i');
  if (args.multiline) cli.push('-U');
  if (args.glob) cli.push('--glob', args.glob);
  if (args.type) cli.push('--type', args.type);
  const before = args.context_before ?? args.context;
  const after = args.context_after ?? args.context;
  if (typeof before === 'number' && before > 0) cli.push('-B', String(before));
  if (typeof after === 'number' && after > 0) cli.push('-A', String(after));
  if (args.output_mode === 'files_with_matches') cli.push('--files-with-matches');
  else if (args.output_mode === 'count') cli.push('--count');
  cli.push('--regexp', args.pattern, '--', searchPath);
  return cli;
}

export const grepSearchTool: ToolHandlerFor<'grep_search'> = {
  name: 'grep_search',
  description:
    'Search file contents with ripgrep. Supports glob/type filters, context lines, and ' +
    'output modes (content | files_with_matches | count). Prefer this over run_terminal_cmd rg.',
  input_schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for' },
      path: { type: 'string', description: 'Directory or file to search (default: workspace root)' },
      glob: { type: 'string', description: 'Glob filter, e.g. "**/*.ts"' },
      output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'] },
      context: { type: 'integer', description: 'Lines of context before and after' },
      context_before: { type: 'integer' },
      context_after: { type: 'integer' },
      case_insensitive: { type: 'boolean' },
      type: { type: 'string', description: 'ripgrep type filter, e.g. ts, py, rust' },
      head_limit: { type: 'integer', description: 'Max matches to return (default 250)' },
      multiline: { type: 'boolean' },
      offset: { type: 'integer', description: 'Skip the first N matches' },
    },
    required: ['pattern'],
  },
  default_permission: 'allow',
  async execute(args: GrepArgs, ctx) {
    if (args.pattern.length === 0) return err('invalid_args', 'empty pattern');
    const searchPath = args.path ? resolveInWorkspace(ctx.cwd, args.path) : ({ ok: true, abs: ctx.cwd } as const);
    if (!searchPath.ok) return searchPath.outcome;

    const result = await runRipgrep(buildArgs(args, searchPath.abs), ctx.cwd, ctx.signal);
    if (result.spawnError) {
      if (result.spawnError.code === 'ENOENT') return err('internal', RG_MISSING_HINT);
      return err('internal', `rg failed: ${result.spawnError.message}`);
    }
    if (result.code === 2 && result.stdout.length === 0) {
      return err('invalid_args', result.stderr.trim() || 'rg rejected the pattern');
    }

    const mode = args.output_mode ?? 'content';
    const headLimit = Math.max(1, args.head_limit ?? DEFAULT_LIMITS.max_grep_matches);
    const offset = Math.max(0, args.offset ?? 0);

    if (mode === 'files_with_matches') {
      const files = result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((file) => ({ path: file, matches: [] as GrepContentMatch[] }));
      const sliced = files.slice(offset);
      const value: GrepSuccess = {
        files: sliced.slice(0, headLimit),
        total_matches: files.length,
        truncated: sliced.length > headLimit,
      };
      return ok(value);
    }

    if (mode === 'count') {
      const files: GrepFileMatch[] = [];
      for (const line of result.stdout.split('\n')) {
        const idx = line.lastIndexOf(':');
        if (idx < 0) continue;
        const file = line.slice(0, idx);
        const count = Number.parseInt(line.slice(idx + 1), 10);
        if (!Number.isFinite(count)) continue;
        const match: GrepContentMatch = {
          line_number: count,
          line: `${count} matches`,
          context_before: [],
          context_after: [],
        };
        files.push({ path: file, matches: [match] });
      }
      const total = files.reduce((sum, f) => sum + (f.matches[0]?.line_number ?? 0), 0);
      return ok({ files: files.slice(0, headLimit), total_matches: total, truncated: files.length > headLimit });
    }

    const byFile = new Map<string, GrepFileMatch>();
    const pendingContext = new Map<string, GrepContentMatch>();
    let total = 0;

    for (const raw of result.stdout.split('\n')) {
      if (raw.length === 0) continue;
      let event: RgJsonMatch;
      try {
        event = JSON.parse(raw) as RgJsonMatch;
      } catch {
        continue;
      }
      if (event.type !== 'match' && event.type !== 'context') continue;
      const file = event.data.path.text;
      const lineNumber = event.data.line_number;
      const text = event.data.lines.text.replace(/\r?\n$/, '');
      let entry = byFile.get(file);
      if (!entry) {
        entry = { path: file, matches: [] };
        byFile.set(file, entry);
      }
      if (event.type === 'match') {
        total++;
        const match: GrepContentMatch = {
          line_number: lineNumber,
          line: text,
          context_before: [],
          context_after: [],
        };
        entry.matches.push(match);
        pendingContext.set(file, match);
      } else {
        const target = pendingContext.get(file);
        if (!target) continue;
        if (lineNumber < target.line_number) target.context_before?.push(text);
        else target.context_after?.push(text);
      }
    }

    const allFiles = [...byFile.values()].filter((f) => f.matches.length > 0);
    let skipped = offset;
    const files: GrepFileMatch[] = [];
    let produced = 0;
    let truncated = false;
    for (const file of allFiles) {
      if (produced >= headLimit) {
        truncated = true;
        break;
      }
      const matches: GrepContentMatch[] = [];
      for (const match of file.matches) {
        if (skipped > 0) {
          skipped--;
          continue;
        }
        if (produced >= headLimit) {
          truncated = true;
          break;
        }
        matches.push(match);
        produced++;
      }
      if (matches.length > 0) files.push({ path: file.path, matches });
    }

    const value: GrepSuccess = { files, total_matches: total, truncated };
    return ok(value);
  },
};
