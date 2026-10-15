/** File checkpoints — pre-edit snapshots enabling undo (agent.v1 UndoEdit flow). */

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { CheckpointInfo } from '../protocol/session.js';

export interface CheckpointRecord extends CheckpointInfo {
  content: Buffer | null;
}

export interface CheckpointStore {
  capture(input: { session_id: string; tool: string; path: string; existed: boolean; content: Buffer | null }): CheckpointInfo;
  list(session_id: string, limit?: number): CheckpointInfo[];
  get(id: string): CheckpointRecord | null;
  remove(id: string): void;
  clearSession(session_id: string): void;
  prune(session_id: string, keep: number): void;
}

interface CheckpointRow {
  id: string;
  session_id: string;
  created_at: string;
  tool: string;
  path: string;
  existed: number;
  content: Uint8Array | null;
}

function rowToRecord(row: CheckpointRow): CheckpointRecord {
  return {
    id: row.id,
    session_id: row.session_id,
    created_at: row.created_at,
    tool: row.tool,
    path: row.path,
    existed: row.existed === 1,
    bytes: row.content ? row.content.byteLength : 0,
    content: row.content ? Buffer.from(row.content) : null,
  };
}

export function createCheckpointStore(db: DatabaseSync): CheckpointStore {
  const insert = db.prepare(
    'INSERT INTO checkpoints (id, session_id, created_at, tool, path, existed, content) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const listStmt = db.prepare(
    'SELECT id, session_id, created_at, tool, path, existed, length(content) AS bytes FROM checkpoints WHERE session_id = ? ORDER BY created_at DESC LIMIT ?',
  );
  const getStmt = db.prepare('SELECT * FROM checkpoints WHERE id = ?');
  const removeStmt = db.prepare('DELETE FROM checkpoints WHERE id = ?');
  const clearStmt = db.prepare('DELETE FROM checkpoints WHERE session_id = ?');
  const pruneStmt = db.prepare(
    `DELETE FROM checkpoints WHERE session_id = ? AND id NOT IN (
       SELECT id FROM checkpoints WHERE session_id = ? ORDER BY created_at DESC LIMIT ?
     )`,
  );

  return {
    capture(input): CheckpointInfo {
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      insert.run(
        id,
        input.session_id,
        createdAt,
        input.tool,
        input.path,
        input.existed ? 1 : 0,
        input.content as never,
      );
      return {
        id,
        session_id: input.session_id,
        created_at: createdAt,
        tool: input.tool,
        path: input.path,
        existed: input.existed,
        bytes: input.content ? input.content.byteLength : 0,
      };
    },

    list(session_id, limit = 20): CheckpointInfo[] {
      const rows = listStmt.all(session_id, limit) as unknown as Array<CheckpointRow & { bytes: number }>;
      return rows.map((row) => ({
        id: row.id,
        session_id: row.session_id,
        created_at: row.created_at,
        tool: row.tool,
        path: row.path,
        existed: row.existed === 1,
        bytes: row.bytes ?? 0,
      }));
    },

    get(id): CheckpointRecord | null {
      const row = getStmt.get(id) as unknown as CheckpointRow | undefined;
      return row ? rowToRecord(row) : null;
    },

    remove(id): void {
      removeStmt.run(id);
    },

    clearSession(session_id): void {
      clearStmt.run(session_id);
    },

    prune(session_id, keep): void {
      pruneStmt.run(session_id, session_id, keep);
    },
  };
}
