/** Shared UI primitives — Card / Pill / StatusDot, mirroring Canvas SDK conventions. */

import type { ReactNode } from 'react';
import { palette } from './theme.js';

export function Card({
  children,
  collapsible = false,
  open = true,
  onToggle,
  style,
}: {
  children: ReactNode;
  collapsible?: boolean;
  open?: boolean;
  onToggle?: () => void;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        border: `1px solid ${palette.stroke.primary}`,
        borderRadius: 8,
        background: palette.bg.elevated,
        overflow: 'hidden',
        ...style,
      }}
    >
      {collapsible ? (
        <button
          type="button"
          onClick={onToggle}
          style={{
            width: '100%',
            textAlign: 'left',
            background: 'transparent',
            border: 'none',
            color: palette.text.secondary,
            padding: '6px 10px',
            cursor: 'pointer',
            fontSize: 12,
          }}
        >
          {open ? '▾' : '▸'} details
        </button>
      ) : null}
      {!collapsible || open ? children : null}
    </div>
  );
}

export function Pill({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'ok' | 'warn' | 'error' | 'accent' }) {
  const colors: Record<string, { bg: string; fg: string }> = {
    neutral: { bg: palette.fill.secondary, fg: palette.text.secondary },
    ok: { bg: 'rgba(63,185,80,0.15)', fg: palette.status.ok },
    warn: { bg: 'rgba(210,153,34,0.15)', fg: palette.status.warn },
    error: { bg: 'rgba(248,81,73,0.15)', fg: palette.status.error },
    accent: { bg: 'rgba(122,184,255,0.15)', fg: palette.accent.primary },
  };
  const c = colors[tone] ?? colors['neutral'];
  return (
    <span
      style={{
        background: c?.bg,
        color: c?.fg,
        borderRadius: 10,
        padding: '1px 8px',
        fontSize: 11,
        fontWeight: 500,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

export function StatusDot({ tone }: { tone: 'ok' | 'warn' | 'error' | 'muted' }) {
  const colors = {
    ok: palette.status.ok,
    warn: palette.status.warn,
    error: palette.status.error,
    muted: palette.text.tertiary,
  };
  return <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: colors[tone], flexShrink: 0 }} />;
}

export function Spinner() {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 10,
        height: 10,
        border: `2px solid ${palette.stroke.primary}`,
        borderTopColor: palette.accent.primary,
        borderRadius: '50%',
        animation: 'spin 0.9s linear infinite',
        flexShrink: 0,
      }}
    />
  );
}
