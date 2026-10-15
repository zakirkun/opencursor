/** Typed RPC client + SSE event stream against the opencursor server. */

export interface RpcError {
  message: string;
}

export class ServerClient {
  private readonly baseUrl: string;
  private nextId = 1;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    const response = await fetch(`${this.baseUrl}/api/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, method, params: params ?? {} }),
    });
    if (!response.ok) {
      throw new Error(`rpc transport failed: ${response.status}`);
    }
    const payload = (await response.json()) as { id: number; result?: T; error?: string };
    if (payload.error) throw new Error(payload.error);
    return payload.result as T;
  }

  events(onMessage: (message: unknown) => void, onError?: (error: Event) => void): () => void {
    const source = new EventSource(`${this.baseUrl}/api/events`);
    source.onmessage = (event) => {
      try {
        onMessage(JSON.parse(event.data));
      } catch {
        // ignore malformed frames
      }
    };
    source.onerror = (error) => onError?.(error);
    return () => source.close();
  }
}
