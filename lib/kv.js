// Minimal REST client for Vercel KV / Upstash Redis.
// Vercel KV auto-populates KV_REST_API_URL + KV_REST_API_TOKEN when you
// connect a KV store to your project (Storage tab). Upstash direct users get
// UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN. We accept either.
// No @vercel/kv dependency required — this is a thin wrapper around fetch.

const URL_ENV = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const TOKEN_ENV = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';

export const KV_ENABLED = !!(URL_ENV && TOKEN_ENV);

// GET returns the stored value (usually a string) or null when the key does
// not exist. Callers that stored JSON should parse it themselves.
export async function kvGet(key) {
  if (!KV_ENABLED) return null;
  const res = await fetch(`${URL_ENV}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${TOKEN_ENV}` },
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

// SET stores a value. Non-string values are JSON-encoded automatically.
export async function kvSet(key, value) {
  if (!KV_ENABLED) throw new Error('KV is not configured');
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  const res = await fetch(`${URL_ENV}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN_ENV}`,
      'Content-Type': 'text/plain',
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`KV SET failed (${res.status}): ${text.slice(0, 200)}`);
  }
}
