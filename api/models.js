/**
 * GET /api/models?provider=venice|openrouter|cerebras|groq|nvidia
 * Optional header: X-Provider-Key (BYOK for listing)
 *
 * Each provider returns THAT provider’s full catalog from its own API
 * (lib/model-catalog.js). NVIDIA uses NVCF account functions when a key is
 * present (not a guessed list).
 *
 * GET /api/models?op=defaults — the current default chat + coder model per
 * provider, picked from the live catalogs (lib/model-health.js).
 * GET /api/models?op=refresh  — re-check every catalog now (the cron).
 */

import { PROVIDERS } from '../lib/providers.js';
import { getCatalog } from '../lib/model-catalog.js';
import { currentDefaults, refreshAllCatalogs } from '../lib/model-health.js';
import { handleUnlockPaid, isUnlockPaidRequest } from '../lib/unlock-paid-handler.js';

export default async function handler(req, res) {
  // /api/unlock-paid is rewritten here so Hobby stays under the 12-function cap.
  if (isUnlockPaidRequest(req)) {
    return handleUnlockPaid(req, res);
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Provider-Key, X-Paid-Password');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const op = (req.query?.op || '').toString();
  if (op === 'refresh') {
    // Vercel cron sends the secret; anyone else needs it too when it's set.
    const secret = process.env.CRON_SECRET;
    if (secret && req.headers.authorization !== `Bearer ${secret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return res.status(200).json(await refreshAllCatalogs());
  }
  if (op === 'defaults') {
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
    return res.status(200).json({ defaults: await currentDefaults() });
  }

  const providerId = (req.query?.provider || 'venice').toString();
  if (!PROVIDERS[providerId]) {
    return res.status(400).json({
      error: `Unknown provider: ${providerId}`,
      providers: Object.keys(PROVIDERS),
    });
  }

  const catalog = await getCatalog(providerId, req.headers['x-provider-key']);
  if (catalog.keySource === 'client' || String(catalog.source || '').startsWith('nvcf')) {
    res.setHeader('Cache-Control', 'no-store');
  } else if (catalog.source !== 'fallback') {
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  }
  return res.status(200).json(catalog);
}
