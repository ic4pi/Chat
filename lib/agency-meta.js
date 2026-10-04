// Platform adapter for Facebook Pages and Instagram Business accounts, shaped
// for lib/autopilot.js. Publishing reuses lib/social.js; this file adds the
// read side (comments, metrics) and comment replies through the Graph API.
//
// Tokens go in the Authorization header, never in a URL, so they cannot land in
// request logs. The Graph version is overridable with META_GRAPH_VERSION.
//
// Reading comments and replying needs the app to hold the right permissions
// (e.g. pages_read_engagement, pages_manage_engagement, instagram_manage_comments).
// In Development mode that only works for roles on the app; for a client's real
// account the app must pass Meta's App Review.

import { publishToAccount } from './social.js';

const VERSION = process.env.META_GRAPH_VERSION || 'v21.0';
const BASE = `https://graph.facebook.com/${VERSION}`;

async function graph(path, token, { method = 'GET', params = {}, form } = {}) {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: form ? new URLSearchParams(form) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error?.message || `Graph API error (HTTP ${res.status})`);
  return data;
}

/** `account` is one entry of config.socialAccounts. Returns null for platforms without comment support. */
export function createMetaPlatform(account) {
  if (!account) return null;
  // social.js treats any account that is not email/instagram/twitter as a Facebook Page.
  if (account.platform === 'email' || account.platform === 'twitter') return null;
  const isIg = account.platform === 'instagram';
  const token = account.pageToken;
  const selfId = isIg ? account.igUserId : account.pageId;
  if (!token || !selfId) return null;

  return {
    selfId,

    async publish({ text, imageUrl }) {
      return publishToAccount(account, { message: text, imageUrl });
    },

    async listComments(postId) {
      const fields = isIg ? 'id,text,username,timestamp,from' : 'id,message,from,created_time';
      const data = await graph(`/${postId}/comments`, token, { params: { fields, limit: '50' } });
      return (data.data || []).map((c) => ({
        id: c.id,
        text: isIg ? c.text : c.message,
        fromId: c.from?.id || null,
        createdAt: isIg ? c.timestamp : c.created_time,
      }));
    },

    async reply(commentId, text) {
      const path = isIg ? `/${commentId}/replies` : `/${commentId}/comments`;
      const data = await graph(path, token, { method: 'POST', form: { message: text } });
      return { id: data.id };
    },

    async metrics(postId) {
      if (isIg) {
        const d = await graph(`/${postId}`, token, { params: { fields: 'like_count,comments_count' } });
        return { likes: d.like_count || 0, comments: d.comments_count || 0, shares: 0 };
      }
      const d = await graph(`/${postId}`, token, {
        params: { fields: 'reactions.summary(true).limit(0),comments.summary(true).limit(0),shares' },
      });
      return {
        likes: d.reactions?.summary?.total_count || 0,
        comments: d.comments?.summary?.total_count || 0,
        shares: d.shares?.count || 0,
      };
    },
  };
}
