/** Side panel — todos, sessions, memory, system, settings. */

import { useState } from 'react';
import { palette } from './theme.js';
import { Pill } from './primitives.js';
import { SettingsPanel } from './SettingsPanel.js';
import type { ServerClient } from '../lib/client.js';

export interface SidebarData {
  todos: Array<{ id: string; content: string; status: string }>;
  sessions: Array<{ id: string; updated_at: string; message_count: number }>;
  memories: Array<{ id: string; kind: string; text: string }>;
  mcp: Array<{ name: string; status: string; tools: Array<{ name: string }>; error?: string }>;
  index: { files: number; chunks: number };
  sessionId: string | null;
}

export function SidePanel({
  data,
  client,
  onLoadSession,
  onNewSession,
  onRunIndex,
  onClearIndex,
  onCompact,
  onUndo,
  onForgetMemory,
  onSettingsSaved,
}: {
  data: SidebarData;
  client: ServerClient;
  onLoadSession: (id: string) => void;
  onNewSession: () => void;
  onRunIndex: () => void;
  onClearIndex: () => void;
  onCompact: () => void;
  onUndo: () => void;
  onForgetMemory: (id: string) => void;
  onSettingsSaved: () => void;
}) {
  const [tab, setTab] = useState<'todos' | 'sessions' | 'memory' | 'system' | 'settings'>('todos');
  const tabs: Array<{ id: typeof tab; label: string }> = [
    { id: 'todos', label: `Todos ${data.todos.length > 0 ? `(${data.todos.filter((t) => t.status === 'completed').length}/${data.todos.length})` : ''}` },
    { id: 'sessions', label: 'Sessions' },
    { id: 'memory', label: 'Memory' },
    { id: 'system', label: 'System' },
    { id: 'settings', label: 'Settings' },
  ];

  return (
    <div style={{ width: 280, borderLeft: `1px solid ${palette.stroke.primary}`, background: palette.bg.chrome, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', borderBottom: `1px solid ${palette.stroke.primary}` }}>
        {tabs.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => setTab(entry.id)}
            style={{
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              background: 'transparent',
              border: 'none',
              borderBottom: tab === entry.id ? `2px solid ${palette.accent.primary}` : '2px solid transparent',
              color: tab === entry.id ? palette.text.primary : palette.text.tertiary,
              padding: '8px 2px',
              fontSize: 10,
              fontWeight: 600,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: 10, fontSize: 12 }}>
        {tab === 'todos' ? <TodoList todos={data.todos} /> : null}
        {tab === 'sessions' ? (
          <SessionList sessions={data.sessions} currentId={data.sessionId} onLoad={onLoadSession} onNew={onNewSession} />
        ) : null}
        {tab === 'memory' ? <MemoryList memories={data.memories} onForget={onForgetMemory} /> : null}
        {tab === 'system' ? (
          <SystemPanel data={data} onRunIndex={onRunIndex} onClearIndex={onClearIndex} onCompact={onCompact} onUndo={onUndo} />
        ) : null}
        {tab === 'settings' ? <SettingsPanel client={client} onSaved={onSettingsSaved} /> : null}
      </div>
    </div>
  );
}

function TodoList({ todos }: { todos: SidebarData['todos'] }) {
  if (todos.length === 0) return <div style={{ color: palette.text.tertiary }}>No todos yet — the agent creates them for multi-step work.</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {todos.map((todo) => {
        const color =
          todo.status === 'completed'
            ? palette.status.ok
            : todo.status === 'in_progress'
              ? palette.status.warn
              : todo.status === 'cancelled'
                ? palette.text.tertiary
                : palette.text.secondary;
        const glyph = todo.status === 'completed' ? '[x]' : todo.status === 'in_progress' ? '[~]' : todo.status === 'cancelled' ? '[-]' : '[ ]';
        return (
          <div key={todo.id} style={{ color, display: 'flex', gap: 6 }}>
            <span style={{ fontFamily: 'monospace', flexShrink: 0 }}>{glyph}</span>
            <span style={{ textDecoration: todo.status === 'completed' ? 'line-through' : 'none' }}>{todo.content}</span>
          </div>
        );
      })}
    </div>
  );
}

function SessionList({
  sessions,
  currentId,
  onLoad,
  onNew,
}: {
  sessions: SidebarData['sessions'];
  currentId: string | null;
  onLoad: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <div>
      <button type="button" onClick={onNew} style={{ width: '100%', marginBottom: 8, background: palette.accent.control, color: palette.text.primary, border: `1px solid ${palette.stroke.primary}`, borderRadius: 6, padding: '6px 0', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
        + New session
      </button>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {sessions.length === 0 ? <div style={{ color: palette.text.tertiary }}>No sessions yet.</div> : null}
        {sessions.map((session) => (
          <button
            key={session.id}
            type="button"
            onClick={() => onLoad(session.id)}
            style={{
              textAlign: 'left',
              background: session.id === currentId ? palette.fill.secondary : 'transparent',
              border: `1px solid ${session.id === currentId ? palette.stroke.primary : 'transparent'}`,
              borderRadius: 6,
              padding: '6px 8px',
              cursor: 'pointer',
              color: palette.text.secondary,
              fontSize: 11,
            }}
          >
            <div style={{ fontFamily: 'monospace' }}>{session.id.slice(0, 8)}</div>
            <div style={{ color: palette.text.tertiary, marginTop: 2 }}>
              {session.updated_at.slice(0, 16).replace('T', ' ')} · {session.message_count} msgs
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function MemoryList({ memories, onForget }: { memories: SidebarData['memories']; onForget: (id: string) => void }) {
  if (memories.length === 0) return <div style={{ color: palette.text.tertiary }}>No memories yet. The agent stores facts and decisions across sessions.</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {memories.map((entry) => (
        <div key={entry.id} style={{ borderBottom: `1px solid ${palette.stroke.tertiary}`, paddingBottom: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Pill tone="accent">{entry.kind}</Pill>
            <button type="button" onClick={() => onForget(entry.id)} title="forget" style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: palette.text.tertiary, cursor: 'pointer', fontSize: 11 }}>
              ✕
            </button>
          </div>
          <div style={{ color: palette.text.secondary, marginTop: 3 }}>{entry.text.slice(0, 160)}</div>
        </div>
      ))}
    </div>
  );
}

function SystemPanel({
  data,
  onRunIndex,
  onClearIndex,
  onCompact,
  onUndo,
}: {
  data: SidebarData;
  onRunIndex: () => void;
  onClearIndex: () => void;
  onCompact: () => void;
  onUndo: () => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <section>
        <div style={{ color: palette.text.tertiary, fontSize: 11, marginBottom: 4 }}>Semantic index</div>
        <div style={{ color: palette.text.secondary }}>
          {data.index.files} files · {data.index.chunks} chunks
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          <SmallButton onClick={onRunIndex}>Build index</SmallButton>
          <SmallButton onClick={onClearIndex}>Clear</SmallButton>
        </div>
      </section>
      <section>
        <div style={{ color: palette.text.tertiary, fontSize: 11, marginBottom: 4 }}>Context</div>
        <div style={{ display: 'flex', gap: 6 }}>
          <SmallButton onClick={onCompact}>Compact conversation</SmallButton>
          <SmallButton onClick={onUndo}>Undo last edits</SmallButton>
        </div>
      </section>
      <section>
        <div style={{ color: palette.text.tertiary, fontSize: 11, marginBottom: 4 }}>MCP servers</div>
        {data.mcp.length === 0 ? (
          <div style={{ color: palette.text.tertiary }}>None configured (edit ~/.opencursor/config.json)</div>
        ) : (
          data.mcp.map((server) => (
            <div key={server.name} style={{ marginBottom: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ color: palette.text.secondary }}>{server.name}</span>
                <Pill tone={server.status === 'connected' ? 'ok' : 'error'}>{server.status}</Pill>
              </div>
              <div style={{ color: palette.text.tertiary, fontSize: 11, marginTop: 2 }}>
                {server.status === 'connected' ? server.tools.map((tool) => tool.name).join(', ') || 'no tools' : server.error ?? ''}
              </div>
            </div>
          ))
        )}
      </section>
    </div>
  );
}

function SmallButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} style={{ background: palette.fill.secondary, color: palette.text.secondary, border: `1px solid ${palette.stroke.secondary}`, borderRadius: 6, padding: '5px 10px', fontSize: 11, cursor: 'pointer' }}>
      {children}
    </button>
  );
}
