import {
  isJunkContextPath,
  isSourcePath,
  packContextFiles,
  formatSearchHits,
  truncateForContext,
  trimMessageHistory,
  pickAuditSeedPaths,
} from '../src/contextBudget.ts';
import {
  looksLikeSuggestRequest,
  looksLikeApplyRequest,
  mergeContinuation,
  stripContinueMarkers,
  adoptBareHtmlDocument,
  looksLikeLegacyWelcome,
  needsCodeContext,
} from '../src/agentParse.ts';

let failed = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error('FAIL:', msg); failed++; }
  else console.log('ok:', msg);
}

assert(isJunkContextPath('public/agent/assets/index-CtOox8uN.js'), 'skips agent asset bundle');
assert(isJunkContextPath('sandbox-terminal/dist/assets/index-CtOox8uN.js'), 'skips dist bundle');
assert(!isSourcePath('public/agent/assets/index-CtOox8uN.js'), 'bundles are not source');
assert(isSourcePath('sandbox-terminal/src/App.tsx'), 'tsx is source');
assert(isSourcePath('api/agent-chat.js'), 'api js is source');
assert(!isSourcePath('readme.txt'), 'txt not treated as source');

const big = 'x'.repeat(200_000);
assert(truncateForContext(big, 1000).includes('truncated'), 'truncates huge files');

const packed = packContextFiles(new Map([
  ['public/agent/assets/index-CtOox8uN.js', big],
  ['api/agent-chat.js', 'export default 1'],
]));
assert(!packed.has('public/agent/assets/index-CtOox8uN.js'), 'pack drops junk path');
assert(packed.has('api/agent-chat.js'), 'pack keeps source');

const hits = formatSearchHits([
  { path: 'api/search.js', snippets: ['10|export default async function handler'] },
  { path: 'public/agent/assets/index-X.js', snippets: ['1|bundle'] },
]);
assert(hits.includes('api/search.js'), 'formats source hit');
assert(!hits.includes('public/agent/assets'), 'omits junk hit');

const hist = trimMessageHistory(
  [
    { role: 'user', content: 'a'.repeat(50_000) },
    { role: 'assistant', content: 'b'.repeat(50_000) },
    { role: 'user', content: 'latest question' },
  ],
  20_000,
);
assert(hist[hist.length - 1]!.content === 'latest question', 'keeps latest user msg');

assert(looksLikeSuggestRequest('suggest additions and fixes'), 'suggest additions = suggest');
assert(looksLikeSuggestRequest('audit and recommend changes/fixes'), 'audit = suggest');
assert(!looksLikeSuggestRequest('Create a full HTML file for an interactive Kybalion explorer. Review the source texts for accuracy, add ideas for each principle. Code only.'), 'explicit build order with incidental review/ideas words is not suggest-only');
assert(!looksLikeSuggestRequest('build me a landing page, any feedback on layout welcome'), 'build order wins over incidental feedback');
assert(looksLikeApplyRequest('Generate a full HTML file for a Kybalion explorer. Code only.'), 'explicit build order = apply');
assert(looksLikeSuggestRequest('review the page and suggest improvements, do not change anything'), 'review-only stays suggest');
assert(looksLikeSuggestRequest('just suggest ideas for a single page app'), '"just suggest" stays suggest');
assert(!looksLikeApplyRequest('suggest additions and fixes'), 'suggest is not apply');
assert(looksLikeApplyRequest('apply that fix now'), 'apply that fix = apply');
assert(looksLikeApplyRequest('fix the login bug'), 'fix the bug = apply');
assert(looksLikeLegacyWelcome('Fix the auth token expiry bug in src/auth.ts'), 'detects legacy welcome poison');
assert(!needsCodeContext('hey'), 'hey stays light — no file dump');
assert(!needsCodeContext('thanks'), 'thanks stays light');
assert(needsCodeContext('suggest additions and fixes'), 'suggest pulls code context');

// ── long single-file replies ──
const cutHtml = 'File: a.html\n```html\n<!DOCTYPE html>\n<html><body><script>\nlet p = {};\np.speed\n\n⟦MORE⟧';
assert(stripContinueMarkers(cutHtml).endsWith('p.speed'), 'markers stripped');
assert(mergeContinuation(cutHtml, 'X = 1;\n</script></body></html>\n```') === 'File: a.html\n```html\n<!DOCTYPE html>\n<html><body><script>\nlet p = {};\np.speedX = 1;\n</script></body></html>\n```', 'mid-token cut joins without a break');
const restarted = mergeContinuation(cutHtml, '```html\n<!DOCTYPE html>\n<html><body><script>\nlet p = {};\np.speed = 2;\n</script></body></html>\n```');
assert(!/<!DOCTYPE[\s\S]*<!DOCTYPE/i.test(restarted), 'a restarted file is not duplicated: ' + restarted);
const longCut = '```js\nfunction animateParticles(list) {\n  for (const particle of list) particle.speed';
assert(mergeContinuation(longCut, 'function animateParticles(list) {\n  for (const particle of list) particle.speed *= 2;\n}\n```').split('function animateParticles').length === 2, 'repeated tail is dropped');
const bare = adoptBareHtmlDocument('Here you go:\n```html\n<!DOCTYPE html><html><head><title>Hermetic Academy &amp; More</title></head><body>x</body></html>\n```');
assert(/File: hermetic-academy-and-more\.html\n```html/.test(bare), 'bare html gets a File: header');
assert(adoptBareHtmlDocument('File: x.html\n```html\n<!DOCTYPE html><html></html>\n```') === 'File: x.html\n```html\n<!DOCTYPE html><html></html>\n```', 'existing header untouched');
assert(adoptBareHtmlDocument('```html\n<!DOCTYPE html><html><body>cut off') === '```html\n<!DOCTYPE html><html><body>cut off', 'incomplete doc is not adopted');

const seeds = pickAuditSeedPaths([
  'public/agent/assets/index-X.js',
  'readme.txt',
  'api/agent-chat.js',
  'sandbox-terminal/src/ChatPane.tsx',
  'sandbox-terminal/src/useRepoContext.ts',
  'package.json',
], 4);
assert(seeds.includes('api/agent-chat.js'), 'audit seeds prefer api source');
assert(seeds.includes('sandbox-terminal/src/ChatPane.tsx'), 'audit seeds prefer agent UI source');
assert(!seeds.includes('public/agent/assets/index-X.js'), 'audit seeds skip bundles');

if (failed) { console.error(`\n${failed} failure(s)`); process.exit(1); }
console.log('\nAll context-budget tests passed.');
