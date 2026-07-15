// Minimal REST client for Vercel KV / Upstash Redis.
//
// Vercel auto-populates env vars when you attach a KV store. The exact names
// depend on what was in the "Custom Prefix" field during setup:
//
//   Prefix left blank  → KV_REST_API_URL  + KV_REST_API_TOKEN         (standard)
//   Prefix = STORAGE   → STORAGE_URL      + STORAGE_TOKEN             (Upstash style)
//   Upstash direct     → UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
//
// We try all known patterns so the app works regardless of what was chosen.

function resolveCredentials() {
  const candidates = [
    // Standard Vercel KV (blank prefix)
    { url: process.env.KV_REST_API_URL,           token: process.env.KV_REST_API_TOKEN },
    // Custom prefix = STORAGE (what shows as default in Vercel's UI)
    { url: process.env.STORAGE_REST_API_URL,      token: process.env.STORAGE_REST_API_TOKEN },
    { url: process.env.STORAGE_URL,               token: process.env.STORAGE_TOKEN },
    // Upstash direct
    { url: process.env.UPSTASH_REDIS_REST_URL,    token: process.env.UPSTASH_REDIS_REST_TOKEN },
  ];
  return candidates.find((c) => c.url && c.token) || { url: '', token: '' };
}

const { url: KV_URL, token: KV_TOKEN } = resolveCredentials();
export const KV_ENABLED = !!(KV_URL && KV_TOKEN);

export async function kvGet(key) {
  if (!KV_ENABLED) return null;
  const res = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
    cache: 'no-store',
  });
  if (!res.ok) {
    if (res.status === 404) return null;
    const body = await res.text().catch(() => '');
    throw new Error(`KV GET failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return data && Object.prototype.hasOwnProperty.call(data, 'result') ? data.result : null;
}

export async function kvSet(key, value) {
  if (!KV_ENABLED) throw new Error('KV is not configured');
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  const res = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KV_TOKEN}`,
      'Content-Type': 'text/plain',
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`KV SET failed (${res.status}): ${text.slice(0, 200)}`);
  }
}
