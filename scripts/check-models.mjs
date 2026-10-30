#!/usr/bin/env node
/**
 * Model-health checks — no network. A fake OpenRouter serves a catalog in
 * which the chat's saved model has been retired; the real /api/chat handler
 * must answer on a current replacement and say so.
 *
 * Run: npm run check:models
 */

import assert from 'node:assert/strict';
import { pickDefault, isModelGoneError, fetchWithModelFallback } from '../lib/model-health.js';

let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`check-models: ok — ${name}`);
  } catch (err) {
    failed++;
    console.error(`check-models: FAIL — ${name}\n  ${err.stack || err.message}`);
  }
}

const CATALOG = [
  { id: 'cohere/north-mini-code:free', pricing: { prompt: '0' } },
  { id: 'nvidia/nemotron-3-super-120b-a12b:free', pricing: { prompt: '0' } },
  { id: 'google/gemma-4-31b-it:free', pricing: { prompt: '0' } },
  { id: 'qwen/qwen3-coder', pricing: { prompt: '0.0000003' } },
  { id: 'anthropic/claude-sonnet-4.5', pricing: { prompt: '0.000003' } },
];
const enriched = CATALOG.map((m) => ({
  id: m.id, free: /:free$/.test(m.id),
  categories: /code/.test(m.id) ? ['coder'] : ['general'],
}));

await check('chat default is never a coder; coder default is a coder', () => {
  assert.equal(pickDefault(enriched, 'chat', { providerId: 'openrouter' }), 'nvidia/nemotron-3-super-120b-a12b:free');
  assert.equal(pickDefault(enriched, 'coder', { providerId: 'openrouter' }), 'cohere/north-mini-code:free');
  // Free tier on OpenRouter: the paid Qwen coder is never the pick.
  assert.notEqual(pickDefault(enriched, 'coder', { providerId: 'openrouter' }), 'qwen/qwen3-coder');
});

await check('Venice chat default is the smaller Gemma 4 (26B A4B); then Gemma 4, then Venice Uncensored', () => {
  const venice = [
    { id: 'olafangensan-glm-4.7-flash-heretic', free: false, categories: ['creative', 'uncensored', 'general'] },
    { id: 'venice-uncensored-1-2', free: false, categories: ['creative', 'uncensored'] },
    { id: 'e2ee-gemma-4-26b-a4b-uncensored-p', free: false, categories: ['uncensored'] },
    { id: 'gemma-4-uncensored', free: false, categories: ['uncensored', 'general'] },
  ];
  assert.equal(pickDefault(venice, 'chat', { providerId: 'venice' }), 'e2ee-gemma-4-26b-a4b-uncensored-p');
  const noGemma = venice.filter((m) => !m.id.includes('gemma'));
  assert.equal(pickDefault(noGemma, 'chat', { providerId: 'venice' }), 'venice-uncensored-1-2');
});

await check('retired-model errors recognised; rate limits and auth are not', () => {
  assert.ok(isModelGoneError(404, '{"error":{"message":"This model is unavailable for free. The paid version is available now"}}'));
  assert.ok(isModelGoneError(404, 'No endpoints found for qwen/qwen3-coder:free.'));
  assert.ok(isModelGoneError(400, 'deepseek/deepseek-chat-v3.1:free is not a valid model ID'));
  assert.ok(!isModelGoneError(429, 'Rate limit exceeded'));
  assert.ok(!isModelGoneError(401, 'invalid api key'));
  assert.ok(!isModelGoneError(404, 'Not Found'));
});

// Fake OpenRouter: catalog + completions where the old models are gone.
const realFetch = globalThis.fetch;
const seen = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (/\/models/.test(u)) return new Response(JSON.stringify({ data: CATALOG }), { status: 200 });
  if (/\/chat\/completions/.test(u)) {
    const body = JSON.parse(opts.body);
    seen.push(body.model);
    if (['qwen/qwen3-coder:free', 'deepseek/deepseek-chat-v3.1:free'].includes(body.model)) {
      return new Response('{"error":{"message":"This model is unavailable for free."}}', { status: 404 });
    }
    if (body.stream) {
      const enc = new TextEncoder();
      return new Response(new ReadableStream({ start(c) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: `hi from ${body.model}` } }] })}\n\ndata: [DONE]\n\n`));
        c.close();
      } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: `hi from ${body.model}` }, finish_reason: 'stop' }] }), { status: 200 });
  }
  return realFetch(url, opts);
};
process.env.OPENROUTER_API_KEY = 'test';

await check('fetchWithModelFallback: one retry on a same-kind replacement', async () => {
  seen.length = 0;
  const out = await fetchWithModelFallback({
    providerId: 'openrouter', model: 'deepseek/deepseek-chat-v3.1:free', kind: 'chat',
    doFetch: (m) => fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: m }) }),
  });
  assert.equal(out.res.status, 200);
  assert.deepEqual(out.replaced, { from: 'deepseek/deepseek-chat-v3.1:free', to: 'nvidia/nemotron-3-super-120b-a12b:free' });
  assert.deepEqual(seen, ['deepseek/deepseek-chat-v3.1:free', 'nvidia/nemotron-3-super-120b-a12b:free']);
});

await check('fetchWithModelFallback: a persistent 429 on a paid model is retried, then passes through readable', async () => {
  let calls = 0;
  const out = await fetchWithModelFallback({
    providerId: 'openrouter', model: 'thedrummer/cydonia-24b-v4.1', kind: 'chat', retryWaitsMs: [1, 1],
    doFetch: async () => { calls++; return new Response('Rate limit exceeded', { status: 429 }); },
  });
  assert.equal(out.res.status, 429);
  assert.equal(await out.res.text(), 'Rate limit exceeded');
  assert.equal(out.replaced, null);
  assert.equal(calls, 3, 'tried once, then retried twice on the same model');
});

await check('fetchWithModelFallback: a 429 that clears on retry answers on the SAME model', async () => {
  let calls = 0;
  const out = await fetchWithModelFallback({
    providerId: 'openrouter', model: 'thedrummer/cydonia-24b-v4.1', kind: 'chat', retryWaitsMs: [1, 1],
    doFetch: async () => (++calls < 2 ? new Response('Provider returned error', { status: 429 }) : new Response('{}', { status: 200 })),
  });
  assert.equal(out.res.status, 200);
  assert.equal(out.model, 'thedrummer/cydonia-24b-v4.1');
  assert.equal(out.replaced, null);
});

await check('fetchWithModelFallback: a non-rate-limit error is not retried', async () => {
  let calls = 0;
  const out = await fetchWithModelFallback({
    providerId: 'openrouter', model: 'x', kind: 'chat', retryWaitsMs: [1, 1],
    doFetch: async () => { calls++; return new Response('Unauthorized', { status: 401 }); },
  });
  assert.equal(out.res.status, 401);
  assert.equal(calls, 1);
});

await check('/api/chat answers on a replacement and reports it', async () => {
  const { default: handler } = await import('../api/chat.js');
  const out = await invoke(handler, {
    messages: [{ role: 'user', content: 'hello' }], provider: 'openrouter',
    model: 'deepseek/deepseek-chat-v3.1:free', stream: true,
  });
  const events = out.body.split('\n\n').filter((b) => b.startsWith('data:')).map((b) => JSON.parse(b.slice(5)));
  const done = events.find((e) => e.type === 'done');
  assert.equal(done?.reply, 'hi from nvidia/nemotron-3-super-120b-a12b:free');
  assert.deepEqual(done.modelReplaced, { from: 'deepseek/deepseek-chat-v3.1:free', to: 'nvidia/nemotron-3-super-120b-a12b:free' });
  assert.ok(events.some((e) => /no longer available/.test(e.message || '')));
});

await check('/api/agent-chat replaces a retired coder with a coder', async () => {
  const { default: handler } = await import('../api/agent-chat.js');
  const out = await invoke(handler, {
    messages: [{ role: 'user', content: 'write hello.py' }], provider: 'openrouter',
    model: 'qwen/qwen3-coder:free', stream: false, systemPrompt: 'coder',
  });
  const data = JSON.parse(out.body);
  assert.equal(data.modelReplaced?.to, 'cohere/north-mini-code:free');
});

function invoke(handler, body) {
  return new Promise((resolve) => {
    let buf = '';
    const res = {
      statusCode: 200, headers: {}, writableEnded: false, destroyed: false,
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, flushHeaders() {},
      status(c) { this.statusCode = c; return this; },
      json(d) { buf = JSON.stringify(d); this.writableEnded = true; resolve({ status: this.statusCode, body: buf }); return this; },
      write(chunk) { buf += chunk; return true; },
      end() { this.writableEnded = true; resolve({ status: this.statusCode, body: buf }); },
      on() {}, off() {},
    };
    handler({ method: 'POST', headers: {}, query: {}, body, socket: {} }, res);
  });
}

globalThis.fetch = realFetch;
if (failed) {
  console.error(`check-models: ${failed} failed`);
  process.exit(1);
}
console.log('check-models: all checks passed');
