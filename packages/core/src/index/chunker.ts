/** Chunker — line-window chunks with overlap and language-agnostic boundaries. */

export interface Chunk {
  start_line: number;
  end_line: number;
  text: string;
}

export interface ChunkerOptions {
  max_lines?: number;
  overlap_lines?: number;
  max_chars?: number;
}

const DEFAULT_MAX_LINES = 60;
const DEFAULT_OVERLAP = 10;
const DEFAULT_MAX_CHARS = 4000;

export function chunkFile(content: string, opts?: ChunkerOptions): Chunk[] {
  const maxLines = opts?.max_lines ?? DEFAULT_MAX_LINES;
  const overlap = opts?.overlap_lines ?? DEFAULT_OVERLAP;
  const maxChars = opts?.max_chars ?? DEFAULT_MAX_CHARS;

  const lines = content.split('\n');
  if (lines.length === 0) return [];
  const chunks: Chunk[] = [];
  let start = 0;
  while (start < lines.length) {
    let end = Math.min(start + maxLines, lines.length);
    let text = lines.slice(start, end).join('\n');
    while (text.length > maxChars && end - start > 1) {
      end = start + Math.max(1, Math.floor((end - start) / 2));
      text = lines.slice(start, end).join('\n');
    }
    const trimmed = text.trim();
    if (trimmed.length > 0) {
      chunks.push({ start_line: start + 1, end_line: end, text });
    }
    if (end >= lines.length) break;
    const next = end - overlap;
    start = next > start ? next : end;
  }
  return chunks;
}
