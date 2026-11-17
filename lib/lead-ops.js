/**
 * The real-world wiring for leads (lib/leads.js stays pure): which model drafts, which email
 * account sends, who gets told, and the cron step that drafts replies for new leads.
 */

import { loadConfig } from './config.js';
import { resolveProvider, withProviderChatExtras, DEFAULT_MODELS, formatProviderError } from './providers.js';
import { sendEmail } from './email.js';
import { getBusiness, businessBlock } from './business-profile.js';
import { db, HUB_ENABLED } from './hub.js';
import { logTeamAction, recentTeamActions } from './team-log.js';
import { agency } from './agency-control.js';
import { leads, draftReply, sendApproved } from './leads.js';

export const CLOSER_ID = 'agency-closer';
const DRAFTS_PER_DAY = Number(process.env.AGENCY_MAX_LEAD_DRAFTS_PER_DAY) > 0 ? Math.floor(Number(process.env.AGENCY_MAX_LEAD_DRAFTS_PER_DAY)) : 20;

/**
 * An email account built from Vercel settings (RESEND_API_KEY + RESEND_FROM_EMAIL), so no form has to be filled in.
 * null when RESEND_API_KEY is not set.
 */
export function envEmailAccount(env = process.env) {
  const key = String(env.RESEND_API_KEY || '').trim();
  if (!key) return null;
  return { id: 'env-email', label: 'Email (Vercel settings)', platform: 'email', resendApiKey: key, fromEmail: String(env.RESEND_FROM_EMAIL || '').trim() || 'hello@thesemantiq.com' };
}

/** The email account replies go out from: one saved on /team or Admin (LEADS_EMAIL_ACCOUNT picks one), else the Vercel-settings one. */
export async function emailAccount(config) {
  const cfg = config || await loadConfig();
  const ok = (a) => a.platform === 'email' && a.resendApiKey && a.fromEmail;
  const wanted = (process.env.LEADS_EMAIL_ACCOUNT || '').trim();
  return (cfg.socialAccounts || []).find((a) => ok(a) && (!wanted || a.id === wanted)) || envEmailAccount();
}

export async function ownerId() {
  if (!HUB_ENABLED) return null;
  const { data } = await db.from('owners').select('id').order('created_at', { ascending: true }).limit(1).single();
  return data?.id || null;
}

async function note(entry) {
  try { const oid = await ownerId(); if (oid) await logTeamAction(oid, { personaName: 'Marcus', ...entry }); } catch { /* the log never breaks a run */ }
}

async function complete(system, user) {
  const providerId = process.env.LEADS_PROVIDER || process.env.AUTOPOST_PROVIDER || 'venice';
  const model = process.env.LEADS_MODEL || process.env.AUTOPOST_MODEL || DEFAULT_MODELS[providerId];
  const resolved = resolveProvider(providerId, '');
  const res = await fetch(resolved.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resolved.apiKey}`, ...resolved.extraHeaders() },
    body: JSON.stringify(withProviderChatExtras({
      model, stream: false, temperature: 0.6, max_tokens: 600,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }, providerId)),
    signal: AbortSignal.timeout(90_000),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(formatProviderError(resolved.label, res.status, raw, model));
  return String(JSON.parse(raw)?.choices?.[0]?.message?.content || '').trim();
}

/** Draft (or redraft) the closer's reply to one lead. Saves a draft; sends nothing. */
export async function draftLead(id) {
  const config = await loadConfig();
  const persona = (config.personas || []).find((p) => p.id === CLOSER_ID);
  const business = await getBusiness().catch(() => ({}));
  const saved = await draftReply(leads, id, {
    complete,
    by: persona?.name || 'Marcus',
    masterPrompt: config.masterPrompt || '',
    personaPrompt: persona?.systemPrompt || '',
    businessText: businessBlock(business),
  });
  await note({ verb: 'drafted a reply to a new lead', summary: `${saved.name || saved.email}: ${saved.message.slice(0, 100)}` });
  return saved;
}

/** Send the approved draft from the configured email account. */
export async function sendLead(id) {
  const account = await emailAccount();
  if (!account) throw new Error('No email account is set up. Add one (Resend key + from-address) in Admin → Social accounts, platform "email".');
  const sent = await sendApproved(leads, id, {
    send: ({ to, subject, text }) => sendEmail({ apiKey: account.resendApiKey, from: account.fromEmail, to, subject, text }),
  });
  await note({ verb: 'sent a reply to a lead', platform: 'email', summary: `${sent.name || sent.email}: ${sent.draft?.subject || ''}` });
  return sent;
}

/** Tell the owner a lead arrived, by email, when LEAD_NOTIFY_EMAIL and an email account exist. Never throws. */
export async function notifyNewLead(lead) {
  try {
    const to = (process.env.LEAD_NOTIFY_EMAIL || '').trim();
    if (!to) return;
    const account = await emailAccount();
    if (!account) return;
    const site = (process.env.SITE_URL || '').replace(/\/$/, '');
    await sendEmail({
      apiKey: account.resendApiKey,
      from: account.fromEmail,
      to,
      subject: `New lead: ${lead.name || lead.email}`,
      text: `${lead.name || '(no name)'} <${lead.email}>${lead.company ? ` — ${lead.company}` : ''}\n\n${lead.message}\n\n${site ? `Review and approve the reply: ${site}/team` : 'Open /team to review and approve the reply.'}`,
    });
  } catch (err) { console.error('notifyNewLead failed:', err); }
}

/** Cron step: write a reply draft for every lead that does not have one yet, within the daily cap. */
export async function draftNewLeads() {
  const control = await agency.getControl().catch(() => ({ paused: false }));
  if (control.paused) return [];
  const out = [];
  for (const lead of (await leads.list()).filter((l) => l.status === 'new' && !l.draft)) {
    if (!(await agency.consume('leadDrafts', DRAFTS_PER_DAY))) { out.push({ id: lead.id, ok: false, skipped: true, error: `Daily limit of ${DRAFTS_PER_DAY} lead drafts reached.` }); break; }
    try { await draftLead(lead.id); out.push({ id: lead.id, ok: true }); }
    catch (err) { out.push({ id: lead.id, ok: false, error: err.message || String(err) }); }
  }
  return out;
}

/** The team's recent real actions (posts, replies, lead drafts), newest first, for the Team page. */
export async function teamActivity() {
  try { const oid = await ownerId(); return oid ? (await recentTeamActions(oid)).slice().reverse() : []; } catch { return []; }
}
