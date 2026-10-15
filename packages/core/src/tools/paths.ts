/** Path safety helpers — all tool paths resolve through here. */

import path from 'node:path';
import type { ToolOutcome } from '../protocol/tools.js';
import { err } from '../protocol/tools.js';

export type ResolvedPath =
  | { ok: true; abs: string }
  | { ok: false; outcome: ToolOutcome<never> };

/**
 * Resolve a tool path argument.
 * - Absolute paths are accepted as-is.
 * - Relative paths resolve against the workspace root and must stay inside it.
 */
export function resolveInWorkspace(cwd: string, p: string): ResolvedPath {
  if (p.trim().length === 0) {
    return { ok: false, outcome: err('invalid_args', 'empty path') };
  }
  if (path.isAbsolute(p)) {
    return { ok: true, abs: path.normalize(p) };
  }
  const abs = path.resolve(cwd, p);
  const rel = path.relative(cwd, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, outcome: err('permission_denied', `path escapes workspace: ${p}`) };
  }
  return { ok: true, abs };
}

/** Display path: workspace-relative with forward slashes when inside, else absolute. */
export function displayPath(cwd: string, abs: string): string {
  const rel = path.relative(cwd, abs);
  if (rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    return rel.split(path.sep).join('/');
  }
  return abs.split(path.sep).join('/');
}
