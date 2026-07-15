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
  removeFromContext: (relPath: string) => void;
  clearContext:    () => void;
  setPendingChanges: (changes: PendingChange[]) => void;
  applyChanges:    () => Promise<{ path: string; ok: boolean; error?: string }[]>;
  clearChanges:    () => void;
}

export function useRepoContext(): RepoContextState & RepoContextActions {
  const [root,           setRoot]           = useState('');
  const [sandboxId,      setSandboxId]      = useState<string | null>(null);
  const [isRemote,       setIsRemote]       = useState(false);
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
        setRoot(data.repoDir ?? rootPathOrUrl);
        setTree(data.tree ?? []);
        setTotalFiles(data.totalFiles ?? 0);
      } else {
        // Local mode: direct /files endpoint on sandbox-runner
        setSandboxId(null);
        setIsRemote(false);
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
    try {
      const headers = sandboxId ? { 'X-Sandbox-Session': sandboxId } : undefined;
      const url = sandboxId
        ? `${API_URL}/file?path=${encodeURIComponent(relPath)}`
        : `${API_URL}/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(relPath)}`;
      const res = await fetch(url, { headers });
      const data = await res.json() as { content?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setContextFiles(m => new Map(m).set(relPath, data.content ?? ''));
    } catch (err: unknown) {
      console.error('addToContext failed:', err);
    }
  }, [root, sandboxId, contextFiles]);

  const removeFromContext = useCallback((relPath: string) => {
    setContextFiles(m => { const n = new Map(m); n.delete(relPath); return n; });
  }, []);

  const clearContext = useCallback(() => setContextFiles(new Map()), []);

  const applyChanges = useCallback(async () => {
    if (!pendingChanges.length) return [];
    const body = sandboxId
      ? { files: pendingChanges.map(c => ({ path: c.path, content: c.content })) }
      : { root, files: pendingChanges.map(c => ({ path: c.path, content: c.content })) };

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
    root, sandboxId, isRemote, tree, totalFiles,
    contextFiles, pendingChanges, loading, error,
    openRepo, addToContext, removeFromContext, clearContext,
    setPendingChanges, applyChanges, clearChanges,
  };
}
