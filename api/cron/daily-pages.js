// Called hourly by Vercel Cron (see vercel.json). Publishes any daily page
// whose time has come and that has not been made yet — so a missed hour is
// caught up on the next one, and a slot is never made twice.
import { checkAdminAuth } from '../../lib/auth.js';
import { runDueSlots } from '../../lib/daily-pages.js';

export default async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] !== undefined;
  const isAdmin = checkAdminAuth(req).ok;
  if (!isVercelCron && !isAdmin) {
    return res.status(403).json({ error: 'This endpoint only runs via Vercel Cron or admin auth.' });
  }
  try {
    return res.status(200).json(await runDueSlots());
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Daily pages run failed' });
  }
}
