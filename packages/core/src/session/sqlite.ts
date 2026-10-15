/** SQLite-backed session store (source of truth for sessions/messages/ops). */

import type { DatabaseSync } from 'node:sqlite';
import type { SessionListing, SessionOpRecord, SessionStore } from '../types.js';
import type { SessionState } from '../protocol/session.js';

interface SessionRow {
  id: string;
  created_at: string;
  updated_at: string;
  cwd: string;
  model_provider: string;
  model_id: string;
  usage_json: string;
  summary_json: string | null;
}

interface MessageRow {
  data_json: string;
}

interface TodoRow {
  data_json: string;
}

export function createSqliteSessionStore(db: DatabaseSync): SessionStore {
  const upsertSession = db.prepare(
    `INSERT INTO sessions (id, created_at, updated_at, cwd, model_provider, model_id, usage_json, summary_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       updated_at = excluded.updated_at,
       cwd = excluded.cwd,
       model_provider = excluded.model_provider,
       model_id = excluded.model_id,
       usage_json = excluded.usage_json,
       summary_json = excluded.summary_json`,
  );
  const deleteMessages = db.prepare('DELETE FROM messages WHERE session_id = ?');
  const insertMessage = db.prepare(
    'INSERT INTO messages (session_id, seq, data_json, created_at) VALUES (?, ?, ?, ?)',
  );
  const deleteTodos = db.prepare('DELETE FROM todos WHERE session_id = ?');
  const insertTodo = db.prepare('INSERT INTO todos (session_id, todo_id, data_json) VALUES (?, ?, ?)');
  const insertOp = db.prepare('INSERT INTO ops (session_id, ts, event_json) VALUES (?, ?, ?)');
  const getSession = db.prepare('SELECT * FROM sessions WHERE id = ?');
  const getMessages = db.prepare('SELECT data_json FROM messages WHERE session_id = ? ORDER BY seq ASC');
  const getTodos = db.prepare('SELECT data_json FROM todos WHERE session_id = ?');
  const listSessions = db.prepare(
    `SELECT id, updated_at, (SELECT COUNT(*) FROM messages WHERE session_id = sessions.id) AS message_count
     FROM sessions ORDER BY updated_at DESC`,
  );
  const latest = db.prepare('SELECT id FROM sessions ORDER BY updated_at DESC LIMIT 1');

  return {
    async load(id: string): Promise<SessionState | null> {
      const row = getSession.get(id) as unknown as SessionRow | undefined;
      if (!row) return null;
      const messages = (getMessages.all(id) as unknown as MessageRow[]).map((message) =>
        JSON.parse(message.data_json),
      );
      const todos = (getTodos.all(id) as unknown as TodoRow[]).map((todo) => JSON.parse(todo.data_json));
      let usage: { input_tokens: number; output_tokens: number } = { input_tokens: 0, output_tokens: 0 };
      try {
        usage = JSON.parse(row.usage_json) as typeof usage;
      } catch {
        // fall back to zeroed usage
      }
      const loaded: SessionState = {
        version: 1,
        id: row.id,
        created_at: row.created_at,
        updated_at: row.updated_at,
        cwd: row.cwd,
        model: { provider: row.model_provider, id: row.model_id },
        messages: messages as SessionState['messages'],
        todos: todos as SessionState['todos'],
        usage,
      };
      if (row.summary_json) {
        try {
          loaded.summary = JSON.parse(row.summary_json) as SessionState['summary'];
        } catch {
          // a corrupt summary is dropped rather than failing the load
        }
      }
      return loaded;
    },

    async save(state: SessionState): Promise<void> {
      state.updated_at = new Date().toISOString();
      upsertSession.run(
        state.id,
        state.created_at,
        state.updated_at,
        state.cwd,
        state.model.provider,
        state.model.id,
        JSON.stringify(state.usage),
        state.summary ? JSON.stringify(state.summary) : null,
      );
      deleteMessages.run(state.id);
      state.messages.forEach((message, index) => {
        insertMessage.run(state.id, index, JSON.stringify(message), message.timestamp);
      });
      deleteTodos.run(state.id);
      for (const todo of state.todos) {
        insertTodo.run(state.id, todo.id, JSON.stringify(todo));
      }
    },

    async appendOp(id: string, op: SessionOpRecord): Promise<void> {
      insertOp.run(id, op.ts, JSON.stringify(op.event));
    },

    async latestId(): Promise<string | null> {
      const row = latest.get() as unknown as { id: string } | undefined;
      return row?.id ?? null;
    },

    async list(): Promise<SessionListing[]> {
      const rows = listSessions.all() as unknown as Array<{ id: string; updated_at: string; message_count: number }>;
      return rows.map((row) => ({ id: row.id, updated_at: row.updated_at, message_count: row.message_count }));
    },
  };
}
