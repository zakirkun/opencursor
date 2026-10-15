/** Memory engine — SQLite source of truth, JSON mirror, Markdown digest. */

import { renameSync, writeFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Homebase } from '../homebase.js';
import type { MemoryEntry, MemoryKind } from '../protocol/tools.js';

export interface MemorySearchOptions {
  query?: string;
  kind?: MemoryKind;
  tags?: string[];
  limit?: number;
}

export interface MemoryStore {
  add(input: {
    text: string;
    kind?: MemoryKind;
    tags?: string[];
    session_id?: string | null;
    source: string;
  }): MemoryEntry;
  search(options: MemorySearchOptions): MemoryEntry[];
  list(limit?: number): MemoryEntry[];
  forget(id: string): boolean;
  count(): number;
  digest(maxChars: number): string;
  rebuildMirrors(): void;
}

interface MemoryRow {
  id: string;
  ts: string;
  kind: string;
  text: string;
  tags: string;
  session_id: string | null;
  source: string;
}

function rowToEntry(row: MemoryRow): MemoryEntry {
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(row.tags) as unknown;
    if (Array.isArray(parsed)) tags = parsed.filter((tag): tag is string => typeof tag === 'string');
  } catch {
    tags = [];
  }
  return {
    id: row.id,
    ts: row.ts,
    kind: row.kind as MemoryKind,
    text: row.text,
    tags,
    session_id: row.session_id,
    source: row.source,
  };
}

function sanitizeFtsQuery(input: string): string | null {
  const tokens = input
    .split(/\s+/)
    .map((token) => token.replace(/["'*():\-^]/g, '').trim())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${token}"`).join(' OR ');
}

export function createMemoryStore(db: DatabaseSync, home: Homebase): MemoryStore {
  const insertMemory = db.prepare(
    'INSERT INTO memories (id, ts, kind, text, tags, session_id, source) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const insertFts = db.prepare('INSERT INTO memories_fts (id, text, tags) VALUES (?, ?, ?)');
  const deleteMemory = db.prepare('DELETE FROM memories WHERE id = ?');
  const deleteFts = db.prepare('DELETE FROM memories_fts WHERE id = ?');
  const getMemory = db.prepare('SELECT * FROM memories WHERE id = ?');

  const rebuildMirrorsInternal = (): void => {
    const rows = db
      .prepare('SELECT * FROM memories ORDER BY ts DESC')
      .all() as unknown as MemoryRow[];
    const entries = rows.map(rowToEntry);
    try {
      const temp = `${home.memory_json_path}.tmp`;
      writeFileSync(temp, `${JSON.stringify({ version: 1, updated_at: new Date().toISOString(), entries }, null, 2)}\n`, 'utf8');
      renameSync(temp, home.memory_json_path);
    } catch {
      // mirror write failure must not break memory writes
    }
    try {
      const lines: string[] = ['# opencursor memory', '', `updated: ${new Date().toISOString()}`, ''];
      const byKind = new Map<string, MemoryEntry[]>();
      for (const entry of entries) {
        const group = byKind.get(entry.kind) ?? [];
        group.push(entry);
        byKind.set(entry.kind, group);
      }
      for (const [kind, group] of byKind) {
        lines.push(`## ${kind}`, '');
        for (const entry of group.slice(0, 200)) {
          const tags = entry.tags.length > 0 ? ` _(${entry.tags.join(', ')})_` : '';
          lines.push(`- ${entry.ts.slice(0, 10)} ${entry.text}${tags}`);
        }
        lines.push('');
      }
      const temp = `${home.memory_md_path}.tmp`;
      writeFileSync(temp, lines.join('\n'), 'utf8');
      renameSync(temp, home.memory_md_path);
    } catch {
      // mirror write failure must not break memory writes
    }
  };

  return {
    add(input) {
      const entry: MemoryEntry = {
        id: randomUUID(),
        ts: new Date().toISOString(),
        kind: input.kind ?? 'note',
        text: input.text.trim(),
        tags: input.tags ?? [],
        session_id: input.session_id ?? null,
        source: input.source,
      };
      insertMemory.run(entry.id, entry.ts, entry.kind, entry.text, JSON.stringify(entry.tags), entry.session_id, entry.source);
      insertFts.run(entry.id, entry.text, entry.tags.join(' '));
      rebuildMirrorsInternal();
      return entry;
    },

    search(options) {
      const limit = Math.max(1, options.limit ?? 8);
      let rows: MemoryRow[] = [];
      const fts = options.query ? sanitizeFtsQuery(options.query) : null;
      if (fts) {
        try {
          const candidates = db
            .prepare(
              `SELECT m.* FROM memories m
               JOIN memories_fts f ON f.id = m.id
               WHERE memories_fts MATCH ?
               ORDER BY m.ts DESC
               LIMIT ?`,
            )
            .all(fts, limit * 4) as unknown as MemoryRow[];
          rows = candidates;
        } catch {
          rows = [];
        }
      }
      if (rows.length === 0) {
        rows = db
          .prepare('SELECT * FROM memories ORDER BY ts DESC LIMIT ?')
          .all(limit * 4) as unknown as MemoryRow[];
      }
      let entries = rows.map(rowToEntry);
      if (options.kind) entries = entries.filter((entry) => entry.kind === options.kind);
      if (options.tags && options.tags.length > 0) {
        entries = entries.filter((entry) => options.tags && options.tags.every((tag) => entry.tags.includes(tag)));
      }
      if (options.query && fts) {
        const lowerTokens = options.query.toLowerCase().split(/\s+/).filter((token) => token.length > 1);
        entries = entries.filter((entry) => {
          const haystack = `${entry.text} ${entry.tags.join(' ')}`.toLowerCase();
          return lowerTokens.some((token) => haystack.includes(token)) || lowerTokens.length === 0;
        });
      }
      return entries.slice(0, limit);
    },

    list(limit = 20) {
      const rows = db
        .prepare('SELECT * FROM memories ORDER BY ts DESC LIMIT ?')
        .all(limit) as unknown as MemoryRow[];
      return rows.map(rowToEntry);
    },

    forget(id) {
      const existing = getMemory.get(id) as unknown as MemoryRow | undefined;
      if (!existing) return false;
      deleteMemory.run(id);
      deleteFts.run(id);
      rebuildMirrorsInternal();
      return true;
    },

    count() {
      const row = db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number };
      return row.n;
    },

    digest(maxChars) {
      const rows = db
        .prepare("SELECT * FROM memories WHERE kind != 'note' ORDER BY ts DESC LIMIT 200")
        .all() as unknown as MemoryRow[];
      const entries = rows.map(rowToEntry);
      if (entries.length === 0) return '';
      const lines: string[] = [];
      let used = 0;
      for (const entry of entries) {
        const line = `- [${entry.kind}] ${entry.text}${entry.tags.length > 0 ? ` (${entry.tags.join(', ')})` : ''}`;
        if (used + line.length > maxChars) break;
        lines.push(line);
        used += line.length + 1;
      }
      if (lines.length === 0) return '';
      return `Remembered context (from previous sessions):\n${lines.join('\n')}`;
    },

    rebuildMirrors() {
      rebuildMirrorsInternal();
    },
  };
}
