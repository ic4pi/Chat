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
  'api/admin-config.js',
  'api/git-push.js',
];

function fail(msg) {
  console.error(`check-api: FAIL — ${msg}`);
  process.exit(1);
}

function ok(msg) {
  console.log(`check-api: ok — ${msg}`);
}

// 1) Syntax check critical modules (works without installing deps beyond node).
for (const rel of SYNTAX_FILES) {
  const abs = path.join(root, rel);
  if (!existsSync(abs)) fail(`missing required file ${rel}`);
  const r = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8' });
  if (r.status !== 0) {
    fail(`syntax error in ${rel}\n${(r.stderr || r.stdout || '').trim()}`);
  }
}
ok(`syntax (${SYNTAX_FILES.length} files)`);

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

console.log('check-api: all checks passed');
