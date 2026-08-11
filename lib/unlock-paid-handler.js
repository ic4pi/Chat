/**
 * Shared paid-unlock HTTP logic used by /api/models?op=unlock-paid
 * (rewritten from /api/unlock-paid so Hobby stays ≤12 serverless functions).
 */

import {
  paidUnlockConfigured,
  verifyPaidPassword,
} from './model-meta.js';

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

/** Handle GET/POST unlock. Returns true when the response was sent. */
export async function handleUnlockPaid(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Paid-Password, X-Provider-Key');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }

  if (req.method === 'GET') {
    res.status(200).json({
      configured: paidUnlockConfigured(),
      hint: paidUnlockConfigured()
        ? 'Use your PAID_MODELS_PASSWORD or ADMIN_PASSWORD.'
        : 'Set PAID_MODELS_PASSWORD or ADMIN_PASSWORD in Vercel, then redeploy.',
    });
    return true;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return true;
  }

  if (!paidUnlockConfigured()) {
    res.status(503).json({
      error:
        'Paid unlock is not configured. Set PAID_MODELS_PASSWORD or ADMIN_PASSWORD in Vercel, then redeploy.',
    });
    return true;
  }

  const password = passwordFromRequest(req);
  if (!password) {
    res.status(400).json({
      error: 'No password received. Type the password and try again.',
    });
    return true;
  }

  if (!verifyPaidPassword(password)) {
    res.status(401).json({
      error:
        'Wrong password. Use the same value as ADMIN_PASSWORD (or PAID_MODELS_PASSWORD if you set one).',
    });
    return true;
  }

  res.status(200).json({ ok: true });
  return true;
}

export function isUnlockPaidRequest(req) {
  const op = String(req.query?.op || '').trim();
  if (op === 'unlock-paid' || op === 'unlock') return true;
  const url = String(req.url || '');
  return /(?:\?|&)op=unlock(?:-paid)?(?:&|$)/.test(url);
}
