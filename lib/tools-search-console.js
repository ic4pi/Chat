/**
 * Google Search Console tool (read-only) — real queries, clicks and
 * positions for SEO jobs, instead of audits based on guesswork.
 *
 * This one needs a one-time setup only the owner can do in Google Cloud
 * (create a service account, download its JSON key, add the service-account
 * email as a user on the Search Console property). Until then,
 * gscConnected() is false and jobs report it as a missing tool.
 *
 * Env:
 *   GSC_SERVICE_ACCOUNT_JSON — the full JSON key, pasted as one line
 *   GSC_SITE_URL             — e.g. "sc-domain:example.com" or "https://example.com/"
 */

import { createSign } from 'node:crypto';

export function gscConnected() {
  return !!(process.env.GSC_SERVICE_ACCOUNT_JSON || '').trim() && !!(process.env.GSC_SITE_URL || '').trim();
}

function serviceAccount() {
  try {
    const sa = JSON.parse(process.env.GSC_SERVICE_ACCOUNT_JSON);
    if (!sa.client_email || !sa.private_key) throw new Error('missing fields');
    return sa;
  } catch {
    throw new Error('GSC_SERVICE_ACCOUNT_JSON is not valid service-account JSON.');
  }
}

/** Mint an OAuth access token from the service account (JWT bearer flow, no deps). */
async function accessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/webmasters.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })}`;
  const sig = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${unsigned}.${sig}`,
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error(`Google token exchange failed: HTTP ${res.status}`);
  return data.access_token;
}

/** Top search queries over the last 28 days. */
export async function getSearchSnapshot({ rowLimit = 15 } = {}) {
  const sa = serviceAccount();
  const token = await accessToken(sa);
  const site = (process.env.GSC_SITE_URL || '').trim();
  const end = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);   // GSC lags ~3 days
  const start = new Date(Date.now() - 31 * 86_400_000).toISOString().slice(0, 10);
  const res = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ startDate: start, endDate: end, dimensions: ['query'], rowLimit }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Search Console query failed: HTTP ${res.status} — is the service account added to the property?`);
  return {
    range: `${start} → ${end}`,
    site,
    queries: (data.rows || []).map((r) => ({
      query: r.keys[0],
      clicks: r.clicks,
      impressions: r.impressions,
      position: Math.round(r.position * 10) / 10,
    })),
  };
}
