import {
  isJunkContextPath,
  packContextFiles,
  truncateForContext,
  trimMessageHistory,
} from '../src/contextBudget.ts';

let failed = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error('FAIL:', msg); failed++; }
  else console.log('ok:', msg);
}

assert(isJunkContextPath('public/agent/assets/index-CtOox8uN.js'), 'skips agent asset bundle');
assert(isJunkContextPath('sandbox-terminal/dist/assets/index-CtOox8uN.js'), 'skips dist bundle');
assert(isJunkContextPath('foo/assets/index-AbCdEfGh.js'), 'skips hashed vite bundle');
assert(!isJunkContextPath('sandbox-terminal/src/App.tsx'), 'keeps source');
assert(!isJunkContextPath('api/agent-chat.js'), 'keeps api source');

const big = 'x'.repeat(200_000);
const trunc = truncateForContext(big, 1000);
assert(trunc.length < 1200 && trunc.includes('truncated'), 'truncates huge files');

const packed = packContextFiles(new Map([
  ['public/agent/assets/index-CtOox8uN.js', big],
  ['api/agent-chat.js', 'export default 1'],
  ['sandbox-terminal/src/App.tsx', 'export function App(){}'],
]));
assert(!packed.has('public/agent/assets/index-CtOox8uN.js'), 'pack drops junk path');
assert(packed.has('api/agent-chat.js'), 'pack keeps source');

const hist = trimMessageHistory(
  [
    { role: 'user', content: 'a'.repeat(50_000) },
    { role: 'assistant', content: 'b'.repeat(50_000) },
    { role: 'user', content: 'latest question' },
  ],
  20_000,
);
assert(hist[hist.length - 1]!.content === 'latest question', 'keeps latest user msg');
assert(hist.reduce((n, m) => n + m.content.length, 0) <= 20_000 + 100, 'history under budget');

if (failed) { console.error(`\n${failed} failure(s)`); process.exit(1); }
console.log('\nAll context-budget tests passed.');
