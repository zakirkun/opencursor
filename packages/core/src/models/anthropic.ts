/** Anthropic Messages API streaming client. */

import type { ModelClient, ModelConfig, ModelRequest, ModelStreamEvent } from '../protocol/models.js';
import type { ModelToolCall } from '../protocol/session.js';
import { iterateFetchSSE } from './sse.js';

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

interface NormalizedAssistant {
  role: 'assistant';
  text: string;
  reasoning?: string;
  tool_calls?: Array<{ id: string; name: string; args: unknown; args_raw?: string }>;
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

function isAssistant(message: NormalizedMessage): message is NormalizedAssistant {
  return message.role === 'assistant';
}

function isTool(message: NormalizedMessage): message is NormalizedTool {
  return message.role === 'tool';
}

export function toAnthropicMessages(messages: readonly unknown[]): AnthropicMessage[] {
  const output: AnthropicMessage[] = [];
  for (const raw of messages as NormalizedMessage[]) {
    if (raw.role === 'user') {
      output.push({ role: 'user', content: raw.text });
      continue;
    }
    if (isAssistant(raw)) {
      const blocks: AnthropicContentBlock[] = [];
      if (raw.text.length > 0) blocks.push({ type: 'text', text: raw.text });
      for (const call of raw.tool_calls ?? []) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args ?? {} });
      }
      output.push({ role: 'assistant', content: blocks.length > 0 ? blocks : '' });
      continue;
    }
    if (isTool(raw)) {
      const results = raw.results.map((result) => ({
        type: 'tool_result',
        tool_use_id: result.call_id,
        content: JSON.stringify(result.outcome).slice(0, 200_000),
        is_error: !(typeof result.outcome === 'object' && result.outcome !== null && (result.outcome as { kind?: string }).kind === 'success'),
      }));
      const last = output[output.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content)) {
        last.content.push(...results);
      } else {
        output.push({ role: 'user', content: results });
      }
    }
  }
  return output;
}

export class AnthropicClient implements ModelClient {
  readonly provider = 'anthropic' as const;
  readonly id: string;
  private readonly config: ModelConfig;

  constructor(config: ModelConfig) {
    this.config = config;
    this.id = config.id;
  }

  async *generate(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const base = (this.config.base_url ?? process.env['ANTHROPIC_BASE_URL'] ?? 'https://api.anthropic.com').replace(/\/$/, '');
    const apiKey = this.config.api_key ?? process.env['ANTHROPIC_API_KEY'];
    if (!apiKey) throw new Error('anthropic: ANTHROPIC_API_KEY is not set');

    const body = {
      model: this.id,
      max_tokens: request.max_tokens ?? this.config.max_tokens ?? 8192,
      stream: true,
      ...(request.system ? { system: request.system } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      messages: toAnthropicMessages(request.messages),
      tools: request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema,
      })),
    };

    const abort = new AbortController();
    const onOuterAbort = (): void => abort.abort();
    request.signal?.addEventListener('abort', onOuterAbort, { once: true });

    let stopReason: ModelStreamEvent & { type: 'stop' } = { type: 'stop', reason: 'end_turn' };
    let usageEmitted = false;
    const toolBuffers = new Map<number, { id: string; name: string; json: string; started: boolean }>();

    try {
      for await (const event of iterateFetchSSE(`${base}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: abort.signal,
      })) {
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(event.data) as Record<string, unknown>;
        } catch {
          continue;
        }
        const type = payload['type'];
        if (type === 'message_start') {
          const message = payload['message'] as { usage?: { input_tokens?: number } } | undefined;
          if (message?.usage?.input_tokens !== undefined) {
            yield { type: 'usage', usage: { input_tokens: message.usage.input_tokens } };
            usageEmitted = true;
          }
          continue;
        }
        if (type === 'content_block_start') {
          const index = payload['index'] as number;
          const block = payload['content_block'] as { type?: string; id?: string; name?: string } | undefined;
          if (block?.type === 'tool_use') {
            toolBuffers.set(index, {
              id: block.id ?? `call_${index}`,
              name: block.name ?? 'unknown',
              json: '',
              started: true,
            });
          }
          continue;
        }
        if (type === 'content_block_delta') {
          const index = payload['index'] as number;
          const delta = payload['delta'] as { type?: string; text?: string; partial_json?: string } | undefined;
          if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
            yield { type: 'text-delta', text: delta.text };
          } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
            const buffer = toolBuffers.get(index);
            if (buffer) buffer.json += delta.partial_json;
          }
          continue;
        }
        if (type === 'content_block_stop') {
          const index = payload['index'] as number;
          const buffer = toolBuffers.get(index);
          if (buffer) {
            let args: unknown = {};
            if (buffer.json.trim().length > 0) {
              try {
                args = JSON.parse(buffer.json);
              } catch {
                throw new Error(`anthropic: malformed tool args json for ${buffer.name}`);
              }
            }
            const call: ModelToolCall = {
              id: buffer.id,
              name: buffer.name,
              args,
              args_raw: buffer.json,
            };
            yield { type: 'tool-call', call };
            stopReason = { type: 'stop', reason: 'tool_use' };
          }
          continue;
        }
        if (type === 'message_delta') {
          const delta = payload['delta'] as { stop_reason?: string } | undefined;
          const usage = payload['usage'] as { output_tokens?: number } | undefined;
          if (usage?.output_tokens !== undefined) {
            yield { type: 'usage', usage: { output_tokens: usage.output_tokens } };
            usageEmitted = true;
          }
          const reason = delta?.stop_reason;
          if (reason === 'tool_use') stopReason = { type: 'stop', reason: 'tool_use' };
          else if (reason === 'max_tokens') stopReason = { type: 'stop', reason: 'max_tokens' };
          else if (reason === 'end_turn' || reason === 'stop_sequence') stopReason = { type: 'stop', reason: 'end_turn' };
          continue;
        }
        if (type === 'message_stop') {
          break;
        }
        if (type === 'error') {
          const error = payload['error'] as { message?: string } | undefined;
          throw new Error(`anthropic: ${error?.message ?? 'stream error'}`);
        }
      }
    } catch (error) {
      if (abort.signal.aborted) throw new Error('aborted');
      throw error;
    } finally {
      request.signal?.removeEventListener('abort', onOuterAbort);
      void usageEmitted;
    }

    yield stopReason;
  }
}
