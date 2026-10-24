/**
 * Autopost: a social account with an autopost schedule and a brief writes and
 * publishes a post by itself, no tap. Runs from the hourly cron
 * (api/cron/run-standing-tasks.js). Facebook, Instagram and X. Instagram always
 * gets an image; Facebook gets one when the account has an image style set. Every
 * image is graded and only a clearly good one is used (lib/autopost-image.js);
 * if none is, nothing is posted. Email isn't a feed.
 *
 * At-most-once: the run time is recorded BEFORE publishing, so a slow or
 * failed publish never produces a duplicate on the next tick. Every attempt
 * is written to the team log (what was posted, or why not).
 */

import { loadConfig } from './config.js';
import { kvGet, kvSet, KV_ENABLED } from './kv.js';
import { resolveProvider, withProviderChatExtras, DEFAULT_MODELS, formatProviderError } from './providers.js';
import { publishToAccount } from './social.js';
import { makeImage } from './autopost-image.js';
import { db, HUB_ENABLED } from './hub.js';
import { logTeamAction } from './team-log.js';

const STATE_KEY = 'uncensored-chat:autopost-state:v1';
const EVERY_MS = { hourly: 3_600_000, daily: 86_400_000, weekly: 604_800_000 };
const KEEP_RECENT = 8;
const MAX_POST_CHARS = 2000;
const PLATFORMS = ['facebook', 'instagram', 'twitter'];
const MAX_RETRY_FAILS = 6;   // image/model failures retried on the next hourly tick, then wait a full interval

const parse = (raw) => { try { return typeof raw === 'string' ? JSON.parse(raw) : (raw || {}); } catch { return {}; } };

async function loadState() {
  if (!KV_ENABLED) return {};
  return parse(await kvGet(STATE_KEY));
}
async function saveState(s) {
  if (KV_ENABLED) await kvSet(STATE_KEY, s);
}

export function isAutopostDue(account, state, now = Date.now()) {
  const every = EVERY_MS[account.autopostEvery];
  if (!every || !String(account.autopostBrief || '').trim()) return false;
  if (!PLATFORMS.includes(account.platform)) return false;
  const last = Date.parse(state?.[account.id]?.lastAt || '');
  return Number.isNaN(last) || now - last >= every - 60_000;   // cron jitter
}

async function ownerId() {
  if (!HUB_ENABLED) return null;
  const { data } = await db.from('owners').select('id').order('created_at', { ascending: true }).limit(1).single();
  return data?.id || null;
}

async function writePost(account, config, recent) {
  const providerId = process.env.AUTOPOST_PROVIDER || 'venice';
  const model = process.env.AUTOPOST_MODEL || DEFAULT_MODELS[providerId];
  const resolved = resolveProvider(providerId, '');
  const persona = (config.personas || []).find((p) => p.id === account.autopostPersonaId);
  const system = [
    config.masterPrompt || '',
    persona?.systemPrompt || '',
    'You write one social media post for the account below. Output ONLY the post text, ready to publish: no preamble, no quotes around it, no notes, no placeholders.',
    account.platform === 'twitter' ? 'Hard limit: 270 characters.' : account.platform === 'instagram' ? 'An Instagram caption: a strong first line, short paragraphs, under 900 characters, at most 5 relevant hashtags at the end. A separate image is added automatically — never mention or describe it.' : 'Keep it under 1200 characters.',
  ].filter(Boolean).join('\n\n');
  const user = [
    `Account: ${account.label}`,
    `Brief: ${account.autopostBrief}`,
    recent.length ? `Recent posts (do NOT repeat their wording or angle):\n- ${recent.join('\n- ')}` : '',
    'Write the next post.',
  ].filter(Boolean).join('\n\n');

  const res = await fetch(resolved.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resolved.apiKey}`, ...resolved.extraHeaders() },
    body: JSON.stringify(withProviderChatExtras({
      model, stream: false, temperature: 0.8, max_tokens: 700,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }, providerId)),
    signal: AbortSignal.timeout(120_000),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(formatProviderError(resolved.label, res.status, raw, model));
  let text = String(JSON.parse(raw)?.choices?.[0]?.message?.content || '').trim();
  text = text.replace(/^["“]|["”]$/g, '').trim();
  const limit = account.platform === 'twitter' ? 280 : MAX_POST_CHARS;
  if (!text) throw new Error('The model returned an empty post.');
  if (text.length > limit) throw new Error(`The model wrote ${text.length} characters; the limit is ${limit}. Not posted.`);
  return text;
}

/** Run every due autopost account. `only` forces one account id now (admin test). */
export async function runAutopost({ only, baseUrl } = {}) {
  const config = await loadConfig();
  const state = await loadState();
  const base = (baseUrl || process.env.SITE_URL || '').replace(/\/$/, '');
  const out = [];
  for (const account of config.socialAccounts || []) {
    if (only ? account.id !== only : !isAutopostDue(account, state)) continue;
    if (only && !PLATFORMS.includes(account.platform)) {
      out.push({ id: account.id, label: account.label, ok: false, error: 'Autopost supports Facebook, Instagram and X only.' });
      continue;
    }
    const prev = state[account.id] || {};
    const wantsImage = account.platform === 'instagram' || (account.platform === 'facebook' && String(account.autopostImageStyle || '').trim());
    state[account.id] = { ...prev, lastAt: new Date().toISOString() };   // record first: at-most-once
    await saveState(state);
    let entry;
    let publishing = false;
    try {
      const text = await writePost(account, config, prev.recent || []);
      let imageUrl;
      let score;
      if (wantsImage) {
        if (!base) throw new Error('Cannot generate images: set SITE_URL in the environment.');
        ({ url: imageUrl, score } = await makeImage({ post: text, account, base, platform: account.platform }));
      }
      publishing = true;
      const result = await publishToAccount(account, { message: text, imageUrl });
      state[account.id].recent = [text, ...(prev.recent || [])].slice(0, KEEP_RECENT).map((t) => t.slice(0, 160));
      state[account.id].lastError = null;
      state[account.id].fails = 0;
      entry = { id: account.id, label: account.label, ok: true, postId: result?.id || null, text, imageUrl, imageScore: score };
    } catch (err) {
      state[account.id].lastError = err.message || String(err);
      if (!publishing) {
        // Failed before anything went out (writing, image, grading): retry on the next tick, a few times.
        const fails = (prev.fails || 0) + 1;
        state[account.id].fails = fails;
        if (fails < MAX_RETRY_FAILS) state[account.id].lastAt = prev.lastAt;
        else state[account.id].fails = 0;
      }
      entry = { id: account.id, label: account.label, ok: false, error: state[account.id].lastError };
    }
    await saveState(state);
    out.push(entry);
    try {
      const oid = await ownerId();
      if (oid) {
        await logTeamAction(oid, {
          personaName: 'Autopost',
          platform: account.platform,
          verb: entry.ok ? 'posted' : 'failed to post',
          summary: entry.ok ? String(entry.text).slice(0, 140) : String(entry.error).slice(0, 140),
        });
      }
    } catch { /* logging must never break the run */ }
  }
  return out;
}
