// Agencies = base + roles + playbook, built from files:
//   personas/*.md  characters only            (lib/config.js)
//   roles/*.md     a job: default persona + the tools that job gets
//   agencies/*.md  which roles sit at the table, persona swaps, extra tools, playbook
// Tools belong to roles, never to personas: swap a persona into a role and the tools stay.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseFrontmatter } from './frontmatter.js';
import { loadConfig } from './config.js';

const dir = (n) => path.join(process.cwd(), n);

async function loadDir(name) {
  let files = [];
  try { files = await readdir(dir(name)); } catch { return new Map(); }
  const out = new Map();
  for (const f of files.sort()) {
    const m = /^([a-z0-9][a-z0-9_-]*)\.md$/i.exec(f);
    if (!m || m[1].toLowerCase() === 'readme') continue;
    const { meta, body } = parseFrontmatter(await readFile(path.join(dir(name), f), 'utf8'));
    out.set(m[1].toLowerCase(), { id: m[1].toLowerCase(), ...meta, body });
  }
  return out;
}

export const loadRoles = () => loadDir('roles');
export const loadAgencies = () => loadDir('agencies');

/** Persona by exact id, else by name (full name, or first word of "Name — Title"). */
export function findPersona(personas, ref) {
  const x = String(ref || '').trim().toLowerCase();
  if (!x) return null;
  return personas.find((p) => p.id.toLowerCase() === x)
    || personas.find((p) => p.name.toLowerCase() === x)
    || personas.find((p) => p.name.toLowerCase().split(/\s+[—-]\s+/)[0] === x)
    || personas.find((p) => p.name.toLowerCase().startsWith(x + ' '))
    || null;
}

const list = (v) => (Array.isArray(v) ? v : []);

/** Resolve an agency into concrete seats: { role, persona, tools, ... } plus the combined playbook. */
export async function resolveAgency(agencyId, { personas } = {}) {
  const [roles, agencies] = [await loadRoles(), await loadAgencies()];
  const chain = [];
  for (let id = String(agencyId || '').toLowerCase(), guard = 0; id && guard < 5; guard++) {
    const a = agencies.get(id);
    if (!a) { if (!chain.length) throw new Error(`No agency "${agencyId}". Try /agency.`); break; }
    chain.unshift(a); id = a.extends ? String(a.extends).toLowerCase() : '';
  }
  const ps = personas || (await loadConfig()).personas;
  const roleIds = [...new Set(chain.flatMap((a) => list(a.roles)))];
  const baseTools = [...new Set(chain.flatMap((a) => list(a.all_tools)))];
  const swap = Object.assign({}, ...chain.map((a) => (a.swap && typeof a.swap === 'object' ? a.swap : {})));
  const addTools = Object.assign({}, ...chain.map((a) => (a.add_tools && typeof a.add_tools === 'object' ? a.add_tools : {})));
  const seats = roleIds.map((rid) => {
    const role = roles.get(rid);
    if (!role) throw new Error(`Agency "${agencyId}" lists role "${rid}" but roles/${rid}.md does not exist.`);
    const persona = findPersona(ps, swap[rid] || role.persona);
    const extra = addTools[rid] ? String(addTools[rid]).split(/[\s+]+/) : [];
    return { id: rid, name: role.name, description: role.description || '', body: role.body, personaRef: swap[rid] || role.persona, persona, tools: [...new Set([...list(role.tools), ...baseTools, ...extra])] };
  });
  const last = chain[chain.length - 1];
  return { id: last.id, name: last.name, description: last.description || '', playbook: chain.map((a) => a.body).filter(Boolean).join('\n\n'), seats };
}

export async function listAgencyIds() {
  return [...(await loadAgencies()).values()].filter((a) => a.id !== 'base').map((a) => ({ id: a.id, name: a.name, description: a.description || '' }));
}

// ---- running a seat --------------------------------------------------------------------------
const MAX_TURNS = 5;
const TOOL_RE = /<<tool>>([\s\S]*?)<<\/tool>>/g;

function protocol(seat, toolDefs) {
  return [
    'TOOLS: you can run commands from your own toolset. To run one, put it on its own line as <<tool>>/command args<</tool>> and stop; the result comes back and you continue. Use real results; never invent data.',
    'Commands that act for real (sending, posting, auto-send) are not run by you: write the exact command in your answer for the user to approve.',
    'Your toolset:',
    ...toolDefs.map((t) => `- ${t.usage} — ${t.summary}${t.sensitive ? ' [needs user approval]' : ''}`),
  ].join('\n');
}

export async function runSeat({ agencyId, roleId, request, client, registry, clientContext, llm, model, personas }) {
  const config = await loadConfig();
  const agency = await resolveAgency(agencyId, { personas: personas || config.personas });
  const seat = agency.seats.find((s) => s.id === (roleId || agency.seats[0].id));
  if (!seat) throw new Error(`No role "${roleId}" in ${agency.name}. Seats: ${agency.seats.map((s) => s.id).join(', ')}`);
  if (!seat.persona) throw new Error(`Role "${seat.id}" uses persona "${seat.personaRef}", which isn't set up. Add personas/${String(seat.personaRef).toLowerCase()}.md or fix the role.`);

  const defs = seat.tools.map((n) => registry.TOOLS.get(n)).filter((t) => t && !t.client);
  const allowed = new Set(defs.map((t) => t.name));
  const roster = agency.seats.map((s) => `- ${s.id} (${s.persona?.name || s.personaRef}): ${s.description}`).join('\n');
  const system = [
    config.masterPrompt,
    seat.persona.systemPrompt,
    `YOU ARE ${seat.persona.name}, working as the ${seat.name} in "${agency.name}".\nYOUR ROLE: ${seat.body}`,
    `AGENCY PLAYBOOK:\n${agency.playbook}`,
    `THE TABLE (hand work to a colleague by telling the user to run /ask ${agency.id}/<role> | request):\n${roster}`,
    clientContext,
    protocol(seat, defs),
  ].filter(Boolean).join('\n\n');

  const messages = [{ role: 'user', content: request }];
  const used = [];
  let text = '';
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    text = await llm({ model, system, messages, maxTokens: 3000 });
    const calls = [...text.matchAll(TOOL_RE)].map((m) => m[1].trim()).slice(0, 3);
    if (!calls.length) break;
    const results = [];
    for (const c of calls) {
      const p = registry.parseCommand(c);
      const tool = p && registry.TOOLS.get(p.name);
      if (!tool || !allowed.has(p.name)) { results.push(`${c}\n→ not in your toolset.`); continue; }
      if (registry.needsAuth(tool, p.args)) { results.push(`${c}\n→ not run: this acts for real. Put the exact command in your answer for the user to approve.`); continue; }
      try { results.push(`${c}\n→ ${(await tool.run({ args: p.args, client: p.client || client, req: null, authed: false, isSensitive: registry.isSensitiveName, registry })).text.slice(0, 6000)}`); used.push(c); }
      catch (e) { results.push(`${c}\n→ error: ${e.message}`); }
    }
    messages.push({ role: 'assistant', content: text }, { role: 'user', content: `TOOL RESULTS:\n\n${results.join('\n\n')}\n\nContinue.` });
    if (turn === MAX_TURNS - 1) text = text.replace(TOOL_RE, '').trim() + '\n\n(Stopped after the tool-call limit.)';
  }
  const answer = text.replace(TOOL_RE, '').trim();
  return `**${seat.persona.name} · ${seat.name}** (${agency.name})\n\n${answer}${used.length ? `\n\n_Used: ${used.join(' · ')}_` : ''}`;
}
