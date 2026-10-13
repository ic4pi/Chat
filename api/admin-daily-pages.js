// Admin-only: the daily-pages job.
//
//   GET                      → settings (the token is never sent back) + status + recent pages
//   PUT                      → save settings (a blank token keeps the saved one)
//   POST ?action=run         → make one page and publish it now
//   POST ?action=run&dry=1   → make one page and return it for preview, publish nothing
import { requireAdminAuth } from '../lib/auth.js';
import { KV_ENABLED } from '../lib/kv.js';
import { PROVIDERS } from '../lib/providers.js';
import {
  loadConfig, saveConfig, loadState, publicConfig, configProblem, nextSlot, runManual,
} from '../lib/daily-pages.js';

function status(config, state) {
  return {
    problem: configProblem(config),
    next: config.enabled ? nextSlot(config, state) : null,
    lastRun: state.lastRun,
    history: state.history.slice(0, 20),
    hasProviderKey: !!process.env[PROVIDERS[config.provider]?.apiKeyEnv || ''],
    providerKeyName: PROVIDERS[config.provider]?.apiKeyEnv || '',
  };
}

export default async function handler(req, res) {
  if (!requireAdminAuth(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  if (!KV_ENABLED) {
    return res.status(503).json({ error: 'Storage (Vercel KV) is not connected, so settings cannot be saved. Connect it in Vercel → Storage, then redeploy.' });
  }
  try {
    if (req.method === 'GET') {
      const [config, state] = await Promise.all([loadConfig(), loadState()]);
      return res.status(200).json({ config: publicConfig(config), status: status(config, state) });
    }
    if (req.method === 'PUT') {
      const config = await saveConfig(req.body || {});
      const state = await loadState();
      return res.status(200).json({ ok: true, config: publicConfig(config), status: status(config, state) });
    }
    if (req.method === 'POST' && req.query?.action === 'run') {
      const dry = req.query.dry === '1' || req.query.dry === 'true';
      try {
        const result = await runManual({ dryRun: dry });
        return res.status(200).json({ ok: true, result });
      } catch (err) {
        return res.status(502).json({ error: err.message || 'Run failed' });
      }
    }
    res.setHeader('Allow', 'GET, PUT, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
