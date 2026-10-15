/** Price catalog — fetches per-million-token pricing from llm-prices.com and matches models. */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ModelPricing } from '../protocol/models.js';

export interface PriceCatalogEntry {
  id: string;
  vendor: string;
  name: string;
  input: number;
  output: number;
  input_cached: number | null;
}

export interface PriceCatalog {
  updated_at: string | null;
  fetched_at: string;
  prices: PriceCatalogEntry[];
  source: 'network' | 'cache';
  stale: boolean;
}

const DEFAULT_PRICES_URL = 'https://www.llm-prices.com/current-v1.json';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

export function pricesUrl(): string {
  return process.env['OPENCURSOR_PRICES_URL'] ?? DEFAULT_PRICES_URL;
}

export function defaultPricesCachePath(homeRoot: string): string {
  return path.join(homeRoot, 'prices-cache.json');
}

function parseCatalog(text: string, source: 'network' | 'cache', stale: boolean): PriceCatalog {
  const parsed = JSON.parse(text) as {
    updated_at?: string;
    prices?: Array<{
      id?: string;
      vendor?: string;
      name?: string;
      input?: number;
      output?: number;
      input_cached?: number | null;
    }>;
  };
  const prices: PriceCatalogEntry[] = [];
  for (const entry of parsed.prices ?? []) {
    if (typeof entry.id !== 'string' || typeof entry.input !== 'number' || typeof entry.output !== 'number') continue;
    prices.push({
      id: entry.id,
      vendor: typeof entry.vendor === 'string' ? entry.vendor : '',
      name: typeof entry.name === 'string' ? entry.name : entry.id,
      input: entry.input,
      output: entry.output,
      input_cached: typeof entry.input_cached === 'number' ? entry.input_cached : null,
    });
  }
  return {
    updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : null,
    fetched_at: new Date().toISOString(),
    prices,
    source,
    stale,
  };
}

function readCache(cachePath: string | undefined): PriceCatalog | null {
  if (!cachePath) return null;
  try {
    const text = readFileSync(cachePath, 'utf8');
    const parsed = JSON.parse(text) as { fetched_at?: string } & Record<string, unknown>;
    const catalog = parseCatalog(JSON.stringify(parsed), 'cache', false);
    if (typeof parsed.fetched_at === 'string') catalog.fetched_at = parsed.fetched_at;
    return catalog;
  } catch {
    return null;
  }
}

function writeCache(cachePath: string | undefined, catalog: PriceCatalog): void {
  if (!cachePath) return;
  try {
    mkdirSync(path.dirname(cachePath), { recursive: true });
    const temp = `${cachePath}.tmp`;
    writeFileSync(temp, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
    renameSync(temp, cachePath);
  } catch {
    // cache write failure must not break pricing
  }
}

export async function loadPriceCatalog(opts?: {
  cachePath?: string;
  url?: string;
  maxAgeMs?: number;
  refresh?: boolean;
  signal?: AbortSignal;
}): Promise<PriceCatalog> {
  const cachePath = opts?.cachePath;
  const maxAgeMs = opts?.maxAgeMs ?? DEFAULT_TTL_MS;

  if (!opts?.refresh) {
    const cached = readCache(cachePath);
    if (cached) {
      const age = Date.now() - new Date(cached.fetched_at).getTime();
      if (Number.isFinite(age) && age >= 0 && age < maxAgeMs) return cached;
    }
  }

  try {
    const response = await fetch(opts?.url ?? pricesUrl(), {
      signal: opts?.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`prices request failed: ${response.status}`);
    const text = await response.text();
    const catalog = parseCatalog(text, 'network', false);
    writeCache(cachePath, catalog);
    return catalog;
  } catch (error) {
    const cached = readCache(cachePath);
    if (cached) return { ...cached, stale: true };
    throw error instanceof Error ? error : new Error(String(error));
  }
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function bestPrefixMatch(catalog: PriceCatalog, wanted: string, field: 'id' | 'name'): PriceCatalogEntry | undefined {
  const MIN_PREFIX = 4;
  let best: PriceCatalogEntry | undefined;
  let bestLength = 0;
  for (const entry of catalog.prices) {
    const key = normalizeKey(entry[field]);
    if (key.length < MIN_PREFIX) continue;
    if (!wanted.startsWith(key) && !key.startsWith(wanted)) continue;
    const matched = Math.min(key.length, wanted.length);
    if (matched > bestLength) {
      best = entry;
      bestLength = matched;
    }
  }
  return best;
}

export function matchPrice(catalog: PriceCatalog | null, modelId: string, displayName?: string): ModelPricing | undefined {
  if (!catalog || catalog.prices.length === 0) return undefined;
  const wanted = normalizeKey(modelId);
  if (wanted.length === 0) return undefined;

  const toPricing = (entry: PriceCatalogEntry): ModelPricing => ({
    input_per_million: entry.input,
    output_per_million: entry.output,
    currency: 'USD',
  });

  let match = catalog.prices.find((entry) => normalizeKey(entry.id) === wanted);
  if (!match && displayName) {
    const wantedName = normalizeKey(displayName);
    match = catalog.prices.find((entry) => normalizeKey(entry.name) === wantedName);
  }
  if (!match) match = bestPrefixMatch(catalog, wanted, 'id');
  if (!match && displayName) match = bestPrefixMatch(catalog, normalizeKey(displayName), 'name');
  return match ? toPricing(match) : undefined;
}
