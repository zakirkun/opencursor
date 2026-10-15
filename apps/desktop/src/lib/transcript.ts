/** GUI transcript model — folds server events into renderable items. */

export interface ToolCallView {
  id: string;
  name: string;
  args: unknown;
  argsPreview: string;
  state: 'running' | 'completed';
  progress: string;
  outcome?: { kind: string; code?: string; message?: string; reason?: string; value?: unknown };
  durationMs?: number;
}

export interface PermissionView {
  requestId: string;
  tool: string;
  summary: string;
  args: unknown;
}

export interface QuestionView {
  requestId: string;
  questions: Array<{ question: string; header?: string; options?: Array<{ label: string; description?: string }>; multiple?: boolean }>;
}

export type TranscriptItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string; streaming?: boolean }
  | { kind: 'reasoning'; id: string; text: string }
  | { kind: 'tool'; id: string; call: ToolCallView }
  | { kind: 'notice'; id: string; text: string; tone: 'info' | 'warn' | 'error' }
  | { kind: 'subagent'; id: string; agentId: string; subagentType: string; description: string; status: string; summary?: string };

let seq = 0;
const nextId = (): string => `item-${++seq}`;

function preview(args: unknown, max = 140): string {
  let text: string;
  try {
    text = JSON.stringify(args) ?? String(args);
  } catch {
    text = String(args);
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function applyServerMessage(items: TranscriptItem[], message: unknown): TranscriptItem[] {
  if (typeof message !== 'object' || message === null) return items;
  const record = message as Record<string, unknown>;
  if (record['type'] !== 'agent-event') return items;
  const event = record['event'];
  if (typeof event !== 'object' || event === null) return items;
  const e = event as Record<string, unknown>;
  switch (e['type']) {
    case 'turn-started':
      return [...items, { kind: 'user', id: nextId(), text: String(e['user_text'] ?? '') }];
    case 'text-delta': {
      const last = items[items.length - 1];
      if (last && last.kind === 'assistant' && last.streaming) {
        return [...items.slice(0, -1), { ...last, text: last.text + String(e['text'] ?? '') }];
      }
      return [...items, { kind: 'assistant', id: nextId(), text: String(e['text'] ?? ''), streaming: true }];
    }
    case 'reasoning-delta': {
      const last = items[items.length - 1];
      if (last && last.kind === 'reasoning') {
        return [...items.slice(0, -1), { ...last, text: last.text + String(e['text'] ?? '') }];
      }
      return [...items, { kind: 'reasoning', id: nextId(), text: String(e['text'] ?? '') }];
    }
    case 'tool-call-started': {
      const call = e['call'] as Record<string, unknown> | undefined;
      if (!call) return items;
      const finalized = finalizeStreaming(items);
      return [
        ...finalized,
        {
          kind: 'tool',
          id: String(call['id'] ?? nextId()),
          call: {
            id: String(call['id'] ?? ''),
            name: String(call['name'] ?? 'unknown'),
            args: call['args'],
            argsPreview: preview(call['args']),
            state: 'running',
            progress: '',
          },
        },
      ];
    }
    case 'tool-progress': {
      const callId = String(e['call_id'] ?? '');
      return items.map((item) => {
        if (item.kind !== 'tool' || item.call.id !== callId) return item;
        const progress = `${item.call.progress}${String(e['chunk'] ?? '')}`;
        return { ...item, call: { ...item.call, progress: progress.slice(-4000) } };
      });
    }
    case 'tool-call-completed': {
      const callId = String(e['call_id'] ?? '');
      return items.map((item) => {
        if (item.kind !== 'tool' || item.call.id !== callId) return item;
        return {
          ...item,
          call: {
            ...item.call,
            state: 'completed',
            outcome: e['outcome'] as ToolCallView['outcome'],
            durationMs: typeof e['duration_ms'] === 'number' ? e['duration_ms'] : undefined,
          },
        };
      });
    }
    case 'todos-updated':
      return items;
    case 'mode-changed':
      return [
        ...items,
        {
          kind: 'notice',
          id: nextId(),
          tone: 'info',
          text: `mode: ${String(e['mode'])}${e['explanation'] ? ` — ${String(e['explanation'])}` : ''}`,
        },
      ];
    case 'subagent-started':
      return [
        ...items,
        {
          kind: 'subagent',
          id: nextId(),
          agentId: String(e['agent_id'] ?? ''),
          subagentType: String(e['subagent_type'] ?? 'general'),
          description: String(e['description'] ?? ''),
          status: 'running',
        },
      ];
    case 'subagent-completed': {
      const agentId = String(e['agent_id'] ?? '');
      const status = String(e['status'] ?? 'completed');
      const summary = typeof e['summary'] === 'string' ? e['summary'] : undefined;
      let matched = false;
      const updated = items.map((item) => {
        if (item.kind !== 'subagent' || item.agentId !== agentId) return item;
        matched = true;
        return summary === undefined ? { ...item, status } : { ...item, status, summary };
      });
      if (matched) return updated;
      return [
        ...items,
        {
          kind: 'subagent',
          id: nextId(),
          agentId,
          subagentType: String(e['subagent_type'] ?? 'general'),
          description: '',
          status,
          ...(summary === undefined ? {} : { summary }),
        },
      ];
    }
    case 'hook-result':
      return [
        ...items,
        {
          kind: 'notice',
          id: nextId(),
          tone: e['decision'] === 'allow' ? 'info' : 'warn',
          text: `hook ${String(e['phase'])} ${String(e['tool'])}: ${String(e['decision'])}${e['reason'] ? ` — ${String(e['reason'])}` : ''}`,
        },
      ];
    case 'compacted':
      return [
        ...items,
        { kind: 'notice', id: nextId(), tone: 'info', text: `compacted ${String(e['archived_messages'])} messages into a ${String(e['summary_chars'])} char summary` },
      ];
    case 'undo-completed': {
      const restored = Array.isArray(e['restored']) ? e['restored'] : [];
      return [...items, { kind: 'notice', id: nextId(), tone: 'info', text: `restored ${restored.length} file(s)` }];
    }
    case 'turn-ended':
      return finalizeStreaming(items);
    case 'error':
      return [...finalizeStreaming(items), { kind: 'notice', id: nextId(), tone: 'error', text: String(e['message'] ?? 'error') }];
    default:
      return items;
  }
}

function finalizeStreaming(items: TranscriptItem[]): TranscriptItem[] {
  return items.map((item) => (item.kind === 'assistant' && item.streaming ? { ...item, streaming: false } : item));
}

export function toolStatusColor(kind: string | undefined): 'ok' | 'warn' | 'error' | 'muted' {
  if (kind === 'success') return 'ok';
  if (kind === 'rejected') return 'warn';
  if (kind === 'error') return 'error';
  return 'muted';
}
