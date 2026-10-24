/**
 * Images for autopost, held to a hard quality bar.
 *
 * One image prompt is written from the post and the account's style guide,
 * several candidates are generated, and a vision model grades each as a strict
 * art director. Only an image scoring at or above the bar is used. If none
 * clears it after a second round (which feeds the first round's complaints back
 * into the prompt), this throws and NOTHING is posted — a missing post is better
 * than a sloppy one.
 */

import { resolveProvider, DEFAULT_MODELS, withProviderChatExtras, formatProviderError } from './providers.js';
import { parseLooseJSON } from './campaign-engine.js';

export const DEFAULT_STYLE =
  'One clear subject, clean uncluttered composition, soft cinematic lighting, cohesive modern palette, ' +
  'polished editorial finish. No text, logos or watermarks anywhere in the image.';

const NEGATIVE =
  'text, letters, words, watermark, logo, caption, signature, distorted hands, extra fingers, deformed face, ' +
  'warped anatomy, melted objects, blurry, low quality, oversaturated, cluttered, generic stock photo, plastic skin';

const MIN_SCORE = () => Number(process.env.AUTOPOST_MIN_IMAGE_SCORE) || 8;
const CANDIDATES = () => Math.min(4, Math.max(1, Number(process.env.AUTOPOST_IMAGE_CANDIDATES) || 3));
const ROUNDS = 2;

/** Best scored candidate, and whether it clears the bar. Pure, so it is testable. */
export function pickBest(scored, min = MIN_SCORE()) {
  const ok = scored.filter((c) => c && Number.isFinite(c.score));
  if (!ok.length) return { best: null, passes: false };
  const best = ok.reduce((a, b) => (b.score > a.score ? b : a));
  return { best, passes: best.score >= min };
}

export function parseScore(raw) {
  let j;
  try { j = parseLooseJSON(raw); } catch { return null; }
  const score = Number(j?.score);
  if (!Number.isFinite(score)) return null;
  return { score: Math.max(0, Math.min(10, score)), issues: Array.isArray(j.issues) ? j.issues.map(String).slice(0, 6) : [] };
}

async function chat(providerId, model, messages, { temperature = 0.4, maxTokens = 500, extra } = {}) {
  const resolved = resolveProvider(providerId, '');
  const body = withProviderChatExtras({ model, messages, stream: false, temperature, max_tokens: maxTokens }, providerId);
  if (extra) Object.assign(body, extra);
  const res = await fetch(resolved.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resolved.apiKey}`, ...resolved.extraHeaders() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(formatProviderError(resolved.label, res.status, raw, model));
  return String(JSON.parse(raw)?.choices?.[0]?.message?.content || '').trim();
}

async function pickVeniceVisionModel() {
  if (process.env.AUTOPOST_VISION_MODEL) return process.env.AUTOPOST_VISION_MODEL;
  const resolved = resolveProvider('venice', '');
  const res = await fetch(resolved.modelsUrl, { headers: { Authorization: `Bearer ${resolved.apiKey}` }, signal: AbortSignal.timeout(30_000) });
  const data = await res.json().catch(() => ({}));
  const live = (data.data || []).filter((m) => m?.model_spec?.capabilities?.supportsVision && m.model_spec?.offline !== true);
  if (!live.length) throw new Error('No live Venice vision model to grade images with (set AUTOPOST_VISION_MODEL).');
  return live[0].id;
}

async function writeImagePrompt({ post, style, platform, avoid }) {
  const model = process.env.AUTOPOST_MODEL || DEFAULT_MODELS.venice;
  const out = await chat('venice', model, [
    { role: 'system', content: 'You write image-generation prompts. Output ONE paragraph, nothing else: a concrete subject, composition, lighting and mood. Never ask for text, words, logos, people holding signs, or screens with text in the picture.' },
    { role: 'user', content: `Post (${platform}):\n${post}\n\nHouse visual style to follow exactly:\n${style}\n${avoid.length ? `\nA previous attempt was rejected for: ${avoid.join('; ')}. Avoid those problems.\n` : ''}\nWrite the image prompt.` },
  ], { temperature: 0.7, maxTokens: 350 });
  return `${out.replace(/^["“]|["”]$/g, '')}\n\nStyle: ${style}`;
}

async function generateOne(base, prompt, size) {
  const res = await fetch(`${base}/api/media-generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'image', provider: 'venice', model: process.env.AUTOPOST_IMAGE_MODEL || undefined, prompt, negativePrompt: NEGATIVE, size }),
    signal: AbortSignal.timeout(180_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `image HTTP ${res.status}`);
  const url = (data.images || [])[0]?.url;
  if (!url) throw new Error('Image generated but not hosted (needs SUPABASE_SERVICE_ROLE_KEY).');
  return url;
}

async function grade(visionModel, url, { style, platform }) {
  const raw = await chat('venice', visionModel, [{
    role: 'user',
    content: [
      { type: 'text', text:
        `You are a strict art director approving an image for a ${platform} post. House style: ${style}\n` +
        'Score 0-10. 10 = flawless and on-brand; 8 = publish-ready; below 8 = reject. Penalise hard: ANY readable or garbled text, ' +
        'watermarks or logos, warped hands/faces/anatomy, melted or merged objects, a generic AI-stock look, off-brand style, muddy or cluttered composition. ' +
        'Reply with JSON only: {"score": number, "issues": ["short issue", ...]}' },
      { type: 'image_url', image_url: { url } },
    ],
  }], { temperature: 0, maxTokens: 300, extra: { venice_parameters: { include_venice_system_prompt: false } } });
  return parseScore(raw);
}

/** Returns { url, score }. Throws (never returns a below-bar image). */
export async function makeImage({ post, account, base, platform }) {
  const style = String(account.autopostImageStyle || '').trim() || DEFAULT_STYLE;
  const size = platform === 'instagram' ? '1024x1024' : '1024x1024';
  const visionModel = await pickVeniceVisionModel();
  let avoid = [];
  let lastBest = null;
  for (let round = 1; round <= ROUNDS; round++) {
    const prompt = await writeImagePrompt({ post, style, platform, avoid });
    const made = await Promise.allSettled(Array.from({ length: CANDIDATES() }, () => generateOne(base, prompt, size)));
    const urls = made.filter((m) => m.status === 'fulfilled').map((m) => m.value);
    if (!urls.length) throw new Error(`Image generation failed: ${made[0]?.reason?.message || 'unknown error'}`);
    const scored = await Promise.all(urls.map(async (url) => {
      try { const g = await grade(visionModel, url, { style, platform }); return g ? { url, ...g } : null; } catch { return null; }
    }));
    const { best, passes } = pickBest(scored);
    if (!best) throw new Error('Could not grade the generated images, so none were used.');
    if (passes) return { url: best.url, score: best.score };
    lastBest = best;
    avoid = best.issues;
  }
  throw new Error(`No image met the quality bar (best ${lastBest.score}/10: ${lastBest.issues.join('; ') || 'unspecified'}). Nothing was posted.`);
}
