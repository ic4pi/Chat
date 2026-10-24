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
import { getBusiness } from './business-profile.js';
import { db, HUB_ENABLED } from './hub.js';
import { logTeamAction } from './team-log.js';

const STATE_KEY = 'uncensored-chat:autopost-state:v1';
const DAY_MS = 86_400_000;
/** How often an account is due: 'daily' means N posts a day, spaced evenly across 24h. */
export function intervalMs(account) {
  if (account.autopostEvery === 'hourly') return 3_600_000;
  if (account.autopostEvery === 'weekly') return 7 * DAY_MS;
  if (account.autopostEvery === 'daily') return Math.round(DAY_MS / Math.min(6, Math.max(1, Number(account.autopostPerDay) || 1)));
  return 0;
}

/** Sensible starting cadence per platform: enough to stay visible, not enough to be tuned out. */
export const RECOMMENDED_PER_DAY = { facebook: 1, instagram: 1, twitter: 3 };

const DEFAULT_BRIEF =
  'Educational content for small business owners: marketing tips and tricks, how to get a website built and working for them, how-tos for related tasks, and how to pick the right campaign. Helpful first, never salesy.';

/** A menu of formats the AI may choose from. It decides what to post; nothing here sets an order. */
export const FORMATS = [
  'quick tip', 'step-by-step how-to for one concrete task', 'website insight (what to ask a developer, costs, timelines, mistakes)',
  'myth vs. fact', 'marketing trick', 'how to choose the right campaign for a goal', 'checklist', 'short lesson from a common mistake',
];
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
  const every = intervalMs(account);
  if (!every) return false;
  if (!PLATFORMS.includes(account.platform)) return false;
  const last = Date.parse(state?.[account.id]?.lastAt || '');
  return Number.isNaN(last) || now - last >= every - 60_000;   // cron jitter
}

async function ownerId() {
  if (!HUB_ENABLED) return null;
  const { data } = await db.from('owners').select('id').order('created_at', { ascending: true }).limit(1).single();
  return data?.id || null;
}

async function writePost(account, config, recent, business = {}) {
  const providerId = process.env.AUTOPOST_PROVIDER || 'venice';
  const model = process.env.AUTOPOST_MODEL || DEFAULT_MODELS[providerId];
  const resolved = resolveProvider(providerId, '');
  const persona = (config.personas || []).find((p) => p.id === account.autopostPersonaId);
  const system = [
    config.masterPrompt || '',
    persona?.systemPrompt || '',
    business.profile ? `ABOUT THE BUSINESS (authoritative — never contradict it, never invent facts, prices or clients beyond it):\n${business.profile}` : '',
    business.notes ? `THE TEAM'S LATEST STRATEGY (from their own discussion — follow it):\n${business.notes}` : '',
    'You write one social media post for the account below. Output ONLY the post text, ready to publish: no preamble, no quotes around it, no notes, no placeholders.',
    account.platform === 'twitter' ? 'Hard limit: 270 characters.' : account.platform === 'instagram' ? 'An Instagram caption: a strong first line, short paragraphs, under 900 characters, at most 5 relevant hashtags at the end. A separate image is added automatically — never mention or describe it.' : 'Keep it under 1200 characters.',
  ].filter(Boolean).join('\n\n');
  const user = [
    `Account: ${account.label}`,
    `Focus: ${String(account.autopostBrief || '').trim() || DEFAULT_BRIEF}`,
    `You are the strategist as well as the writer: decide what this account should post NEXT. Use what you know about the business from your persona and the master prompt. Pick the single most valuable topic and format for the audience right now — formats you can use (or a better one you choose): ${FORMATS.join('; ')}. Look at the recent posts and choose a clearly different topic and format from them. Be specific and useful; never generic advice.`,
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
  const business = await getBusiness().catch(() => ({}));
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
      const text = await writePost(account, config, prev.recent || [], business);
      let imageUrl;
      let score;
      let imageSkipped = null;
      if (wantsImage) {
        try {
          if (!base) throw new Error('Cannot generate images: set SITE_URL in the environment.');
          ({ url: imageUrl, score } = await makeImage({ post: text, account, base, platform: account.platform }));
        } catch (imgErr) {
          // Instagram can't post without an image; Facebook posts the text on its own.
          if (account.platform === 'instagram') throw imgErr;
          imageSkipped = imgErr.message || String(imgErr);
        }
      }
      publishing = true;
      const result = await publishToAccount(account, { message: text, imageUrl });
      state[account.id].recent = [text, ...(prev.recent || [])].slice(0, KEEP_RECENT).map((t) => t.slice(0, 160));
      state[account.id].lastError = null;
      state[account.id].fails = 0;
      entry = { id: account.id, label: account.label, ok: true, postId: result?.id || null, text, imageUrl, imageScore: score, imageSkipped };
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
