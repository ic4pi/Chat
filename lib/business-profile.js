/**
 * The business profile: one page that says everything about the company, kept in
 * KV. The autoposter reads it, and the team (the personas) can discuss it on their
 * own — a group discussion whose conclusions are saved as "strategy notes" that
 * the autoposter also reads. Same KV pattern as standing tasks and admin config.
 */

import { kvGet, kvSet, KV_ENABLED } from './kv.js';
import { runStandingTask } from './run-standing-task.js';

const KEY = 'uncensored-chat:business-profile:v1';
/** Vera (strategy, lead), Dez (copy), Nia (social), Priya (growth), Marcus (client/closer), Cole (outreach), Riot (guerrilla), Victoria (legal). */
export const TEAM_IDS = ['agency-strategist', 'agency-copywriter', 'agency-social', 'agency-growth', 'agency-closer', 'agency-outreach', 'ib25ns8xmrw104in', '1g5eon9umrw14qmd'];
const MARKER = 'FINAL CONTENT STRATEGY';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const PROFILE_MAX = 8000;
export const OFFERS_MAX = 3000;
const NOTES_MAX = 3500;

/** A starting profile written from the Semantiq site's own copy, so posts and replies have a voice from day one. Edit it on /team; a saved value (even empty) wins. */
export const DEFAULT_PROFILE = [
  'Semantiq is an AI-engineered, human-led marketing and web agency for small businesses. Site: thesemantiq.com. Email: hello@thesemantiq.com.',
  'WHO WE SERVE: owners of local small businesses (restaurants, bakeries, trades, salons, clinics, shops) who have a weak or missing website and want more customers from Google and social.',
  'WHAT WE DO: websites, SEO audits, local SEO, and ongoing site care. Prices and packages are in the offers.',
  'HOW WE WORK: automation does the heavy lifting; people set the direction, protect the brand and make the calls. We launch, measure and refine every week. Clear scope, clear reporting, you always know what we did and what it did for you.',
  'VOICE: plain-spoken, practical and warm. No jargon, no hype, no buzzwords. Helpful first, never salesy. Short sentences, specific advice a business owner can act on today.',
  'CALL TO ACTION: send people to the free site check on thesemantiq.com, or to email hello@thesemantiq.com.',
  'NEVER: invent clients, testimonials, case studies, statistics, awards or results; promise rankings or guaranteed outcomes; mention a price or package that is not in the offers; disparage competitors.',
].join('\n\n');

/** Starting offers so the closer has real packages from day one. Edit or clear them on /team; a saved value (even empty) always wins. */
export const DEFAULT_OFFERS = [
  'Free site check — $0 — we review your site and send 3 specific fixes',
  'SEO audit — $300 — full report on rankings, speed, local listings and a prioritized fix list',
  'Starter website — $1,200 — up to 5 pages, mobile-ready, contact form, live in 2 weeks',
  'Website + local SEO setup — $2,200 — Starter site plus Google Business Profile, local keywords and on-page SEO',
  'Monthly local SEO — $600/mo — Google Business Profile, citations, review requests, fixes and a monthly report; 3-month minimum',
  'Care plan — $75/mo — hosting, updates and small edits',
].join('\n');

const parse = (raw) => { try { return typeof raw === 'string' ? JSON.parse(raw) : (raw || {}); } catch { return {}; } };

export async function getBusiness() {
  if (!KV_ENABLED) return { profile: '', offers: '', notes: '', notesAt: null };
  const v = parse(await kvGet(KEY));
  return { profile: v.profile === undefined ? DEFAULT_PROFILE : String(v.profile || ''), offers: v.offers === undefined ? DEFAULT_OFFERS : String(v.offers || ''), notes: String(v.notes || ''), notesAt: v.notesAt || null };
}

async function write(next) {
  if (!KV_ENABLED) throw new Error('KV is not configured');
  await kvSet(KEY, next);
  return next;
}

/** Saves the profile and/or the offers (what is sold, at what price). A field left undefined is kept. */
export async function saveProfile(text, offers) {
  const cur = await getBusiness();
  return write({
    ...cur,
    ...(text === undefined ? {} : { profile: String(text || '').slice(0, PROFILE_MAX) }),
    ...(offers === undefined ? {} : { offers: String(offers || '').slice(0, OFFERS_MAX) }),
  });
}

/** Saves the team's strategy notes by hand (e.g. a chat reply the owner chose to adopt). */
export async function saveNotes(text) {
  const cur = await getBusiness();
  return write({ ...cur, notes: String(text || '').trim().slice(0, NOTES_MAX), notesAt: new Date().toISOString() });
}

/** What the agency is told about the business: profile, offers and the team's strategy. '' when nothing is saved. */
export function businessBlock(biz) {
  if (!biz) return '';
  const parts = [];
  if (biz.profile?.trim()) parts.push(`ABOUT THE BUSINESS (authoritative — never contradict it, never invent facts, prices or clients beyond it):\n${biz.profile.trim()}`);
  if (biz.offers?.trim()) parts.push(`WHAT WE SELL AND AT WHAT PRICE (authoritative — quote only these, never invent a price or a package):\n${biz.offers.trim()}`);
  if (biz.notes?.trim()) parts.push(`THE TEAM'S LATEST STRATEGY (from their own discussion — follow it):\n${biz.notes.trim()}`);
  return parts.join('\n\n');
}

/**
 * The block for a persona speaking in any chat. Only the agency's own team (TEAM_IDS) gets it — a personal
 * persona never does, so a private chat is never colored by the business. '' when storage is off or the read
 * fails: a prompt never breaks on it.
 */
export async function loadBusinessBlockFor(personaId) {
  if (!TEAM_IDS.includes(personaId)) return '';
  try { return businessBlock(await getBusiness()); } catch { return ''; }
}

/** Pull the strategy out of a discussion: everything after the marker, else the last turn. */
export function extractStrategy(turnTexts) {
  const joined = turnTexts.join('\n\n');
  const i = joined.toUpperCase().lastIndexOf(MARKER);
  const picked = i >= 0 ? joined.slice(i + MARKER.length).replace(/^[\s:*#-]+/, '') : (turnTexts[turnTexts.length - 1] || '');
  return picked.trim().slice(0, NOTES_MAX);
}

export function discussionTask(profile) {
  return {
    id: 'team-strategy',
    name: 'Team strategy discussion',
    objective:
      `Here is everything about the business you work for:\n\n${profile}\n\n` +
      'Discuss it as a team, in your own roles. The goal is to win paying customers for the offers above: who exactly buys, what pain makes them act, ' +
      'which offer fits which pain, the objections that stop them (price, "I have Facebook already", "does SEO work") and how to answer each, and which angles earn trust fast. ' +
      `Challenge each other. Then the lead must finish with a section titled "${MARKER}": 6 to 10 specific post angles, each tied to a named offer and ending in a call to action, ` +
      'the tone rules, and the things never to say. Plain text, no preamble.',
    // Only the marketing table. With no list the group chat seats EVERY persona —
    // including private ones (Juno) whose prompts must never reach a public post.
    leadPersonaId: 'agency-strategist',
    personaIds: TEAM_IDS,
  };
}

/** Run the discussion now and save its conclusions. Throws if there is no profile. */
export async function runTeamDiscussion(req) {
  const cur = await getBusiness();
  if (!cur.profile.trim()) throw new Error('Write the business profile first — the team needs something to discuss.');
  const result = await runStandingTask(discussionTask(cur.profile), req);
  const notes = extractStrategy(result.turnTexts || [result.summary || '']);
  if (!notes) throw new Error('The team discussed it but produced no strategy to save.');
  await write({ ...cur, notes, notesAt: new Date().toISOString() });
  return { notes, documentId: result.documentId, turns: result.turns };
}

/** Cron hook: re-discuss weekly so the strategy stays fresh without anyone asking. */
export async function discussIfStale(req) {
  const cur = await getBusiness();
  if (!cur.profile.trim()) return null;
  const last = Date.parse(cur.notesAt || '');
  if (!Number.isNaN(last) && Date.now() - last < WEEK_MS) return null;
  return runTeamDiscussion(req);
}
