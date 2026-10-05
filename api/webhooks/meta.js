// Meta (Facebook / Instagram) webhook endpoint.
//
// GET  — verification handshake. Meta sends hub.mode / hub.verify_token /
//        hub.challenge; we echo the challenge only when the token matches
//        META_WEBHOOK_VERIFY_TOKEN.
// POST — incoming events, authenticated by X-Hub-Signature-256 (HMAC-SHA256
//        of the raw body with META_APP_SECRET, timing-safe compared).
//        Anything with a bad signature is dropped BEFORE any model or
//        Graph API call can happen.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { handleCommentEvent } from '../../lib/comment-replier.js';

function verifySignature(rawBody, header) {
  const secret = (process.env.META_APP_SECRET || '').trim();
  if (!secret || typeof header !== 'string' || !header.startsWith('sha256=')) {
    return false;
  }
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const got = header.slice('sha256='.length);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(got, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

// Vercel parses JSON bodies before the handler runs; reconstruct the raw
// payload for the HMAC in whatever form we received it.
function rawBodyOf(req) {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  if (typeof req.body === 'string') return Buffer.from(req.body, 'utf8');
  if (req.body && typeof req.body === 'object') {
    return Buffer.from(JSON.stringify(req.body), 'utf8');
  }
  return Buffer.alloc(0);
}

function collectJobs(body) {
  const jobs = [];
  for (const entry of body.entry || []) {
    const pageId = entry.id;
    for (const change of entry.changes || []) {
      const v = change.value || {};
      if (change.field === 'feed' && v.item === 'comment' && v.verb === 'add') {
        jobs.push(
          handleCommentEvent({
            platform: 'facebook',
            pageId,
            commentId: v.comment_id,
            commenter: v.from?.name || 'someone',
            commenterId: v.from?.id,
            text: v.message || '',
          }),
        );
      }
      if (change.field === 'comments' && v.id) {
        jobs.push(
          handleCommentEvent({
            platform: 'instagram',
            pageId,
            commentId: v.id,
            commenter: v.from?.username || v.from?.name || 'someone',
            commenterId: v.from?.id,
            text: v.text || '',
          }),
        );
      }
    }
  }
  return jobs;
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } =
      req.query || {};
    if (
      mode === 'subscribe' &&
      token &&
      token === (process.env.META_WEBHOOK_VERIFY_TOKEN || '').trim()
    ) {
      return res.status(200).send(challenge);
    }
    return res.status(403).json({ error: 'verify token mismatch' });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!verifySignature(rawBodyOf(req), req.headers['x-hub-signature-256'])) {
    return res.status(401).json({ error: 'bad signature' });
  }

  // Ack fast — Meta retries non-200s for up to a day. The replier dedupes
  // redeliveries in KV, so a quick 200 here loses nothing.
  res.status(200).json({ ok: true });

  if ((process.env.COMMENT_REPLIER_ENABLED || '').trim() !== '1') return;

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body || '{}');
    } catch {
      return;
    }
  }

  const results = await Promise.allSettled(collectJobs(body || {}));
  for (const r of results) {
    if (r.status === 'rejected') console.error('comment-replier:', r.reason?.message || r.reason);
  }
}
