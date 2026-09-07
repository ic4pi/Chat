/**
 * Proves /api/media-generate reaches a deployed Modal app even when the
 * configured endpoint names an app that does not exist — the "sdx1" for
 * "sdxl" typo that 404'd every image request.
 *
 * Runs a real HTTP server standing in for modal.run: it 404s every unknown
 * app name and serves only the ones the deploy workflow actually creates.
 *
 * Run: npm run check:modal-failover
 */

import http from 'node:http';
import { pathToFileURL } from 'node:url';

let failures = 0;
let checks = 0;
const ok = (l, d = '') => { checks++; console.log(`check-modal-failover: ok — ${l}${d ? ` (${d})` : ''}`); };
const bad = (l, d = '') => { checks++; failures++; console.error(`check-modal-failover: FAIL — ${l}${d ? `\n    ${d}` : ''}`); };
const assert = (c, l, d) => (c ? ok(l) : bad(l, d));

// ── a stand-in modal.run ────────────────────────────────────────────────────
// Only these app names exist, exactly as the deploy workflow names them.
const DEPLOYED = new Set(['sdxl-nsfw-v2', 'wan-video-v2', 'ltx-video-v2']);
const seen = [];

const server = http.createServer((req, res) => {
  const app = (req.headers['x-modal-app'] || '').toString();
  const fn = (req.headers['x-modal-fn'] || '').toString();
  seen.push(`${app}/${fn}`);
  if (!DEPLOYED.has(app)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ detail: 'not found' }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    images_base64: ['ZmFrZS1pbWFnZQ=='],
    mime_type: 'image/webp',
    elapsed_seconds: 1.2,
  }));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const { port } = server.address();

// media-generate builds real https://<ws>--<app>-<fn>.modal.run URLs, so
// intercept fetch and send them at the stand-in with the parts in headers.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  const m = u.match(/^https:\/\/([^-]+)--(.+)-([^-.]+)\.modal\.run$/);
  if (!m) return realFetch(url, init);
  return realFetch(`http://127.0.0.1:${port}/`, {
    ...init,
    headers: { ...(init?.headers || {}), 'x-modal-app': m[2], 'x-modal-fn': m[3] },
  });
};

// The typo, exactly as it sits in Vercel right now.
process.env.MODAL_SDXL_ENDPOINT = 'https://ic4pi--sdx1-nsfw-v2-generate.modal.run';
delete process.env.MODAL_WAN_ENDPOINT;
delete process.env.MODAL_LTX_ENDPOINT;

const mod = await import(pathToFileURL('/home/user/Chat/api/media-generate.js').href);

// ── drive a real image request through the handler ──────────────────────────
function invoke(body) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      _headers: {},
      setHeader(k, v) { this._headers[k] = v; },
      status(c) { this.statusCode = c; return this; },
      json(o) { resolve({ status: this.statusCode, body: o }); return this; },
      end() { resolve({ status: this.statusCode, body: undefined }); return this; },
    };
    mod.default({ method: 'POST', query: {}, headers: {}, body }, res);
  });
}

const out = await invoke({
  provider: 'modal',
  model: 'lustify',
  prompt: 'a lighthouse at dusk',
  size: '1024x1024',
});

assert(out.status === 200, 'an image request succeeds despite the typo\'d endpoint',
  JSON.stringify(out.body).slice(0, 400));
assert(
  !!out.body?.images?.length,
  'the response carries an image',
  JSON.stringify(out.body).slice(0, 300),
);
assert(
  seen[0] === 'sdx1-nsfw-v2/generate',
  'the configured endpoint is tried first, exactly as set',
  seen.join(' → '),
);
assert(
  seen.includes('sdxl-nsfw-v2/generate'),
  'a 404 fails over to the app the deploy workflow creates',
  seen.join(' → '),
);

// Second call must not re-try the dead name — the winner is remembered.
seen.length = 0;
await invoke({ provider: 'modal', model: 'lustify', prompt: 'a second one', size: '1024x1024' });
assert(
  seen.length === 1 && seen[0] === 'sdxl-nsfw-v2/generate',
  'the working endpoint is remembered, no repeated 404 round trip',
  seen.join(' → '),
);

// Nothing deployed under any candidate name → a real, readable error.
seen.length = 0;
DEPLOYED.clear();
const dead = await invoke({ provider: 'modal', model: 'lustify', prompt: 'x', size: '1024x1024' });
assert(dead.status >= 400, 'a genuinely missing app still fails', JSON.stringify(dead.body));
assert(
  /not deployed|no Modal app named/i.test(dead.body?.error || ''),
  'and the error says the app is not deployed, naming the env var',
  dead.body?.error,
);
console.log(`    ${dead.body?.error}`);

server.close();
console.log('');
if (failures) {
  console.error(`check-modal-failover: ${failures} of ${checks} checks FAILED`);
  process.exit(1);
}
console.log(`check-modal-failover: all ${checks} checks passed`);
