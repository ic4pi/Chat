#!/usr/bin/env node
/**
 * Fast pre-push / Auto-test smoke for this Chat app.
 *
 * Catches the failure mode that caused production 503s: sandbox rewrites of
 * lib/providers.js / lib/auth.js that drop required exports or break imports
 * used by /api/chat, /api/models, /api/agent-chat, /api/admin-config.
 *
 * Exit 0 = safe to push. Non-zero = do not push.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SYNTAX_FILES = [
  'lib/providers.js',
  'lib/auth.js',
  'lib/config.js',
  'lib/kv.js',
  'api/chat.js',
  'api/models.js',
  'api/agent-chat.js',
  'api/group-chat.js',
  'api/generate.js',
  'api/admin-config.js',
  'api/sandbox/[op].js',
  'lib/sandbox-api/git-push.js',
  'lib/code-slices.js',
  'lib/hub.js',
  'api/hub/[route].js',
];

function fail(msg) {
  console.error(`check-api: FAIL — ${msg}`);
  process.exit(1);
}

function ok(msg) {
  console.log(`check-api: ok — ${msg}`);
}

// Incomplete "patch-style" dumps that wiped production APIs (HTTP 500).
// Example: model wrote `// ... existing imports ...` + a helper, auto-apply
// overwrote the whole file, and `node --check` still passed.
const INCOMPLETE_PATCH_RE =
  /(?:^|\n)\s*(?:\/\/|#|\/\*|<!--)\s*\.\.\.\s*existing\b|(?:^|\n)\s*\/\/\s*Then in (?:the )?handler\b|\b\.\.\.\s*existing (?:code|imports|content|implementation|logic|handlers?)\b|\b(rest of (?:the )?file|unchanged below|keep the rest|same as before)\b/i;

// 1) Syntax check critical modules (works without installing deps beyond node).
for (const rel of SYNTAX_FILES) {
  const abs = path.join(root, rel);
  if (!existsSync(abs)) fail(`missing required file ${rel}`);
  const src = readFileSync(abs, 'utf8');
  if (INCOMPLETE_PATCH_RE.test(src)) {
    fail(
      `${rel} looks like an incomplete patch (contains "... existing" / stub comments). ` +
        'Workspace must write FULL files, not diffs. Restore the file before pushing.',
    );
  }
  const r = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8' });
  if (r.status !== 0) {
    fail(`syntax error in ${rel}\n${(r.stderr || r.stdout || '').trim()}`);
  }
}
ok(`syntax (${SYNTAX_FILES.length} files)`);

// 1b) Handlers must export default. Prefer a real import when the module
// graph doesn't need optional native deps (e.g. @vercel/sandbox).
const HANDLER_IMPORTS = [
  'api/agent-chat.js',
  'api/chat.js',
  'api/models.js',
  'api/group-chat.js',
  'api/generate.js',
  'api/admin-config.js',
  'api/hub/[route].js',
  'api/assist.js',
];
for (const rel of HANDLER_IMPORTS) {
  const abs = path.join(root, rel);
  const mod = await import(pathToFileURL(abs).href + `?t=${Date.now()}`);
  if (typeof mod.default !== 'function') {
    fail(`${rel} must export default async function handler (got ${typeof mod.default})`);
  }
}
// Static check for sandbox router (imports @vercel/sandbox — may be absent in CI).
const sandboxOpSrc = readFileSync(path.join(root, 'api/sandbox/[op].js'), 'utf8');
if (!/\bexport\s+default\b/.test(sandboxOpSrc)) {
  fail('api/sandbox/[op].js must export default handler');
}
ok(`handler exports (${HANDLER_IMPORTS.length + 1} files)`);

// 2) Contract: providers catalog + sync resolveProvider (must not be a Promise).
const providers = await import(pathToFileURL(path.join(root, 'lib/providers.js')).href);
if (!providers.PROVIDERS || typeof providers.PROVIDERS !== 'object') {
  fail('lib/providers.js must export PROVIDERS');
}
for (const id of ['venice', 'openrouter', 'cerebras', 'groq', 'nvidia']) {
  if (!providers.PROVIDERS[id]?.url || !providers.PROVIDERS[id]?.apiKeyEnv) {
    fail(`PROVIDERS.${id} missing url/apiKeyEnv`);
  }
}
if (!providers.FALLBACK_MODELS?.venice?.length) {
  fail('FALLBACK_MODELS.venice must be a non-empty array');
}
if (!Array.isArray(providers.PROVIDER_IDS) || providers.PROVIDER_IDS.length < 3) {
  fail('PROVIDER_IDS must list providers');
}
if (typeof providers.resolveProvider !== 'function') {
  fail('resolveProvider must be a function');
}

const resolved = providers.resolveProvider('venice', 'smoke-test-key', { requireKey: true });
if (!resolved || typeof resolved.then === 'function') {
  fail('resolveProvider must be synchronous (not async/Promise)');
}
if (resolved.apiKey !== 'smoke-test-key' || resolved.keySource !== 'client') {
  fail('resolveProvider BYOK path broken');
}
if (!resolved.url || typeof resolved.extraHeaders !== 'function') {
  fail('resolveProvider must return url + extraHeaders()');
}
const noKey = providers.resolveProvider('venice', '', { requireKey: false });
if (noKey.keySource !== 'env' && noKey.keySource !== 'none') {
  fail('resolveProvider({ requireKey:false }) keySource unexpected');
}
ok('providers contract');

// 3) Contract: admin Basic auth helpers (503 when unset, 401 when wrong).
const auth = await import(pathToFileURL(path.join(root, 'lib/auth.js')).href);
if (typeof auth.checkAdminAuth !== 'function' || typeof auth.requireAdminAuth !== 'function') {
  fail('lib/auth.js must export checkAdminAuth + requireAdminAuth');
}
const prevUser = process.env.ADMIN_USERNAME;
const prevPass = process.env.ADMIN_PASSWORD;
delete process.env.ADMIN_USERNAME;
delete process.env.ADMIN_PASSWORD;
const unset = auth.checkAdminAuth({ headers: {} });
if (!unset || unset.ok !== false || unset.code !== 'not_configured') {
  fail('checkAdminAuth must return not_configured (→ 503) when env missing');
}
process.env.ADMIN_USERNAME = 'smoke-user';
process.env.ADMIN_PASSWORD = 'smoke-pass';
const noHdr = auth.checkAdminAuth({ headers: {} });
if (!noHdr || noHdr.code !== 'unauthenticated') {
  fail('checkAdminAuth must return unauthenticated without Basic header');
}
const good = auth.checkAdminAuth({
  headers: {
    authorization: `Basic ${Buffer.from('smoke-user:smoke-pass').toString('base64')}`,
  },
});
if (!good?.ok) fail('checkAdminAuth rejected valid Basic credentials');

const fakeRes = {
  statusCode: 0,
  body: null,
  headers: {},
  setHeader(k, v) { this.headers[k] = v; },
  status(code) { this.statusCode = code; return this; },
  json(obj) { this.body = obj; return this; },
};
const allowed = auth.requireAdminAuth(
  { headers: { authorization: `Basic ${Buffer.from('smoke-user:smoke-pass').toString('base64')}` } },
  fakeRes,
);
if (allowed !== true) fail('requireAdminAuth should allow valid Basic auth');
if (prevUser === undefined) delete process.env.ADMIN_USERNAME;
else process.env.ADMIN_USERNAME = prevUser;
if (prevPass === undefined) delete process.env.ADMIN_PASSWORD;
else process.env.ADMIN_PASSWORD = prevPass;
ok('auth contract');

// 4) models.js still imports the catalog symbols it needs (static parse).
const modelsSrc = readFileSync(path.join(root, 'api/models.js'), 'utf8');
for (const sym of ['PROVIDERS', 'FALLBACK_MODELS', 'resolveProvider']) {
  if (!modelsSrc.includes(sym)) fail(`api/models.js must reference ${sym}`);
}
ok('api/models.js imports');

// 5) Code-slice catalog + fallback resolution for POST /api/generate.
const slices = await import(pathToFileURL(path.join(root, 'lib/code-slices.js')).href);
if (!Array.isArray(slices.CHUNK_LIST) || slices.CHUNK_LIST.length < 5) {
  fail('CHUNK_LIST must list coding chunks');
}
for (const id of ['html', 'css', 'js', 'tests', 'a11y']) {
  if (!slices.CHUNK_LIST.some((c) => c.id === id)) fail(`CHUNK_LIST missing ${id}`);
}
if (!slices.GENERAL_PURPOSE_MODEL?.provider || !slices.GENERAL_PURPOSE_MODEL?.model) {
  fail('GENERAL_PURPOSE_MODEL must set provider + model');
}
const assigned = slices.resolveChunkModel(
  { html: { provider: 'openrouter', model: 'openai/gpt-4o' } },
  'html',
);
if (assigned.model !== 'openai/gpt-4o' || assigned.usedFallback) {
  fail('resolveChunkModel should honor assigned models');
}
if (slices.modelBadgeLabel('openai/gpt-4o') !== 'GPT-4o') {
  fail('modelBadgeLabel(gpt-4o) should be GPT-4o');
}
const missing = slices.resolveChunkModel({ html: { provider: '', model: '' } }, 'html');
if (!missing.model || missing.source === 'assigned') {
  fail('resolveChunkModel must fall back when assignment incomplete');
}
const unknown = slices.resolveChunkModel({}, 'not-a-real-chunk');
if (unknown.model !== slices.GENERAL_PURPOSE_MODEL.model || !unknown.usedFallback) {
  fail('unknown chunk must use GENERAL_PURPOSE_MODEL');
}
if (!Array.isArray(slices.DEFAULT_ENABLED_CHUNKS) || slices.DEFAULT_ENABLED_CHUNKS.length < 1) {
  fail('DEFAULT_ENABLED_CHUNKS must list a short default set');
}
const genSrc = readFileSync(path.join(root, 'api/generate.js'), 'utf8');
for (const sym of [
  'resolveChunkModel',
  'chunkModels',
  'GENERAL_PURPOSE_MODEL',
  'selectChunks',
  'TOTAL_BUDGET_MS',
  'MAX_SLICES_PER_RUN',
]) {
  if (!genSrc.includes(sym)) fail(`api/generate.js must reference ${sym}`);
}
ok('code-slices + generate contract');

// 6) Reasoning models need Pro-length budgets — Hobby-era 55s/60s kills
// mid-thought with nothing to show (Qwen uncensored, GLM Flash Heretic, etc.).
// api/agent-chat.js (Workspace) gets the higher Fluid Compute ceiling (800s)
// since its reasoning models routinely need more than 280s; the other two
// routes stay on the plain 300s budget.
const vercel = JSON.parse(readFileSync(path.join(root, 'vercel.json'), 'utf8'));
for (const route of ['api/chat.js', 'api/group-chat.js']) {
  const dur = vercel.functions?.[route]?.maxDuration;
  if (dur !== 300) {
    fail(`${route} maxDuration must be 300 (got ${dur}) — thinking streams need headroom`);
  }
}
{
  const dur = vercel.functions?.['api/agent-chat.js']?.maxDuration;
  if (dur !== 800) {
    fail(`api/agent-chat.js maxDuration must be 800 (got ${dur}) — Fluid Compute headroom for reasoning models`);
  }
}
const agentChatSrc = readFileSync(path.join(root, 'api/agent-chat.js'), 'utf8');
if (/ \|\| 55_000\b/.test(agentChatSrc) || / \|\| 55000\b/.test(agentChatSrc)) {
  fail('api/agent-chat.js must not default AGENT_CHAT_TIMEOUT_MS to Hobby 55s');
}
if (!/ \|\| 770_000\b/.test(agentChatSrc)) {
  fail('api/agent-chat.js must default UPSTREAM_TIMEOUT_MS to 770_000');
}
const chatSrc = readFileSync(path.join(root, 'api/chat.js'), 'utf8');
if (!/UPSTREAM_TIMEOUT_MS\s*=\s*280_000\b/.test(chatSrc)) {
  fail('api/chat.js UPSTREAM_TIMEOUT_MS must be 280_000 under maxDuration 300');
}
if (!agentChatSrc.includes("type: 'thinking'") || !chatSrc.includes("type: 'thinking'")) {
  fail('chat + agent-chat must SSE-forward thinking/reasoning deltas');
}
ok('thinking timeout budgets');

// 7) Paid unlock must persist in localStorage (not session-only).
const appSrc = readFileSync(path.join(root, 'public/app.js'), 'utf8');
const prefsSrc = readFileSync(path.join(root, 'sandbox-terminal/src/providerPrefs.ts'), 'utf8');
for (const [label, src] of [['public/app.js', appSrc], ['providerPrefs.ts', prefsSrc]]) {
  if (!src.includes('localStorage.getItem(PAID_PASS_STORAGE)')) {
    fail(`${label} must read paid unlock from localStorage`);
  }
  if (!src.includes('localStorage.setItem(PAID_PASS_STORAGE')) {
    fail(`${label} must write paid unlock to localStorage`);
  }
  if (/sessionStorage\.setItem\(PAID_PASS_STORAGE/.test(src)) {
    fail(`${label} must not save paid unlock to sessionStorage`);
  }
}
if (/sessionStorage\.getItem\('uncensored_paid_password_v1'\)/.test(
  readFileSync(path.join(root, 'sandbox-terminal/src/ChatPane.tsx'), 'utf8'),
)) {
  fail('ChatPane must use loadPaidPassword(), not raw sessionStorage');
}
ok('paid unlock persistence');

// 8) Serverless function cap. This project is on a Pro team, which does not
//    carry Hobby's 12-function limit, so the ceiling here is a discipline
//    check rather than a hard platform constraint: every new function should
//    have to justify itself. The whole context hub is deliberately one
//    dynamic route (api/hub/[route].js) rather than six files for this reason.
//    If this project is ever moved back to Hobby, drop FUNCTION_CAP to 12.
// 8a) Folding unlock into
// models.js (rewrite /api/unlock-paid) keeps deploys unblocked.
const apiJs = [];
function walkApi(dir) {
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) walkApi(abs);
    else if (name.endsWith('.js')) apiJs.push(path.relative(root, abs));
  }
}
walkApi(path.join(root, 'api'));
const FUNCTION_CAP = 20; // Pro. Was 12 under Hobby.
if (apiJs.length > FUNCTION_CAP) {
  fail(`Function cap is ${FUNCTION_CAP}; found ${apiJs.length}: ${apiJs.join(', ')}`);
}
if (existsSync(path.join(root, 'api/unlock-paid.js'))) {
  fail('api/unlock-paid.js must be folded into api/models.js (function cap)');
}
const modelsUnlockSrc = readFileSync(path.join(root, 'api/models.js'), 'utf8');
if (!modelsUnlockSrc.includes('handleUnlockPaid') || !modelsUnlockSrc.includes('isUnlockPaidRequest')) {
  fail('api/models.js must handle unlock-paid rewrite');
}
const vercelUnlock = JSON.parse(readFileSync(path.join(root, 'vercel.json'), 'utf8'));
const hasUnlockRewrite = (vercelUnlock.rewrites || []).some(
  (r) => r.source === '/api/unlock-paid' && String(r.destination || '').includes('op=unlock-paid'),
);
if (!hasUnlockRewrite) {
  fail('vercel.json must rewrite /api/unlock-paid → /api/models?op=unlock-paid');
}
ok(`function cap (${apiJs.length}/${FUNCTION_CAP})`);

// 9) Coder-package parity. The Workspace is a separate Vite bundle and cannot
//    import public/model-packages.js, so sandbox-terminal/src/coderModels.ts
//    keeps a typed copy of the `coder` package. Deliberate duplication, same
//    as FALLBACK_MODELS ↔ PROVIDER_FALLBACKS — but duplication only stays
//    honest if something checks it, so assert every model id in the Workspace
//    copy still appears in the shared package.
const sharedPkgSrc = readFileSync(path.join(root, 'public/model-packages.js'), 'utf8');
const coderPkgStart = sharedPkgSrc.indexOf("id: 'coder'");
if (coderPkgStart < 0) {
  fail("public/model-packages.js must define a package with id: 'coder'");
}
// The `coder` package body runs to the start of the next package definition.
const nextPkg = sharedPkgSrc.indexOf('\n  {\n    id:', coderPkgStart);
const coderPkgSrc = sharedPkgSrc.slice(coderPkgStart, nextPkg < 0 ? undefined : nextPkg);
const workspaceCoderSrc = readFileSync(
  path.join(root, 'sandbox-terminal/src/coderModels.ts'),
  'utf8',
);
// The shared file passes ids positionally through free()/paid() helpers while
// the Workspace copy uses an `ids:` key, so read each side in its own shape:
// every quoted string in the shared package block, versus the ids arrays here.
const quotedIn = (src) => new Set([...src.matchAll(/['"]([^'"\n]+)['"]/g)].map((m) => m[1]));
const idsIn = (src) => {
  const out = new Set();
  for (const m of src.matchAll(/ids:\s*\[([^\]]*)\]/g)) {
    for (const q of m[1].matchAll(/['"]([^'"]+)['"]/g)) out.add(q[1]);
  }
  return out;
};
const sharedCoderIds = quotedIn(coderPkgSrc);
const strayCoderIds = [...idsIn(workspaceCoderSrc)].filter((id) => !sharedCoderIds.has(id));
if (strayCoderIds.length) {
  fail(
    'sandbox-terminal/src/coderModels.ts has ids absent from the shared coder ' +
    `package in public/model-packages.js: ${strayCoderIds.join(', ')}`,
  );
}
if (!sharedCoderIds.size) {
  fail('Could not parse any model ids out of the shared coder package');
}
ok(`coder-package parity (${sharedCoderIds.size} shared ids)`);

console.log('check-api: all checks passed');
