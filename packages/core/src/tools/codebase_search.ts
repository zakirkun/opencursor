/** codebase_search — keyword-ranked fallback until an embeddings backend exists. */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ToolHandlerFor } from '../types.js';
import type { SemSearchToolArgs, SemSearchFileResult, SemSearchToolSuccess } from '../protocol/tools.js';
import { err, ok } from '../protocol/tools.js';
import { RG_MISSING_HINT, runRipgrep } from './rg.js';

const MAX_TERM_FILES = 200;
const MAX_RESULTS = 20;
const CONTEXT_RADIUS = 2;

function extractTerms(query: string): string[] {
  const stop = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'for', 'how', 'where', 'what', 'does']);
  return [...new Set(
    query
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((term) => term.length >= 3 && !stop.has(term)),
  )].slice(0, 6);
}

export const codebaseSearchTool: ToolHandlerFor<'codebase_search'> = {
  name: 'codebase_search',
  description:
    'Search the codebase for a concept or question. Uses the semantic index when built ' +
    '(run the index tool), otherwise falls back to keyword ranking. Prefer grep_search for exact patterns.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Concept or question to search for' },
      target_directories: { type: 'array', items: { type: 'string' }, description: 'Optional directories to search' },
      explanation: { type: 'string', description: 'Why you need this search (for the user)' },
    },
    required: ['query'],
  },
  default_permission: 'allow',
  async execute(args: SemSearchToolArgs, ctx) {
    if (ctx.indexer) {
      const stats = ctx.indexer.stats();
      if (stats.chunks > 0) {
        try {
          const hits = await ctx.indexer.search(args.query, 12);
          const byPath = new Map<string, SemSearchFileResult>();
          for (const hit of hits) {
            if (hit.score <= 0) continue;
            const existing = byPath.get(hit.path);
            const snippet = hit.text.split('\n').slice(0, 24).map((line, index) => `${String(hit.start_line + index).padStart(5, ' ')}: ${line}`);
            if (existing) {
              existing.lines.push('  --', ...snippet);
              existing.score = Math.max(existing.score ?? 0, hit.score);
            } else {
              byPath.set(hit.path, { path: hit.path, lines: snippet, score: hit.score });
            }
          }
          if (byPath.size > 0) {
            const results = [...byPath.values()].slice(0, 15);
            return ok({ results });
          }
        } catch (error) {
          ctx.onProgress?.('note', `semantic search failed, falling back to keywords: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    const terms = extractTerms(args.query);
    if (terms.length === 0) return err('invalid_args', 'query too short; provide distinctive terms');

    const roots = args.target_directories && args.target_directories.length > 0 ? args.target_directories : ['.'];
    const scores = new Map<string, number>();

    for (const term of terms) {
      for (const root of roots) {
        const result = await runRipgrep(['-l', '-i', '--no-messages', '--regexp', term, '--', root], ctx.cwd, ctx.signal, 4 * 1024 * 1024);
        if (result.spawnError) {
          if (result.spawnError.code === 'ENOENT') return err('internal', RG_MISSING_HINT);
          return err('internal', `rg failed: ${result.spawnError.message}`);
        }
        for (const line of result.stdout.split('\n')) {
          const file = line.trim();
          if (file.length === 0) continue;
          scores.set(file, (scores.get(file) ?? 0) + 1);
        }
      }
    }

    const ranked = [...scores.entries()]
      .sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return a[0].split(/[\\/]/).length - b[0].split(/[\\/]/).length || a[0].localeCompare(b[0]);
      })
      .slice(0, MAX_TERM_FILES)
      .slice(0, MAX_RESULTS);

    ctx.onProgress?.('note', 'codebase_search: keyword fallback used (no embeddings backend configured)');

    const results: SemSearchFileResult[] = [];
    for (const [file] of ranked) {
      try {
        const abs = path.isAbsolute(file) ? file : path.resolve(ctx.cwd, file);
        const text = await readFile(abs, 'utf8');
        const lines = text.split('\n');
        const matched: string[] = [];
        for (let i = 0; i < lines.length && matched.length < 6; i++) {
          const lower = (lines[i] ?? '').toLowerCase();
          if (!terms.some((term) => lower.includes(term))) continue;
          const start = Math.max(0, i - CONTEXT_RADIUS);
          const end = Math.min(lines.length, i + CONTEXT_RADIUS + 1);
          for (let j = start; j < end; j++) {
            matched.push(`${String(j + 1).padStart(5, ' ')}: ${lines[j] ?? ''}`);
          }
          matched.push('  --');
        }
        results.push({ path: file, lines: matched.slice(0, 40) });
      } catch {
        continue;
      }
    }

    const value: SemSearchToolSuccess = { results };
    return ok(value);
  },
};
