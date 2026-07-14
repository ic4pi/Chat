// Authenticated admin endpoint for the master prompt + personas.
//   GET  → returns the full config (masterPrompt + personas with systemPrompt)
//   PUT  → replaces the config with the request body
// Storage backend: Vercel KV. If KV isn't connected yet, both methods respond
// with a clear 503 explaining how to connect it.

import { requireAdminAuth } from '../lib/auth.js';
import { loadConfig, saveConfig } from '../lib/config.js';
import { KV_ENABLED } from '../lib/kv.js';

export default async function handler(req, res) {
  if (!requireAdminAuth(req, res)) return;

  res.setHeader('Cache-Control', 'no-store');

  if (!KV_ENABLED) {
    return res.status(503).json({
      error:
        'Storage not connected. In the Vercel dashboard: Storage → Create → KV, ' +
        'attach it to this project (all environments), then redeploy. Vercel will ' +
        'populate KV_REST_API_URL and KV_REST_API_TOKEN automatically.',
    });
  }

  try {
    if (req.method === 'GET') {
      const config = await loadConfig();
      return res.status(200).json({
        masterPrompt: config.masterPrompt,
        personas: config.personas,
      });
    }

    if (req.method === 'PUT' || req.method === 'POST') {
      const body = req.body || {};
      const masterPrompt = typeof body.masterPrompt === 'string' ? body.masterPrompt : '';
      const personas = Array.isArray(body.personas) ? body.personas : [];
      await saveConfig({ masterPrompt, personas });
      const updated = await loadConfig();
      return res.status(200).json({
        ok: true,
        masterPrompt: updated.masterPrompt,
        personas: updated.personas,
      });
    }

    res.setHeader('Allow', 'GET, PUT, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
