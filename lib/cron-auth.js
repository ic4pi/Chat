/**
 * Is this request really Vercel's cron? Vercel sends `Authorization: Bearer <CRON_SECRET>` whenever the project has a
 * CRON_SECRET env var (the documented mechanism, and what /api/hub/sweep already uses). A bare `x-vercel-cron` header is
 * NOT proof: anyone can send one. With no CRON_SECRET configured we refuse rather than trust a header a stranger can forge.
 */
import { timingSafeEqual } from 'node:crypto';

export function isVercelCron(req, secret = process.env.CRON_SECRET) {
  if (!secret) return false;
  const got = String(req.headers?.authorization || '');
  const want = `Bearer ${secret}`;
  const a = Buffer.from(got); const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}
