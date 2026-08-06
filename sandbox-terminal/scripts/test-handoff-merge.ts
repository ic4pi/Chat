/**
 * Pure-logic check for Chat → Workspace history merge.
 * Run: node --experimental-strip-types scripts/test-handoff-merge.ts
 */
import { mergeHandoffMessages, type StoredMessage, type StoredSession } from '../src/sessionStore.ts';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function msg(id: string, role: 'user' | 'assistant', content: string, kind?: string): StoredMessage {
  return { id, role, content, kind };
}

const imported = [
  msg('i1', 'user', 'build an app', 'imported'),
  msg('i2', 'assistant', 'sure', 'imported'),
];

const prev: StoredSession = {
  v: 2,
  id: 'chat-1',
  title: 'App',
  savedAt: 1,
  repoUrl: null,
  sandboxId: null,
  provider: 'openrouter',
  model: 'qwen/qwen3-coder:free',
  autoApplyOn: true,
  fromChat: true,
  pendingChanges: [{ path: 'app.js', content: 'console.log(1)' }],
  messages: [
    msg('old1', 'user', 'stale import', 'imported'),
    msg('old2', 'assistant', 'stale reply', 'imported'),
    msg('w1', 'user', 'keep writing files'),
    msg('w2', 'assistant', 'File: app.js\n```js\nx\n```'),
  ],
};

const merged = mergeHandoffMessages(imported, prev);
assert(merged.length === 4, `expected 4 messages, got ${merged.length}`);
assert(merged[0].content === 'build an app', 'fresh import prefix');
assert(merged[2].content === 'keep writing files', 'workspace-only user kept');
assert(merged[3].role === 'assistant', 'workspace-only assistant kept');
assert(!merged.some((m) => m.content.startsWith('stale')), 'old imported prefix dropped');

const emptyImport = mergeHandoffMessages([], prev);
assert(emptyImport.length === 4, 'empty handoff must not wipe prior session');

const firstOpen = mergeHandoffMessages(imported, null);
assert(firstOpen.length === 2, 'first open uses import only');

console.log('ok: handoff merge preserves workspace-only turns');
