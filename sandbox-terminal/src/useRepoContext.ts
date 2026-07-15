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
  tree:           FileNode[];
  totalFiles:     number;
  contextFiles:   Map<string, string>;   // relPath → content
  pendingChanges: PendingChange[];
  loading:        boolean;
  error:          string | null;
}

export interface RepoContextActions {
  openRepo:        (rootPath: string) => Promise<void>;
  addToContext:    (relPath: string)  => Promise<void>;
  removeFromContext: (relPath: string) => void;
  clearContext:    () => void;
  setPendingChanges: (changes: PendingChange[]) => void;
  applyChanges:    () => Promise<{ path: string; ok: boolean; error?: string }[]>;
  clearChanges:    () => void;
}

export function useRepoContext(): RepoContextState & RepoContextActions {
  const [root,           setRoot]           = useState('');
  const [tree,           setTree]           = useState<FileNode[]>([]);
  const [totalFiles,     setTotalFiles]     = useState(0);
  const [contextFiles,   setContextFiles]   = useState<Map<string, string>>(new Map());
  const [pendingChanges, setPendingChanges] = useState<PendingChange[]>([]);
  const [loading,        setLoading]        = useState(false);
  const [error,          setError]          = useState<string | null>(null);

  const openRepo = useCallback(async (rootPath: string) => {
    setLoading(true);
    setError(null);
    setTree([]);
    setContextFiles(new Map());
    setPendingChanges([]);
    try {
      const res = await fetch(`${API_URL}/files?root=${encodeURIComponent(rootPath)}`);
      const data = await res.json() as { tree?: FileNode[]; totalFiles?: number; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setRoot(rootPath);
      setTree(data.tree ?? []);
      setTotalFiles(data.totalFiles ?? 0);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const addToContext = useCallback(async (relPath: string) => {
    if (contextFiles.has(relPath)) return;   // already loaded
    try {
      const res = await fetch(
        `${API_URL}/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(relPath)}`
      );
      const data = await res.json() as { content?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setContextFiles(m => new Map(m).set(relPath, data.content ?? ''));
    } catch (err: unknown) {
      console.error('addToContext failed:', err);
    }
  }, [root, contextFiles]);

  const removeFromContext = useCallback((relPath: string) => {
    setContextFiles(m => { const n = new Map(m); n.delete(relPath); return n; });
  }, []);

  const clearContext = useCallback(() => setContextFiles(new Map()), []);

  const applyChanges = useCallback(async () => {
    if (!pendingChanges.length) return [];
    const res = await fetch(`${API_URL}/write-files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        root,
        files: pendingChanges.map(c => ({ path: c.path, content: c.content })),
      }),
    });
    const data = await res.json() as {
      results: Array<{ path: string; written: boolean; error?: string }>;
    };
    const results = (data.results ?? []).map(r => ({
      path: r.path, ok: r.written, error: r.error,
    }));
    // Refresh context for any file we just wrote
    const written = results.filter(r => r.ok).map(r => r.path);
    for (const p of written) {
      if (contextFiles.has(p)) await addToContext(p);
    }
    return results;
  }, [root, pendingChanges, contextFiles, addToContext]);

  const clearChanges = useCallback(() => setPendingChanges([]), []);

  return {
    root, tree, totalFiles, contextFiles, pendingChanges, loading, error,
    openRepo, addToContext, removeFromContext, clearContext,
    setPendingChanges, applyChanges, clearChanges,
  };
}
