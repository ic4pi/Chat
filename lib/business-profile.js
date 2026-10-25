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
const NOTES_MAX = 3500;

const parse = (raw) => { try { return typeof raw === 'string' ? JSON.parse(raw) : (raw || {}); } catch { return {}; } };

export async function getBusiness() {
  if (!KV_ENABLED) return { profile: '', notes: '', notesAt: null };
  const v = parse(await kvGet(KEY));
  return { profile: String(v.profile || ''), notes: String(v.notes || ''), notesAt: v.notesAt || null };
}

async function write(next) {
  if (!KV_ENABLED) throw new Error('KV is not configured');
  await kvSet(KEY, next);
  return next;
}

export async function saveProfile(text) {
  const cur = await getBusiness();
  return write({ ...cur, profile: String(text || '').slice(0, PROFILE_MAX) });
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
      'Discuss it as a team, in your own roles: who the audience really is, what they struggle with, what content would earn their trust, ' +
      'which marketing tips and tricks, website-building advice, how-tos and campaign guidance would help them most, and what to avoid. ' +
      `Challenge each other. Then the lead must finish with a section titled "${MARKER}": 6 to 10 specific topics/angles to post about, ` +
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
