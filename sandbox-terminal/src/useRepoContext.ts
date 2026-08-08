/**
 * useRepoContext — manages which files from the repo are loaded into LLM context.
 *
 * Owns:
 *   - repoRoot: the absolute path the user entered
 *   - fileTree: the tree returned from GET /files
 *   - contextFiles: Map<relativePath, content> — files the model will see
 *   - pendingChanges: files the LLM wants to write back to disk
 */

import { useState, useCallback } from 'react';
import type { FileNode } from './types.js';
import { isJunkContextPath, MAX_FILE_CHARS, truncateForContext } from './contextBudget.js';

const API_URL =
  (import.meta.env['VITE_API_URL'] as string | undefined) ?? 'http://localhost:3001';

export interface PendingChange {
  path:    string;
  content: string;
  /** content currently on disk (undefined = new file) */
  original?: string;
}

export interface RepoContextState {
  root:           string;
  sandboxId:      string | null;   // Vercel Sandbox session name (null when local)
  isRemote:       boolean;         // true = GitHub URL opened via /api/init-repo
  /** Original GitHub/git URL the user opened (for push). */
  repoUrl:        string | null;
  tree:           FileNode[];
  totalFiles:     number;
  contextFiles:   Map<string, string>;   // relPath → content
  pendingChanges: PendingChange[];
  loading:        boolean;
  error:          string | null;
  pythonReady:    boolean | null;
  pythonDetail:   string | null;
  rustReady:      boolean | null;
  rustDetail:     string | null;
  goReady:        boolean | null;
  goDetail:       string | null;
}

export interface RepoContextActions {
  /** Open a GitHub URL or local path. Optional resumeId forces that sandbox session. */
  openRepo:        (rootPathOrUrl: string, resumeId?: string | null) => Promise<void>;
  /** Start (or resume) an empty sandbox project — no GitHub clone required. */
  startBlankProject: (name?: string, resumeId?: string | null) => Promise<void>;
  addToContext:    (relPath: string, opts?: { force?: boolean })  => Promise<void>;
  /** Inject an uploaded / pasted file into model context (not from the repo tree). */
  injectContextFile: (relPath: string, content: string) => void;
  removeFromContext: (relPath: string) => void;
  clearContext:    () => void;
  setPendingChanges: (changes: PendingChange[]) => void;
  /** Write pending (or explicitly provided) changes to disk/sandbox. */
  applyChanges:    (files?: PendingChange[]) => Promise<{ path: string; ok: boolean; error?: string }[]>;
  /** Re-fetch the explorer tree (e.g. after writes). */
  refreshTree:     () => Promise<void>;
  clearChanges:    () => void;
}

export function useRepoContext(): RepoContextState & RepoContextActions {
  const [root,           setRoot]           = useState('');
  const [sandboxId,      setSandboxId]      = useState<string | null>(null);
  const [isRemote,       setIsRemote]       = useState(false);
  const [repoUrl,        setRepoUrl]        = useState<string | null>(null);
  const [tree,           setTree]           = useState<FileNode[]>([]);
  const [totalFiles,     setTotalFiles]     = useState(0);
  const [contextFiles,   setContextFiles]   = useState<Map<string, string>>(new Map());
  const [pendingChanges, setPendingChanges] = useState<PendingChange[]>([]);
  const [loading,        setLoading]        = useState(false);
  const [error,          setError]          = useState<string | null>(null);
  const [pythonReady,    setPythonReady]    = useState<boolean | null>(null);
  const [pythonDetail,   setPythonDetail]   = useState<string | null>(null);
  const [rustReady,      setRustReady]      = useState<boolean | null>(null);
  const [rustDetail,     setRustDetail]     = useState<string | null>(null);
  const [goReady,        setGoReady]        = useState<boolean | null>(null);
  const [goDetail,       setGoDetail]       = useState<string | null>(null);

  /** Build fetch headers — adds X-Sandbox-Session when we have a remote session */
  const sessionHeaders = useCallback((extra?: Record<string, string>): Record<string, string> => {
    const h: Record<string, string> = { 'Content-Type': 'application/json', ...(extra ?? {}) };
    if (sandboxId) h['X-Sandbox-Session'] = sandboxId;
    return h;
  }, [sandboxId]);

  /** Apply toolchain readiness from init-repo / init-blank JSON. */
  const applyStackStatus = useCallback((data: {
    python?: { ready?: boolean; already?: boolean; detail?: string; error?: string };
    rust?: { ready?: boolean; already?: boolean; detail?: string; error?: string };
    go?: { ready?: boolean; already?: boolean; detail?: string; error?: string };
  }) => {
    if (data.python) {
      setPythonReady(!!data.python.ready);
      setPythonDetail(
        data.python.ready
          ? (data.python.detail || (data.python.already ? 'Python already installed' : 'Python + pip ready'))
          : (data.python.error || 'Python install failed'),
      );
    } else {
      setPythonReady(null);
      setPythonDetail(null);
    }
    if (data.rust) {
      setRustReady(!!data.rust.ready);
      setRustDetail(
        data.rust.ready
          ? (data.rust.detail || (data.rust.already ? 'Rust already installed' : 'rustc + cargo ready'))
          : (data.rust.error || 'Rust install failed'),
      );
    } else {
      setRustReady(null);
      setRustDetail(null);
    }
    if (data.go) {
      setGoReady(!!data.go.ready);
      setGoDetail(
        data.go.ready
          ? (data.go.detail || (data.go.already ? 'Go already installed' : 'go toolchain ready'))
          : (data.go.error || 'Go install failed'),
      );
    } else {
      setGoReady(null);
      setGoDetail(null);
    }
  }, []);

  const openRepo = useCallback(async (rootPathOrUrl: string, resumeId?: string | null) => {
    setLoading(true);
    setError(null);
    setTree([]);
    setContextFiles(new Map());
    setPendingChanges([]);

    const isGitUrl = /^https?:\/\/|^git@/.test(rootPathOrUrl);
    const sid = (resumeId !== undefined ? resumeId : sandboxId) || undefined;

    try {
      if (isGitUrl) {
        // Remote mode: clone into Vercel Sandbox via /api/init-repo
        const res = await fetch(`${API_URL}/init-repo`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json',
            ...(sid ? { 'X-Sandbox-Session': sid } : {}) },
          body: JSON.stringify({ url: rootPathOrUrl, sandboxId: sid }),
        });
        const data = await res.json() as {
          sandboxId?: string; repoDir?: string;
          tree?: FileNode[]; totalFiles?: number; error?: string;
          python?: { ready?: boolean; already?: boolean; detail?: string; error?: string };
          rust?: { ready?: boolean; already?: boolean; detail?: string; error?: string };
          go?: { ready?: boolean; already?: boolean; detail?: string; error?: string };
        };
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        setSandboxId(data.sandboxId ?? null);
        setIsRemote(true);
        setRepoUrl(rootPathOrUrl);
        setRoot(data.repoDir ?? rootPathOrUrl);
        setTree(data.tree ?? []);
        setTotalFiles(data.totalFiles ?? 0);
        applyStackStatus(data);
      } else {
        // Local mode: direct /files endpoint on sandbox-runner
        setSandboxId(null);
        setIsRemote(false);
        setRepoUrl(null);
        const res = await fetch(`${API_URL}/files?root=${encodeURIComponent(rootPathOrUrl)}`);
        const data = await res.json() as { tree?: FileNode[]; totalFiles?: number; error?: string };
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        setRoot(rootPathOrUrl);
        setTree(data.tree ?? []);
        setTotalFiles(data.totalFiles ?? 0);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [sandboxId, applyStackStatus]);

  const startBlankProject = useCallback(async (name?: string, resumeId?: string | null) => {
    setLoading(true);
    setError(null);
    setTree([]);
    setContextFiles(new Map());
    setPendingChanges([]);

    const sid = (resumeId !== undefined ? resumeId : sandboxId) || undefined;

    try {
      const res = await fetch(`${API_URL}/init-blank`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(sid ? { 'X-Sandbox-Session': sid } : {}),
        },
        body: JSON.stringify({ sandboxId: sid, name: name || 'untitled-project' }),
      });
      const data = await res.json() as {
        sandboxId?: string; repoDir?: string;
        tree?: FileNode[]; totalFiles?: number; error?: string;
        python?: { ready?: boolean; already?: boolean; detail?: string; error?: string };
        rust?: { ready?: boolean; already?: boolean; detail?: string; error?: string };
        go?: { ready?: boolean; already?: boolean; detail?: string; error?: string };
      };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setSandboxId(data.sandboxId ?? null);
      setIsRemote(true);
      setRepoUrl(null); // blank — no remote until they add one / push elsewhere
      setRoot(data.repoDir ?? 'blank');
      setTree(data.tree ?? []);
      setTotalFiles(data.totalFiles ?? 0);
      applyStackStatus(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [sandboxId, applyStackStatus]);

  const addToContext = useCallback(async (relPath: string, opts?: { force?: boolean }) => {
    // force=true reloads from disk after a write — otherwise the model keeps
    // seeing the pre-edit version while tests already run against the new file.
    if (!opts?.force && contextFiles.has(relPath)) return;
    // Never load hashed bundles / dist into the model prompt.
    if (isJunkContextPath(relPath)) {
      console.warn('addToContext skipped junk path:', relPath);
      return;
    }
    try {
      const headers = sandboxId ? { 'X-Sandbox-Session': sandboxId } : undefined;
      const url = sandboxId
        ? `${API_URL}/file?path=${encodeURIComponent(relPath)}`
        : `${API_URL}/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(relPath)}`;
      const res = await fetch(url, { headers });
      const data = await res.json() as { content?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      const raw = data.content ?? '';
      // Refuse absurd payloads entirely (minified 400KB+ bundles).
      if (raw.length > MAX_FILE_CHARS * 3) {
        console.warn('addToContext skipped oversized file:', relPath, raw.length);
        return;
      }
      setContextFiles(m => new Map(m).set(relPath, truncateForContext(raw)));
    } catch (err: unknown) {
      console.error('addToContext failed:', err);
    }
  }, [root, sandboxId, contextFiles]);

  const injectContextFile = useCallback((relPath: string, content: string) => {
    const path = relPath.startsWith('uploads/') ? relPath : `uploads/${relPath}`;
    setContextFiles(m => new Map(m).set(path, truncateForContext(content)));
  }, []);

  const removeFromContext = useCallback((relPath: string) => {
    setContextFiles(m => { const n = new Map(m); n.delete(relPath); return n; });
  }, []);

  const clearContext = useCallback(() => setContextFiles(new Map()), []);

  const applyChanges = useCallback(async (files?: PendingChange[]) => {
    // Prefer an explicit list — callers that just received model output must
    // not wait on React state (pendingChanges) or they race and write nothing.
    const toWrite = files ?? pendingChanges;
    if (!toWrite.length) return [];
    if (!sandboxId && !root) {
      return toWrite.map(c => ({
        path: c.path,
        ok: false,
        error: 'No sandbox open — Start blank or Open a repo first.',
      }));
    }
    const body = sandboxId
      ? { files: toWrite.map(c => ({ path: c.path, content: c.content })) }
      : { root, files: toWrite.map(c => ({ path: c.path, content: c.content })) };

    let res: Response;
    try {
      res = await fetch(`${API_URL}/write-files`, {
        method: 'POST',
        headers: sessionHeaders(),
        body: JSON.stringify(body),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return toWrite.map(c => ({ path: c.path, ok: false, error: msg || 'Network error writing files' }));
    }

    let data: {
      results?: Array<{ path: string; written: boolean; error?: string }>;
      error?: string;
    } = {};
    try {
      data = await res.json() as typeof data;
    } catch {
      data = { error: `HTTP ${res.status} (non-JSON write-files response)` };
    }

    if (!res.ok || (!data.results && data.error)) {
      const errMsg = data.error || `HTTP ${res.status}`;
      return toWrite.map(c => ({ path: c.path, ok: false, error: errMsg }));
    }

    const results = (data.results ?? []).map(r => ({ path: r.path, ok: !!r.written, error: r.error }));
    // If the API returned an empty results list on success-shaped JSON, surface it.
    if (!results.length) {
      return toWrite.map(c => ({
        path: c.path,
        ok: false,
        error: data.error || 'write-files returned no results',
      }));
    }
    const written = new Set(results.filter(r => r.ok).map(r => r.path));
    // Immediately refresh open-context entries with the bytes we just wrote.
    // Re-fetch alone used to no-op when the path was already in the Map.
    if (written.size > 0) {
      setContextFiles(m => {
        let changed = false;
        const n = new Map(m);
        for (const c of toWrite) {
          if (!written.has(c.path) || !n.has(c.path)) continue;
          n.set(c.path, truncateForContext(c.content));
          changed = true;
        }
        return changed ? n : m;
      });
      for (const p of written) {
        if (contextFiles.has(p)) await addToContext(p, { force: true });
      }
    }
    return results;
  }, [root, sandboxId, pendingChanges, contextFiles, sessionHeaders, addToContext]);

  const refreshTree = useCallback(async () => {
    if (!sandboxId && !root) return;
    try {
      const headers = sandboxId ? { 'X-Sandbox-Session': sandboxId } : undefined;
      const url = sandboxId
        ? `${API_URL}/files?sandboxId=${encodeURIComponent(sandboxId)}`
        : `${API_URL}/files?root=${encodeURIComponent(root)}`;
      const res = await fetch(url, headers ? { headers } : undefined);
      if (!res.ok) return;
      const data = await res.json() as { tree?: FileNode[]; totalFiles?: number };
      if (data.tree) {
        setTree(data.tree);
        setTotalFiles(data.totalFiles ?? 0);
      }
    } catch {
      /* ignore refresh failures */
    }
  }, [root, sandboxId]);

  const clearChanges = useCallback(() => setPendingChanges([]), []);

  return {
    root, sandboxId, isRemote, repoUrl, tree, totalFiles,
    contextFiles, pendingChanges, loading, error,
    pythonReady, pythonDetail,
    rustReady, rustDetail,
    goReady, goDetail,
    openRepo, startBlankProject, addToContext, injectContextFile, removeFromContext, clearContext,
    setPendingChanges, applyChanges, refreshTree, clearChanges,
  };
}
