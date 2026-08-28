/**
 * GET /api/keepalive
 * Extends the sandbox's lifetime — nothing else. Pinged periodically by the
 * client (App.tsx) for as long as the Workspace tab is open, even
 * backgrounded, so stepping away doesn't cost the sandbox VM purely from
 * inactivity. requireSession() already calls sandbox.extendTimeout() as a
 * side effect of any request; this endpoint exists so the client has
 * something to call when there's otherwise nothing else to do.
 */

import { requireSession } from '../sandbox-session.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    await requireSession(req);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
