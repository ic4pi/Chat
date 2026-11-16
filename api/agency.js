// The agency's control room, one function:
//
//   Public  (the website form)   POST /api/agency?op=lead            → saves an inquiry
//   Admin   (HTTP Basic auth)    GET  /team   (= ?op=page)           → the Team page
//                                GET  ?op=overview                   → leads, business, activity, controls
//                                PUT  ?op=business   { profile, offers }
//                                POST ?op=discuss                    → the team discusses the profile now
//                                POST ?op=draft&id=                  → the closer drafts a reply (sends nothing)
//                                PUT  ?op=lead&id=   { status, value, notes, draft }
//                                POST ?op=send&id=                   → sends the APPROVED draft, once
//                                PUT  ?op=control    { paused, reason }
//
// Nothing here sends to a prospect except op=send, and that is a deliberate tap on the Team page.

import { requireAdminAuth } from '../lib/auth.js';
import { getBusiness, saveProfile, saveNotes, runTeamDiscussion } from '../lib/business-profile.js';
import { agency, limits } from '../lib/agency-control.js';
import { leads, validateLeadInput } from '../lib/leads.js';
import { draftLead, sendLead, notifyNewLead, emailAccount, teamActivity } from '../lib/lead-ops.js';
import { KV_ENABLED } from '../lib/kv.js';

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
<title>Team — Jive</title>
<meta name="theme-color" content="#000000" />
<link rel="icon" href="/favicon.ico" sizes="any" />
<link rel="stylesheet" href="/styles.css" />
<link rel="stylesheet" href="/admin.css" />
<link rel="stylesheet" href="/team.css" />
</head>
<body class="admin-body team-body">
<header class="admin-topbar">
  <h1>Team</h1>
  <div class="admin-topbar-actions">
    <a class="text-btn" href="/">Chat →</a>
    <a class="text-btn" href="/admin">Admin →</a>
  </div>
</header>
<main class="admin-main" id="teamRoot"><p class="admin-hint">Loading…</p></main>
<script type="module" src="/team.js"></script>
</body>
</html>`;

const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();

function cors(res) {
  // Only the public intake is cross-origin (the marketing site posts here); everything else is same-origin + Basic auth.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

async function handleLeadIntake(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST, OPTIONS'); return res.status(405).json({ error: 'POST only' }); }
  const v = validateLeadInput(req.body);
  if (!v.ok) {
    if (v.silent) return res.status(200).json({ ok: true });   // a bot gets the same answer as a person
    return res.status(400).json({ error: v.error });
  }
  try {
    const out = await leads.add(v.lead, clientIp(req));
    if (!out.ok) return res.status(out.status || 400).json({ error: out.error });
    if (!out.duplicate) await notifyNewLead(out.lead);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('lead intake failed:', err);
    return res.status(500).json({ error: 'Could not save that right now. Please email us instead.' });
  }
}

export default async function handler(req, res) {
  const op = String(req.query?.op || '');
  if (op === 'lead') return handleLeadIntake(req, res);

  if (!requireAdminAuth(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  const id = typeof req.query?.id === 'string' ? req.query.id : '';
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  try {
    if (op === 'page' || op === '') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(PAGE);
    }

    if (op === 'overview' && req.method === 'GET') {
      const [business, list, summary, control, usage, activity, account] = await Promise.all([
        getBusiness(), leads.list(), leads.summary(), agency.getControl(), agency.usage(), teamActivity(), emailAccount().catch(() => null),
      ]);
      return res.status(200).json({
        kv: KV_ENABLED,
        business, leads: list, summary, control, usage, limits: limits(), activity,
        emailReady: !!account,
        notifyReady: !!(process.env.LEAD_NOTIFY_EMAIL || '').trim(),
      });
    }

    if (op === 'business' && req.method === 'PUT') {
      if (body.notes !== undefined) await saveNotes(body.notes);
      return res.status(200).json(await saveProfile(body.profile, body.offers));
    }
    if (op === 'discuss' && req.method === 'POST') {
      return res.status(200).json(await runTeamDiscussion(req));
    }
    if (op === 'control' && req.method === 'PUT') {
      await agency.setPaused(body.paused === true, body.reason);
      return res.status(200).json(await agency.getControl());
    }

    if (op === 'draft' && req.method === 'POST') {
      if (!id) return res.status(400).json({ error: 'id required' });
      return res.status(200).json({ lead: await draftLead(id) });
    }
    if (op === 'lead' && req.method === 'PUT') {
      const next = await leads.update(id, body);
      return next ? res.status(200).json({ lead: next }) : res.status(404).json({ error: 'No such lead.' });
    }
    if (op === 'send' && req.method === 'POST') {
      if (!id) return res.status(400).json({ error: 'id required' });
      return res.status(200).json({ lead: await sendLead(id) });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Request failed' });
  }

  res.setHeader('Allow', 'GET, PUT, POST');
  return res.status(405).json({ error: 'Unknown or unsupported operation.' });
}
