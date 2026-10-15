/** Composer — message input with send/stop. */

import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import { palette } from './theme.js';

export function Composer({
  disabled,
  busy,
  onSend,
  onAbort,
}: {
  disabled: boolean;
  busy: boolean;
  onSend: (text: string) => void;
  onAbort: () => void;
}) {
  const [text, setText] = useState('');

  const submit = (): void => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || disabled) return;
    onSend(trimmed);
    setText('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div style={{ borderTop: `1px solid ${palette.stroke.primary}`, padding: 12, background: palette.bg.chrome }}>
      <div
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'flex-end',
          border: `1px solid ${palette.stroke.primary}`,
          borderRadius: 8,
          background: palette.bg.editor,
          padding: 8,
        }}
      >
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={disabled ? 'starting…' : busy ? 'agent is working — type to queue next message' : 'Describe a task… (Enter to send, Shift+Enter for newline)'}
          rows={2}
          disabled={disabled}
          style={{
            flex: 1,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            color: palette.text.primary,
            fontSize: 13,
            resize: 'none',
            fontFamily: 'inherit',
            lineHeight: 1.5,
          }}
        />
        {busy ? (
          <button type="button" onClick={onAbort} style={buttonStyle(palette.status.error)}>
            Stop
          </button>
        ) : (
          <button type="button" onClick={submit} disabled={disabled || text.trim().length === 0} style={buttonStyle(palette.accent.control)}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}

function buttonStyle(background: string): React.CSSProperties {
  return {
    background,
    color: palette.text.primary,
    border: `1px solid ${palette.stroke.primary}`,
    borderRadius: 6,
    padding: '6px 16px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  };
}
