// / tool registry. One file per group; add a tool by exporting it from a group file.
// Tools are standalone commands — personas never own them; roles (later) do.
import { loadConfig } from '../config.js';
import { logTeamAction } from '../team-log.js';
import core from './core.js';
import research from './research.js';
import creative from './creative.js';
import ops from './ops.js';
import growth from './growth.js';
import agency from './agency.js';

// Handled in the browser (audio playback / existing campaign + media UIs).
const CLIENT_TOOLS = [
  { name: 'voice', group: 'Creative', summary: 'Read text aloud in the active persona\'s voice.', usage: '/voice text to speak', client: true },
  { name: 'video', group: 'Creative', summary: 'Open the video studio (/media).', usage: '/video', client: true },
  { name: 'campaign', group: 'Ops', summary: 'Full multi-channel campaign (strategist → editor → every platform).', usage: '/campaign what you are promoting', client: true },
];

export const TOOLS = new Map();
for (const t of [...core, ...research, ...creative, ...ops, ...growth, ...agency, ...CLIENT_TOOLS]) TOOLS.set(t.name, t);

export const needsAuth = (tool, args) => (typeof tool.sensitive === 'function' ? !!tool.sensitive(args) : !!tool.sensitive);
export const isSensitiveName = (name) => { const t = TOOLS.get(name); return !!t && (typeof t.sensitive === 'function' ? true : !!t.sensitive); };

export const registry = { TOOLS, parseCommand, needsAuth, isSensitiveName };

export function listTools() {
  return [...TOOLS.values()].map(({ name, group, summary, usage, client, sensitive }) => ({ name, group, summary, usage, client: !!client, sensitive: !!sensitive }));
}

/** Split "/name rest @client more" → { name, args, client }. */
export function parseCommand(input) {
  const m = /^\/(\w+)\s*([\s\S]*)$/.exec(String(input || '').trim());
  if (!m) return null;
  let args = m[2];
  let client = '';
  const at = /(^|\s)@([a-z0-9-]+)(?=\s|$|\|)/i.exec(args);
  if (at) { client = at[2].toLowerCase(); args = (args.slice(0, at.index) + ' ' + args.slice(at.index + at[0].length)).replace(/\s+/g, ' ').trim(); }
  return { name: m[1].toLowerCase(), args, client };
}

export async function runTool({ name, args, client, req, authed, ownerId }) {
  const tool = TOOLS.get(name);
  if (!tool) throw Object.assign(new Error(`Unknown command /${name}. Try /help.`), { status: 404 });
  if (tool.client) throw Object.assign(new Error(`/${name} runs in the browser.`), { status: 400 });
  const r = await tool.run({ args, client, req, authed, isSensitive: isSensitiveName, registry });
  if (r.log && ownerId) await logTeamAction(ownerId, { personaName: 'Tools', verb: 'ran', platform: name, summary: r.log }).catch(() => {});
  return { text: r.text };
}

/** Cron: run due scheduled jobs. Sensitive ones only if they were approved when scheduled. */
export async function processSchedule(req) {
  const { readCol, writeCol } = await import('./store.js');
  const q = await readCol('schedule', []);
  const out = [];
  for (const j of q) {
    if (j.status !== 'pending' || j.runAt > Date.now()) continue;
    const p = parseCommand(j.command);
    j.status = 'done';
    try {
      const tool = p && TOOLS.get(p.name);
      if (!tool || tool.client) throw new Error('not runnable');
      if (needsAuth(tool, p.args) && !j.approved) throw new Error('was not approved when scheduled');
      const r = await tool.run({ args: p.args, client: p.client, req, authed: j.approved, isSensitive: isSensitiveName, registry });
      j.result = r.text.slice(0, 500);
      out.push({ id: j.id, ok: true });
    } catch (e) { j.status = 'failed'; j.error = e.message; out.push({ id: j.id, ok: false, error: e.message }); }
  }
  if (out.length) await writeCol('schedule', q);
  return out;
}
