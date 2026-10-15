/** Indexer — incremental scan, chunk, embed, and semantic search over the workspace. */

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { chunkFile } from './chunker.js';
import { cosineSimilarity } from './embeddings.js';
import type { EmbeddingsProvider } from './embeddings.js';
import type { IndexStore } from './store.js';

export interface IndexerOptions {
  cwd: string;
  store: IndexStore;
  embeddings: EmbeddingsProvider;
  max_files?: number;
  max_file_bytes?: number;
}

export interface IndexRunResult {
  scanned: number;
  indexed: number;
  skipped: number;
  removed: number;
  chunks: number;
}

export interface SemanticHit {
  path: string;
  start_line: number;
  end_line: number;
  text: string;
  score: number;
}

export interface Indexer {
  run(): Promise<IndexRunResult>;
  search(query: string, limit?: number): Promise<SemanticHit[]>;
  stats(): { files: number; chunks: number };
  clear(): void;
}

const DEFAULT_MAX_FILES = 2000;
const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const INDEXABLE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs', '.go', '.java', '.kt', '.kts',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.rb', '.php', '.swift', '.m', '.mm', '.scala',
  '.sh', '.ps1', '.sql', '.md', '.json', '.yaml', '.yml', '.toml', '.css', '.scss', '.html',
]);

function ripgrepBinary(): string {
  return process.env['OPENCURSOR_RIPGREP_PATH'] ?? 'rg';
}

function listWorkspaceFiles(cwd: string, maxFiles: number): string[] | null {
  const result = spawnSync(
    ripgrepBinary(),
    ['--files', '--hidden', '--glob', '!.git', '--glob', '!node_modules', '--glob', '!dist', '--no-messages'],
    { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true },
  );
  if (result.error || result.status === null || result.status >= 2) return null;
  return (result.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, maxFiles);
}

async function fallbackWalk(cwd: string, maxFiles: number): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  const files: string[] = [];
  const skip = new Set(['.git', 'node_modules', 'dist', '.opencursor']);
  const queue: string[] = [''];
  while (queue.length > 0 && files.length < maxFiles) {
    const relative = queue.shift() ?? '';
    const absolute = path.join(cwd, relative);
    let entries;
    try {
      entries = await readdir(absolute, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.github') continue;
      if (skip.has(entry.name)) continue;
      const childRelative = relative.length > 0 ? path.join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) queue.push(childRelative);
      else if (entry.isFile()) files.push(childRelative.split(path.sep).join('/'));
      if (files.length >= maxFiles) break;
    }
  }
  return files;
}

export function createIndexer(options: IndexerOptions): Indexer {
  const maxFiles = options.max_files ?? DEFAULT_MAX_FILES;
  const maxFileBytes = options.max_file_bytes ?? DEFAULT_MAX_FILE_BYTES;

  return {
    async run(): Promise<IndexRunResult> {
      const listed = listWorkspaceFiles(options.cwd, maxFiles) ?? (await fallbackWalk(options.cwd, maxFiles));
      const candidates = listed.filter((file) => INDEXABLE_EXTENSIONS.has(path.extname(file).toLowerCase()));

      const seen = new Set<string>();
      let indexed = 0;
      let skipped = 0;
      let chunks = 0;
      let scanned = 0;

      for (const relative of candidates) {
        scanned++;
        seen.add(relative);
        const absolute = path.resolve(options.cwd, relative);
        let fileStat;
        try {
          fileStat = await stat(absolute);
        } catch {
          skipped++;
          continue;
        }
        if (fileStat.size > maxFileBytes) {
          skipped++;
          continue;
        }
        const existing = options.store.getFile(relative);
        if (existing && existing.mtime_ms === Math.floor(fileStat.mtimeMs) && existing.size === fileStat.size) {
          skipped++;
          continue;
        }
        let content: string;
        try {
          content = await readFile(absolute, 'utf8');
        } catch {
          skipped++;
          continue;
        }
        if (content.includes('\u0000')) {
          skipped++;
          continue;
        }
        const sha256 = createHash('sha256').update(content).digest('hex');
        if (existing && existing.sha256 === sha256) {
          const kept = options.store.loadChunksForFile(relative);
          options.store.upsertFile(
            {
              path: relative,
              sha256,
              mtime_ms: Math.floor(fileStat.mtimeMs),
              size: fileStat.size,
              chunk_count: kept.length,
            },
            kept.map((chunk) => ({
              start_line: chunk.start_line,
              end_line: chunk.end_line,
              text: chunk.text,
              embedding: chunk.embedding,
            })),
          );
          skipped++;
          continue;
        }

        const fileChunks = chunkFile(content);
        if (fileChunks.length === 0) {
          options.store.removeFile(relative);
          skipped++;
          continue;
        }
        const embeddings = await options.embeddings.embed(fileChunks.map((chunk) => chunk.text));
        options.store.upsertFile(
          {
            path: relative,
            sha256,
            mtime_ms: Math.floor(fileStat.mtimeMs),
            size: fileStat.size,
            chunk_count: fileChunks.length,
          },
          fileChunks.map((chunk, i) => ({ ...chunk, embedding: embeddings[i] ?? new Float32Array(options.embeddings.dimensions) })),
        );
        indexed++;
        chunks += fileChunks.length;
      }

      let removed = 0;
      for (const record of options.store.listFiles()) {
        if (!seen.has(record.path)) {
          options.store.removeFile(record.path);
          removed++;
        }
      }

      return { scanned, indexed, skipped, removed, chunks };
    },

    async search(query: string, limit = 12): Promise<SemanticHit[]> {
      const trimmed = query.trim();
      if (trimmed.length === 0) return [];
      const stored = options.store.loadChunks();
      if (stored.length === 0) return [];
      const [queryVector] = await options.embeddings.embed([trimmed]);
      if (!queryVector) return [];
      const scored = stored.map((chunk) => ({
        path: chunk.path,
        start_line: chunk.start_line,
        end_line: chunk.end_line,
        text: chunk.text,
        score: cosineSimilarity(queryVector, chunk.embedding),
      }));
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, limit);
    },

    stats() {
      return options.store.stats();
    },

    clear() {
      options.store.clear();
    },
  };
}
