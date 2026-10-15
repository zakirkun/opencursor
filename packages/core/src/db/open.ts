/** SQLite open + schema bootstrap (node:sqlite). */

import { DatabaseSync } from 'node:sqlite';

const SCHEMA_VERSION = 3;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  cwd TEXT NOT NULL,
  model_provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  usage_json TEXT NOT NULL DEFAULT '{}',
  summary_json TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
CREATE TABLE IF NOT EXISTS ops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  event_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ops_session ON ops(session_id, id);
CREATE TABLE IF NOT EXISTS todos (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  todo_id TEXT NOT NULL,
  data_json TEXT NOT NULL,
  PRIMARY KEY (session_id, todo_id)
);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  session_id TEXT,
  source TEXT NOT NULL,
  meta_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_memories_kind_ts ON memories(kind, ts DESC);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(id UNINDEXED, text, tags);
CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  tool TEXT NOT NULL,
  path TEXT NOT NULL,
  existed INTEGER NOT NULL,
  content BLOB
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON checkpoints(session_id, created_at DESC);
CREATE TABLE IF NOT EXISTS message_archives (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  data_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_archives_session ON message_archives(session_id, created_at DESC);
CREATE TABLE IF NOT EXISTS indexed_files (
  path TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  mtime_ms INTEGER NOT NULL,
  size INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL,
  indexed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  text TEXT NOT NULL,
  embedding BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
`;

export interface DatabaseOptions {
  wal?: boolean;
  busy_timeout_ms?: number;
}

export function openDatabase(filePath: string, opts?: DatabaseOptions): DatabaseSync {
  const db = new DatabaseSync(filePath);
  if (opts?.wal !== false && filePath !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
  }
  db.exec(`PRAGMA busy_timeout = ${opts?.busy_timeout_ms ?? 3000}`);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  const current = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
    | { value: string }
    | undefined;
  if (!current) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
  } else if (Number(current.value) < SCHEMA_VERSION) {
    db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(SCHEMA_VERSION), 'schema_version');
  }
  return db;
}

function migrate(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info('sessions')").all() as unknown as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'summary_json')) {
    db.exec('ALTER TABLE sessions ADD COLUMN summary_json TEXT');
  }
}

export function closeDatabase(db: DatabaseSync): void {
  try {
    db.close();
  } catch {
    // already closed
  }
}
