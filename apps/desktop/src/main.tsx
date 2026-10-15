/** Desktop entry — boots the local server (under Tauri) and mounts the GUI. */

import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './style.css';

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

const FALLBACK_PORT = 4180;

async function resolvePort(): Promise<number> {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = Number.parseInt(params.get('port') ?? '', 10);
  if (Number.isFinite(fromQuery) && fromQuery > 0) return fromQuery;

  if (window.__TAURI_INTERNALS__) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const port = await invoke<number>('start_server', { cwd: null });
      if (Number.isFinite(port) && port > 0) return port;
    } catch (error) {
      console.error('failed to start opencursor server:', error);
    }
  }
  return FALLBACK_PORT;
}

const container = document.getElementById('root');
if (!container) throw new Error('#root missing');
const root = createRoot(container);

void resolvePort().then((port) => {
  root.render(<App port={port} />);
});
