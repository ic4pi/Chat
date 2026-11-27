// Admin-only: inspect and delete rows from memory_facts — the table that
// used to get auto-injected into every chat reply (see the removed
// memoryContext() call in api/chat.js / api/group-chat.js). There was never
// a way to see or remove a bad fact once it landed in there; this is that.
//
//   GET    /api/admin-memory                → list recent facts (all owners)
//   GET    /api/admin-memory?q=punch        → list facts whose content matches
//   DELETE /api/admin-memory?id=<uuid>      → delete one fact by id
import { requireAdminAuth } from '../lib/auth.js';
import { db, HUB_ENABLED } from '../lib/hub.js';

export default async function handler(req, res) {
  if (!requireAdminAuth(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');

  if (!HUB_ENABLED) {
    return res.status(503).json({ error: 'Hub/memory is not configured (missing SUPABASE_SERVICE_ROLE_KEY).' });
  }

  if (req.method === 'GET') {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    let query = db
      .from('memory_facts')
      .select('id, owner_id, category, content, confidence, created_at')
      .order('created_at', { ascending: false })
      .limit(100);
    if (q) query = query.ilike('content', `%${q}%`);
    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ facts: data || [] });
  }

  if (req.method === 'DELETE') {
    const id = typeof req.query.id === 'string' ? req.query.id.trim() : '';
    if (!id) return res.status(400).json({ error: 'id query param is required' });
    const { error } = await db.from('memory_facts').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true, deleted: id });
  }

  res.setHeader('Allow', 'GET, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}
