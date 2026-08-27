/**
 * ChunkModelPanel — per–code-slice LLM selector + Generate control.
 *
 * - Dropdown (provider + model) per chunk, ARIA-labelled
 * - Badge showing the active LLM short name
 * - Selections persist via codeSlices localStorage helpers
 * - Generate posts chunkModels to POST /api/generate
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CHUNK_LIST,
  loadChunkModels,
  loadEnabledChunks,
  modelBadgeLabel,
  saveChunkModels,
  saveEnabledChunks,
  setChunkModel,
  type ChunkId,
  type ChunkModel,
} from './codeSlices.js';
import {
  DEFAULT_MODELS,
  FALLBACK_MODELS,
  PROVIDER_LIST,
  fetchModels,
  loadPaidPassword,
  loadProviderKeys,
  paidUnlocked,
  type CatalogModel,
} from './providerPrefs.js';

const API_URL =
  (import.meta.env['VITE_API_URL'] as string | undefined) ?? 'http://localhost:3001';

export interface GenerateChunkResult {
  chunkId: string;
  label: string;
  ok: boolean;
  content?: string;
  error?: string;
  provider?: string;
  model?: string;
  badge?: string;
  usedFallback?: boolean;
}

export interface ChunkModelPanelProps {
  /** Optional repo / file context appended server-side. */
  contextText?: string;
  disabled?: boolean;
  /** When false, Generate is blocked — files cannot be applied without a sandbox. */
  sandboxReady?: boolean;
  onComplete?: (results: GenerateChunkResult[], combined: string) => void;
  onStatus?: (message: string) => void;
}

const selectStyle: React.CSSProperties = {
  background: '#12151D',
  color: '#ECEEF3',
  border: '1px solid #232838',
  borderRadius: 4,
  padding: '5px 8px',
  fontFamily: 'inherit',
  fontSize: 12,
  width: '100%',
  minHeight: 32,
  cursor: 'pointer',
};

const badgeStyle: React.CSSProperties = {
  display: 'inline-block',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.04em',
  padding: '2px 7px',
  borderRadius: 999,
  background: 'rgba(212,255,63,0.12)',
  color: '#FF3D8E',
  border: '1px solid #C81F6B',
  whiteSpace: 'nowrap',
  maxWidth: 140,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  verticalAlign: 'middle',
};

async function readSseGenerate(
  res: Response,
  handlers: {
    onStatus?: (m: string) => void;
    onChunkDone?: (r: GenerateChunkResult) => void;
  },
): Promise<GenerateChunkResult[]> {
  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  if (ctype.includes('application/json')) {
    const data = await res.json() as { chunks?: GenerateChunkResult[]; error?: string };
    if (data.error) throw new Error(data.error);
    return Array.isArray(data.chunks) ? data.chunks : [];
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error('No response body');
  const decoder = new TextDecoder();
  let buffer = '';
  let final: GenerateChunkResult[] = [];

  const handleEvent = (raw: string) => {
    const line = raw.trim();
    if (!line.startsWith('data:')) return;
    const json = line.slice(5).trim();
    if (!json || json === '[DONE]') return;
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(json) as Record<string, unknown>; } catch { return; }
    const type = String(ev.type || '');
    if (type === 'status' && typeof ev.message === 'string') {
      handlers.onStatus?.(ev.message);
    } else if (type === 'chunk-done') {
      const r = ev as unknown as GenerateChunkResult;
      handlers.onChunkDone?.(r);
    } else if (type === 'done' && Array.isArray(ev.chunks)) {
      final = ev.chunks as GenerateChunkResult[];
    } else if (type === 'error') {
      throw new Error(String(ev.error || 'Generate failed'));
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';
    for (const part of parts) handleEvent(part);
  }
  if (buffer.trim()) handleEvent(buffer);
  return final;
}

export function ChunkModelPanel({
  contextText,
  disabled,
  sandboxReady = true,
  onComplete,
  onStatus,
}: ChunkModelPanelProps) {
  const [chunkModels, setChunkModels] = useState<Record<ChunkId, ChunkModel>>(() => loadChunkModels());
  const [enabled, setEnabled] = useState<Record<ChunkId, boolean>>(() => loadEnabledChunks());
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [catalog, setCatalog] = useState<Record<string, CatalogModel[]>>({});
  const [loadingProv, setLoadingProv] = useState<Record<string, boolean>>({});
  const abortRef = useRef<AbortController | null>(null);

  // Prefetch catalogs for providers currently assigned.
  const neededProviders = useMemo(() => {
    const set = new Set<string>();
    for (const c of CHUNK_LIST) set.add(chunkModels[c.id]?.provider || 'openrouter');
    return [...set];
  }, [chunkModels]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const pid of neededProviders) {
        if (catalog[pid]?.length) continue;
        setLoadingProv((prev) => ({ ...prev, [pid]: true }));
        const keys = loadProviderKeys();
        const models = await fetchModels(pid, keys[pid] || undefined);
        if (cancelled) return;
        setCatalog((prev) => ({
          ...prev,
          [pid]: models.length ? models : (FALLBACK_MODELS[pid] || []).map((m) => ({
            ...m,
            provider: pid,
            free: pid === 'openrouter',
            paid: pid !== 'openrouter',
          })),
        }));
        setLoadingProv((prev) => ({ ...prev, [pid]: false }));
      }
    })();
    return () => { cancelled = true; };
  }, [neededProviders, catalog]);

  const persist = useCallback((next: Record<ChunkId, ChunkModel>) => {
    setChunkModels(next);
    saveChunkModels(next);
  }, []);

  const handleProviderChange = useCallback((chunkId: ChunkId, provider: string) => {
    const defaultModel = DEFAULT_MODELS[provider] || '';
    persist(setChunkModel(chunkModels, chunkId, provider, defaultModel));
  }, [chunkModels, persist]);

  const handleModelChange = useCallback((chunkId: ChunkId, model: string) => {
    const provider = chunkModels[chunkId]?.provider || 'openrouter';
    persist(setChunkModel(chunkModels, chunkId, provider, model));
  }, [chunkModels, persist]);

  const handleToggle = useCallback((chunkId: ChunkId, on: boolean) => {
    setEnabled((prev) => {
      const next = { ...prev, [chunkId]: on };
      saveEnabledChunks(next);
      return next;
    });
  }, []);

  const handleGenerate = useCallback(async () => {
    const text = prompt.trim();
    if (!text || busy || disabled) return;
    if (!sandboxReady) {
      setError('Open a blank project or GitHub repo first — Generate needs a sandbox to save files.');
      return;
    }

    const activeChunks = CHUNK_LIST.filter((c) => enabled[c.id]).map((c) => c.id);
    if (!activeChunks.length) {
      setError('Enable at least one code slice.');
      return;
    }
    if (activeChunks.length > 6) {
      setError('Enable at most 6 slices per run (avoids Vercel timeouts).');
      return;
    }

    setBusy(true);
    setError(null);
    setStatus('Starting…');
    onStatus?.('Starting…');

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const keys = loadProviderKeys();
    const paidPw = loadPaidPassword();

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (paidPw) headers['X-Paid-Password'] = paidPw;
    // Prefer openrouter key as default BYOK header when present
    const fallbackKey = keys.openrouter || keys.venice || Object.values(keys).find(Boolean) || '';
    if (fallbackKey) headers['X-Provider-Key'] = fallbackKey;

    try {
      const res = await fetch(`${API_URL}/generate`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          prompt: text,
          chunks: activeChunks,
          chunkModels,
          providerKeys: keys,
          apiKey: fallbackKey || undefined,
          paidPassword: paidPw || undefined,
          context: contextText || undefined,
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const ctype = (res.headers.get('content-type') || '').toLowerCase();
        if (ctype.includes('application/json')) {
          const d = await res.json().catch(() => ({})) as { error?: string };
          throw new Error(d.error || `HTTP ${res.status}`);
        }
        throw new Error(`HTTP ${res.status}`);
      }

      const collected: GenerateChunkResult[] = [];
      const results = await readSseGenerate(res, {
        onStatus: (m) => {
          setStatus(m);
          onStatus?.(m);
        },
        onChunkDone: (r) => {
          collected.push(r);
          setStatus(
            r.ok
              ? `✓ ${r.label} (${r.badge || modelBadgeLabel(r.model || '')})`
              : `✗ ${r.label}: ${r.error || 'failed'}`,
          );
        },
      });

      const finalResults = results.length ? results : collected;
      const combined = finalResults
        .filter((r) => r.ok && r.content)
        .map((r) => `<!-- slice:${r.chunkId} model:${r.model || ''} -->\n${r.content}`)
        .join('\n\n');

      onComplete?.(finalResults, combined);
      setStatus(
        finalResults.every((r) => r.ok)
          ? `Done — ${finalResults.length} slices`
          : `Finished with errors — ${finalResults.filter((r) => r.ok).length}/${finalResults.length} ok`,
      );
    } catch (err: unknown) {
      if ((err as Error)?.name === 'AbortError') {
        setStatus('Cancelled');
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        setStatus('');
        onStatus?.(msg);
      }
    } finally {
      setBusy(false);
    }
  }, [prompt, busy, disabled, sandboxReady, enabled, chunkModels, contextText, onComplete, onStatus]);

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return (
    <section
      aria-labelledby="chunk-model-panel-title"
      style={{
        padding: '10px 12px 12px',
        borderTop: '1px solid #191D27',
        background: '#0B0D12',
        maxHeight: 'min(55vh, 480px)',
        overflow: 'auto',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
        <h2
          id="chunk-model-panel-title"
          style={{ margin: 0, fontSize: 12, fontWeight: 700, color: '#FF3D8E', letterSpacing: '0.06em', textTransform: 'uppercase' }}
        >
          LLM per code slice
        </h2>
        <span style={{ fontSize: 10, color: '#656C7E' }}>
          Choices save here. Default run: HTML + CSS + JS (max 6). Needs an open sandbox to save files.
        </span>
      </div>

      {!sandboxReady && (
        <div role="status" style={{
          marginBottom: 10, padding: '8px 10px', borderRadius: 6,
          background: 'rgba(52,211,153,.16)', border: '1px solid rgba(52,211,153,.16)', color: '#ffcc66', fontSize: 12,
        }}>
          Open a <strong style={{ color: '#ffe0a0' }}>blank project</strong> or <strong style={{ color: '#ffe0a0' }}>GitHub repo</strong> first.
          Generate is locked until a sandbox can receive files.
        </div>
      )}

      <ul
        role="list"
        aria-label="Code slice model assignments"
        style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}
      >
        {CHUNK_LIST.map((chunk) => {
          const assignment = chunkModels[chunk.id];
          const provider = assignment?.provider || 'openrouter';
          const model = assignment?.model || DEFAULT_MODELS[provider] || '';
          const badge = modelBadgeLabel(model);
          const models = catalog[provider] || FALLBACK_MODELS[provider] || [];
          const provLabelId = `chunk-prov-label-${chunk.id}`;
          const modelLabelId = `chunk-model-label-${chunk.id}`;
          const rowLabelId = `chunk-row-label-${chunk.id}`;

          return (
            <li
              key={chunk.id}
              style={{
                display: 'grid',
                gridTemplateColumns: 'auto 1fr',
                gap: 8,
                alignItems: 'start',
                padding: '8px 10px',
                border: '1px solid #191D27',
                borderRadius: 6,
                background: enabled[chunk.id] ? '#0B0D12' : '#0B0D12',
                opacity: enabled[chunk.id] ? 1 : 0.55,
              }}
            >
              <label
                style={{ display: 'flex', alignItems: 'center', gap: 6, paddingTop: 4, cursor: 'pointer' }}
                title={`Include ${chunk.label} in Generate`}
              >
                <input
                  type="checkbox"
                  checked={!!enabled[chunk.id]}
                  onChange={(e) => handleToggle(chunk.id, e.target.checked)}
                  aria-labelledby={rowLabelId}
                  style={{ accentColor: '#FF3D8E' }}
                />
              </label>

              <div style={{ display: 'grid', gap: 6, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span id={rowLabelId} style={{ fontSize: 13, fontWeight: 600, color: '#ECEEF3' }}>
                    {chunk.label}
                  </span>
                  <span
                    className="chunk-llm-badge"
                    style={badgeStyle}
                    title={`${provider} · ${model}`}
                    aria-label={`Active model for ${chunk.label}: ${badge}`}
                  >
                    {badge}
                  </span>
                  <span style={{ fontSize: 10, color: '#656C7E' }}>{chunk.description}</span>
                </div>

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(100px, 0.9fr) minmax(140px, 1.4fr)',
                    gap: 8,
                  }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <label id={provLabelId} htmlFor={`chunk-provider-${chunk.id}`} style={{ fontSize: 10, color: '#9198AA', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      Provider
                    </label>
                    <select
                      id={`chunk-provider-${chunk.id}`}
                      value={provider}
                      disabled={busy || !enabled[chunk.id]}
                      aria-labelledby={`${rowLabelId} ${provLabelId}`}
                      onChange={(e) => handleProviderChange(chunk.id, e.target.value)}
                      style={selectStyle}
                    >
                      {PROVIDER_LIST.map((p) => (
                        <option key={p.id} value={p.id}>{p.label}</option>
                      ))}
                    </select>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <label id={modelLabelId} htmlFor={`chunk-model-${chunk.id}`} style={{ fontSize: 10, color: '#9198AA', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      Model
                    </label>
                    <select
                      id={`chunk-model-${chunk.id}`}
                      value={model}
                      disabled={busy || !enabled[chunk.id] || !!loadingProv[provider]}
                      aria-labelledby={`${rowLabelId} ${modelLabelId}`}
                      aria-busy={!!loadingProv[provider]}
                      onChange={(e) => handleModelChange(chunk.id, e.target.value)}
                      style={selectStyle}
                    >
                      {loadingProv[provider] && !models.length ? (
                        <option value={model}>Loading…</option>
                      ) : (
                        models.map((m) => {
                          const locked = m.free === false && !paidUnlocked();
                          return (
                            <option key={m.id} value={m.id} disabled={locked}>
                              {m.name}{m.free ? ' · free' : ' · paid'}{locked ? ' 🔒' : ''}
                            </option>
                          );
                        })
                      )}
                      {/* Ensure current value remains selectable even if catalog lags */}
                      {model && !models.some((m) => m.id === model) && (
                        <option value={model}>{model}</option>
                      )}
                    </select>
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
        <label htmlFor="chunk-generate-prompt" style={{ fontSize: 10, color: '#9198AA', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Feature prompt
        </label>
        <textarea
          id="chunk-generate-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={busy || disabled}
          rows={3}
          placeholder="Describe what to build — each enabled slice uses its own LLM…"
          aria-describedby="chunk-generate-hint"
          style={{
            ...selectStyle,
            resize: 'vertical',
            minHeight: 64,
            lineHeight: 1.4,
            cursor: 'text',
          }}
        />
        <p id="chunk-generate-hint" style={{ margin: 0, fontSize: 10, color: '#656C7E' }}>
          Generate → <code style={{ color: '#9198AA' }}>POST /api/generate</code>.
          Unconfigured models fall back to general-purpose. Keep ≤6 slices enabled.
        </p>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={() => { void handleGenerate(); }}
            disabled={busy || disabled || !sandboxReady || !prompt.trim()}
            aria-busy={busy}
            title={!sandboxReady ? 'Open a blank project or repo first' : 'Generate enabled slices'}
            style={{
              background: busy || !sandboxReady ? '#191D27' : '#FF3D8E',
              color: busy || !sandboxReady ? '#9198AA' : '#0B0D12',
              border: 'none',
              borderRadius: 4,
              padding: '8px 16px',
              fontFamily: 'inherit',
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              cursor: busy || disabled || !sandboxReady || !prompt.trim() ? 'not-allowed' : 'pointer',
            }}
          >
            {busy ? 'Generating…' : 'Generate'}
          </button>
          {busy && (
            <button
              type="button"
              onClick={handleCancel}
              style={{
                background: 'transparent',
                color: '#9198AA',
                border: '1px solid #232838',
                borderRadius: 4,
                padding: '7px 12px',
                fontFamily: 'inherit',
                fontSize: 11,
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
          )}
          {status && (
            <span role="status" aria-live="polite" style={{ fontSize: 11, color: '#34D399' }}>
              {status}
            </span>
          )}
        </div>
        {error && (
          <div role="alert" style={{ fontSize: 12, color: '#ff6a6a' }}>{error}</div>
        )}
      </div>
    </section>
  );
}

export default ChunkModelPanel;
