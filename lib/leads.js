/**
 * Leads: the inbound half of the agency's money loop.
 *
 *   website form  →  lead saved  →  the team's closer drafts a reply  →  YOU approve  →  it is sent
 *
 * Nothing is sent to a prospect without a tap in the Team page. Drafting happens on the hourly
 * cron (or the "Draft" button), never in the visitor's request, so the form is instant and a
 * stranger can never make the app spend model credits on demand beyond the daily cap.
 *
 * Storage: one KV blob (small, single-owner app), like the business profile and standing tasks.
 * `createLeads(store)` is pure over a tiny store so it is tested without KV.
 */

import { createHash, randomBytes } from 'node:crypto';
import { kvGet, kvSet, kvIncr, kvExpire, KV_ENABLED } from './kv.js';

const KEY = 'uncensored-chat:leads:v1';
export const MAX_LEADS = 300;
export const STATUSES = ['new', 'drafted', 'sent', 'won', 'lost'];
const LIMITS = { name: 120, email: 200, company: 160, message: 4000, source: 80, notes: 2000, subject: 200, draft: 6000 };
export const INTAKE_PER_HOUR = 5;
const DAY_MS = 86_400_000;

const EMAIL_RE = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']{2,}$/;
const clip = (v, n) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n);
const parse = (raw) => { try { return typeof raw === 'string' ? JSON.parse(raw) : (raw && typeof raw === 'object' ? raw : {}); } catch { return {}; } };

/** Validates what a visitor sent. Returns { ok:true, lead } or { ok:false, error, silent? } (silent = a bot: pretend success). */
export function validateLeadInput(body) {
  const b = body && typeof body === 'object' ? body : {};
  // Honeypot: a real person never sees this field, so any value means a bot. Say "ok" and drop it.
  if (clip(b.website, 200) || clip(b.url, 200)) return { ok: false, silent: true, error: 'bot' };
  const email = clip(b.email, LIMITS.email).toLowerCase();
  const message = clip(b.message, LIMITS.message);
  if (!EMAIL_RE.test(email)) return { ok: false, error: 'Please enter a valid email address so we can reply.' };
  if (message.length < 5) return { ok: false, error: 'Tell us a little about what you need.' };
  return {
    ok: true,
    lead: {
      name: clip(b.name, LIMITS.name),
      email,
      company: clip(b.company, LIMITS.company),
      message,
      source: clip(b.source, LIMITS.source) || 'website',
    },
  };
}

/** "SUBJECT: …" on the first line, the email body after it. Tolerates models that skip the label. */
export function parseDraft(raw) {
  const text = String(raw || '').trim().replace(/^```[a-z]*\n?|```$/g, '').trim();
  const m = /^\s*(?:\*\*)?subject(?:\*\*)?\s*:\s*(.+?)\s*\n+([\s\S]*)$/i.exec(text);
  if (m) return { subject: clip(m[1].replace(/\*+/g, ''), LIMITS.subject), body: clip(m[2], LIMITS.draft) };
  return { subject: '', body: clip(text, LIMITS.draft) };
}

const kvStore = {
  enabled: KV_ENABLED,
  get: async () => parse(await kvGet(KEY)),
  set: (v) => kvSet(KEY, v),
  /** Fixed-window counter shared across instances; null when KV is off. */
  hit: async (k, ttl) => { const n = await kvIncr(k); if (n === 1 && ttl) await kvExpire(k, ttl); return n; },
};

export function createLeads(store = kvStore, clock = () => Date.now(), rand = () => randomBytes(5).toString('hex')) {
  async function all() {
    if (!store.enabled) return [];
    const v = await store.get();
    return Array.isArray(v.leads) ? v.leads : [];
  }
  async function save(leads) {
    if (!store.enabled) throw new Error('KV is not configured');
    await store.set({ leads: leads.slice(0, MAX_LEADS) });
  }

  /** Saves a validated lead. `ipKey` (any stable string for the sender) rate-limits intake. */
  async function add(input, ipKey = '') {
    if (!store.enabled) return { ok: false, status: 503, error: 'Inquiries are not available right now. Please email us instead.' };
    if (ipKey) {
      const h = createHash('sha256').update(String(ipKey)).digest('hex').slice(0, 16);
      const n = await store.hit(`uncensored-chat:leads:rl:${h}`, 3600);
      if (n !== null && n > INTAKE_PER_HOUR) return { ok: false, status: 429, error: 'Too many requests — please try again in a little while.' };
    }
    const leads = await all();
    const now = clock();
    // The same person pressing Send twice is one lead.
    const dupe = leads.find((l) => l.email === input.email && l.message === input.message && now - Date.parse(l.createdAt) < DAY_MS);
    if (dupe) return { ok: true, lead: dupe, duplicate: true };
    const lead = {
      id: `l_${now.toString(36)}${rand()}`,
      ...input,
      status: 'new',
      createdAt: new Date(now).toISOString(),
      draft: null,
      sentAt: null,
      value: null,
      notes: '',
    };
    await save([lead, ...leads]);
    return { ok: true, lead };
  }

  async function list() { return all(); }
  async function get(id) { return (await all()).find((l) => l.id === id) || null; }

  /** Patch a lead. Only the fields the owner may change; `draft` may be edited text, never invented here. */
  async function update(id, patch = {}) {
    const leads = await all();
    const i = leads.findIndex((l) => l.id === id);
    if (i < 0) return null;
    const cur = leads[i];
    const next = { ...cur };
    if (patch.status !== undefined && STATUSES.includes(patch.status)) next.status = patch.status;
    if (patch.notes !== undefined) next.notes = clip(patch.notes, LIMITS.notes);
    if (patch.value !== undefined) {
      const v = patch.value === null || patch.value === '' ? null : Number(patch.value);
      next.value = Number.isFinite(v) && v >= 0 ? v : cur.value;
    }
    if (patch.draft && typeof patch.draft === 'object') {
      next.draft = {
        subject: clip(patch.draft.subject, LIMITS.subject),
        body: clip(patch.draft.body, LIMITS.draft),
        by: patch.draft.by || cur.draft?.by || 'you',
        at: new Date(clock()).toISOString(),
      };
      if (cur.status === 'new' && next.draft.body) next.status = 'drafted';
    }
    leads[i] = next;
    await save(leads);
    return next;
  }

  /** Claims the right to send, once. Returns the lead, or null if it was already sent or claimed. */
  async function claimSend(id) {
    const leads = await all();
    const i = leads.findIndex((l) => l.id === id);
    if (i < 0) return null;
    const l = leads[i];
    // A claim older than 10 minutes means the sender crashed mid-send; the owner may try again.
    if (l.sentAt || (l.sendingAt && clock() - Date.parse(l.sendingAt) < 600_000)) return null;
    leads[i] = { ...l, sendingAt: new Date(clock()).toISOString() };
    await save(leads);
    return leads[i];
  }
  async function finishSend(id, ok, error = null) {
    const leads = await all();
    const i = leads.findIndex((l) => l.id === id);
    if (i < 0) return null;
    const { sendingAt, ...rest } = leads[i];
    leads[i] = ok
      ? { ...rest, status: 'sent', sentAt: new Date(clock()).toISOString(), sendError: null }
      : { ...rest, sendError: String(error || 'send failed').slice(0, 300) };
    await save(leads);
    return leads[i];
  }

  async function summary() {
    const leads = await all();
    const count = (s) => leads.filter((l) => l.status === s).length;
    const won = leads.filter((l) => l.status === 'won');
    return {
      total: leads.length,
      new: count('new'),
      drafted: count('drafted'),
      sent: count('sent'),
      won: won.length,
      lost: count('lost'),
      wonValue: won.reduce((t, l) => t + (Number(l.value) || 0), 0),
    };
  }

  return { add, list, get, update, claimSend, finishSend, summary };
}

export const leads = createLeads();

/** Fixed-window limiter for any public action, per sender. True while the sender is within `limit` per `windowSeconds`. */
export async function withinRate(bucket, ipKey, limit, windowSeconds = 3600, store = kvStore) {
  if (!store.enabled || !ipKey) return true;
  const h = createHash('sha256').update(String(ipKey)).digest('hex').slice(0, 16);
  const n = await store.hit(`uncensored-chat:rl:${bucket}:${h}`, windowSeconds);
  return n === null || n <= limit;
}

// ── drafting and sending (deps injected so tests never touch a network) ───────────────────────

/** The prompt pair for the closer's reply to a lead. Pure. */
export function buildDraftPrompt({ lead, personaPrompt = '', masterPrompt = '', businessText = '' }) {
  const outbound = lead.kind === 'outbound';
  const system = [
    masterPrompt,
    personaPrompt,
    businessText,
    outbound
      ? [
        'You are writing a FIRST email, as the business, to a company that has NOT contacted us. We checked their public website and found real issues.',
        'Open with one specific, true finding from the check below (never invent one), say in a sentence why it costs them customers, and offer to send the full list of fixes and a free 15-minute walkthrough.',
        'Be respectful and low-pressure, not salesy; do not claim we have worked with them or know them. Do not quote a price unless an offer above fits their biggest problem.',
        'End with one clear, easy next step (reply to this email) and a one-line opt-out: "If this isn\'t useful, just reply \"no thanks\" and we won\'t email again."',
      ].join('\n')
      : 'You are replying, as the business, to someone who just filled in the contact form on the website.',
    outbound ? '' : 'Write a short, warm, specific email: acknowledge exactly what they asked for, say how we would approach it, name the matching offer and its price ONLY if it appears in the offers above (otherwise say we will scope it together and never invent a number), and end with one clear next step.',
    'Name any offer and price ONLY if it appears in the offers above; never invent a number.',
    'Under 170 words. No placeholders, no brackets, no "[Your Name]". Sign off with the business name from the profile if there is one, otherwise just "The team". Never promise results or timelines that are not in the profile.',
    'Output format: the first line is "SUBJECT: <subject>", then a blank line, then the email body. Nothing else.',
  ].filter(Boolean).join('\n\n');
  const user = [
    `Name: ${lead.name || '(not given)'}`,
    lead.company ? `Company: ${lead.company}` : '',
    `Email: ${lead.email}`,
    `${outbound ? 'What the site check found' : 'What they wrote'}:\n"""\n${lead.message}\n"""`,
    outbound ? 'Write the email.' : 'Write the reply.',
  ].filter(Boolean).join('\n');
  return { system, user };
}

/**
 * Drafts a reply for one lead and saves it as a draft (status "drafted"). Never sends.
 * deps: { complete(system, user) → text, personaPrompt, masterPrompt, businessText }
 */
export async function draftReply(store, id, deps) {
  const lead = await store.get(id);
  if (!lead) throw new Error('Lead not found.');
  const { system, user } = buildDraftPrompt({ lead, ...deps });
  const raw = await deps.complete(system, user);
  const { subject, body } = parseDraft(raw);
  if (!body) throw new Error('The model returned an empty draft.');
  return store.update(id, { draft: { subject: subject || 'Re: your enquiry', body, by: deps.by || 'Marcus' } });
}

/**
 * Sends the approved draft once. deps: { send({ to, subject, text }) → result }.
 * The claim is taken BEFORE sending, so a retry or a double tap can never email a prospect twice;
 * a failed send releases the claim and records why.
 */
export async function sendApproved(store, id, deps) {
  const lead = await store.get(id);
  if (!lead) throw new Error('Lead not found.');
  if (lead.sentAt) throw new Error('Already sent.');
  if (!lead.draft?.body?.trim()) throw new Error('There is no draft to send. Write or generate one first.');
  const claimed = await store.claimSend(id);
  if (!claimed) throw new Error('A send for this lead is already in progress or done.');
  try {
    await deps.send({ to: lead.email, subject: lead.draft.subject || 'Re: your enquiry', text: lead.draft.body });
  } catch (err) {
    await store.finishSend(id, false, err.message || err);
    throw err;
  }
  return store.finishSend(id, true);
}
