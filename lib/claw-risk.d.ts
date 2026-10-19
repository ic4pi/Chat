export type ClawAction =
  | { do: 'run'; cmd: string; cwd?: string; timeout?: number }
  | { do: 'read' | 'list' | 'mkdir' | 'delete'; path: string }
  | { do: 'write' | 'append'; path: string; content: string }
  | { do: 'move'; from: string; to: string }
  | { do: 'open'; target: string };
export type ClawLevel = 'safe' | 'caution' | 'danger' | 'blocked';
export const MAX_ACTIONS: number;
export function cleanAction(a: unknown): { action?: ClawAction; error?: string };
export function validateActions(list: unknown): { ok: true; actions: ClawAction[] } | { ok: false; error: string };
export function classifyAction(a: ClawAction): { level: ClawLevel; reasons: string[] };
export function describeAction(a: ClawAction): string;
export function worstLevel(actions: ClawAction[]): ClawLevel;
export function extractClawBlock(raw: string): { text: string; actions: unknown[] | null; errors: string[] };
