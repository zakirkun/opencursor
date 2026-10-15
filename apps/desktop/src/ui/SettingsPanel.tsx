/** Settings panel — LLM provider configuration + live model browsing with pricing. */

import { useCallback, useEffect, useState } from 'react';
import type { ServerClient } from '../lib/client.js';
import { palette } from './theme.js';
import { Pill } from './primitives.js';

interface LlmConfigView {
  provider: 'anthropic' | 'openai' | null;
  model: string | null;
  api_key: string | null;
  base_url: string | null;
  max_tokens: number | null;
  temperature: number | null;
}

interface ModelStatusView {
  configured: boolean;
  provider: string | null;
  model: string | null;
  reason?: string;
}

interface ListedModelView {
  id: string;
  display_name?: string;
  context_length?: number;
  pricing?: { input_per_million?: number; output_per_million?: number; currency?: string };
  price_source?: 'catalog' | 'provider';
}

interface CatalogView {
  updated_at: string | null;
  source: string;
  stale: boolean;
}

function parseNumber(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function priceText(pricing: ListedModelView['pricing']): string | null {
  if (!pricing) return null;
  const parts: string[] = [];
  if (pricing.input_per_million !== undefined) parts.push(`$${pricing.input_per_million.toFixed(2)}/M in`);
  if (pricing.output_per_million !== undefined) parts.push(`$${pricing.output_per_million.toFixed(2)}/M out`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function SettingsPanel({ client, onSaved }: { client: ServerClient; onSaved: () => void }) {
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [configPath, setConfigPath] = useState<string | null>(null);

  const [provider, setProvider] = useState<'anthropic' | 'openai'>('openai');
  const [apiKey, setApiKey] = useState('');
  const [keyTouched, setKeyTouched] = useState(false);
  const [keyStored, setKeyStored] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [maxTokens, setMaxTokens] = useState('');
  const [temperature, setTemperature] = useState('');

  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ ok: boolean; text: string } | null>(null);

  const [models, setModels] = useState<ListedModelView[] | null>(null);
  const [catalog, setCatalog] = useState<CatalogView | null>(null);
  const [modelsBusy, setModelsBusy] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const result = await client.call<{ config: { llm: LlmConfigView }; config_path: string }>('config.get');
        if (disposed) return;
        const llm = result.config.llm;
        setProvider(llm.provider ?? 'openai');
        setKeyStored(llm.api_key === '***');
        setBaseUrl(llm.base_url ?? '');
        setModel(llm.model ?? '');
        setMaxTokens(llm.max_tokens === null ? '' : String(llm.max_tokens));
        setTemperature(llm.temperature === null ? '' : String(llm.temperature));
        setConfigPath(result.config_path);
        setReady(true);
      } catch (error) {
        if (!disposed) setLoadError(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      disposed = true;
    };
  }, [client]);

  const save = useCallback(async () => {
    setSaving(true);
    setSaveResult(null);
    const patch: Record<string, unknown> = {
      provider,
      model: model.trim().length > 0 ? model.trim() : null,
      base_url: baseUrl.trim().length > 0 ? baseUrl.trim() : null,
      max_tokens: parseNumber(maxTokens),
      temperature: parseNumber(temperature),
    };
    const typedKey = apiKey.trim();
    if (keyTouched && typedKey.length > 0) patch['api_key'] = typedKey;
    try {
      const result = await client.call<{ model: ModelStatusView }>('config.set', { patch: { llm: patch } });
      if (keyTouched && typedKey.length > 0) setKeyStored(true);
      setKeyTouched(false);
      setApiKey('');
      setSaveResult({
        ok: true,
        text: result.model.configured
          ? `saved — model: ${result.model.model ?? 'unknown'}`
          : `saved — ${result.model.reason ?? 'no model resolved'}`,
      });
      onSaved();
    } catch (error) {
      setSaveResult({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setSaving(false);
    }
  }, [client, provider, model, baseUrl, maxTokens, temperature, apiKey, keyTouched, onSaved]);

  const browse = useCallback(
    async (refresh: boolean) => {
      setModelsBusy(true);
      setModelsError(null);
      try {
        const result = await client.call<{ provider: string; models: ListedModelView[]; catalog: CatalogView | null }>(
          'models.list',
          { provider, refresh_prices: refresh },
        );
        setModels(result.models);
        setCatalog(result.catalog);
      } catch (error) {
        setModelsError(error instanceof Error ? error.message : String(error));
      } finally {
        setModelsBusy(false);
      }
    },
    [client, provider],
  );

  if (loadError !== null) {
    return <div style={{ color: palette.status.error, fontSize: 12 }}>config load failed: {loadError}</div>;
  }
  if (!ready) {
    return <div style={{ color: palette.text.tertiary }}>loading config…</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <section>
        <SectionLabel>Provider</SectionLabel>
        <select
          value={provider}
          onChange={(event) => {
            const value = event.target.value;
            if (value === 'anthropic' || value === 'openai') setProvider(value);
          }}
          style={inputStyle}
        >
          <option value="openai">openai</option>
          <option value="anthropic">anthropic</option>
        </select>
      </section>

      <section>
        <SectionLabel>API key</SectionLabel>
        <input
          type="password"
          value={apiKey}
          onChange={(event) => {
            setApiKey(event.target.value);
            setKeyTouched(true);
          }}
          placeholder={keyStored && !keyTouched ? 'configured — type to replace' : 'not set'}
          style={inputStyle}
          autoComplete="off"
          spellCheck={false}
        />
      </section>

      <section>
        <SectionLabel>Base URL</SectionLabel>
        <input
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="provider default"
          style={inputStyle}
          spellCheck={false}
        />
      </section>

      <section>
        <SectionLabel>Model</SectionLabel>
        <input
          value={model}
          onChange={(event) => setModel(event.target.value)}
          placeholder="first from /models when empty"
          style={inputStyle}
          spellCheck={false}
        />
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          <label style={{ flex: 1, minWidth: 0 }}>
            <span style={tinyLabelStyle}>max tokens</span>
            <input
              value={maxTokens}
              onChange={(event) => setMaxTokens(event.target.value)}
              placeholder="default"
              style={inputStyle}
              inputMode="decimal"
              spellCheck={false}
            />
          </label>
          <label style={{ flex: 1, minWidth: 0 }}>
            <span style={tinyLabelStyle}>temperature</span>
            <input
              value={temperature}
              onChange={(event) => setTemperature(event.target.value)}
              placeholder="default"
              style={inputStyle}
              inputMode="decimal"
              spellCheck={false}
            />
          </label>
        </div>
      </section>

      <section>
        <button type="button" onClick={() => void save()} disabled={saving} style={primaryButtonStyle(saving)}>
          {saving ? 'saving…' : 'Save to config.json'}
        </button>
        {saveResult ? (
          <div style={{ marginTop: 6 }}>
            <Pill tone={saveResult.ok ? 'ok' : 'error'}>{saveResult.text}</Pill>
          </div>
        ) : null}
      </section>

      <section>
        <SectionLabel>Available models</SectionLabel>
        <div style={{ display: 'flex', gap: 6 }}>
          <SmallButton onClick={() => void browse(false)} disabled={modelsBusy}>
            {modelsBusy ? 'listing…' : 'Browse'}
          </SmallButton>
          <SmallButton onClick={() => void browse(true)} disabled={modelsBusy}>
            Refresh prices
          </SmallButton>
        </div>
        {catalog ? (
          <div
            style={{
              color: catalog.stale ? palette.status.warn : palette.text.tertiary,
              fontSize: 10,
              marginTop: 6,
            }}
          >
            prices: {catalog.source}
            {catalog.updated_at ? ` · updated ${catalog.updated_at.slice(0, 10)}` : ''}
            {catalog.stale ? ' · stale' : ''}
          </div>
        ) : null}
        {modelsError ? (
          <div style={{ color: palette.status.error, fontSize: 11, marginTop: 6 }}>{modelsError}</div>
        ) : null}
        {modelsError === null && models !== null ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
            {models.length === 0 ? <div style={{ color: palette.text.tertiary }}>provider returned no models</div> : null}
            {models.map((entry) => (
              <ModelRow key={entry.id} entry={entry} selected={entry.id === model.trim()} onPick={() => setModel(entry.id)} />
            ))}
          </div>
        ) : null}
      </section>

      {configPath ? (
        <div style={{ color: palette.text.quaternary, fontSize: 10, fontFamily: 'monospace', wordBreak: 'break-all' }}>{configPath}</div>
      ) : null}
    </div>
  );
}

function ModelRow({ entry, selected, onPick }: { entry: ListedModelView; selected: boolean; onPick: () => void }) {
  const price = priceText(entry.pricing);
  const context = entry.context_length !== undefined ? `${Math.round(entry.context_length / 1000)}k ctx` : null;
  const detail = [price, context].filter((part): part is string => part !== null).join(' · ');
  return (
    <button
      type="button"
      onClick={onPick}
      title={entry.display_name ? `${entry.display_name} (${entry.id})` : entry.id}
      style={{
        textAlign: 'left',
        background: selected ? palette.fill.secondary : 'transparent',
        border: `1px solid ${selected ? palette.stroke.primary : 'transparent'}`,
        borderRadius: 6,
        padding: '5px 7px',
        cursor: 'pointer',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          fontFamily: 'monospace',
          fontSize: 11,
          color: palette.text.secondary,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {entry.id}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 2, overflow: 'hidden' }}>
        {entry.price_source ? <Pill tone={entry.price_source === 'provider' ? 'accent' : 'neutral'}>{entry.price_source}</Pill> : null}
        <span
          style={{
            color: palette.text.tertiary,
            fontSize: 10,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {detail.length > 0 ? detail : 'no pricing'}
        </span>
      </div>
    </button>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ color: palette.text.tertiary, fontSize: 11, marginBottom: 4 }}>{children}</div>;
}

function SmallButton({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled === true}
      style={{
        background: palette.fill.secondary,
        color: disabled === true ? palette.text.tertiary : palette.text.secondary,
        border: `1px solid ${palette.stroke.secondary}`,
        borderRadius: 6,
        padding: '5px 10px',
        fontSize: 11,
        cursor: disabled === true ? 'default' : 'pointer',
      }}
    >
      {children}
    </button>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  background: palette.bg.editor,
  border: `1px solid ${palette.stroke.primary}`,
  borderRadius: 6,
  color: palette.text.primary,
  fontSize: 12,
  padding: '5px 8px',
  outline: 'none',
};

const tinyLabelStyle: React.CSSProperties = {
  display: 'block',
  color: palette.text.tertiary,
  fontSize: 10,
  marginBottom: 3,
};

function primaryButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    width: '100%',
    background: disabled ? palette.fill.secondary : palette.accent.control,
    color: disabled ? palette.text.tertiary : palette.text.primary,
    border: `1px solid ${palette.stroke.primary}`,
    borderRadius: 6,
    padding: '6px 0',
    fontSize: 12,
    fontWeight: 600,
    cursor: disabled ? 'default' : 'pointer',
  };
}
