/** Dependency-free Server-Sent Events parser. */

export interface SSEEvent {
  event?: string;
  data: string;
}

export async function* parseSSEStream(body: ReadableStream<Uint8Array>): AsyncIterable<SSEEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let eventName: string | undefined;
  let dataLines: string[] = [];

  const flush = (): SSEEvent | null => {
    if (dataLines.length === 0) {
      eventName = undefined;
      return null;
    }
    const event: SSEEvent = { data: dataLines.join('\n') };
    if (eventName !== undefined) event.event = eventName;
    dataLines = [];
    eventName = undefined;
    return event;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex: number;
      while ((newlineIndex = buffer.search(/\r\n|\n|\r/)) !== -1) {
        const rawLine = buffer.slice(0, newlineIndex);
        const separator = buffer.match(/\r\n|\n|\r/)?.[0] ?? '\n';
        buffer = buffer.slice(newlineIndex + separator.length);

        if (rawLine.length === 0) {
          const event = flush();
          if (event) yield event;
          continue;
        }
        if (rawLine.startsWith(':')) continue;
        const colonIndex = rawLine.indexOf(':');
        const field = colonIndex === -1 ? rawLine : rawLine.slice(0, colonIndex);
        let valueText = colonIndex === -1 ? '' : rawLine.slice(colonIndex + 1);
        if (valueText.startsWith(' ')) valueText = valueText.slice(1);
        if (field === 'event') eventName = valueText;
        else if (field === 'data') dataLines.push(valueText);
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) {
      const rawLine = buffer;
      if (!rawLine.startsWith(':')) {
        const colonIndex = rawLine.indexOf(':');
        const field = colonIndex === -1 ? rawLine : rawLine.slice(0, colonIndex);
        let valueText = colonIndex === -1 ? '' : rawLine.slice(colonIndex + 1);
        if (valueText.startsWith(' ')) valueText = valueText.slice(1);
        if (field === 'event') eventName = valueText;
        else if (field === 'data') dataLines.push(valueText);
      }
    }
    const trailing = flush();
    if (trailing) yield trailing;
  } finally {
    reader.releaseLock();
  }
}

export async function* iterateFetchSSE(
  url: string,
  init: RequestInit,
): AsyncIterable<SSEEvent> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`SSE request failed: ${response.status} ${response.statusText} ${text.slice(0, 500)}`);
  }
  if (!response.body) {
    throw new Error('SSE request failed: response body is null');
  }
  yield* parseSSEStream(response.body);
}
