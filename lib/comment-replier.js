// Replies to Facebook / Instagram comments on your pages, in a persona's
// voice. Called from api/webhooks/meta.js AFTER signature verification.
//
// Flow: dedupe (KV) → generate short reply with the same provider stack the
// chat uses → POST the reply via Graph API → team-log entry so group chat
// can see the page actually replied.

import { loadConfig } from './config.js';
import { resolveProvider, withProviderChatExtras } from './providers.js';
import { kvGet, kvSet, kvExpire, KV_ENABLED } from './kv.js';
import { logTeamAction } from './team-log.js';

const GRAPH = 'https://graph.facebook.com/v21.0';

const REPLIER_SYSTEM =
  'You write short, natural social media replies on behalf of the page. ' +
  '2-3 sentences max, conversational, no hashtag spam, no emoji spam. ' +
  'Match the vibe of the comment. If it is hostile or spam, keep it ' +
  'brief and classy. Never break the persona you are given.';

async function pageTokenFor(pageId) {
  const fallback = (process.env.META_PAGE_ACCESS_TOKEN || '').trim();
  try {
    const config = await loadConfig();
    const acct = (config.socialAccounts || []).find(
      (a) => a.pageId === pageId && a.pageToken,
    );
    return acct ? acct.pageToken : fallback;
  } catch {
    return fallback;
  }
}

async function personaPrompt() {
  try {
    const config = await loadConfig();
    const wanted = (process.env.COMMENT_REPLIER_PERSONA || '').trim();
    const persona =
      config.personas.find((p) => p.id === wanted) || config.personas[0];
    return [config.masterPrompt, persona?.systemPrompt].filter(Boolean).join('\n\n');
  } catch {
    return '';
  }
}

async function generateReply({ system, commenter, text }) {
  const providerId = (process.env.COMMENT_REPLIER_PROVIDER || 'openrouter').trim();
  const model = (process.env.COMMENT_REPLIER_MODEL || 'openrouter/free').trim();
  const resolved = resolveProvider(providerId);
  const user =
    `Comment from ${commenter} on one of the page's posts:\n"${text}"\n\n` +
    'Write the reply text only — no surrounding quotes, no preamble.';
  const upstream = await fetch(resolved.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${resolved.apiKey}`,
      ...resolved.extraHeaders(),
    },
    body: JSON.stringify(
      withProviderChatExtras(
        {
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          stream: false,
          max_tokens: 300,
        },
        providerId,
      ),
    ),
  });
  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    throw new Error(`model call failed ${upstream.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  const reply = (data.choices?.[0]?.message?.content || '')
    .trim()
    .replace(/^["'“”]+|["'“”]+$/g, '');
  if (!reply) throw new Error('model returned empty reply');
  return reply;
}

async function postFbReply({ commentId, token, message }) {
  const resp = await fetch(`${GRAPH}/${commentId}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, access_token: token }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.error) {
    throw new Error(`fb reply failed: ${JSON.stringify(data.error || data).slice(0, 300)}`);
  }
  return data.id;
}

async function postIgReply({ commentId, token, message }) {
  const resp = await fetch(`${GRAPH}/${commentId}/replies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, access_token: token }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.error) {
    throw new Error(`ig reply failed: ${JSON.stringify(data.error || data).slice(0, 300)}`);
  }
  return data.id;
}

// KV-setNX pattern: returns true when this comment was already handled, so
// Meta's webhook redeliveries never produce a double reply.
async function alreadyHandled(commentId) {
  if (!KV_ENABLED) return false;
  const key = `uncensored-chat:cr:done:${commentId}`;
  if (await kvGet(key)) return true;
  await kvSet(key, { at: new Date().toISOString() });
  await kvExpire(key, 60 * 60 * 24 * 7).catch(() => {});
  return false;
}

export async function handleCommentEvent({
  platform, pageId, commentId, commenter, commenterId, text,
}) {
  if (!text || !commentId) return { skipped: 'empty' };
  // Never reply to ourselves — this is the loop-killer.
  if (process.env.META_PAGE_ID && commenterId === process.env.META_PAGE_ID.trim()) {
    return { skipped: 'self' };
  }
  if (await alreadyHandled(commentId)) return { skipped: 'duplicate' };

  const token = await pageTokenFor(pageId);
  if (!token) {
    console.error('comment-replier: no page token for page', pageId);
    return { skipped: 'no-token' };
  }

  const system = [await personaPrompt(), REPLIER_SYSTEM].filter(Boolean).join('\n\n');
  const reply = await generateReply({ system, commenter, text });
  const replyId =
    platform === 'instagram'
      ? await postIgReply({ commentId, token, message: reply })
      : await postFbReply({ commentId, token, message: reply });

  await logTeamAction(`page:${pageId}`, {
    action: 'comment-reply',
    platform,
    commenter,
    commentText: String(text).slice(0, 140),
    reply: reply.slice(0, 140),
  });
  return { ok: true, replyId };
}
