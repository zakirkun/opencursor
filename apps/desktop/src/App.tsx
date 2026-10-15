/** opencursor desktop GUI — main application. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ServerClient } from './lib/client.js';
import { applyServerMessage } from './lib/transcript.js';
import type { PermissionView, QuestionView, TranscriptItem } from './lib/transcript.js';
import { TranscriptView } from './ui/TranscriptView.js';
import { Composer } from './ui/Composer.js';
import { SidePanel } from './ui/SidePanel.js';
import type { SidebarData } from './ui/SidePanel.js';
import { PermissionDialog } from './ui/PermissionDialog.js';
import { QuestionDialog } from './ui/QuestionDialog.js';
import { palette } from './ui/theme.js';

interface StatusResult {
  cwd: string;
  session_id: string | null;
  model: { provider: string | null; id: string | null };
  model_configured: boolean;
  model_reason: string | null;
  mcp: Array<{ name: string; status: string; tools: Array<{ name: string }>; error?: string }>;
  index: { files: number; chunks: number };
}
const EMPTY_SIDEBAR: SidebarData = {
  todos: [],
  sessions: [],
  memories: [],
  mcp: [],
  index: { files: 0, chunks: 0 },
  sessionId: null,
};

export function App({ port }: { port: number }) {
  const client = useMemo(() => new ServerClient(`http://127.0.0.1:${port}`), [port]);
  const [items, setItems] = useState<TranscriptItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState<StatusResult | null>(null);
  const [sidebar, setSidebar] = useState<SidebarData>(EMPTY_SIDEBAR);
  const [permission, setPermission] = useState<PermissionView | null>(null);
  const [question, setQuestion] = useState<QuestionView | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [mode, setMode] = useState<'agent' | 'plan'>('agent');
  const sessionIdRef = useRef<string | null>(null);

  const refreshSidebar = useCallback(async () => {
    try {
      const [todos, sessions, memories, mcp, index] = await Promise.all([
        client.call<{ todos: SidebarData['todos'] }>('todos'),
        client.call<{ sessions: SidebarData['sessions'] }>('session.list'),
        client.call<{ entries: SidebarData['memories'] }>('memory.list', { limit: 50 }),
        client.call<{ servers: SidebarData['mcp'] }>('mcp.status'),
        client.call<{ files: number; chunks: number }>('index.status'),
      ]);
      setSidebar({
        todos: todos.todos,
        sessions: sessions.sessions,
        memories: memories.entries,
        mcp: mcp.servers,
        index,
        sessionId: sessionIdRef.current,
      });
    } catch {
      // sidebar refresh failures are non-fatal
    }
  }, [client]);

  const refreshStatus = useCallback(async () => {
    try {
      const statusResult = await client.call<StatusResult>('status');
      setStatus(statusResult);
    } catch {
      // status refresh failures surface through the connection indicator
    }
  }, [client]);

  const switchMode = useCallback(
    async (next: 'agent' | 'plan') => {
      const previous = mode;
      setMode(next);
      try {
        await client.call('mode.set', { mode: next });
      } catch (error) {
        setMode(previous);
        setItems((current) => [
          ...current,
          { kind: 'notice', id: `merr-${Date.now()}`, tone: 'error', text: error instanceof Error ? error.message : String(error) },
        ]);
      }
    },
    [client, mode],
  );

  useEffect(() => {
    let disposed = false;
    const connect = async (): Promise<void> => {
      try {
        const statusResult = await client.call<StatusResult>('status');
        if (disposed) return;
        setStatus(statusResult);
        setConnected(true);
        setConnectionError(null);
        sessionIdRef.current = statusResult.session_id;
        if (statusResult.session_id) {
          const state = await client.call<{ state: { messages: Array<Record<string, unknown>>; mode?: string } | null }>('session.state');
          if (state.state) {
            setItems(seedFromState(state.state.messages));
            setMode(state.state.mode === 'plan' ? 'plan' : 'agent');
          }
        } else {
          const created = await client.call<{ session_id: string }>('session.new');
          sessionIdRef.current = created.session_id;
        }
        await refreshSidebar();
      } catch (error) {
        if (disposed) return;
        setConnected(false);
        setConnectionError(error instanceof Error ? error.message : String(error));
        setTimeout(() => void connect(), 1500);
      }
    };
    void connect();

    const close = client.events((message) => {
      const record = message as Record<string, unknown>;
      if (record['type'] === 'permission-request') {
        setPermission({
          requestId: String(record['request_id']),
          tool: String(record['tool']),
          summary: String(record['summary']),
          args: record['args'],
        });
        return;
      }
      if (record['type'] === 'question-request') {
        setQuestion({
          requestId: String(record['request_id']),
          questions: (record['questions'] as QuestionView['questions']) ?? [],
        });
        return;
      }
      if (record['type'] === 'agent-event') {
        setItems((current) => applyServerMessage(current, message));
        const event = record['event'] as Record<string, unknown> | undefined;
        if (event?.['type'] === 'turn-started') setBusy(true);
        if (event?.['type'] === 'turn-ended') {
          setBusy(false);
          void refreshSidebar();
        }
        if (event?.['type'] === 'todos-updated') {
          setSidebar((current) => ({ ...current, todos: (event['todos'] as SidebarData['todos']) ?? [] }));
        }
      }
    });

    const interval = setInterval(() => void refreshSidebar(), 8000);
    return () => {
      disposed = true;
      clearInterval(interval);
      close();
    };
  }, [client, refreshSidebar]);

  const send = useCallback(
    async (text: string) => {
      try {
        await client.call('chat.send', { text });
        setBusy(true);
      } catch (error) {
        setItems((current) => [
          ...current,
          { kind: 'notice', id: `err-${Date.now()}`, tone: 'error', text: error instanceof Error ? error.message : String(error) },
        ]);
      }
    },
    [client],
  );

  const abort = useCallback(() => {
    void client.call('chat.abort').catch(() => undefined);
  }, [client]);

  const respondPermission = useCallback(
    async (decision: 'allow' | 'allow_always' | 'deny') => {
      const current = permission;
      setPermission(null);
      if (!current) return;
      try {
        await client.call('permission.respond', { request_id: current.requestId, decision });
      } catch (error) {
        setItems((existing) => [
          ...existing,
          { kind: 'notice', id: `perr-${Date.now()}`, tone: 'error', text: error instanceof Error ? error.message : String(error) },
        ]);
      }
    },
    [client, permission],
  );

  const respondQuestion = useCallback(
    async (answers: Array<{ question: string; answers: string[] }>) => {
      const current = question;
      setQuestion(null);
      if (!current) return;
      try {
        await client.call('question.respond', { request_id: current.requestId, answers });
      } catch {
        // question surface errors surface through the transcript
      }
    },
    [client, question],
  );

  const loadSession = useCallback(
    async (id: string) => {
      try {
        const loaded = await client.call<{ state: { messages: Array<Record<string, unknown>>; mode?: string } }>('session.load', { session_id: id });
        sessionIdRef.current = id;
        setItems(seedFromState(loaded.state.messages));
        setMode(loaded.state.mode === 'plan' ? 'plan' : 'agent');
        await refreshSidebar();
      } catch (error) {
        setItems((current) => [
          ...current,
          { kind: 'notice', id: `serr-${Date.now()}`, tone: 'error', text: error instanceof Error ? error.message : String(error) },
        ]);
      }
    },
    [client, refreshSidebar],
  );

  const newSession = useCallback(async () => {
    try {
      const created = await client.call<{ session_id: string }>('session.new');
      sessionIdRef.current = created.session_id;
      setItems([]);
      setMode('agent');
      await refreshSidebar();
    } catch {
      // ignore
    }
  }, [client, refreshSidebar]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: palette.bg.editor, color: palette.text.primary, fontFamily: "'Segoe UI', system-ui, sans-serif" }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 14px',
          background: palette.bg.chrome,
          borderBottom: `1px solid ${palette.stroke.primary}`,
        }}
      >
        <span style={{ fontWeight: 700, fontSize: 13, color: palette.accent.primary, letterSpacing: 0.3 }}>opencursor</span>
        <div style={{ display: 'flex', border: `1px solid ${palette.stroke.primary}`, borderRadius: 6, overflow: 'hidden' }}>
          {(['agent', 'plan'] as const).map((entry) => (
            <button
              key={entry}
              type="button"
              onClick={() => void switchMode(entry)}
              title={entry === 'plan' ? 'read-only research mode' : 'edit and run commands'}
              style={{
                background: mode === entry ? palette.accent.control : 'transparent',
                color: mode === entry ? palette.text.primary : palette.text.tertiary,
                border: 'none',
                padding: '3px 10px',
                fontSize: 11,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {entry}
            </button>
          ))}
        </div>
        {status ? (
          <span style={{ color: status.model_configured ? palette.text.tertiary : palette.status.warn, fontSize: 11 }}>
            {status.model_configured
              ? `${status.model.provider ?? '?'}:${status.model.id ?? '?'} · ${status.cwd}`
              : `no model configured — open Settings${status.model_reason ? ` (${status.model_reason})` : ''}`}
          </span>
        ) : null}
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: connected ? palette.status.ok : palette.status.error }}>
          <span style={{ width: 7, height: 7, borderRadius: 4, background: connected ? palette.status.ok : palette.status.error, display: 'inline-block' }} />
          {connected ? 'connected' : connectionError ?? 'connecting…'}
        </span>
      </header>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <TranscriptView items={items} busy={busy} />
          <Composer disabled={!connected} busy={busy} onSend={(text) => void send(text)} onAbort={abort} />
        </main>
        <SidePanel
          data={{ ...sidebar, sessionId: sessionIdRef.current }}
          client={client}
          onLoadSession={(id) => void loadSession(id)}
          onNewSession={() => void newSession()}
          onRunIndex={() => void client.call('index.run').then(refreshSidebar)}
          onClearIndex={() => void client.call('index.clear').then(refreshSidebar)}
          onCompact={() => void client.call('context.compact').then(refreshSidebar)}
          onUndo={() => void client.call('checkpoints.undo', { all: false }).then(refreshSidebar)}
          onForgetMemory={(id) => void client.call('memory.forget', { id }).then(refreshSidebar)}
          onSettingsSaved={() => void refreshStatus()}
        />
      </div>
      {permission ? <PermissionDialog view={permission} onDecision={(decision) => void respondPermission(decision)} /> : null}
      {question ? <QuestionDialog view={question} onAnswer={(answers) => void respondQuestion(answers)} /> : null}
    </div>
  );
}

function seedFromState(messages: Array<Record<string, unknown>>): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let seq = 0;
  for (const message of messages) {
    const role = message['role'];
    if (role === 'user') {
      items.push({ kind: 'user', id: `seed-${seq++}`, text: String(message['text'] ?? '') });
    } else if (role === 'assistant') {
      const text = String(message['text'] ?? '');
      if (text.length > 0) items.push({ kind: 'assistant', id: `seed-${seq++}`, text });
      const calls = Array.isArray(message['tool_calls']) ? (message['tool_calls'] as Array<Record<string, unknown>>) : [];
      for (const call of calls) {
        items.push({
          kind: 'tool',
          id: String(call['id'] ?? `seed-${seq++}`),
          call: {
            id: String(call['id'] ?? ''),
            name: String(call['name'] ?? 'tool'),
            args: call['args'],
            argsPreview: JSON.stringify(call['args'] ?? {}).slice(0, 140),
            state: 'completed',
            progress: '',
            outcome: call['outcome'] as never,
            durationMs: typeof call['duration_ms'] === 'number' ? call['duration_ms'] : undefined,
          },
        });
      }
    }
  }
  return items;
}
