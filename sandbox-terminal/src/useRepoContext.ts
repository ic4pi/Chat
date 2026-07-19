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
}

export interface RepoContextActions {
  openRepo:        (rootPathOrUrl: string) => Promise<void>;
  addToContext:    (relPath: string)  => Promise<void>;
  /** Inject an uploaded / pasted file into model context (not from the repo tree). */
  injectContextFile: (relPath: string, content: string) => void;
  removeFromContext: (relPath: string) => void;
  clearContext:    () => void;
  setPendingChanges: (changes: PendingChange[]) => void;
  /** Write pending (or explicitly provided) changes to disk/sandbox. */
  applyChanges:    (files?: PendingChange[]) => Promise<{ path: string; ok: boolean; error?: string }[]>;
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

  /** Build fetch headers — adds X-Sandbox-Session when we have a remote session */
  const sessionHeaders = useCallback((extra?: Record<string, string>): Record<string, string> => {
    const h: Record<string, string> = { 'Content-Type': 'application/json', ...(extra ?? {}) };
    if (sandboxId) h['X-Sandbox-Session'] = sandboxId;
    return h;
  }, [sandboxId]);

  const openRepo = useCallback(async (rootPathOrUrl: string) => {
    setLoading(true);
    setError(null);
    setTree([]);
    setContextFiles(new Map());
    setPendingChanges([]);

    const isGitUrl = /^https?:\/\/|^git@/.test(rootPathOrUrl);

    try {
      if (isGitUrl) {
        // Remote mode: clone into Vercel Sandbox via /api/init-repo
        const res = await fetch(`${API_URL}/init-repo`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json',
            ...(sandboxId ? { 'X-Sandbox-Session': sandboxId } : {}) },
          body: JSON.stringify({ url: rootPathOrUrl, sandboxId }),
        });
        const data = await res.json() as {
          sandboxId?: string; repoDir?: string;
          tree?: FileNode[]; totalFiles?: number; error?: string;
        };
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        setSandboxId(data.sandboxId ?? null);
        setIsRemote(true);
        setRepoUrl(rootPathOrUrl);
        setRoot(data.repoDir ?? rootPathOrUrl);
        setTree(data.tree ?? []);
        setTotalFiles(data.totalFiles ?? 0);
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
  }, [sandboxId]);

  const addToContext = useCallback(async (relPath: string) => {
    if (contextFiles.has(relPath)) return;
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
    const body = sandboxId
      ? { files: toWrite.map(c => ({ path: c.path, content: c.content })) }
      : { root, files: toWrite.map(c => ({ path: c.path, content: c.content })) };

    const res = await fetch(`${API_URL}/write-files`, {
      method: 'POST',
      headers: sessionHeaders(),
      body: JSON.stringify(body),
    });
    const data = await res.json() as { results: Array<{ path: string; written: boolean; error?: string }> };
    const results = (data.results ?? []).map(r => ({ path: r.path, ok: r.written, error: r.error }));
    const written = results.filter(r => r.ok).map(r => r.path);
    for (const p of written) {
      if (contextFiles.has(p)) await addToContext(p);
    }
    return results;
  }, [root, sandboxId, pendingChanges, contextFiles, sessionHeaders, addToContext]);

  const clearChanges = useCallback(() => setPendingChanges([]), []);

  return {
    root, sandboxId, isRemote, repoUrl, tree, totalFiles,
    contextFiles, pendingChanges, loading, error,
    openRepo, addToContext, injectContextFile, removeFromContext, clearContext,
    setPendingChanges, applyChanges, clearChanges,
  };
}
