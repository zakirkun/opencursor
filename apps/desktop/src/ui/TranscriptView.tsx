/** Transcript view — user/assistant/reasoning/tool/notice items. */

import { useEffect, useRef } from 'react';
import { ToolCard } from './ToolCard.js';
import { palette } from './theme.js';
import type { TranscriptItem } from '../lib/transcript.js';

function Markdownish({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <div style={{ fontSize: 13, lineHeight: 1.55, color: palette.text.primary }}>
      {lines.map((line, index) => {
        if (line.startsWith('### ')) {
          return (
            <div key={index} style={{ fontWeight: 600, fontSize: 13, marginTop: 8 }}>
              {line.slice(4)}
            </div>
          );
        }
        if (line.startsWith('## ')) {
          return (
            <div key={index} style={{ fontWeight: 700, fontSize: 14, marginTop: 10 }}>
              {line.slice(3)}
            </div>
          );
        }
        if (line.startsWith('# ')) {
          return (
            <div key={index} style={{ fontWeight: 700, fontSize: 16, marginTop: 12 }}>
              {line.slice(2)}
            </div>
          );
        }
        if (line.startsWith('- ') || line.startsWith('* ')) {
          return (
            <div key={index} style={{ paddingLeft: 14, position: 'relative' }}>
              <span style={{ position: 'absolute', left: 2 }}>•</span>
              {line.slice(2)}
            </div>
          );
        }
        if (line.startsWith('```')) {
          return (
            <div key={index} style={{ color: palette.text.tertiary, fontSize: 11 }}>
              {line}
            </div>
          );
        }
        if (line.trim().length === 0) return <div key={index} style={{ height: 6 }} />;
        return <div key={index}>{line}</div>;
      })}
    </div>
  );
}

export function TranscriptView({ items, busy }: { items: TranscriptItem[]; busy: boolean }) {
  const endRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [items.length, busy]);

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
      {items.length === 0 ? (
        <div style={{ color: palette.text.tertiary, fontSize: 13, textAlign: 'center', marginTop: 60 }}>
          Ask a question or describe a task. The agent can read and edit files, run commands, search the codebase, and remember context.
        </div>
      ) : null}
      {items.map((item) => {
        switch (item.kind) {
          case 'user':
            return (
              <div key={item.id} style={{ margin: '14px 0 6px' }}>
                <span style={{ color: palette.accent.primary, fontWeight: 700, fontSize: 12 }}>You</span>
                <div style={{ marginTop: 3, fontSize: 13, color: palette.text.primary, whiteSpace: 'pre-wrap' }}>{item.text}</div>
              </div>
            );
          case 'assistant':
            return (
              <div key={item.id} style={{ margin: '10px 0' }}>
                <span style={{ color: palette.status.ok, fontWeight: 700, fontSize: 12 }}>opencursor</span>
                <div style={{ marginTop: 3 }}>
                  <Markdownish text={item.text} />
                  {item.streaming ? <span style={{ color: palette.accent.primary }}>▍</span> : null}
                </div>
              </div>
            );
          case 'reasoning':
            return (
              <div key={item.id} style={{ margin: '8px 0', paddingLeft: 10, borderLeft: `2px solid ${palette.stroke.secondary}`, color: palette.text.tertiary, fontSize: 12, whiteSpace: 'pre-wrap', maxHeight: 120, overflow: 'hidden' }}>
                {item.text.slice(0, 600)}
              </div>
            );
          case 'tool':
            return <ToolCard key={item.id} call={item.call} />;
          case 'subagent': {
            const tone =
              item.status === 'completed'
                ? palette.status.ok
                : item.status === 'running'
                  ? palette.status.info
                  : item.status === 'cancelled'
                    ? palette.text.tertiary
                    : palette.status.error;
            return (
              <div key={item.id} style={{ margin: '8px 0', marginLeft: 12, border: `1px solid ${palette.stroke.secondary}`, borderRadius: 8, padding: '6px 10px', background: palette.fill.tertiary }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ color: palette.accent.primary, fontWeight: 600, fontSize: 12 }}>subagent · {item.subagentType}</span>
                  <span style={{ color: tone, fontSize: 11 }}>{item.status}</span>
                  {item.description.length > 0 ? (
                    <span style={{ color: palette.text.tertiary, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.description}</span>
                  ) : null}
                </div>
                {item.summary ? (
                  <div style={{ color: palette.text.secondary, fontSize: 12, marginTop: 4, whiteSpace: 'pre-wrap' }}>{item.summary.slice(0, 600)}</div>
                ) : null}
              </div>
            );
          }
          case 'notice': {
            const color = item.tone === 'error' ? palette.status.error : item.tone === 'warn' ? palette.status.warn : palette.text.tertiary;
            return (
              <div key={item.id} style={{ margin: '6px 0', color, fontSize: 12 }}>
                {item.text}
              </div>
            );
          }
        }
      })}
      <div ref={endRef} />
    </div>
  );
}
