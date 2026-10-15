/** Model client factory + environment detection. */

import type { ModelClient, ModelConfig, ModelProvider } from '../protocol/models.js';
import { DEFAULT_MODELS } from '../protocol/models.js';
import { AnthropicClient } from './anthropic.js';
import { OpenAIClient } from './openai.js';
import { MockModelClient } from './mock.js';

export function createModelClient(config: ModelConfig): ModelClient {
  switch (config.provider) {
    case 'anthropic':
      return new AnthropicClient(config);
    case 'openai':
      return new OpenAIClient(config);
    case 'mock':
      return new MockModelClient(config.id);
  }
}

export function detectModelConfig(
  env: Record<string, string | undefined> = process.env,
  overrides?: { provider?: 'anthropic' | 'openai' | 'mock' | null; model?: string | null },
): ModelConfig {
  const explicit = overrides?.provider ?? (env['OPENCURSOR_PROVIDER'] as ModelProvider | undefined);
  const modelOverride = overrides?.model ?? env['OPENCURSOR_MODEL'] ?? undefined;

  const pick = (provider: ModelProvider): ModelConfig => ({
    provider,
    id: modelOverride ?? DEFAULT_MODELS[provider],
  });
  if (explicit === 'anthropic' || explicit === 'openai' || explicit === 'mock') {
    return pick(explicit);
  }
  if (env['ANTHROPIC_API_KEY']) return pick('anthropic');
  if (env['OPENAI_API_KEY']) return pick('openai');
  return pick('mock');
}

export { MockModelClient } from './mock.js';
export { AnthropicClient, toAnthropicMessages } from './anthropic.js';
export { OpenAIClient, toOpenAIMessages } from './openai.js';
export { parseSSEStream, iterateFetchSSE } from './sse.js';
