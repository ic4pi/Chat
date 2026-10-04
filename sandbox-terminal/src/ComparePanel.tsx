/**
 * ComparePanel — two models, one prompt, two running previews.
 *
 * Each side is a full ChatPane (so both get the real agent: streaming,
 * File:/Edit: parsing, retries — not a stripped-down generator) writing into
 * its own subdirectory of the same sandbox (compare-a/, compare-b/) via
 * /api/write-files, each served by its own dev server on its own port via
 * /api/preview-start's `dir` option. One sandbox, two isolated projects.
 *
 * Deliberately simple: no auto-apply toggle (every write lands immediately —
 * that's the point, you're here to see it run) and no shared file context
 * (each side starts blank, driven only by the prompt). For "which model
 * handles this existing repo better," two full Workspace sessions are a
 * truer comparison than this; this is for "show me both takes on an idea."
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChatPane, type ChatHandle, type Message } from './ChatPane.js';
import { PreviewPanel } from './PreviewPanel.js';
import {
  DEFAULT_MODELS,
  FALLBACK_MODELS,
  PROVIDER_LIST,
  fetchModels,
  loadProviderKeys,
  paidUnlocked,
  type CatalogModel,
} from './providerPrefs.js';

const API_URL =
  (import.meta.env['VITE_API_URL'] as string | undefined) ?? 'http://localhost:3001';

interface Props {
  open: boolean;
  onClose: () => void;
  sandboxId: string | null;
}

interface SideState {
  provider: string;
  model: string;
  messages: Message[];
  status: string;
}

const selectStyle: React.CSSProperties = {
  background: '#12151D', color: '#ECEEF3', border: '1px solid #232838',
  borderRadius: 4, padding: '5px 8px', fontFamily: 'inherit', fontSize: 15,
  minWidth: 0, cursor: 'pointer',
};

function ModelPicker({
  label, provider, model, catalog, loading, onProvider, onModel,
}: {
  label: string;
  provider: string;
  model: string;
  catalog: CatalogModel[];
  loading: boolean;
  onProvider: (p: string) => void;
  onModel: (m: string) => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minWidth: 0 }}>
      <span style={{ fontSize: 13, fontWeight: 700, color: '#FF3D8E', letterSpacing: '0.04em' }}>{label}</span>
      <select value={provider} onChange={e => onProvider(e.target.value)} style={{ ...selectStyle, flex: '0 0 auto' }}>
        {PROVIDER_LIST.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
      </select>
      <select value={model} onChange={e => onModel(e.target.value)} style={{ ...selectStyle, flex: 1 }} disabled={loading && !catalog.length}>
        {loading && !catalog.length ? (
          <option value={model}>Loading…</option>
        ) : (
          catalog.map(m => {
            const locked = m.free === false && !paidUnlocked();
            return <option key={m.id} value={m.id} disabled={locked}>{m.name}{m.free ? ' · free' : ' · paid'}{locked ? ' 🔒' : ''}</option>;
          })
        )}
        {model && !catalog.some(m => m.id === model) && <option value={model}>{model}</option>}
      </select>
    </div>
  );
}

function useSide(initialProvider: string, dir: string) {
  const [state, setState] = useState<SideState>(() => ({
    provider: initialProvider,
    model: DEFAULT_MODELS[initialProvider] || '',
    messages: [],
    status: '',
  }));
  const [catalog, setCatalog] = useState<CatalogModel[]>([]);
  const [loading, setLoading] = useState(false);
  const ref = useRef<ChatHandle>(null);

  const loadCatalog = useCallback((providerId: string) => {
    setLoading(true);
    const keys = loadProviderKeys();
    void fetchModels(providerId, keys[providerId] || undefined).then(models => {
      setCatalog(models.length ? models : (FALLBACK_MODELS[providerId] || []).map(m => ({
        ...m, provider: providerId, free: providerId === 'openrouter', paid: providerId !== 'openrouter',
      })));
      setLoading(false);
    });
  }, []);

  const setProvider = useCallback((p: string) => {
    setState(s => ({ ...s, provider: p, model: DEFAULT_MODELS[p] || '' }));
    loadCatalog(p);
  }, [loadCatalog]);

  const setModel = useCallback((m: string) => setState(s => ({ ...s, model: m })), []);

  /** Writes land under dir/ via /api/write-files directly — Compare mode
   *  skips the main tab's auto-verify/apply pipeline entirely; every write
   *  here is immediate and unconditional. */
  const onFileChanges = useCallback(async (changes: { path: string; content: string }[], sandboxId: string | null) => {
    if (!sandboxId || !changes.length) return;
    // A blank canvas rarely produces Edit: (diff) blocks — there's nothing to
    // diff against — but if one slips through unresolved, content is empty;
    // writing that would blank out or create a junk file, so skip it.
    const files = changes.filter(c => c.content).map(c => ({ path: `${dir}/${c.path}`, content: c.content }));
    if (!files.length) return;
    try {
      await fetch(`${API_URL}/write-files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Sandbox-Session': sandboxId },
        body: JSON.stringify({ files }),
      });
    } catch { /* surfaced implicitly — preview just won't update */ }
  }, [dir]);

  return { state, setState, catalog, loading, ref, setProvider, setModel, onFileChanges, loadCatalog };
}

export function ComparePanel({ open, onClose, sandboxId }: Props) {
  const a = useSide('openrouter', 'compare-a');
  const b = useSide('cerebras', 'compare-b');
  const [prompt, setPrompt] = useState('');
  const [sending, setSending] = useState(false);

  // This panel stays mounted (hidden via CSS, not unmounted) so a running
  // generation survives closing/reopening Compare — so "on mount" really
  // does mean "once ever," no `open` gating needed.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    a.loadCatalog(a.state.provider);
    b.loadCatalog(b.state.provider);
  }, []);

  const sendToBoth = useCallback(async () => {
    const text = prompt.trim();
    if (!text || sending || !sandboxId) return;
    setSending(true);
    setPrompt('');
    try {
      await Promise.all([
        a.ref.current?.programmaticSend(text, 'user').then(changes => a.onFileChanges(changes, sandboxId)),
        b.ref.current?.programmaticSend(text, 'user').then(changes => b.onFileChanges(changes, sandboxId)),
      ]);
    } finally {
      setSending(false);
    }
  }, [prompt, sending, sandboxId, a, b]);

  const side = (s: ReturnType<typeof useSide>, label: string, port: number, dir: string) => (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
      <div style={{ padding: '8px 10px', borderBottom: '1px solid #191D27', flexShrink: 0 }}>
        <ModelPicker
          label={label}
          provider={s.state.provider}
          model={s.state.model}
          catalog={s.catalog}
          loading={s.loading}
          onProvider={s.setProvider}
          onModel={s.setModel}
        />
      </div>
      <div style={{ flex: '1 1 45%', minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <ChatPane
          ref={s.ref}
          repoRoot={label}
          repoUrl={null}
          sandboxId={sandboxId}
          provider={s.state.provider}
          model={s.state.model}
          role="write"
          apiKey={loadProviderKeys()[s.state.provider] || undefined}
          tree={[]}
          contextFiles={new Map()}
          autoRun={false}
          appliedPaths={new Set()}
          autoSelectedFiles={[]}
          searchHits={[]}
          initialMessages={s.state.messages}
          onMessagesChange={(messages) => s.setState(prev => ({ ...prev, messages }))}
          onRunCode={() => {}}
          onFileChanges={(changes) => s.onFileChanges(changes, sandboxId)}
        />
      </div>
      <div style={{ flex: '1 1 55%', minHeight: 0, borderTop: '1px solid #191D27', overflow: 'hidden', display: 'flex' }}>
        <PreviewPanel sandboxId={sandboxId} detectedPort={null} defaultPort={port} dir={dir} />
      </div>
    </div>
  );

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 50, background: '#0B0D12',
      display: open ? 'flex' : 'none', flexDirection: 'column',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
        borderBottom: '1px solid #191D27', flexShrink: 0 }}>
        <strong style={{ color: '#FF3D8E', fontSize: 15, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
          Compare
        </strong>
        {!sandboxId && (
          <span style={{ fontSize: 14, color: '#ffcc66' }}>
            Open a blank project or GitHub repo first — Compare needs a sandbox to run both previews.
          </span>
        )}
        <div style={{ flex: 1, display: 'flex', gap: 8, minWidth: 0 }}>
          <input
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendToBoth(); } }}
            placeholder="Describe what to build — both models get this exact prompt…"
            disabled={sending || !sandboxId}
            style={{ flex: 1, background: '#12151D', color: '#ECEEF3', border: '1px solid #232838',
              borderRadius: 4, padding: '7px 10px', fontFamily: 'inherit', fontSize: 15 }}
          />
          <button type="button" onClick={() => void sendToBoth()} disabled={sending || !prompt.trim() || !sandboxId}
            style={{ background: sending || !sandboxId ? '#191D27' : '#FF3D8E',
              color: sending || !sandboxId ? '#9198AA' : '#0B0D12', border: 'none', borderRadius: 4,
              padding: '7px 16px', fontFamily: 'inherit', fontSize: 15, fontWeight: 700,
              whiteSpace: 'nowrap', cursor: sending || !sandboxId ? 'default' : 'pointer' }}>
            {sending ? 'Sending…' : 'Send to both'}
          </button>
        </div>
        <button type="button" onClick={onClose} title="Close Compare"
          style={{ background: 'transparent', color: '#9198AA', border: '1px solid #232838',
            borderRadius: 4, width: 28, height: 28, cursor: 'pointer', fontSize: 16, flexShrink: 0 }}>
          ×
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
        <div style={{ flex: 1, minWidth: 0, borderRight: '1px solid #191D27', display: 'flex' }}>
          {side(a, 'Model A', 3000, 'compare-a')}
        </div>
        <div style={{ flex: 1, minWidth: 0, display: 'flex' }}>
          {side(b, 'Model B', 3001, 'compare-b')}
        </div>
      </div>
    </div>
  );
}

export default ComparePanel;
