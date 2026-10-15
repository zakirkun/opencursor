/** Tool call card — status, args, streamed progress, outcome summary. */

import { useState } from 'react';
import { Card, Pill, Spinner, StatusDot } from './primitives.js';
import { palette } from './theme.js';
import type { ToolCallView } from '../lib/transcript.js';

function outcomeTone(kind: string | undefined): 'ok' | 'warn' | 'error' | 'muted' {
  if (kind === 'success') return 'ok';
  if (kind === 'rejected') return 'warn';
  if (kind === 'error') return 'error';
  return 'muted';
}

function summarizeOutcome(call: ToolCallView): string {
  const outcome = call.outcome;
  if (!outcome) return '';
  if (outcome.kind === 'rejected') return `rejected: ${outcome.reason ?? ''}`;
  if (outcome.kind === 'error') return `${outcome.code ?? 'error'}: ${outcome.message ?? ''}`;
  const value = outcome.value as Record<string, unknown> | undefined;
  if (!value || typeof value !== 'object') return 'ok';
  if (typeof value['total_matches'] === 'number') return `${value['total_matches']} matches`;
  if (Array.isArray(value['files'])) return `${value['files'].length} files`;
  if (Array.isArray(value['entries'])) return `${value['entries'].length} entries`;
  if (Array.isArray(value['results'])) return `${value['results'].length} results`;
  if (typeof value['exit_code'] === 'number') return `exit ${value['exit_code']}`;
  if (typeof value['bytes_written'] === 'number') return `${value['bytes_written']} bytes`;
  if (typeof value['diff_string'] === 'string') return 'diff computed';
  if (typeof value['content'] === 'string') return `${(value['content'] as string).slice(0, 120)}`;
  if (typeof value['message'] === 'string') return String(value['message']);
  return 'ok';
}

export function ToolCard({ call }: { call: ToolCallView }) {
  const [open, setOpen] = useState(false);
  const tone = outcomeTone(call.outcome?.kind);
  const pillTone = tone === 'muted' ? 'neutral' : tone;
  const progressTail = call.progress.split('\n').slice(-6).join('\n');
  return (
    <Card style={{ marginLeft: 12, marginTop: 4 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '7px 10px',
          cursor: 'pointer',
          borderBottom: open ? `1px solid ${palette.stroke.tertiary}` : 'none',
        }}
        onClick={() => setOpen((value) => !value)}
      >
        {call.state === 'running' ? <Spinner /> : <StatusDot tone={tone} />}
        <span style={{ color: palette.accent.primary, fontWeight: 600, fontSize: 12 }}>{call.name}</span>
        <span style={{ color: palette.text.tertiary, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
          {call.argsPreview}
        </span>
        {call.durationMs !== undefined ? <span style={{ color: palette.text.quaternary, fontSize: 11 }}>{call.durationMs}ms</span> : null}
        {call.state === 'completed' && call.outcome ? <Pill tone={pillTone}>{call.outcome.kind}</Pill> : null}
      </div>
      {call.state === 'completed' && call.outcome ? (
        <div style={{ padding: '4px 10px', fontSize: 12, color: tone === 'error' ? palette.status.error : tone === 'warn' ? palette.status.warn : palette.text.secondary }}>
          {summarizeOutcome(call)}
        </div>
      ) : null}
      {open ? (
        <div style={{ borderTop: `1px solid ${palette.stroke.tertiary}`, padding: '8px 10px' }}>
          <div style={{ color: palette.text.tertiary, fontSize: 11, marginBottom: 4 }}>arguments</div>
          <pre style={{ margin: 0, fontSize: 11, color: palette.text.secondary, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {JSON.stringify(call.args, null, 2)}
          </pre>
          {progressTail.length > 0 ? (
            <>
              <div style={{ color: palette.text.tertiary, fontSize: 11, margin: '8px 0 4px' }}>output</div>
              <pre style={{ margin: 0, fontSize: 11, color: palette.text.secondary, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 220, overflow: 'auto' }}>
                {progressTail}
              </pre>
            </>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
