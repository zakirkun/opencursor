/** Permission dialog — y / always / deny with argument preview. */

import { useEffect } from 'react';
import { palette } from './theme.js';
import type { PermissionView } from '../lib/transcript.js';

export function PermissionDialog({
  view,
  onDecision,
}: {
  view: PermissionView;
  onDecision: (decision: 'allow' | 'allow_always' | 'deny') => void;
}) {
  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'y' || event.key === 'Y') onDecision('allow');
      else if (event.key === 'a' || event.key === 'A') onDecision('allow_always');
      else if (event.key === 'n' || event.key === 'N' || event.key === 'Escape') onDecision('deny');
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onDecision]);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
      }}
    >
      <div
        style={{
          width: 560,
          maxWidth: '92vw',
          background: palette.bg.elevated,
          border: `1px solid ${palette.status.warn}`,
          borderRadius: 10,
          padding: 18,
        }}
      >
        <div style={{ color: palette.status.warn, fontWeight: 700, fontSize: 14, marginBottom: 6 }}>
          Permission required — {view.tool}
        </div>
        <div style={{ color: palette.text.secondary, fontSize: 13, marginBottom: 10 }}>{view.summary}</div>
        <pre
          style={{
            background: palette.bg.editor,
            border: `1px solid ${palette.stroke.tertiary}`,
            borderRadius: 6,
            padding: 10,
            fontSize: 12,
            color: palette.text.secondary,
            maxHeight: 200,
            overflow: 'auto',
            margin: '0 0 14px',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {JSON.stringify(view.args, null, 2)}
        </pre>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" onClick={() => onDecision('deny')} style={btn(palette.status.error)}>
            Deny (N)
          </button>
          <button type="button" onClick={() => onDecision('allow_always')} style={btn(palette.accent.control)}>
            Always for this pattern (A)
          </button>
          <button type="button" onClick={() => onDecision('allow')} style={btn(palette.status.ok)}>
            Allow once (Y)
          </button>
        </div>
      </div>
    </div>
  );
}

function btn(background: string): React.CSSProperties {
  return {
    background,
    color: palette.text.primary,
    border: `1px solid ${palette.stroke.primary}`,
    borderRadius: 6,
    padding: '7px 14px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  };
}
