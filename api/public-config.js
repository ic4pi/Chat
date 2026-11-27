// Public read-only view of the persona list, safe to expose to any visitor.
// Deliberately does NOT return system prompts or the master prompt — those
// are secrets that get applied server-side in /api/chat and must never
// reach the browser.

import { loadConfig } from '../lib/config.js';
import { requestContext, visiblePersonas } from '../lib/access.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const config = await loadConfig();
    const ctx = await requestContext(req);
    const personas = visiblePersonas(config, ctx).map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description || '',
      builtin: !!p.builtin,
    }));
    // Label + platform only — tokens/secrets never reach the browser.
    const isConfigured = (a) => (a.platform === 'twitter'
      ? a.consumerKey && a.consumerSecret && a.accessToken && a.accessTokenSecret
      : a.platform === 'email'
        ? a.resendApiKey && a.fromEmail
        : a.pageId && a.pageToken);
    // Posting accounts are the owner's: nobody else is shown (or can pick) them.
    const socialAccounts = (ctx.isOwner ? (config.socialAccounts || []) : [])
      .filter(isConfigured)
      .map((a) => ({ id: a.id, label: a.label, platform: a.platform }));
    // Short public cache; personas rarely change. Admin edits will lag by a
    // few seconds on the public config which is fine — the chat endpoint
    // reads live from KV on every request, so replies never use a stale
    // system prompt.
    // The answer depends on who is signed in, so it must never sit in a shared cache.
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Vary', 'Cookie');
    return res.status(200).json({
      personas,
      socialAccounts,
      account: ctx.account ? { email: ctx.account.email, isOwner: ctx.isOwner, plan: ctx.account.plan } : null,
      hasMasterPrompt: !!config.masterPrompt,
      storage: config._source,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
