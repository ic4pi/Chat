/**
 * Meta Graph API posting (Facebook Pages, Instagram Business) and X/Twitter
 * posting (OAuth 1.0a). Server-side only: tokens never leave this file's
 * callers.
 */

import { createHmac, randomBytes } from 'node:crypto';
import { sendEmail } from './email.js';

const GRAPH_VERSION = 'v21.0';
const GRAPH_URL = `https://graph.facebook.com/${GRAPH_VERSION}`;

async function graphFetch(path, { method = 'GET', params = {} } = {}) {
  const url = new URL(`${GRAPH_URL}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, v);
  }
  const res = await fetch(url, { method });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const msg = data.error?.message || `Graph API error (HTTP ${res.status})`;
    throw new Error(msg);
  }
  return data;
}

/**
 * A system-user or user token can't post to a Page directly (Graph error #200);
 * the Page's own token can. Ask Graph for it, and keep the given token when the
 * lookup yields none (it already is a Page token).
 */
async function resolvePageToken(pageId, token) {
  try {
    const data = await graphFetch(`/${pageId}`, { params: { fields: 'access_token', access_token: token } });
    return { token: data.access_token || token, lookupError: null };
  } catch (e) {
    return { token, lookupError: e instanceof Error ? e.message : String(e) };
  }
}

/** Post text (and optionally one image) to a Facebook Page's feed. */
export async function postToFacebookPage({ pageId, pageToken: givenToken, message, imageUrl }) {
  if (!pageId || !givenToken) throw new Error('Facebook Page is not configured (missing pageId/pageToken)');
  const { token: pageToken, lookupError } = await resolvePageToken(pageId, givenToken);
  if (!message && !imageUrl) throw new Error('Nothing to post — need a message or an image');
  try {
    return await publishToPage({ pageId, pageToken, message, imageUrl });
  } catch (e) {
    // The fallback to the given token hides why the Page-token lookup failed; say it.
    const why = e instanceof Error ? e.message : String(e);
    throw new Error(lookupError ? `${why} (could not get the Page's own token for ${pageId}: ${lookupError})` : why);
  }
}

async function publishToPage({ pageId, pageToken, message, imageUrl }) {
  if (imageUrl) {
    const data = await graphFetch(`/${pageId}/photos`, {
      method: 'POST',
      params: { url: imageUrl, caption: message || '', access_token: pageToken },
    });
    return { id: data.post_id || data.id, permalink: null };
  }

  const data = await graphFetch(`/${pageId}/feed`, {
    method: 'POST',
    params: { message, access_token: pageToken },
  });
  return { id: data.id, permalink: null };
}

/**
 * Instagram publishing is two calls: create a media container, then publish
 * it. It always needs an image — Instagram has no text-only post.
 */
export async function postToInstagram({ igUserId, pageToken, caption, imageUrl }) {
  if (!igUserId || !pageToken) throw new Error('Instagram account is not configured (missing igUserId/pageToken)');
  if (!imageUrl) throw new Error('Instagram requires an image — text-only posts are not supported by the platform');

  const container = await graphFetch(`/${igUserId}/media`, {
    method: 'POST',
    params: { image_url: imageUrl, caption: caption || '', access_token: pageToken },
  });
  const published = await graphFetch(`/${igUserId}/media_publish`, {
    method: 'POST',
    params: { creation_id: container.id, access_token: pageToken },
  });
  return { id: published.id, permalink: null };
}

// --- X (Twitter) — OAuth 1.0a request signing -----------------------------

function percentEncode(str) {
  return encodeURIComponent(str).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function buildOAuth1Header({ method, url, consumerKey, consumerSecret, accessToken, accessTokenSecret }) {
  const oauthParams = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: accessToken,
    oauth_version: '1.0',
  };

  // JSON POST body is never part of the OAuth 1.0a signature base string —
  // only the oauth_* params themselves (there are no query params here).
  const paramString = Object.keys(oauthParams)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(oauthParams[k])}`)
    .join('&');

  const baseString = [method.toUpperCase(), percentEncode(url), percentEncode(paramString)].join('&');
  const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(accessTokenSecret)}`;
  const signature = createHmac('sha1', signingKey).update(baseString).digest('base64');

  const headerParams = { ...oauthParams, oauth_signature: signature };
  return 'OAuth ' + Object.keys(headerParams)
    .sort()
    .map((k) => `${percentEncode(k)}="${percentEncode(headerParams[k])}"`)
    .join(', ');
}

/** Post a text tweet. X has no image support here yet — text only. */
export async function postToTwitter({ consumerKey, consumerSecret, accessToken, accessTokenSecret, message, imageUrl }) {
  if (!consumerKey || !consumerSecret || !accessToken || !accessTokenSecret) {
    throw new Error('X account is not configured (missing consumer key/secret or access token/secret)');
  }
  if (imageUrl) {
    throw new Error('Image posting to X is not supported yet — text only');
  }
  if (!message || !message.trim()) {
    throw new Error('Nothing to post — X posts need text');
  }

  const url = 'https://api.twitter.com/2/tweets';
  const authHeader = buildOAuth1Header({
    method: 'POST',
    url,
    consumerKey,
    consumerSecret,
    accessToken,
    accessTokenSecret,
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: message }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.detail || data?.title || data?.errors?.[0]?.message || `X API error (HTTP ${res.status})`;
    throw new Error(msg);
  }
  return { id: data.data?.id, permalink: null };
}

/** Dispatch by the account's configured platform. */
export async function publishToAccount(account, { message, imageUrl, to, subject }) {
  if (account.platform === 'email') {
    return sendEmail({
      apiKey: account.resendApiKey,
      from: account.fromEmail,
      to,
      subject,
      text: message,
    });
  }
  if (account.platform === 'instagram') {
    return postToInstagram({
      igUserId: account.igUserId,
      pageToken: account.pageToken,
      caption: message,
      imageUrl,
    });
  }
  if (account.platform === 'twitter') {
    return postToTwitter({
      consumerKey: account.consumerKey,
      consumerSecret: account.consumerSecret,
      accessToken: account.accessToken,
      accessTokenSecret: account.accessTokenSecret,
      message,
      imageUrl,
    });
  }
  return postToFacebookPage({
    pageId: account.pageId,
    pageToken: account.pageToken,
    message,
    imageUrl,
  });
}
