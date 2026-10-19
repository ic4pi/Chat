// POST /api/tools { input: "/crm list" }  → { text }
// GET  /api/tools                         → { tools: [...] } (drives /help + autocomplete)
// Commands that act for real (send email, publish, auto-send) need the same
// unlock password as paid models / social posting.

import { TOOLS, listTools, parseCommand, runTool, needsAuth } from '../lib/tools/index.js';
import { paidPasswordFromRequest, verifyPaidPassword, paidUnlockConfigured } from '../lib/model-meta.js';
import { resolveOwner } from '../lib/hub.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Paid-Password');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method === 'GET') {
    res.setHeader('Cache-Control', 'public, s-maxage=60');
    return res.status(200).json({ tools: listTools() });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const cmd = parseCommand(body.input);
  if (!cmd) return res.status(400).json({ error: 'Start with /command — try /help.' });
  const tool = TOOLS.get(cmd.name);
  if (!tool) return res.status(404).json({ error: `Unknown command /${cmd.name}. Try /help.` });

  const authed = paidUnlockConfigured() && verifyPaidPassword(paidPasswordFromRequest(req));
  if (needsAuth(tool, cmd.args) && !authed) {
    return res.status(403).json({
      needsPassword: true,
      error: paidUnlockConfigured()
        ? `/${cmd.name} acts for real — enter the unlock password.`
        : 'This acts for real. Set PAID_MODELS_PASSWORD (or ADMIN_PASSWORD) in Vercel first.',
    });
  }

  try {
    const ownerId = await resolveOwner(req, res).catch(() => null);
    const out = await runTool({ ...cmd, req, authed, ownerId });
    return res.status(200).json(out);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message || 'Tool failed' });
  }
}
