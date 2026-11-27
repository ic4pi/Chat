/**
 * Guess limiter for password checks. A wrong password is counted per client address; after MAX wrong guesses in a
 * window the address is refused (429) until the window passes — so a password can't be brute-forced by trying
 * thousands of them. A right password is never counted.
 *
 * Counts live in KV (shared by every serverless instance). With KV off, a per-instance map is used (weaker, better
 * than nothing). A KV error never locks the owner out: the password check itself still decides.
 */
import { kvGet, kvIncr, kvExpire, KV_ENABLED } from './kv.js';

export const MAX_FAILURES = 8;
export const WINDOW_SEC = 900;   // 15 minutes
const memory = new Map();        // key -> { n, until }

export const clientIp = (req) =>
  String(req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim() || 'unknown';

const keyFor = (req, bucket) => `throttle:v1:${bucket}:${clientIp(req)}`;

export async function isBlocked(req, bucket, { max = MAX_FAILURES } = {}) {
  const key = keyFor(req, bucket);
  try {
    if (KV_ENABLED) return (Number(await kvGet(key)) || 0) >= max;
  } catch { return false; }
  const m = memory.get(key);
  return !!m && m.until > Date.now() && m.n >= max;
}

export async function noteFailure(req, bucket, { windowSec = WINDOW_SEC } = {}) {
  const key = keyFor(req, bucket);
  try {
    if (KV_ENABLED) {
      const n = await kvIncr(key);
      if (n === 1) await kvExpire(key, windowSec);
      return;
    }
  } catch { return; }
  const now = Date.now();
  const m = memory.get(key);
  if (!m || m.until <= now) memory.set(key, { n: 1, until: now + windowSec * 1000 });
  else m.n += 1;
}

/** Test helper: forget the in-memory counts. */
export function resetThrottle() { memory.clear(); }

export function sendBlocked(res, windowSec = WINDOW_SEC) {
  res.setHeader('Retry-After', String(windowSec));
  res.setHeader('Cache-Control', 'no-store');
  return res.status(429).json({ error: 'Too many wrong passwords from this address. Try again in about 15 minutes.' });
}
