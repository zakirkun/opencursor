/** Index store — SQLite persistence for indexed files and their embedding chunks. */

import type { DatabaseSync } from 'node:sqlite';
import { bufferToFloat32, float32ToBuffer } from './embeddings.js';
import type { Chunk } from './chunker.js';

export interface IndexedFileRecord {
  path: string;
  sha256: string;
  mtime_ms: number;
  size: number;
  chunk_count: number;
}

export interface ChunkRecord {
  path: string;
  start_line: number;
  end_line: number;
  text: string;
  embedding: Float32Array;
}

export interface IndexStats {
  files: number;
  chunks: number;
}

export interface IndexStore {
  getFile(path: string): IndexedFileRecord | null;
  upsertFile(record: IndexedFileRecord, chunks: Array<Chunk & { embedding: Float32Array }>): void;
  removeFile(path: string): void;
  listFiles(): IndexedFileRecord[];
  loadChunks(): ChunkRecord[];
  loadChunksForFile(path: string): ChunkRecord[];
  stats(): IndexStats;
  clear(): void;
}

interface FileRow {
  path: string;
  sha256: string;
  mtime_ms: number;
  size: number;
  chunk_count: number;
}

interface ChunkRow {
  path: string;
  start_line: number;
  end_line: number;
  text: string;
  embedding: Uint8Array;
}

export function createIndexStore(db: DatabaseSync): IndexStore {
  const getFileStmt = db.prepare('SELECT path, sha256, mtime_ms, size, chunk_count FROM indexed_files WHERE path = ?');
  const insertFile = db.prepare(
    `INSERT INTO indexed_files (path, sha256, mtime_ms, size, chunk_count, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       sha256 = excluded.sha256,
       mtime_ms = excluded.mtime_ms,
       size = excluded.size,
       chunk_count = excluded.chunk_count,
       indexed_at = excluded.indexed_at`,
  );
  const deleteChunks = db.prepare('DELETE FROM chunks WHERE path = ?');
  const insertChunk = db.prepare(
    'INSERT INTO chunks (path, start_line, end_line, text, embedding) VALUES (?, ?, ?, ?, ?)',
  );
  const deleteFileStmt = db.prepare('DELETE FROM indexed_files WHERE path = ?');
  const listFilesStmt = db.prepare('SELECT path, sha256, mtime_ms, size, chunk_count FROM indexed_files ORDER BY path');
  const loadChunksStmt = db.prepare('SELECT path, start_line, end_line, text, embedding FROM chunks');
  const loadChunksForFileStmt = db.prepare(
    'SELECT path, start_line, end_line, text, embedding FROM chunks WHERE path = ? ORDER BY start_line',
  );
  const statsStmt = db.prepare(
    'SELECT (SELECT COUNT(*) FROM indexed_files) AS files, (SELECT COUNT(*) FROM chunks) AS chunks',
  );
  const clearFiles = db.prepare('DELETE FROM indexed_files');
  const clearChunks = db.prepare('DELETE FROM chunks');

  return {
    getFile(path) {
      const row = getFileStmt.get(path) as unknown as FileRow | undefined;
      return row ? { ...row } : null;
    },

    upsertFile(record, chunks) {
      insertFile.run(record.path, record.sha256, record.mtime_ms, record.size, record.chunk_count, new Date().toISOString());
      deleteChunks.run(record.path);
      for (const chunk of chunks) {
        insertChunk.run(record.path, chunk.start_line, chunk.end_line, chunk.text, float32ToBuffer(chunk.embedding) as never);
      }
    },

    removeFile(path) {
      deleteFileStmt.run(path);
      deleteChunks.run(path);
    },

    listFiles() {
      const rows = listFilesStmt.all() as unknown as FileRow[];
      return rows.map((row) => ({ ...row }));
    },

    loadChunks() {
      const rows = loadChunksStmt.all() as unknown as ChunkRow[];
      return rows.map((row) => ({
        path: row.path,
        start_line: row.start_line,
        end_line: row.end_line,
        text: row.text,
        embedding: bufferToFloat32(Buffer.from(row.embedding)),
      }));
    },

    loadChunksForFile(path) {
      const rows = loadChunksForFileStmt.all(path) as unknown as ChunkRow[];
      return rows.map((row) => ({
        path: row.path,
        start_line: row.start_line,
        end_line: row.end_line,
        text: row.text,
        embedding: bufferToFloat32(Buffer.from(row.embedding)),
      }));
    },

    stats() {
      const row = statsStmt.get() as unknown as { files: number; chunks: number };
      return { files: row.files, chunks: row.chunks };
    },

    clear() {
      clearFiles.run();
      clearChunks.run();
    },
  };
}
