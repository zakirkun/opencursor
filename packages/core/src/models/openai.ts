/** OpenAI Chat Completions streaming client (also works with OpenAI-compatible endpoints). */

import type { ModelClient, ModelConfig, ModelInfo, ModelRequest, ModelStreamEvent } from '../protocol/models.js';
import type { ModelToolCall } from '../protocol/session.js';
import { iterateFetchSSE } from './sse.js';
import { normalizeModelEntry } from './listing.js';

interface NormalizedAssistant {
  role: 'assistant';
  text: string;
  tool_calls?: Array<{ id: string; name: string; args: unknown }>;
}

interface NormalizedUser {
  role: 'user';
  text: string;
}

interface NormalizedTool {
  role: 'tool';
  results: Array<{ call_id: string; name: string; outcome: unknown }>;
}

type NormalizedMessage = NormalizedAssistant | NormalizedUser | NormalizedTool;

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export function toOpenAIMessages(messages: readonly unknown[], system?: string): OpenAIMessage[] {
  const output: OpenAIMessage[] = [];
  if (system) output.push({ role: 'system', content: system });
  for (const raw of messages as NormalizedMessage[]) {
    if (raw.role === 'user') {
      output.push({ role: 'user', content: raw.text });
      continue;
    }
    if (raw.role === 'assistant') {
      const message: OpenAIMessage = { role: 'assistant', content: raw.text.length > 0 ? raw.text : null };
      if (raw.tool_calls && raw.tool_calls.length > 0) {
        message.tool_calls = raw.tool_calls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
        }));
      }
      output.push(message);
      continue;
    }
    for (const result of raw.results) {
      output.push({
        role: 'tool',
        tool_call_id: result.call_id,
        content: JSON.stringify(result.outcome).slice(0, 200_000),
      });
    }
  }
  return output;
}

interface StreamDelta {
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

export class OpenAIClient implements ModelClient {
  readonly provider = 'openai' as const;
  readonly id: string;
  private readonly config: ModelConfig;

  constructor(config: ModelConfig) {
    this.config = config;
    this.id = config.id;
  }

  private baseUrl(): string {
    return (this.config.base_url ?? process.env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  }

  private apiKey(): string {
    const apiKey = this.config.api_key ?? process.env['OPENAI_API_KEY'];
    if (!apiKey) throw new Error('openai: OPENAI_API_KEY is not set');
    return apiKey;
  }

  async listModels(): Promise<ModelInfo[]> {
    const response = await fetch(`${this.baseUrl()}/models`, {
      headers: { authorization: `Bearer ${this.apiKey()}` },
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`openai: models request failed: ${response.status} ${detail.slice(0, 300)}`);
    }
    const payload = (await response.json()) as { data?: Array<Record<string, unknown>> };
    const models: ModelInfo[] = [];
    for (const entry of payload.data ?? []) {
      const normalized = normalizeModelEntry(entry);
      if (normalized) models.push(normalized);
    }
    models.sort((a, b) => a.id.localeCompare(b.id));
    return models;
  }

  async *generate(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const base = this.baseUrl();
    const apiKey = this.apiKey();

    const body = {
      model: this.id,
      stream: true,
      stream_options: { include_usage: true },
      ...(request.max_tokens !== undefined || this.config.max_tokens !== undefined
        ? { max_completion_tokens: request.max_tokens ?? this.config.max_tokens }
        : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      messages: toOpenAIMessages(request.messages, request.system),
      tools: request.tools.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
      })),
    };

    const abort = new AbortController();
    const onOuterAbort = (): void => abort.abort();
    request.signal?.addEventListener('abort', onOuterAbort, { once: true });

    const toolBuffers = new Map<number, { id?: string; name?: string; json: string }>();
    let finishReason: string | null = null;
    let sawToolCalls = false;

    try {
      for await (const event of iterateFetchSSE(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: abort.signal,
      })) {
        if (event.data === '[DONE]') break;
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(event.data) as Record<string, unknown>;
        } catch {
          continue;
        }
        const usage = payload['usage'] as { prompt_tokens?: number; completion_tokens?: number } | null | undefined;
        if (usage && (usage.prompt_tokens !== undefined || usage.completion_tokens !== undefined)) {
          yield {
            type: 'usage',
            usage: {
              ...(usage.prompt_tokens !== undefined ? { input_tokens: usage.prompt_tokens } : {}),
              ...(usage.completion_tokens !== undefined ? { output_tokens: usage.completion_tokens } : {}),
            },
          };
        }
        const choices = payload['choices'] as Array<{ delta?: StreamDelta; finish_reason?: string | null }> | undefined;
        const choice = choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta;
        if (!delta) continue;
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          yield { type: 'text-delta', text: delta.content };
        }
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (typeof reasoning === 'string' && reasoning.length > 0) {
          yield { type: 'reasoning-delta', text: reasoning };
        }
        for (const fragment of delta.tool_calls ?? []) {
          const index = fragment.index ?? 0;
          let buffer = toolBuffers.get(index);
          if (!buffer) {
            buffer = { json: '' };
            toolBuffers.set(index, buffer);
          }
          if (fragment.id) buffer.id = fragment.id;
          if (fragment.function?.name) buffer.name = (buffer.name ?? '') + fragment.function.name;
          if (fragment.function?.arguments) buffer.json += fragment.function.arguments;
          sawToolCalls = true;
        }
      }
    } catch (error) {
      if (abort.signal.aborted) throw new Error('aborted');
      throw error;
    } finally {
      request.signal?.removeEventListener('abort', onOuterAbort);
    }

    for (const [, buffer] of [...toolBuffers.entries()].sort((a, b) => a[0] - b[0])) {
      let args: unknown = {};
      if (buffer.json.trim().length > 0) {
        try {
          args = JSON.parse(buffer.json);
        } catch {
          throw new Error(`openai: malformed tool args json for ${buffer.name ?? 'unknown'}`);
        }
      }
      const call: ModelToolCall = {
        id: buffer.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
        name: buffer.name ?? 'unknown',
        args,
        args_raw: buffer.json,
      };
      yield { type: 'tool-call', call };
    }

    const reason: 'end_turn' | 'tool_use' | 'max_tokens' =
      sawToolCalls || finishReason === 'tool_calls'
        ? 'tool_use'
        : finishReason === 'length'
          ? 'max_tokens'
          : 'end_turn';
    yield { type: 'stop', reason };
  }
}
