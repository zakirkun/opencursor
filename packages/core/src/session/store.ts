/** File-backed session persistence. */

import { appendFile, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SessionListing, SessionOpRecord, SessionStore } from '../types.js';
import type { SessionState } from '../protocol/session.js';

function defaultRoot(): string {
  return process.env['OPENCURSOR_SESSION_DIR'] ?? path.join(process.cwd(), '.opencursor', 'sessions');
}

async function writeAtomic(target: string, content: string): Promise<void> {
  const temp = `${target}.tmp`;
  await writeFile(temp, content, 'utf8');
  try {
    await rename(temp, target);
  } catch {
    await unlink(target).catch(() => undefined);
    await rename(temp, target);
  }
}

export function createFileSessionStore(rootDir?: string): SessionStore {
  const root = rootDir ?? defaultRoot();

  const ensureRoot = async (): Promise<void> => {
    await mkdir(root, { recursive: true });
  };

  return {
    async load(id: string): Promise<SessionState | null> {
      const file = path.join(root, `${id}.json`);
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch {
        return null;
      }
      try {
        return JSON.parse(text) as SessionState;
      } catch {
        await rename(file, `${file}.bad`).catch(() => undefined);
        return null;
      }
    },

    async save(state: SessionState): Promise<void> {
      await ensureRoot();
      state.updated_at = new Date().toISOString();
      await writeAtomic(path.join(root, `${state.id}.json`), JSON.stringify(state, null, 2));
    },

    async appendOp(id: string, op: SessionOpRecord): Promise<void> {
      await ensureRoot();
      await appendFile(path.join(root, `${id}.ndjson`), `${JSON.stringify(op)}\n`, 'utf8');
    },

    async latestId(): Promise<string | null> {
      const listing = await this.list();
      return listing[0]?.id ?? null;
    },

    async list(): Promise<SessionListing[]> {
      await ensureRoot();
      const entries = await readdir(root).catch(() => []);
      const sessions: SessionListing[] = [];
      for (const entry of entries) {
        if (!entry.endsWith('.json') || entry.endsWith('.bad') || entry.endsWith('.tmp')) continue;
        try {
          const text = await readFile(path.join(root, entry), 'utf8');
          const state = JSON.parse(text) as SessionState;
          sessions.push({
            id: state.id,
            updated_at: state.updated_at,
            message_count: state.messages.length,
          });
        } catch {
          continue;
        }
      }
      sessions.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
      return sessions;
    },
  };
}
