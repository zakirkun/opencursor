/** Message archives — full message history preserved when a conversation is compacted. */

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Message } from '../protocol/session.js';

export interface MessageArchiveInfo {
  id: string;
  session_id: string;
  created_at: string;
  message_count: number;
}

export interface MessageArchiveStore {
  archive(session_id: string, messages: Message[]): MessageArchiveInfo;
  list(session_id: string, limit?: number): MessageArchiveInfo[];
  get(id: string): { info: MessageArchiveInfo; messages: Message[] } | null;
  clearSession(session_id: string): void;
}

interface ArchiveRow {
  id: string;
  session_id: string;
  created_at: string;
  data_json: string;
}

function parseMessages(dataJson: string): Message[] {
  try {
    const parsed = JSON.parse(dataJson) as unknown;
    return Array.isArray(parsed) ? (parsed as Message[]) : [];
  } catch {
    return [];
  }
}

export function createArchiveStore(db: DatabaseSync): MessageArchiveStore {
  const insert = db.prepare('INSERT INTO message_archives (id, session_id, created_at, data_json) VALUES (?, ?, ?, ?)');
  const listStmt = db.prepare(
    'SELECT id, session_id, created_at, data_json FROM message_archives WHERE session_id = ? ORDER BY created_at DESC LIMIT ?',
  );
  const getStmt = db.prepare('SELECT * FROM message_archives WHERE id = ?');
  const clearStmt = db.prepare('DELETE FROM message_archives WHERE session_id = ?');

  return {
    archive(session_id, messages): MessageArchiveInfo {
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      insert.run(id, session_id, createdAt, JSON.stringify(messages));
      return { id, session_id, created_at: createdAt, message_count: messages.length };
    },

    list(session_id, limit = 10): MessageArchiveInfo[] {
      const rows = listStmt.all(session_id, limit) as unknown as ArchiveRow[];
      return rows.map((row) => ({
        id: row.id,
        session_id: row.session_id,
        created_at: row.created_at,
        message_count: parseMessages(row.data_json).length,
      }));
    },

    get(id) {
      const row = getStmt.get(id) as unknown as ArchiveRow | undefined;
      if (!row) return null;
      const messages = parseMessages(row.data_json);
      return {
        info: { id: row.id, session_id: row.session_id, created_at: row.created_at, message_count: messages.length },
        messages,
      };
    },

    clearSession(session_id): void {
      clearStmt.run(session_id);
    },
  };
}
