// The agency's control room, one function:
//
//   Public  (the website form)   POST /api/agency?op=lead            → saves an inquiry
//           (the free site checker)      POST /api/agency?op=check  { site } → a scored report (nothing saved)
//   Admin   (HTTP Basic auth)    GET  /team   (= ?op=page)           → the Team page
//                                GET  ?op=overview                   → leads, business, activity, controls
//                                PUT  ?op=business   { profile, offers }
//                                POST ?op=discuss                    → the team discusses the profile now
//                                POST ?op=draft&id=                  → the closer drafts a reply (sends nothing)
//                                PUT  ?op=lead&id=   { status, value, notes, draft }
//                                POST ?op=send&id=                   → sends the APPROVED draft, once
//                                POST ?op=prospect { site, email, name?, company? } → checks THEIR site, saves an outbound lead
//                                GET  ?op=accounts                   → social/email accounts (no secrets) + autopost status
//                                PUT  ?op=account  { id, autopostEvery, autopostPerDay }
//                                POST ?op=facebook-token&id= { token, asIs? } → reconnect a Facebook/Instagram page (never-expiring token)
//                                POST ?op=email    { fromEmail, resendApiKey, testTo? } → saves the email account (+ optional test)
//                                PUT  ?op=control    { paused, reason }
//
// Nothing here sends to a prospect except op=send, and that is a deliberate tap on the Team page.

import { requireAdminAuth } from '../lib/auth.js';
import { getBusiness, saveProfile, saveNotes, runTeamDiscussion } from '../lib/business-profile.js';
import { agency, limits } from '../lib/agency-control.js';
import { leads, validateLeadInput, withinRate } from '../lib/leads.js';
import { checkSite, reportText } from '../lib/site-check.js';
import { draftLead, sendLead, notifyNewLead, emailAccount, envEmailAccount, teamActivity } from '../lib/lead-ops.js';
import { KV_ENABLED } from '../lib/kv.js';
import { loadConfig, updateSocialAccounts } from '../lib/config.js';
import { getAutopostState } from '../lib/autopost.js';
import { sendEmail } from '../lib/email.js';
import { reconnectPage } from '../lib/meta-token.js';

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

const CHECKS_PER_HOUR = 10;
const CHECKS_PER_DAY = Number(process.env.AGENCY_MAX_SITE_CHECKS_PER_DAY) > 0 ? Math.floor(Number(process.env.AGENCY_MAX_SITE_CHECKS_PER_DAY)) : 500;

/** The free checker: public, so limited per sender and per day. It only reads the page the visitor named. */
async function handleSiteCheck(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST, OPTIONS'); return res.status(405).json({ error: 'POST only' }); }
  try {
    if (!(await withinRate('check', clientIp(req), CHECKS_PER_HOUR))) return res.status(429).json({ error: 'You have run a lot of checks — please try again in an hour.' });
    if (!(await agency.consume('siteChecks', CHECKS_PER_DAY))) return res.status(429).json({ error: 'The checker is very busy today. Please try again tomorrow.' });
    const report = await checkSite((req.body || {}).site);
    return res.status(200).json({ report });
  } catch (err) {
    // Readable failures (bad address, site down) are the visitor's to fix; show them as-is.
    return res.status(400).json({ error: err.message || 'Could not check that site.' });
  }
}

export default async function handler(req, res) {
  const op = String(req.query?.op || '');
  if (op === 'lead') return handleLeadIntake(req, res);
  if (op === 'check') return handleSiteCheck(req, res);

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

    if (op === 'accounts' && req.method === 'GET') {
      const [config, state] = await Promise.all([loadConfig(), getAutopostState().catch(() => ({}))]);
      const accounts = (config.socialAccounts || []).map((a) => ({
        id: a.id, label: a.label, platform: a.platform,
        connected: a.platform === 'email' ? !!(a.resendApiKey && a.fromEmail) : a.platform === 'twitter' ? !!(a.consumerKey && a.accessToken) : !!(a.pageId && a.pageToken),
        fromEmail: a.platform === 'email' ? a.fromEmail : undefined,
        autopostEvery: a.autopostEvery, autopostPerDay: a.autopostPerDay,
        lastPostAt: state[a.id]?.lastAt || null, lastError: state[a.id]?.lastError || null, fails: state[a.id]?.fails || 0,
      }));
      // The Vercel-settings email account counts as connected when no email account is saved on the page.
      const envAcct = envEmailAccount();
      if (envAcct && !accounts.some((a) => a.platform === 'email' && a.connected)) {
        accounts.push({ id: envAcct.id, label: envAcct.label, platform: 'email', connected: true, fromEmail: envAcct.fromEmail, fromEnv: true, autopostEvery: 'off', autopostPerDay: 1, lastPostAt: null, lastError: null, fails: 0 });
      }
      return res.status(200).json({ accounts });
    }
    if (op === 'account' && req.method === 'PUT') {
      const every = ['off', 'hourly', 'daily', 'weekly'].includes(body.autopostEvery) ? body.autopostEvery : null;
      if (!id && !body.id) return res.status(400).json({ error: 'id required' });
      const target = id || String(body.id);
      let found = false;
      await updateSocialAccounts((list) => list.map((a) => {
        if (a.id !== target) return a;
        found = true;
        return { ...a, ...(every ? { autopostEvery: every } : {}), ...(body.autopostPerDay ? { autopostPerDay: Number(body.autopostPerDay) } : {}) };
      }));
      return found ? res.status(200).json({ ok: true }) : res.status(404).json({ error: 'No such account.' });
    }
    if (op === 'facebook-token' && req.method === 'POST') {
      const token = String(body.token || '').trim();
      if (!id) return res.status(400).json({ error: 'id required' });
      if (!token) return res.status(400).json({ error: 'Paste the token first.' });
      const acct = (await loadConfig()).socialAccounts.find((a) => a.id === id);
      if (!acct || (acct.platform !== 'facebook' && acct.platform !== 'instagram')) return res.status(404).json({ error: 'No such Facebook/Instagram account.' });
      let pageToken = token; let pageName = ''; let longLived = false;
      if (body.asIs !== true) {
        const r = await reconnectPage({ token, pageId: acct.pageId, appSecret: process.env.META_APP_SECRET });
        pageToken = r.pageToken; pageName = r.pageName; longLived = r.longLived;
      }
      await updateSocialAccounts((list) => list.map((a) => (a.id === id ? { ...a, pageToken } : a)));
      return res.status(200).json({ ok: true, pageName, longLived });
    }
    if (op === 'email' && req.method === 'POST') {
      const fromEmail = String(body.fromEmail || '').trim();
      const key = String(body.resendApiKey || '').trim();
      if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$|^.+<[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}>$/.test(fromEmail)) return res.status(400).json({ error: 'Enter the from-address, e.g. hello@yourdomain.com.' });
      let saved = null;
      await updateSocialAccounts((list) => {
        const cur = list.find((a) => a.platform === 'email');
        saved = { ...(cur || { id: 'email-main', label: 'Email' }), platform: 'email', fromEmail, resendApiKey: key || cur?.resendApiKey || '' };
        return cur ? list.map((a) => (a.id === cur.id ? saved : a)) : [...list, saved];
      });
      if (!saved.resendApiKey) return res.status(400).json({ error: 'Paste your Resend API key.' });
      let test = null;
      const to = String(body.testTo || '').trim();
      if (to) {
        try { await sendEmail({ apiKey: saved.resendApiKey, from: fromEmail, to, subject: 'Test from your agency', text: 'This is a test. Your email account works — approved replies will send from this address.' }); test = { ok: true }; }
        catch (err) { test = { ok: false, error: err.message || String(err) }; }
      }
      return res.status(200).json({ ok: true, test });
    }
    if (op === 'prospect' && req.method === 'POST') {
      const v = validateLeadInput({ email: body.email, name: body.name, company: body.company, message: 'placeholder' });
      if (!v.ok) return res.status(400).json({ error: v.error });
      const report = await checkSite(body.site);
      const lead = await leads.add({ ...v.lead, message: reportText(report).slice(0, 3900), source: 'outbound', kind: 'outbound' });
      if (!lead.ok) return res.status(lead.status || 400).json({ error: lead.error });
      return res.status(200).json({ lead: lead.lead, report });
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
