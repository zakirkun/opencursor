/** In-memory session store for subagent child sessions. */

import type { SessionListing, SessionOpRecord, SessionStore } from '../types.js';
import type { SessionState } from '../protocol/session.js';

export function createMemorySessionStore(): SessionStore {
  const sessions = new Map<string, SessionState>();
  return {
    async load(id: string): Promise<SessionState | null> {
      const state = sessions.get(id);
      return state ? structuredClone(state) : null;
    },
    async save(state: SessionState): Promise<void> {
      state.updated_at = new Date().toISOString();
      sessions.set(state.id, structuredClone(state));
    },
    async appendOp(_id: string, _op: SessionOpRecord): Promise<void> {
      // ops are not persisted for ephemeral child sessions
    },
    async latestId(): Promise<string | null> {
      let latest: SessionState | null = null;
      for (const state of sessions.values()) {
        if (!latest || state.updated_at > latest.updated_at) latest = state;
      }
      return latest?.id ?? null;
    },
    async list(): Promise<SessionListing[]> {
      return [...sessions.values()].map((state) => ({
        id: state.id,
        updated_at: state.updated_at,
        message_count: state.messages.length,
      }));
    },
  };
}
