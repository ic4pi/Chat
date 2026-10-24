/**
 * Runs one standing task through the existing /api/group-chat engine
 * (server calling its own public endpoint, same as a browser would) and
 * saves the result as a `documents` row so it's there to review later —
 * nobody is watching a cron job run live.
 *
 * Deliberately reuses /api/group-chat over HTTP instead of importing its
 * handler directly: that logic is tested and live already (Orchestrated
 * mode, forcedLeadId, handoffs) — calling it as a normal request means
 * zero risk of this new code accidentally changing how a real user's
 * group chat behaves.
 */

import { db, HUB_ENABLED } from './hub.js';

function baseUrlFromReq(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, '');
  const host = req?.headers?.host || process.env.VERCEL_URL;
  if (!host) throw new Error('Cannot determine site URL to call /api/group-chat (set SITE_URL env var).');
  const protocol = host.startsWith('localhost') ? 'http' : 'https';
  return `${protocol}://${host}`;
}

/** Parse an SSE response body into the event list group-chat emits. */
function parseSSE(text) {
  const events = [];
  for (const block of text.split('\n\n')) {
    const line = block.split('\n').find((l) => l.startsWith('data:'));
    if (!line) continue;
    try { events.push(JSON.parse(line.slice(5).trim())); } catch { /* skip malformed */ }
  }
  return events;
}

export async function runStandingTask(task, req) {
  if (!task.objective?.trim()) throw new Error('Task has no objective to work on.');

  const base = baseUrlFromReq(req);
  const upstream = await fetch(`${base}/api/group-chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Paid-Password': process.env.ADMIN_PASSWORD || process.env.PAID_MODELS_PASSWORD || '',
    },
    body: JSON.stringify({
      topic: task.name,
      mode: 'orchestrated',
      model: 'venice-uncensored',
      provider: 'venice',
      personaIds: task.personaIds?.length ? task.personaIds : undefined,
      forcedLeadId: task.leadPersonaId || undefined,
      messages: [{ role: 'user', content: task.objective }],
    }),
  });

  if (!upstream.ok) {
    throw new Error(`group-chat call failed: HTTP ${upstream.status}`);
  }
  const text = await upstream.text();
  const events = parseSSE(text);

  const turns = events.filter((e) => e.type === 'turn');
  const errorEvents = events.filter((e) => e.type === 'error');
  const doneEvent = events.find((e) => e.type === 'done');

  if (!turns.length) {
    const reason = errorEvents.map((e) => e.error).join('; ') || 'no personas replied';
    throw new Error(`Standing task produced nothing: ${reason}`);
  }

  const sections = turns.map((t) => ({ heading: t.personaName, body: t.content }));
  const title = `${task.name} — ${new Date().toISOString().slice(0, 10)}`;

  let documentId = null;
  if (HUB_ENABLED) {
    try {
      // documents.owner_id is NOT NULL and there's no live request/cookie in
      // a cron context to resolve one from — fall back to the single owner
      // row this personal app actually has, oldest first.
      let ownerId = task.ownerId || null;
      if (!ownerId) {
        const { data: owner } = await db
          .from('owners')
          .select('id')
          .order('created_at', { ascending: true })
          .limit(1)
          .single();
        ownerId = owner?.id || null;
      }
      if (!ownerId) throw new Error('No owner row exists yet to attach this document to.');

      const { data, error } = await db
        .from('documents')
        .insert({
          owner_id: ownerId,
          type: 'business_doc',
          title,
          sections,
          status: 'done',
          built_from_at: new Date().toISOString(),
        })
        .select('id')
        .single();
      if (!error) documentId = data?.id || null;
    } catch (err) {
      console.error('saving standing-task document failed:', err);
    }
  }

  return {
    title,
    turnTexts: turns.map((t) => String(t.content || '')),
    turns: turns.length,
    summary: doneEvent?.summary || '',
    documentId,
    errors: errorEvents.map((e) => e.error),
  };
}
