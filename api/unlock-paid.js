/**
 * GET  /api/unlock-paid  → { configured: boolean }
 * POST /api/unlock-paid  → { ok: true } when password matches
 *
 * Accepts PAID_MODELS_PASSWORD or ADMIN_PASSWORD (either works).
 */

import {
  paidUnlockConfigured,
  verifyPaidPassword,
} from '../lib/model-meta.js';

function readBody(req) {
  const raw = req.body;
  if (raw == null || raw === '') return {};
  if (typeof raw === 'object' && !Buffer.isBuffer(raw)) return raw;
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  try {
    return JSON.parse(text || '{}');
  } catch {
    return {};
  }
}

function passwordFromRequest(req) {
  const body = readBody(req);
  const candidates = [
    body.password,
    body.paidPassword,
    body.pass,
    req.headers['x-paid-password'],
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return '';
}

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
        ? 'Use your PAID_MODELS_PASSWORD or ADMIN_PASSWORD.'
        : 'Set PAID_MODELS_PASSWORD or ADMIN_PASSWORD in Vercel, then redeploy.',
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

  const password = passwordFromRequest(req);
  if (!password) {
    return res.status(400).json({
      error: 'No password received. Type the password and try again.',
    });
  }

  if (!verifyPaidPassword(password)) {
    return res.status(401).json({
      error:
        'Wrong password. Use the same value as ADMIN_PASSWORD (or PAID_MODELS_PASSWORD if you set one).',
    });
  }

  return res.status(200).json({ ok: true });
}
