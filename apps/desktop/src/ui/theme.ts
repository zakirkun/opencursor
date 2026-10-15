/** Design tokens — mirrors the observed Canvas SDK semantic token groups. */

export const palette = {
  text: {
    primary: '#e6e6ef',
    secondary: '#a8a8b8',
    tertiary: '#6e6e82',
    quaternary: '#4a4a5c',
    link: '#7ab8ff',
    onAccent: '#0b0b10',
  },
  bg: {
    editor: '#101014',
    chrome: '#15151b',
    elevated: '#1b1b23',
  },
  fill: {
    primary: '#262633',
    secondary: '#1f1f2a',
    tertiary: '#191922',
    quaternary: '#141419',
  },
  stroke: {
    primary: '#33333f',
    secondary: '#282833',
    tertiary: '#1f1f28',
  },
  accent: {
    primary: '#7ab8ff',
    control: '#2b4a6f',
  },
  diff: {
    added: '#2ea043',
    addedBg: 'rgba(46, 160, 67, 0.14)',
    removed: '#f85149',
    removedBg: 'rgba(248, 81, 73, 0.14)',
    context: '#6e6e82',
  },
  status: {
    ok: '#3fb950',
    warn: '#d29922',
    error: '#f85149',
    info: '#58a6ff',
  },
} as const;

export type Palette = typeof palette;
