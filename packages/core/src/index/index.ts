import type { DatabaseSync } from 'node:sqlite';
import { createIndexer } from './indexer.js';
import type { Indexer } from './indexer.js';
import { createIndexStore } from './store.js';
import { LocalHashingEmbeddings, OpenAIEmbeddings } from './embeddings.js';
import type { EmbeddingsProvider } from './embeddings.js';

export interface EmbeddingsSettings {
  provider?: 'local' | 'openai' | null;
  model?: string | null;
  base_url?: string | null;
  api_key?: string | null;
}

export function createDefaultEmbeddings(settings?: EmbeddingsSettings): EmbeddingsProvider {
  const provider = settings?.provider ?? (process.env['OPENCURSOR_EMBEDDINGS_PROVIDER'] as 'local' | 'openai' | undefined) ?? 'local';
  if (provider === 'openai') {
    const options: { model: string; base_url?: string; api_key?: string } = {
      model: settings?.model ?? process.env['OPENCURSOR_EMBEDDINGS_MODEL'] ?? 'text-embedding-3-small',
    };
    const baseUrl = settings?.base_url ?? process.env['OPENCURSOR_EMBEDDINGS_BASE_URL'];
    const apiKey = settings?.api_key ?? process.env['OPENCURSOR_EMBEDDINGS_API_KEY'];
    if (baseUrl) options.base_url = baseUrl;
    if (apiKey) options.api_key = apiKey;
    return new OpenAIEmbeddings(options);
  }
  return new LocalHashingEmbeddings();
}

export function createDefaultIndexer(opts: { cwd: string; db: DatabaseSync; embeddings?: EmbeddingsSettings }): Indexer {
  const store = createIndexStore(opts.db);
  const embeddings = createDefaultEmbeddings(opts.embeddings);
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
