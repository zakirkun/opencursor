/** Minimal LCS line diff — bounded, dependency-free. */

const MAX_CELLS = 640_000;

/**
 * Returns a unified-style diff body (no hunk headers, full sequence with
 * markers) or null when inputs are too large for the bounded LCS.
 */
export function lineDiff(oldLines: string[], newLines: string[]): string | null {
  const n = oldLines.length;
  const m = newLines.length;
  if (n === 0 && m === 0) return '';
  if ((n + 1) * (m + 1) > MAX_CELLS) return null;

  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  const at = (i: number, j: number): number => dp[i * width + j] ?? 0;

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        oldLines[i] === newLines[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }

  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const oldLine = oldLines[i] ?? '';
    const newLine = newLines[j] ?? '';
    if (oldLine === newLine) {
      out.push(` ${oldLine}`);
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      out.push(`-${oldLine}`);
      i++;
    } else {
      out.push(`+${newLine}`);
      j++;
    }
  }
  while (i < n) {
    out.push(`-${oldLines[i] ?? ''}`);
    i++;
  }
  while (j < m) {
    out.push(`+${newLines[j] ?? ''}`);
    j++;
  }
  return out.join('\n');
}

export function splitLines(text: string): string[] {
  const lines = text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
