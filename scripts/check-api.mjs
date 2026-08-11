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
import { existsSync, readFileSync } from 'node:fs';
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

// 6) Paid unlock must persist in localStorage (not session-only).
const appSrc = readFileSync(path.join(root, 'public/app.js'), 'utf8');
const prefsSrc = readFileSync(path.join(root, 'sandbox-terminal/src/providerPrefs.ts'), 'utf8');
for (const [label, src] of [['public/app.js', appSrc], ['providerPrefs.ts', prefsSrc]]) {
  if (!src.includes('localStorage.getItem(PAID_PASS_STORAGE)')) {
    fail(`${label} must read paid unlock from localStorage`);
  }
  if (!src.includes('localStorage.setItem(PAID_PASS_STORAGE')) {
    fail(`${label} must write paid unlock to localStorage`);
  }
  // Primary store must not be session-only (migration reads are fine).
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

console.log('check-api: all checks passed');
