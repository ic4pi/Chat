/**
 * Meta Graph API posting — Facebook Pages and Instagram Business accounts.
 * Server-side only: a page token never leaves this file's callers.
 */

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

/** Post text (and optionally one image) to a Facebook Page's feed. */
export async function postToFacebookPage({ pageId, pageToken, message, imageUrl }) {
  if (!pageId || !pageToken) throw new Error('Facebook Page is not configured (missing pageId/pageToken)');
  if (!message && !imageUrl) throw new Error('Nothing to post — need a message or an image');

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

/** Dispatch by the account's configured platform. */
export async function publishToAccount(account, { message, imageUrl }) {
  if (account.platform === 'instagram') {
    return postToInstagram({
      igUserId: account.igUserId,
      pageToken: account.pageToken,
      caption: message,
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
