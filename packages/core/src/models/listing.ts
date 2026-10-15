/** Shared model-listing helpers — pricing normalization across provider shapes. */

import type { ModelInfo, ModelPricing } from '../protocol/models.js';

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * Normalize a provider model entry into ModelInfo, parsing pricing when the
 * endpoint reports it (OpenRouter `pricing.prompt/completion` per-token USD,
 * or `input_cost_per_token`/`output_cost_per_token` per-token variants).
 */
export function normalizeModelEntry(entry: Record<string, unknown>): ModelInfo | null {
  const id = typeof entry['id'] === 'string' ? entry['id'] : typeof entry['name'] === 'string' ? entry['name'] : null;
  if (!id) return null;

  const info: ModelInfo = { id };

  const display = entry['display_name'] ?? entry['name'] ?? entry['displayName'];
  if (typeof display === 'string' && display.length > 0 && display !== id) info.display_name = display;

  const created = entry['created_at'] ?? entry['created'];
  if (typeof created === 'string') info.created_at = created;
  else if (typeof created === 'number') info.created_at = new Date(created * 1000).toISOString();

  const contextLength = toNumber(entry['context_length'] ?? entry['context_window'] ?? entry['top_provider']);
  if (contextLength !== undefined) info.context_length = contextLength;

  const pricing = parsePricing(entry);
  if (pricing) info.pricing = pricing;

  return info;
}

function parsePricing(entry: Record<string, unknown>): ModelPricing | undefined {
  const pricing: ModelPricing = {};

  const pricingBlock = entry['pricing'];
  if (typeof pricingBlock === 'object' && pricingBlock !== null) {
    const block = pricingBlock as Record<string, unknown>;
    const prompt = toNumber(block['prompt'] ?? block['input'] ?? block['input_per_token']);
    const completion = toNumber(block['completion'] ?? block['output'] ?? block['output_per_token']);
    if (prompt !== undefined) pricing.input_per_million = prompt * 1_000_000;
    if (completion !== undefined) pricing.output_per_million = completion * 1_000_000;
    const currency = block['currency'];
    if (typeof currency === 'string') pricing.currency = currency;
  }

  const directInput = toNumber(entry['input_cost_per_token'] ?? entry['input_cost_per_million']);
  const directOutput = toNumber(entry['output_cost_per_token'] ?? entry['output_cost_per_million']);
  if (directInput !== undefined) {
    pricing.input_per_million =
      entry['input_cost_per_million'] !== undefined ? directInput : directInput * 1_000_000;
  }
  if (directOutput !== undefined) {
    pricing.output_per_million =
      entry['output_cost_per_million'] !== undefined ? directOutput : directOutput * 1_000_000;
  }

  if (pricing.input_per_million === undefined && pricing.output_per_million === undefined) return undefined;
  return pricing;
}

export function formatPricing(pricing: ModelPricing | undefined): string | null {
  if (!pricing) return null;
  const parts: string[] = [];
  if (pricing.input_per_million !== undefined) parts.push(`$${pricing.input_per_million.toFixed(2)}/M in`);
  if (pricing.output_per_million !== undefined) parts.push(`$${pricing.output_per_million.toFixed(2)}/M out`);
  if (parts.length === 0) return null;
  return parts.join(' · ');
}
