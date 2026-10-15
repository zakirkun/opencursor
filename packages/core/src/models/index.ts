/** Model client factory + configuration resolution. */

import type { ModelClient, ModelConfig, ModelInfo, ModelProvider } from '../protocol/models.js';
import { AnthropicClient } from './anthropic.js';
import { OpenAIClient } from './openai.js';
import { loadPriceCatalog, matchPrice, defaultPricesCachePath } from './prices.js';
import type { PriceCatalog } from './prices.js';

export function createModelClient(config: ModelConfig): ModelClient {
  switch (config.provider) {
    case 'anthropic':
      return new AnthropicClient(config);
    case 'openai':
      return new OpenAIClient(config);
  }
}

export interface LlmSettings {
  provider?: ModelProvider | null;
  model?: string | null;
  api_key?: string | null;
  base_url?: string | null;
  max_tokens?: number | null;
  temperature?: number | null;
}

export function pickProvider(env: Record<string, string | undefined>, settings?: LlmSettings): ModelProvider | null {
  const explicit = settings?.provider ?? (env['OPENCURSOR_PROVIDER'] as ModelProvider | undefined);
  if (explicit === 'anthropic' || explicit === 'openai') return explicit;
  if (settings?.api_key) {
    return settings?.base_url?.toLowerCase().includes('anthropic') ? 'anthropic' : 'openai';
  }
  if (env['ANTHROPIC_API_KEY']) return 'anthropic';
  if (env['OPENAI_API_KEY']) return 'openai';
  return null;
}

export function buildModelConfig(
  provider: ModelProvider,
  modelId: string | null,
  env: Record<string, string | undefined> = process.env,
  settings?: LlmSettings,
): ModelConfig {
  const config: ModelConfig = { provider, id: modelId ?? '' };
  if (provider === 'anthropic') {
    const apiKey = settings?.api_key ?? env['ANTHROPIC_API_KEY'];
    const baseUrl = settings?.base_url ?? env['ANTHROPIC_BASE_URL'];
    if (apiKey) config.api_key = apiKey;
    if (baseUrl) config.base_url = baseUrl;
  } else {
    const apiKey = settings?.api_key ?? env['OPENAI_API_KEY'];
    const baseUrl = settings?.base_url ?? env['OPENAI_BASE_URL'];
    if (apiKey) config.api_key = apiKey;
    if (baseUrl) config.base_url = baseUrl;
  }
  if (settings?.max_tokens !== null && settings?.max_tokens !== undefined) config.max_tokens = settings.max_tokens;
  if (settings?.temperature !== null && settings?.temperature !== undefined) config.temperature = settings.temperature;
  return config;
}

export interface ResolvedLlm {
  config: ModelConfig | null;
  reason?: string;
}

/**
 * Resolve the effective model config. The model id is never hardcoded: when the
 * user has not chosen one, the first entry from the provider's /models endpoint
 * is used. Returns config: null with a reason when no provider is configured.
 */
export async function resolveModelConfig(
  env: Record<string, string | undefined> = process.env,
  settings?: LlmSettings,
): Promise<ResolvedLlm> {
  const provider = pickProvider(env, settings);
  if (!provider) {
    return { config: null, reason: 'no LLM provider configured; set a provider and API key in settings' };
  }
  const configuredModel = settings?.model ?? env['OPENCURSOR_MODEL'] ?? null;
  if (configuredModel) {
    return { config: buildModelConfig(provider, configuredModel, env, settings) };
  }
  const probe = createModelClient(buildModelConfig(provider, '', env, settings));
  try {
    const models = await probe.listModels();
    const first = models[0]?.id;
    if (!first) {
      return { config: null, reason: `provider ${provider} returned no models; choose a model id in settings` };
    }
    return { config: buildModelConfig(provider, first, env, settings) };
  } catch (error) {
    return {
      config: null,
      reason: `could not list models from ${provider}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export interface ListedModel extends ModelInfo {
  price_source?: 'catalog' | 'provider';
}

/**
 * List models for a provider and merge pricing: provider-reported pricing wins;
 * otherwise match against the llm-prices.com catalog.
 */
export async function listModelsWithPrices(
  config: ModelConfig,
  opts?: { homeRoot?: string; refreshPrices?: boolean },
): Promise<{ models: ListedModel[]; catalog: { updated_at: string | null; source: string; stale: boolean } | null }> {
  const client = createModelClient(config);
  const models = await client.listModels();

  let catalog: PriceCatalog | null = null;
  let catalogSummary: { updated_at: string | null; source: string; stale: boolean } | null = null;
  try {
    catalog = await loadPriceCatalog({
      cachePath: opts?.homeRoot ? defaultPricesCachePath(opts.homeRoot) : undefined,
      refresh: opts?.refreshPrices,
    });
    catalogSummary = { updated_at: catalog.updated_at, source: catalog.source, stale: catalog.stale };
  } catch {
    catalog = null;
  }

  const listed: ListedModel[] = models.map((model) => {
    if (model.pricing && (model.pricing.input_per_million !== undefined || model.pricing.output_per_million !== undefined)) {
      return { ...model, price_source: 'provider' };
    }
    const matched = matchPrice(catalog, model.id, model.display_name);
    if (matched) return { ...model, pricing: matched, price_source: 'catalog' };
    return model;
  });

  return { models: listed, catalog: catalogSummary };
}

export function detectModelConfig(
  env: Record<string, string | undefined> = process.env,
  settings?: LlmSettings,
): ModelConfig | null {
  const provider = pickProvider(env, settings);
  if (!provider) return null;
  const configuredModel = settings?.model ?? env['OPENCURSOR_MODEL'] ?? null;
  return buildModelConfig(provider, configuredModel, env, settings);
}

export { AnthropicClient, toAnthropicMessages } from './anthropic.js';
export { OpenAIClient, toOpenAIMessages } from './openai.js';
export { parseSSEStream, iterateFetchSSE } from './sse.js';
export { normalizeModelEntry, formatPricing } from './listing.js';
export { loadPriceCatalog, matchPrice, defaultPricesCachePath, pricesUrl } from './prices.js';
export type { PriceCatalog, PriceCatalogEntry } from './prices.js';
