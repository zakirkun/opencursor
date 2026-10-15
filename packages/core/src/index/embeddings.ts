/** Embeddings provider abstraction — Anthropic/OpenAI-compatible or a local hashing fallback. */

export interface EmbeddingsProvider {
  readonly id: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export function float32ToBuffer(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function bufferToFloat32(buffer: Buffer): Float32Array {
  return new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Deterministic local embedding — hashed token buckets with L2 normalization. */
export class LocalHashingEmbeddings implements EmbeddingsProvider {
  readonly id = 'local-hashing';
  readonly dimensions: number;

  constructor(dimensions = 512) {
    this.dimensions = dimensions;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => this.embedOne(text));
  }

  private embedOne(text: string): Float32Array {
    const vector = new Float32Array(this.dimensions);
    const tokens = text
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((token) => token.length >= 2);
    for (const token of tokens) {
      const hash = fnv1a(token);
      const bucket = hash % this.dimensions;
      const sign = (hash & 0x80000000) === 0 ? 1 : -1;
      vector[bucket] = (vector[bucket] ?? 0) + sign;
      const bigramHash = fnv1a(token.slice(0, 2));
      const bigramBucket = bigramHash % this.dimensions;
      vector[bigramBucket] = (vector[bigramBucket] ?? 0) + sign * 0.5;
    }
    let norm = 0;
    for (let i = 0; i < vector.length; i++) norm += (vector[i] ?? 0) ** 2;
    if (norm > 0) {
      const inv = 1 / Math.sqrt(norm);
      for (let i = 0; i < vector.length; i++) vector[i] = (vector[i] ?? 0) * inv;
    }
    return vector;
  }
}

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

interface OpenAIEmbeddingsResponse {
  data?: Array<{ embedding?: number[] }>;
  error?: { message?: string };
}

/** OpenAI-compatible embeddings endpoint (also serves compatible local servers). */
export class OpenAIEmbeddings implements EmbeddingsProvider {
  readonly id: string;
  readonly dimensions: number;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly batchSize: number;

  constructor(opts: {
    model: string;
    base_url?: string;
    api_key?: string;
    dimensions?: number;
    batch_size?: number;
  }) {
    this.model = opts.model;
    this.baseUrl = (opts.base_url ?? process.env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.apiKey = opts.api_key ?? process.env['OPENAI_API_KEY'] ?? '';
    this.dimensions = opts.dimensions ?? 1536;
    this.batchSize = opts.batch_size ?? 64;
    this.id = `openai:${this.model}`;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (this.apiKey.length === 0) {
      throw new Error('embeddings: OPENAI_API_KEY is not set');
    }
    const results: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const response = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.model, input: batch }),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`embeddings request failed: ${response.status} ${detail.slice(0, 300)}`);
      }
      const payload = (await response.json()) as OpenAIEmbeddingsResponse;
      if (payload.error) throw new Error(`embeddings error: ${payload.error.message ?? 'unknown'}`);
      for (const item of payload.data ?? []) {
        results.push(Float32Array.from(item.embedding ?? []));
      }
    }
    if (results.length !== texts.length) {
      throw new Error(`embeddings: expected ${texts.length} vectors, received ${results.length}`);
    }
    return results;
  }
}
