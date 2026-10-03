// A short rolling log of real-world actions a persona actually took
// (a post published, an email sent) — scoped per owner, read back into
// group chat so personas can reference what the team already did instead
// of only reacting to what was said in the thread.

import { kvGet, kvSet, KV_ENABLED } from './kv.js';

const MAX_ENTRIES = 8;

function logKey(ownerId) {
  return `uncensored-chat:team-log:${ownerId}`;
}

function parseList(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

export async function logTeamAction(ownerId, entry) {
  if (!KV_ENABLED || !ownerId) return;
  try {
    const key = logKey(ownerId);
    const list = parseList(await kvGet(key));
    list.push({ ...entry, at: new Date().toISOString() });
    await kvSet(key, list.slice(-MAX_ENTRIES));
  } catch (err) {
    console.error('logTeamAction failed:', err);
  }
}

export async function recentTeamActions(ownerId) {
  if (!KV_ENABLED || !ownerId) return [];
  try {
    return parseList(await kvGet(logKey(ownerId)));
  } catch {
    return [];
  }
}

export function formatTeamActions(actions) {
  if (!Array.isArray(actions) || !actions.length) return '';
  const lines = actions.map((a) => {
    const when = a.at ? new Date(a.at).toLocaleString() : '';
    const who = a.personaName || 'Someone';
    const verb = a.verb || 'acted';
    const where = a.platform ? ` (${a.platform})` : '';
    const summary = a.summary || '';
    return `- ${who} ${verb}${where} ${when}: ${summary}`.replace(/\s+/g, ' ').trim();
  });
  return `Recent team actions — these already happened for real, not hypothetical:\n${lines.join('\n')}`;
}
