import {
  isJunkContextPath,
  isSourcePath,
  packContextFiles,
  formatSearchHits,
  truncateForContext,
  trimMessageHistory,
  pickAuditSeedPaths,
} from '../src/contextBudget.ts';
import { parsePlan, togglePlanLine, extractPlanBlock, planForPersona, loadPlan, savePlan } from '../src/buildPlan.ts';
import {
  looksLikeSuggestRequest,
  looksLikeApplyRequest,
  mergeContinuation,
  stripContinueMarkers,
  adoptBareHtmlDocument,
  looksLikeLegacyWelcome,
  needsCodeContext,
  looksLikeToolMimic,
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

assert(looksLikeToolMimic('**Read:** /workspace/compare-a-x/.gitignore\n\n**Read:** /workspace/compare-a-x\n\n[MORE]\n(empty response)'), 'Read: lines then nothing is a tool mimic');
assert(looksLikeToolMimic('(empty response)'), 'an empty reply is a failed build');
assert(!looksLikeToolMimic('File: index.html\n```html\n<h1>Hi</h1>\n```'), 'a File: block is a real build');
assert(!looksLikeToolMimic('Here is a plan.\n1. Do this\n2. Do that'), 'a prose plan is not a tool mimic');
assert(!looksLikeToolMimic('**Read:** /a.txt\n```js\nconsole.log(1)\n```'), 'code present is not a mimic');

// ── build plan ───────────────────────────────────────────────────────────
{
  const md = '## Setup\n- [x] ~~Scaffold~~\n- [ ] Add API\n\n## Ship\n* [X] Deploy\n- [ ] Announce';
  const p = parsePlan(md);
  assert(p.total === 4 && p.done === 2, 'plan counts done/total across groups and bullet styles');
  assert(p.groups.length === 2 && p.groups[0]!.name === 'Setup' && p.groups[1]!.name === 'Ship', 'plan groups by heading');
  assert(p.groups[0]!.items[0]!.text === 'Scaffold' && p.groups[0]!.items[0]!.done, 'strikethrough the model adds is stripped');
  assert(parsePlan('just some prose, no checkboxes').total === 0, 'prose is not a plan');
  assert(parsePlan('- [ ] loose item').groups[0]!.name === '', 'items before any heading go in an unnamed group');
  const t = togglePlanLine(md, 2);
  assert(t.split('\n')[2] === '- [x] Add API' && t.replace('- [x] Add API', '- [ ] Add API') === md, 'toggle flips only that line');
  assert(togglePlanLine(t, 2) === md, 'toggle twice returns the original');
  assert(togglePlanLine(md, 0) === md && togglePlanLine(md, 99) === md, 'toggling a heading or a missing line changes nothing');
}
{
  const reply = "On it.\n<<<BRIEF\nGoal: x\nBRIEF>>>\n<<<PLAN\n## A\n- [ ] one\n- [x] two\nPLAN>>>";
  const r = extractPlanBlock(reply);
  assert(r.plan === '## A\n- [ ] one\n- [x] two', 'plan block is extracted whole');
  assert(r.text.includes('<<<BRIEF') && !r.text.includes('PLAN'), 'plan block removed from the visible text, brief kept');
  const cut = extractPlanBlock('Sure.\n<<<PLAN\n## A\n- [ ] one\n- [ ] tw');
  assert(cut.plan !== null && cut.plan.includes('one') && !cut.text.includes('PLAN'), 'a cut-off plan block still counts');
  const empty = extractPlanBlock('Hi\n<<<PLAN\nno checkboxes here\nPLAN>>>');
  assert(empty.plan === null && !empty.text.includes('<<<PLAN'), 'a plan with no checkboxes never replaces the old plan');
  assert(extractPlanBlock('plain reply').plan === null && extractPlanBlock('plain reply').text === 'plain reply', 'no block, no change');
}
{
  assert(planForPersona('').startsWith('BUILD PLAN: none yet'), 'orchestrator is told when there is no plan');
  assert(planForPersona('## A\n- [x] a\n- [ ] b').startsWith('BUILD PLAN (1/2 done'), 'orchestrator sees progress and the plan');
  const store: Record<string, string> = {};
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
  };
  savePlan('s1', '## A\n- [ ] a'); savePlan('s2', '## B\n- [ ] b');
  assert(loadPlan('s1') === '## A\n- [ ] a' && loadPlan('s2') === '## B\n- [ ] b' && loadPlan('nope') === '', 'plans are stored per session');
  savePlan('s1', '   ');
  assert(loadPlan('s1') === '' && loadPlan('s2') !== '', 'saving an empty plan clears only that session');
  store['workspace_build_plan_v1'] = '{not json';
  assert(loadPlan('s2') === '', 'corrupt storage reads as no plan, never throws');
}

if (failed) { console.error(`\n${failed} failure(s)`); process.exit(1); }
console.log('\nAll context-budget tests passed.');
