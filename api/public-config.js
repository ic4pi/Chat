// Public read-only view of the persona list, safe to expose to any visitor.
// Deliberately does NOT return system prompts or the master prompt — those
// are secrets that get applied server-side in /api/chat and must never
// reach the browser.

import { loadConfig } from '../lib/config.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const config = await loadConfig();
    const personas = config.personas.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description || '',
      builtin: !!p.builtin,
    }));
    // Short public cache; personas rarely change. Admin edits will lag by a
    // few seconds on the public config which is fine — the chat endpoint
    // reads live from KV on every request, so replies never use a stale
    // system prompt.
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    return res.status(200).json({
      personas,
      hasMasterPrompt: !!config.masterPrompt,
      storage: config._source,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
