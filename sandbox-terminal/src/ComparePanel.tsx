/**
 * ComparePanel — two coders, one brief, two running previews.
 *
 * Each side is a full ChatPane (streaming, File:/Edit: parsing, retries)
 * writing into its own folder of the same sandbox, each served by its own dev
 * server via /api/preview-start's `dir` option.
 *
 * What it's for: see two takes side by side, then
 *   - ↻ Run again — redo one side, on whatever model you pick there
 *   - ★ Save      — keep a version (IndexedDB) so a re-run never loses it
 *   - ✓ Use this  — copy that version into the main project and keep going
 *                   with your persona
 * Every run writes to a fresh folder (compare-a-<run id>) so a re-run never
 * mixes with the files of the run before it, even after a page reload. Each side keeps its
 * files in memory, so follow-up Edit: blocks apply against them.
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ChatPane, type ChatHandle } from './ChatPane.js';
import { PreviewPanel } from './PreviewPanel.js';
import { applyFileEdit } from './agentParse.js';
import type { PendingChange } from './useRepoContext.js';
import type { FileNode } from './types.js';
import {
  DEFAULT_MODELS,
  FALLBACK_MODELS,
  PROVIDER_LIST,
  fetchModels,
  loadProviderKeys,
  paidUnlocked,
  type CatalogModel,
} from './providerPrefs.js';
import { deleteBuild, listBuilds, saveBuild, type SavedBuild } from './savedBuilds.js';

const API_URL =
  (import.meta.env['VITE_API_URL'] as string | undefined) ?? 'http://localhost:3001';

/** What a version carries when you take it into the main project. */
export interface BuildChoice {
  title: string;
  provider: string;
  model: string;
  files: Record<string, string>;
}

export interface CompareHandle {
  /** Send a brief (usually from the persona) to both coders — on the models
   *  you picked for A and B, when you picked them. */
  runBrief: (brief: string, picks?: { a: { provider: string; model: string }; b: { provider: string; model: string } }) => void;
}

interface Props {
  open: boolean;
  onClose: () => void;
  sandboxId: string | null;
  onUseBuild: (build: BuildChoice) => void | Promise<void>;
}

interface SideState {
  provider: string;
  model: string;
  files: Record<string, string>;
  /** Unique per run, across reloads — every run gets a folder of its own. */
  run: string;
  lastPrompt: string;
  busy: boolean;
  previewKick: number;
  note: string;
  /** Bumped to send pendingSend once a model change has rendered. */
  kick: number;
}

const selectStyle: React.CSSProperties = {
  background: '#12151D', color: '#ECEEF3', border: '1px solid #232838',
  borderRadius: 4, padding: '5px 8px', fontFamily: 'inherit', fontSize: 15,
  minWidth: 0, cursor: 'pointer',
};

const smallBtn = (enabled: boolean, accent = false): React.CSSProperties => ({
  background: enabled && accent ? '#FF3D8E' : 'transparent',
  color: !enabled ? '#4A5168' : accent ? '#0B0D12' : '#C9CEDA',
  border: `1px solid ${enabled ? (accent ? '#FF3D8E' : '#323A50') : '#232838'}`,
  borderRadius: 4, padding: '4px 10px', fontFamily: 'inherit', fontSize: 14,
  fontWeight: accent ? 700 : 500, cursor: enabled ? 'pointer' : 'default', whiteSpace: 'nowrap',
});

/** "Goal: a green landing page…" → "A green landing page…" */
export function buildTitle(prompt: string): string {
  const line = prompt.replace(/^Build this now[^\n]*\n+/i, '').split('\n').find((l) => l.trim()) || 'Untitled build';
  const clean = line.replace(/^\s*(?:Goal|Task)\s*:\s*/i, '').trim();
  const t = clean.charAt(0).toUpperCase() + clean.slice(1);
  return t.length > 70 ? `${t.slice(0, 68)}…` : t;
}

/** A brief becomes an explicit build instruction so the coder writes files. */
function asBuildPrompt(brief: string): string {
  return /^Build this now/i.test(brief) ? brief : `Build this now — write the files:\n\n${brief}`;
}

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
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minWidth: 0, flex: 1 }}>
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

const newRunId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

function useSide(slot: 'a' | 'b') {
  const firstRun = useRef(newRunId());
  const [state, setState] = useState<SideState>(() => ({
    provider: 'openrouter',
    model: DEFAULT_MODELS.openrouter || '',
    files: {},
    run: firstRun.current,
    lastPrompt: '',
    busy: false,
    previewKick: 0,
    note: '',
    kick: 0,
  }));
  const [catalog, setCatalog] = useState<CatalogModel[]>([]);
  const [loading, setLoading] = useState(false);
  const ref = useRef<ChatHandle>(null);
  // Async work reads these, not the render's state, so a send never writes
  // into a folder or file set that a re-run has already replaced.
  const filesRef = useRef<Record<string, string>>({});
  const runRef = useRef(firstRun.current);
  const pendingSend = useRef<string | null>(null);
  const touchedModel = useRef(false);
  const dir = `compare-${slot}-${state.run}`;

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
    touchedModel.current = true;
    setState(s => ({ ...s, provider: p, model: DEFAULT_MODELS[p] || '' }));
    loadCatalog(p);
  }, [loadCatalog]);

  const setModel = useCallback((m: string) => {
    touchedModel.current = true;
    setState(s => ({ ...s, model: m }));
  }, []);

  /** Live default, unless you already picked something on this side. */
  const setDefaultModel = useCallback((provider: string, model: string) => {
    if (touchedModel.current || !model) return;
    setState(s => ({ ...s, provider, model }));
    loadCatalog(provider);
  }, [loadCatalog]);

  const flash = useCallback((note: string) => {
    setState(s => ({ ...s, note }));
    setTimeout(() => setState(s => (s.note === note ? { ...s, note: '' } : s)), 2500);
  }, []);

  const writeToSandbox = useCallback(async (files: Array<{ path: string; content: string }>, sandboxId: string) => {
    const folder = `compare-${slot}-${runRef.current}`;
    try {
      await fetch(`${API_URL}/write-files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Sandbox-Session': sandboxId },
        body: JSON.stringify({ files: files.map(f => ({ path: `${folder}/${f.path}`, content: f.content })) }),
      });
      setState(s => ({ ...s, previewKick: s.previewKick + 1 }));
    } catch { /* preview just won't update */ }
  }, [slot]);

  /** Full files replace; Edit: blocks apply in order against this side's files. */
  const onFileChanges = useCallback(async (changes: PendingChange[], sandboxId: string | null) => {
    if (!sandboxId || !changes.length) return;
    const next = { ...filesRef.current };
    const written: Array<{ path: string; content: string }> = [];
    for (const c of changes) {
      let content = c.content;
      if (c.edit) {
        const r = applyFileEdit(next[c.path], c.edit);
        if ('error' in r) continue;
        content = r.content;
      }
      if (!content) continue;
      next[c.path] = content;
      written.push({ path: c.path, content });
    }
    if (!written.length) return;
    filesRef.current = next;
    setState(s => ({ ...s, files: next }));
    await writeToSandbox(written, sandboxId);
  }, [writeToSandbox]);

  const send = useCallback(async (text: string) => {
    setState(s => ({ ...s, lastPrompt: text, busy: true }));
    try {
      await ref.current?.programmaticSend(text, 'user');
    } finally {
      setState(s => ({ ...s, busy: false }));
    }
  }, []);

  /** Fresh folder, fresh conversation, optionally starting from given files. */
  const reset = useCallback((files: Record<string, string>, patch: Partial<SideState> = {}) => {
    runRef.current = newRunId();
    filesRef.current = { ...files };
    // previewKick back to 0: the remounted preview must wait for this run's files.
    setState(s => ({ ...s, ...patch, files: { ...files }, run: runRef.current, previewKick: 0 }));
  }, []);

  const rerun = useCallback(() => {
    if (!state.lastPrompt || state.busy) return;
    pendingSend.current = state.lastPrompt;
    reset({});
  }, [state.lastPrompt, state.busy, reset]);

  // After a re-run remounts the side's chat (or a picked model has rendered),
  // send the waiting prompt.
  useEffect(() => {
    const text = pendingSend.current;
    if (!text || !ref.current) return;
    pendingSend.current = null;
    void send(text);
  }, [state.run, state.kick, send]);

  /** Send on a specific model: switch first, send once the switch has rendered. */
  const sendOn = useCallback((text: string, pick: { provider: string; model: string }) => {
    touchedModel.current = true;
    pendingSend.current = text;
    setState(s => ({ ...s, provider: pick.provider, model: pick.model, kick: s.kick + 1 }));
    loadCatalog(pick.provider);
  }, [loadCatalog]);

  const loadBuild = useCallback(async (build: SavedBuild, sandboxId: string | null) => {
    touchedModel.current = true;
    reset(build.files, { provider: build.provider, model: build.model, lastPrompt: build.prompt });
    loadCatalog(build.provider);
    if (sandboxId) {
      await writeToSandbox(Object.entries(build.files).map(([path, content]) => ({ path, content })), sandboxId);
    }
  }, [reset, loadCatalog, writeToSandbox]);

  return {
    state, dir, catalog, loading, ref, filesRef,
    setProvider, setModel, setDefaultModel, onFileChanges, send, sendOn, rerun, loadBuild, loadCatalog, flash,
  };
}

type Side = ReturnType<typeof useSide>;

function treeOf(files: Record<string, string>): FileNode[] {
  return Object.keys(files).sort().map(path => ({ name: path, path, type: 'file' as const }));
}

export const ComparePanel = forwardRef<CompareHandle, Props>(function ComparePanel(
  { open, onClose, sandboxId, onUseBuild }, handleRef,
) {
  const a = useSide('a');
  const b = useSide('b');
  const [prompt, setPrompt] = useState('');
  const [builds, setBuilds] = useState<SavedBuild[]>([]);
  const [showSaved, setShowSaved] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const sending = a.state.busy || b.state.busy;

  const refreshBuilds = useCallback(() => {
    listBuilds().then(setBuilds).catch((err: Error) => setStorageError(`Saved builds unavailable: ${err.message}`));
  }, []);

  // Stays mounted (hidden via CSS) so a running generation survives closing
  // and reopening Compare — "on mount" means once.
  useEffect(() => {
    a.loadCatalog(a.state.provider);
    b.loadCatalog(b.state.provider);
    refreshBuilds();
    // Two different live defaults: a coder on A, a general model on B.
    fetch(`${API_URL}/models?op=defaults`)
      .then(r => r.json())
      .then((d: { defaults?: Record<string, { chat?: string; coder?: string }> }) => {
        const or = d.defaults?.openrouter;
        if (or?.coder) a.setDefaultModel('openrouter', or.coder);
        if (or?.chat) b.setDefaultModel('openrouter', or.chat);
      })
      .catch(() => { /* keep the hint defaults */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sendToBoth = useCallback(async (text: string) => {
    const t = text.trim();
    if (!t || sending || !sandboxId) return;
    setPrompt('');
    await Promise.all([a.send(t), b.send(t)]);
  }, [sending, sandboxId, a, b]);

  useImperativeHandle(handleRef, () => ({
    runBrief: (brief, picks) => {
      const text = asBuildPrompt(brief);
      if (!picks) { void sendToBoth(text); return; }
      if (!sandboxId) return;
      a.sendOn(text, picks.a);
      b.sendOn(text, picks.b);
    },
  }), [sendToBoth, sandboxId, a, b]);

  const save = useCallback(async (s: Side) => {
    const files = s.filesRef.current;
    if (!Object.keys(files).length) return;
    try {
      await saveBuild({
        title: buildTitle(s.state.lastPrompt), provider: s.state.provider, model: s.state.model,
        prompt: s.state.lastPrompt, files,
      });
      s.flash('Saved ★');
      refreshBuilds();
    } catch (err: unknown) {
      s.flash(`Couldn't save: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [refreshBuilds]);

  const use = useCallback((s: Side) => {
    const files = s.filesRef.current;
    if (!Object.keys(files).length) return;
    void onUseBuild({ title: buildTitle(s.state.lastPrompt), provider: s.state.provider, model: s.state.model, files });
  }, [onUseBuild]);

  const side = (s: Side, label: string, port: number) => {
    const hasFiles = Object.keys(s.state.files).length > 0;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
        <div style={{ padding: '8px 10px', borderBottom: '1px solid #191D27', flexShrink: 0,
          display: 'flex', flexDirection: 'column', gap: 6 }}>
          <ModelPicker
            label={label}
            provider={s.state.provider}
            model={s.state.model}
            catalog={s.catalog}
            loading={s.loading}
            onProvider={s.setProvider}
            onModel={s.setModel}
          />
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <button type="button" data-testid={`compare-rerun-${label}`} onClick={s.rerun}
              disabled={!s.state.lastPrompt || s.state.busy}
              title="Build the same thing again on the model picked above"
              style={smallBtn(!!s.state.lastPrompt && !s.state.busy)}>↻ Run again</button>
            <button type="button" data-testid={`compare-save-${label}`} onClick={() => void save(s)}
              disabled={!hasFiles} title="Keep this version — re-runs won't lose it"
              style={smallBtn(hasFiles)}>★ Save</button>
            <button type="button" data-testid={`compare-use-${label}`} onClick={() => use(s)}
              disabled={!hasFiles || s.state.busy}
              title="Copy this version into your project and keep building it with your persona"
              style={smallBtn(hasFiles && !s.state.busy, true)}>✓ Use this one</button>
            <span style={{ fontSize: 13, color: '#9198AA' }}>
              {s.state.note || (hasFiles ? `${Object.keys(s.state.files).length} file${Object.keys(s.state.files).length === 1 ? '' : 's'}` : '')}
            </span>
          </div>
        </div>
        <div style={{ flex: '1 1 45%', minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <ChatPane
            key={s.dir}
            ref={s.ref}
            repoRoot={s.dir}
            repoUrl={null}
            sandboxId={sandboxId}
            provider={s.state.provider}
            model={s.state.model}
            role="write"
            apiKey={loadProviderKeys()[s.state.provider] || undefined}
            tree={treeOf(s.state.files)}
            contextFiles={new Map(Object.entries(s.state.files))}
            autoRun={false}
            appliedPaths={new Set(Object.keys(s.state.files))}
            autoSelectedFiles={[]}
            searchHits={[]}
            initialMessages={[]}
            onRunCode={() => {}}
            onFileChanges={(changes) => s.onFileChanges(changes, sandboxId)}
          />
        </div>
        <div style={{ flex: '1 1 55%', minHeight: 0, borderTop: '1px solid #191D27', overflow: 'hidden', display: 'flex' }}>
          <PreviewPanel key={s.dir} sandboxId={sandboxId} detectedPort={null} defaultPort={port}
            dir={s.dir} autoStartKey={s.state.previewKick} />
        </div>
      </div>
    );
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 50, background: '#0B0D12',
      display: open ? 'flex' : 'none', flexDirection: 'column',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
        borderBottom: '1px solid #191D27', flexShrink: 0, flexWrap: 'wrap' }}>
        <strong style={{ color: '#FF3D8E', fontSize: 15, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
          Compare
        </strong>
        {!sandboxId && (
          <span style={{ fontSize: 14, color: '#ffcc66' }}>
            Open a blank project or GitHub repo first — Compare needs a sandbox to run both previews.
          </span>
        )}
        <div style={{ flex: 1, display: 'flex', gap: 8, minWidth: 240 }}>
          <input
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendToBoth(prompt); } }}
            placeholder="Describe what to build — or send a brief from your persona with ⇄"
            disabled={sending || !sandboxId}
            style={{ flex: 1, background: '#12151D', color: '#ECEEF3', border: '1px solid #232838',
              borderRadius: 4, padding: '7px 10px', fontFamily: 'inherit', fontSize: 15, minWidth: 0 }}
          />
          <button type="button" onClick={() => void sendToBoth(prompt)} disabled={sending || !prompt.trim() || !sandboxId}
            style={smallBtn(!sending && !!prompt.trim() && !!sandboxId, true)}>
            {sending ? 'Building…' : 'Send to both'}
          </button>
        </div>
        <button type="button" data-testid="compare-saved-toggle" onClick={() => { refreshBuilds(); setShowSaved(v => !v); }}
          style={smallBtn(true)}>★ Saved ({builds.length})</button>
        <button type="button" onClick={onClose} title="Close Compare"
          style={{ background: 'transparent', color: '#9198AA', border: '1px solid #232838',
            borderRadius: 4, width: 28, height: 28, cursor: 'pointer', fontSize: 16, flexShrink: 0 }}>
          ×
        </button>
      </div>
      {showSaved && (
        <div data-testid="compare-saved-list" style={{ borderBottom: '1px solid #191D27', padding: '8px 14px',
          maxHeight: 240, overflowY: 'auto', flexShrink: 0, background: '#0F1218' }}>
          {storageError && <div style={{ color: '#ff8a8a', fontSize: 14 }}>{storageError}</div>}
          {!builds.length && !storageError && (
            <div style={{ color: '#9198AA', fontSize: 14 }}>
              Nothing saved yet. ★ Save a version you like and it stays here, even after re-runs or a new sandbox.
            </div>
          )}
          {builds.map(build => (
            <div key={build.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '5px 0',
              borderBottom: '1px solid #171B26', flexWrap: 'wrap' }}>
              <span style={{ flex: 1, minWidth: 200, fontSize: 14, color: '#ECEEF3' }}>
                ★ {build.title}
                <span style={{ color: '#656C7E' }}> · {build.model} · {Object.keys(build.files).length} files · {new Date(build.createdAt).toLocaleString()}</span>
              </span>
              <button type="button" style={smallBtn(true, true)}
                onClick={() => void onUseBuild({ title: build.title, provider: build.provider, model: build.model, files: build.files })}>
                ✓ Use in project</button>
              <button type="button" style={smallBtn(!!sandboxId)} disabled={!sandboxId}
                onClick={() => void a.loadBuild(build, sandboxId)}>Open in A</button>
              <button type="button" style={smallBtn(!!sandboxId)} disabled={!sandboxId}
                onClick={() => void b.loadBuild(build, sandboxId)}>Open in B</button>
              <button type="button" style={smallBtn(true)}
                onClick={() => { if (confirm(`Delete the saved build "${build.title}"?`)) void deleteBuild(build.id).then(refreshBuilds); }}>
                Delete</button>
            </div>
          ))}
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
        <div style={{ flex: 1, minWidth: 0, borderRight: '1px solid #191D27', display: 'flex' }}>
          {side(a, 'A', 3000)}
        </div>
        <div style={{ flex: 1, minWidth: 0, display: 'flex' }}>
          {side(b, 'B', 3001)}
        </div>
      </div>
    </div>
  );
});
ComparePanel.displayName = 'ComparePanel';

export default ComparePanel;
