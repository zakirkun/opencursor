import type { DatabaseSync } from 'node:sqlite';
import { createIndexer } from './indexer.js';
import type { Indexer } from './indexer.js';
import { createIndexStore } from './store.js';
import { LocalHashingEmbeddings, OpenAIEmbeddings } from './embeddings.js';
import type { EmbeddingsProvider } from './embeddings.js';

export function createDefaultEmbeddings(): EmbeddingsProvider {
  const provider = process.env['OPENCURSOR_EMBEDDINGS_PROVIDER'] ?? 'local';
  if (provider === 'openai') {
    return new OpenAIEmbeddings({ model: process.env['OPENCURSOR_EMBEDDINGS_MODEL'] ?? 'text-embedding-3-small' });
  }
  return new LocalHashingEmbeddings();
}

export function createDefaultIndexer(opts: { cwd: string; db: DatabaseSync }): Indexer {
  const store = createIndexStore(opts.db);
  const embeddings = createDefaultEmbeddings();
  const metaGet = opts.db.prepare('SELECT value FROM meta WHERE key = ?');
  const metaSet = opts.db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  const current = metaGet.get('embeddings_id') as { value: string } | undefined;
  if (current && current.value !== embeddings.id) store.clear();
  metaSet.run('embeddings_id', embeddings.id);
  return createIndexer({ cwd: opts.cwd, store, embeddings });
}

export { createIndexer } from './indexer.js';
export type { Indexer, IndexRunResult, SemanticHit, IndexerOptions } from './indexer.js';
export { createIndexStore } from './store.js';
export type { IndexStore, IndexedFileRecord, ChunkRecord, IndexStats } from './store.js';
export { chunkFile } from './chunker.js';
export type { Chunk, ChunkerOptions } from './chunker.js';
export { LocalHashingEmbeddings, OpenAIEmbeddings, cosineSimilarity, float32ToBuffer, bufferToFloat32 } from './embeddings.js';
export type { EmbeddingsProvider } from './embeddings.js';
