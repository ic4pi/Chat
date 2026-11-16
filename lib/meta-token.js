/**
 * Reconnect a Facebook Page without hunting through Meta's tools: paste ANY fresh token (a short-lived one from the
 * Graph API Explorer is fine) and this turns it into the Page's own token that does not expire:
 *
 *   1. ask Meta which app issued the token                  GET /app
 *   2. swap it for a long-lived user token                   GET /oauth/access_token?grant_type=fb_exchange_token
 *   3. read the Pages that user manages; take OUR Page's own token   GET /me/accounts
 *      (a Page token derived from a long-lived user token has no expiry)
 *
 * `fetchImpl` is injectable so this is tested without Facebook. Every failure is Meta's own words, shown to the owner.
 */

const GRAPH = 'https://graph.facebook.com/v21.0';

async function graph(fetchImpl, path, params) {
  const url = `${GRAPH}${path}?${new URLSearchParams(params)}`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(body.error?.message || `Facebook error (HTTP ${res.status})`);
  return body;
}

/**
 * @returns {{ pageToken: string, pageName: string, pageId: string, longLived: boolean }}
 * Throws with Facebook's message if any step fails.
 */
export async function reconnectPage({ token, pageId, appSecret, fetchImpl = fetch }) {
  const user = String(token || '').trim();
  if (!user) throw new Error('Paste the token first.');
  if (!appSecret) throw new Error('META_APP_SECRET is not set in Vercel, so the token cannot be extended automatically.');

  const app = await graph(fetchImpl, '/app', { access_token: user });
  if (!app.id) throw new Error('Facebook did not say which app this token belongs to.');

  const long = await graph(fetchImpl, '/oauth/access_token', {
    grant_type: 'fb_exchange_token', client_id: app.id, client_secret: appSecret, fb_exchange_token: user,
  });
  if (!long.access_token) throw new Error('Facebook would not extend the token.');

  const pages = await graph(fetchImpl, '/me/accounts', { fields: 'id,name,access_token', limit: '100', access_token: long.access_token });
  const list = Array.isArray(pages.data) ? pages.data : [];
  const mine = (pageId && list.find((p) => String(p.id) === String(pageId))) || (!pageId && list.length === 1 ? list[0] : null);
  if (!mine?.access_token) {
    throw new Error(list.length
      ? `This login manages ${list.map((p) => p.name).join(', ')} but not the connected page${pageId ? ` (${pageId})` : ''}. Log in as someone who manages it.`
      : 'This login does not manage any Facebook Pages. Make sure you grant pages_show_list and pages_manage_posts, and choose the page.');
  }
  return { pageToken: mine.access_token, pageName: mine.name || '', pageId: String(mine.id), longLived: true };
}
