/**
 * GET  /api/unlock-paid  → { configured: boolean }
 * POST /api/unlock-paid  → { ok: true } when password matches
 *
 * Password: PAID_MODELS_PASSWORD, or ADMIN_PASSWORD if that is unset.
 */

import {
  paidUnlockConfigured,
  verifyPaidPassword,
} from '../lib/model-meta.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Paid-Password');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method === 'GET') {
    return res.status(200).json({
      configured: paidUnlockConfigured(),
      hint: paidUnlockConfigured()
        ? 'Enter the paid-models password to unlock paid LLMs.'
        : 'Set PAID_MODELS_PASSWORD (or ADMIN_PASSWORD) in Vercel to enable paid unlock.',
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!paidUnlockConfigured()) {
    return res.status(503).json({
      error:
        'Paid unlock is not configured. Set PAID_MODELS_PASSWORD or ADMIN_PASSWORD in Vercel, then redeploy.',
    });
  }

  const body = req.body || {};
  const password =
    (typeof body.password === 'string' && body.password) ||
    (typeof req.headers['x-paid-password'] === 'string' && req.headers['x-paid-password']) ||
    '';

  if (!verifyPaidPassword(password)) {
    return res.status(401).json({ error: 'Wrong password.' });
  }

  return res.status(200).json({ ok: true });
}
