/**
 * Posts you approved for later. You approve the whole launch once; the
 * hourly cron (api/cron/run-standing-tasks.js) publishes each post when its
 * time comes, through the same publishToAccount the Post button uses, and
 * logs it as a team action. Same KV blob pattern as standing tasks.
 */

import { kvGet, kvSet, KV_ENABLED } from './kv.js';
import { loadConfig } from './config.js';
import { publishToAccount } from './social.js';
import { logTeamAction } from './team-log.js';

const KEY = 'uncensored-chat:scheduled-posts:v1';
const MAX_KEPT = 300;
const MAX_PER_RUN = 10;

function parse(raw) {
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(v?.posts) ? v.posts : [];
  } catch {
    return [];
  }
}

export async function listScheduledPosts() {
  if (!KV_ENABLED) return [];
  return parse(await kvGet(KEY));
}

async function save(posts) {
  // Keep every pending post; trim only the oldest finished ones.
  const pending = posts.filter((p) => p.status === 'scheduled');
  const done = posts.filter((p) => p.status !== 'scheduled').slice(-Math.max(0, MAX_KEPT - pending.length));
  await kvSet(KEY, { posts: [...pending, ...done] });
}

export function isAccountReady(a) {
  if (!a) return false;
  if (a.platform === 'twitter') return !!(a.consumerKey && a.consumerSecret && a.accessToken && a.accessTokenSecret);
  if (a.platform === 'email') return !!(a.resendApiKey && a.fromEmail);
  return !!(a.pageId && a.pageToken);
}

/** Validates and queues posts; returns what was queued and what was refused, with why. */
export async function schedulePosts(items, { ownerId = null, accounts }) {
  if (!KV_ENABLED) throw new Error('Scheduling needs Vercel KV, which is not configured.');
  const queued = [];
  const refused = [];
  for (const it of (Array.isArray(items) ? items : []).slice(0, 50)) {
    const account = accounts.find((a) => a.id === it?.accountId);
    const message = String(it?.message || '').trim().slice(0, 5000);
    const at = Date.parse(it?.at);
    const ref = it?.ref;
    if (!account || !isAccountReady(account)) { refused.push({ ref, error: 'account not connected' }); continue; }
    if (account.platform === 'email') { refused.push({ ref, error: 'email needs a recipient — send it from its card' }); continue; }
    if (!message && !it?.imageUrl) { refused.push({ ref, error: 'nothing to post' }); continue; }
    if (account.platform === 'instagram' && !it?.imageUrl) { refused.push({ ref, error: 'Instagram needs an image' }); continue; }
    if (!Number.isFinite(at)) { refused.push({ ref, error: 'no valid time' }); continue; }
    queued.push({
      id: `sp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      ref,
      ownerId,
      accountId: account.id,
      label: account.label,
      platform: account.platform,
      message,
      imageUrl: typeof it.imageUrl === 'string' && /^https:\/\//.test(it.imageUrl) ? it.imageUrl : undefined,
      personaName: typeof it.personaName === 'string' ? it.personaName.slice(0, 80) : undefined,
      at: new Date(at).toISOString(),
      status: 'scheduled',
      createdAt: new Date().toISOString(),
    });
  }
  if (queued.length) await save([...(await listScheduledPosts()), ...queued]);
  return { queued, refused };
}

export async function cancelScheduledPosts(ids) {
  const want = new Set((Array.isArray(ids) ? ids : []).filter((x) => typeof x === 'string'));
  const posts = await listScheduledPosts();
  let cancelled = 0;
  for (const p of posts) {
    if (want.has(p.id) && p.status === 'scheduled') { p.status = 'cancelled'; cancelled += 1; }
  }
  if (cancelled) await save(posts);
  return cancelled;
}

/** Publishes everything due. Called hourly by cron. */
export async function publishDuePosts(now = Date.now()) {
  if (!KV_ENABLED) return [];
  const posts = await listScheduledPosts();
  const due = posts.filter((p) => p.status === 'scheduled' && Date.parse(p.at) <= now).slice(0, MAX_PER_RUN);
  if (!due.length) return [];
  const config = await loadConfig();
  const results = [];
  for (const p of due) {
    const account = (config.socialAccounts || []).find((a) => a.id === p.accountId);
    try {
      if (!isAccountReady(account)) throw new Error('account is no longer connected');
      const out = await publishToAccount(account, { message: p.message, imageUrl: p.imageUrl });
      p.status = 'posted';
      p.postedAt = new Date().toISOString();
      p.resultId = out?.id || null;
      await logTeamAction(p.ownerId, {
        personaName: p.personaName,
        platform: p.platform,
        verb: 'posted',
        summary: p.message.slice(0, 140),
      });
    } catch (err) {
      p.status = 'failed';
      p.error = String(err?.message || err).slice(0, 300);
    }
    results.push({ id: p.id, status: p.status, error: p.error });
  }
  await save(posts);
  return results;
}
