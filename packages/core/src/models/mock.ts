/** Deterministic offline model — scripted tool calls and text for demos/tests. */

import type { ModelClient, ModelRequest, ModelStreamEvent } from '../protocol/models.js';
import type { ModelToolCall } from '../protocol/session.js';

interface NormalizedAssistant {
  role: 'assistant';
  text: string;
  tool_calls?: Array<{ id: string; name: string }>;
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

function chunkText(text: string, size = 24): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks.length > 0 ? chunks : [''];
}

export class MockModelClient implements ModelClient {
  readonly provider = 'mock' as const;
  readonly id: string;

  constructor(id = 'mock-1') {
    this.id = id;
  }

  async *generate(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const messages = request.messages as NormalizedMessage[];
    const lastUser = [...messages].reverse().find((m): m is NormalizedUser => m.role === 'user');
    const lastAssistant = [...messages].reverse().find((m): m is NormalizedAssistant => m.role === 'assistant');
    const pendingToolResults = [...messages].reverse().find((m): m is NormalizedTool => m.role === 'tool');

    const userText = (lastUser?.text ?? '').toLowerCase();
    const priorToolResults =
      lastAssistant && pendingToolResults && messages.indexOf(pendingToolResults) > messages.indexOf(lastAssistant)
        ? pendingToolResults
        : null;
    void priorToolResults;

    const lastToolMessage = messages[messages.length - 1];
    const toolResultContext =
      lastToolMessage && lastToolMessage.role === 'tool' ? lastToolMessage.results[0] : null;

    if (toolResultContext && lastAssistant) {
      const preview = JSON.stringify(toolResultContext.outcome).slice(0, 200);
      const text = `Tool ${toolResultContext.name} finished. Result preview: ${preview}`;
      for (const chunk of chunkText(text)) {
        yield { type: 'text-delta', text: chunk };
      }
      yield { type: 'usage', usage: { input_tokens: 10, output_tokens: Math.ceil(text.length / 4) } };
      yield { type: 'stop', reason: 'end_turn' };
      return;
    }

    const toolCall = (name: string, args: unknown): ModelToolCall => ({
      id: `mock_${this.id}_${Math.random().toString(36).slice(2, 10)}`,
      name,
      args,
      args_raw: JSON.stringify(args),
    });

    const emitTool = async function* (call: ModelToolCall, note: string): AsyncIterable<ModelStreamEvent> {
      for (const chunk of chunkText(note)) {
        yield { type: 'text-delta', text: chunk };
      }
      yield { type: 'tool-call', call };
      yield { type: 'usage', usage: { input_tokens: 8, output_tokens: 16 } };
      yield { type: 'stop', reason: 'tool_use' };
    };

    if (userText.includes('hello')) {
      const text = 'Hello! I am the opencursor mock model. Try: list files, read package.json, run echo, or make a plan.';
      for (const chunk of chunkText(text)) {
        yield { type: 'text-delta', text: chunk };
      }
      yield { type: 'usage', usage: { input_tokens: 6, output_tokens: Math.ceil(text.length / 4) } };
      yield { type: 'stop', reason: 'end_turn' };
      return;
    }
    if (userText.includes('list files')) {
      yield* emitTool(toolCall('list_dir', { path: '.' }), 'Listing the workspace root.');
      return;
    }
    if (userText.includes('read package.json') || (userText.includes('read') && userText.includes('package'))) {
      yield* emitTool(toolCall('read_file', { path: 'package.json', include_line_numbers: true }), 'Reading package.json.');
      return;
    }
    if (userText.includes('run echo')) {
      yield* emitTool(toolCall('run_terminal_cmd', { command: 'echo opencursor-mock' }), 'Running the echo command.');
      return;
    }
    if (userText.includes('make a plan') || userText.trim() === 'plan' || userText.includes('create a plan')) {
      yield* emitTool(
        toolCall('create_plan', {
          plan: '- step one\n- step two',
          name: 'Mock plan',
          overview: 'Demo plan from the mock model',
          todos: [
            { id: 't1', content: 'Step one', status: 'pending' },
            { id: 't2', content: 'Step two', status: 'pending' },
          ],
        }),
        'Drafting a small plan.',
      );
      return;
    }
    if (userText.includes('list mcp') || userText.includes('mcp list')) {
      yield* emitTool(toolCall('mcp', { operation: 'list' }), 'Listing MCP servers.');
      return;
    }
    if (userText.includes('ping mcp')) {
      yield* emitTool(toolCall('mcp', { operation: 'call', server: 'smoke', tool: 'ping', arguments: {} }), 'Calling the smoke MCP server.');
      return;
    }
    if (userText.includes('grep') || userText.includes('search for')) {
      yield* emitTool(toolCall('grep_search', { pattern: 'opencursor', output_mode: 'content' }), 'Searching the workspace.');
      return;
    }

    const text = `echo: ${lastUser?.text ?? ''} (mock)`;
    for (const chunk of chunkText(text)) {
      yield { type: 'text-delta', text: chunk };
    }
    yield { type: 'usage', usage: { input_tokens: 5, output_tokens: Math.ceil(text.length / 4) } };
    yield { type: 'stop', reason: 'end_turn' };
  }
}
