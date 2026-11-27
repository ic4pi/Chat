// POST /api/social-post — publish a persona's drafted copy to a real
// Facebook Page or Instagram Business account.
//
// Needs the ADMIN password (ADMIN_PASSWORD, or username:password) — NOT the paid-models password, which people may
// be given to use paid models. This publishes publicly and sends email from the owner's account, so only the owner
// can do it. Wrong guesses are counted per address and cut off (lib/throttle.js).

import { loadConfig } from '../lib/config.js';
import { paidPasswordFromRequest, verifyAdminPassword, adminPasswordConfigured } from '../lib/model-meta.js';
import { isBlocked, noteFailure, sendBlocked } from '../lib/throttle.js';
import { publishToAccount } from '../lib/social.js';
import { resolveOwner } from '../lib/hub.js';
import { logTeamAction } from '../lib/team-log.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Paid-Password');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!adminPasswordConfigured()) {
    return res.status(403).json({
      error: 'Publishing is locked. Set ADMIN_PASSWORD in Vercel, then enter it when you publish.',
    });
  }
  if (await isBlocked(req, 'publish')) return sendBlocked(res);
  const submitted = paidPasswordFromRequest(req);
  if (!verifyAdminPassword(submitted)) {
    await noteFailure(req, 'publish');
    return res.status(403).json({ error: 'Publishing needs the admin password (not the paid-models password).' });
  }

  const { accountId, message, imageUrl, to, subject, personaName } = req.body || {};
  if (!accountId || typeof accountId !== 'string') {
    return res.status(400).json({ error: 'accountId is required' });
  }
  if ((!message || !String(message).trim()) && !imageUrl) {
    return res.status(400).json({ error: 'Nothing to post — need a message or an image' });
  }

  try {
    const config = await loadConfig();
    const account = (config.socialAccounts || []).find((a) => a.id === accountId);
    if (!account) return res.status(404).json({ error: 'That account is not configured in /admin.' });
    const configured = account.platform === 'twitter'
      ? account.consumerKey && account.consumerSecret && account.accessToken && account.accessTokenSecret
      : account.platform === 'email'
        ? account.resendApiKey && account.fromEmail
        : account.pageId && account.pageToken;
    if (!configured) {
      return res.status(400).json({ error: `"${account.label}" is missing credentials in /admin.` });
    }
    if (account.platform === 'email' && (!to || !String(to).trim())) {
      return res.status(400).json({ error: 'A recipient address is required to send email.' });
    }

    const result = await publishToAccount(account, {
      message: String(message || ''),
      imageUrl: imageUrl || undefined,
      to: to || undefined,
      subject: subject || undefined,
    });
    try {
      const ownerId = await resolveOwner(req, res);
      if (ownerId) {
        await logTeamAction(ownerId, {
          personaName: typeof personaName === 'string' ? personaName.slice(0, 80) : undefined,
          platform: account.platform,
          verb: account.platform === 'email' ? 'emailed' : 'posted',
          summary: account.platform === 'email'
            ? `to ${to}: ${String(subject || '').slice(0, 100)}`
            : String(message || '').slice(0, 140),
        });
      }
    } catch (err) {
      console.error('team action log failed:', err);
    }

    return res.status(200).json({ ok: true, id: result.id, label: account.label, platform: account.platform });
  } catch (err) {
    return res.status(502).json({ error: err.message || 'Publish failed' });
  }
}
