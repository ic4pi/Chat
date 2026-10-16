// Ops / tools: crm, outreach (cold + follow-up cadence), proposal, contract.
import { readCol, writeCol, newId } from './store.js';
import { ask, pipes, splitSub, clientContext } from './util.js';
import { sendViaAccount } from './core.js';

const STATUSES = ['new', 'contacted', 'replied', 'meeting', 'proposal', 'won', 'lost'];
const DAY = 86400e3;

const findLead = (leads, key) => {
  const k = String(key || '').trim().toLowerCase();
  return leads.find((l) => l.id === k) || leads.find((l) => l.name.toLowerCase() === k) || leads.find((l) => l.name.toLowerCase().includes(k) && k) || leads.find((l) => l.email?.toLowerCase() === k);
};
const fmtLead = (l) => `\`${l.id}\` **${l.name}**${l.company ? ' · ' + l.company : ''}${l.email ? ' · ' + l.email : ''} — ${l.status}${l.notes.length ? '\n   ↳ ' + l.notes[l.notes.length - 1].text : ''}`;

const crm = {
  name: 'crm', group: 'Ops',
  summary: 'Lightweight CRM: leads, status pipeline, notes.',
  usage: '/crm add Name | email | company | note   ·   /crm list [status]   ·   /crm show x   ·   /crm status x won   ·   /crm note x | text   ·   /crm del x',
  async run({ args }) {
    const [sub, rest] = splitSub(args);
    const leads = await readCol('crm', []);
    if (sub === 'add') {
      const [name, email, company, note] = pipes(rest);
      if (!name) throw new Error('Usage: /crm add Name | email | company | note');
      const l = { id: newId('l'), name, email: email || '', company: company || '', status: 'new', notes: note ? [{ text: note, at: Date.now() }] : [], createdAt: Date.now(), updatedAt: Date.now() };
      leads.push(l);
      await writeCol('crm', leads);
      return { text: `Added ${fmtLead(l)}` };
    }
    if (sub === 'list' || !sub) {
      const f = STATUSES.includes(rest.toLowerCase()) ? rest.toLowerCase() : null;
      const rows = leads.filter((l) => !f || l.status === f);
      const counts = STATUSES.map((s) => `${s} ${leads.filter((l) => l.status === s).length}`).join(' · ');
      return { text: `${counts}\n\n${rows.length ? rows.map(fmtLead).join('\n') : 'No leads.'}` };
    }
    if (sub === 'show') {
      const l = findLead(leads, rest);
      if (!l) throw new Error('Lead not found.');
      return { text: `${fmtLead(l)}\n\n${l.notes.map((n) => `- ${new Date(n.at).toISOString().slice(0, 10)}: ${n.text}`).join('\n') || '(no notes)'}` };
    }
    if (sub === 'status') {
      const [key, st] = rest.split(/\s+(?=\S+$)/);
      const l = findLead(leads, key);
      if (!l || !STATUSES.includes((st || '').toLowerCase())) throw new Error(`Usage: /crm status lead ${STATUSES.join('|')}`);
      l.status = st.toLowerCase(); l.updatedAt = Date.now();
      await writeCol('crm', leads);
      return { text: `${l.name} → ${l.status}` };
    }
    if (sub === 'note') {
      const [key, ...t] = pipes(rest);
      const l = findLead(leads, key);
      if (!l || !t.length) throw new Error('Usage: /crm note lead | text');
      l.notes.push({ text: t.join(' | '), at: Date.now() }); l.updatedAt = Date.now();
      await writeCol('crm', leads);
      return { text: `Noted on ${l.name}.` };
    }
    if (sub === 'del') {
      const l = findLead(leads, rest);
      if (!l) throw new Error('Lead not found.');
      await writeCol('crm', leads.filter((x) => x !== l));
      return { text: `Deleted ${l.name}.` };
    }
    throw new Error('Usage: /crm add | list | show | status | note | del');
  },
};

// ---- outreach --------------------------------------------------------------------------------
const CADENCE_DAYS = [0, 3, 7, 14];

function stepLine(s, i) {
  return `${i + 1}. day +${s.day} · ${s.status}${s.sentAt ? ' ' + new Date(s.sentAt).toISOString().slice(0, 10) : ''} — **${s.subject}**`;
}

async function sendStep(seq, leads, step) {
  const lead = leads.find((l) => l.id === seq.leadId);
  if (!lead?.email) throw new Error(`${lead?.name || 'Lead'} has no email — /crm note it or re-add with an email.`);
  await sendViaAccount({ to: lead.email, subject: step.subject, body: step.body, accountLabel: seq.account });
  step.status = 'sent'; step.sentAt = Date.now();
  if (lead.status === 'new') lead.status = 'contacted';
  lead.updatedAt = Date.now();
  lead.notes.push({ text: `Outreach step sent: ${step.subject}`, at: Date.now() });
  if (seq.steps.every((s) => s.status !== 'pending')) seq.status = 'done';
}

/** Cron entry: send due steps of sequences the user switched to auto. Returns a summary list. */
export async function processDueOutreach() {
  const seqs = await readCol('outreach', []);
  const leads = await readCol('crm', []);
  const out = [];
  for (const seq of seqs) {
    if (seq.status !== 'active' || !seq.auto) continue;
    const step = seq.steps.find((s) => s.status === 'pending');
    if (!step || step.dueAt > Date.now()) continue;
    try { await sendStep(seq, leads, step); out.push({ id: seq.id, step: step.n, ok: true }); }
    catch (e) { seq.status = 'paused'; seq.error = e.message; out.push({ id: seq.id, step: step.n, ok: false, error: e.message }); }
  }
  if (out.length) { await writeCol('outreach', seqs); await writeCol('crm', leads); }
  return out;
}

const outreach = {
  name: 'outreach', group: 'Outbound', sensitive: (a) => ['send', 'auto'].includes(String(a).trim().split(/\s+/)[0].toLowerCase()),
  summary: 'Cold email + follow-up cadence (day 0/3/7/14). Drafts → you approve → manual or auto-send. Replied stops it.',
  usage: '/outreach new lead | offer/goal   ·   /outreach list   ·   /outreach show id   ·   /outreach send id   ·   /outreach auto id on|off   ·   /outreach replied id   ·   /outreach pause|resume id   ·   /outreach due',
  async run({ args, client }) {
    const [sub, rest] = splitSub(args);
    const seqs = await readCol('outreach', []);
    const leads = await readCol('crm', []);
    const seq = () => { const s = seqs.find((x) => x.id === rest.split(/\s+/)[0]); if (!s) throw new Error('No sequence with that id. /outreach list'); return s; };
    const save = async () => { await writeCol('outreach', seqs); await writeCol('crm', leads); };

    if (sub === 'new') {
      const [leadKey, ...goal] = pipes(rest);
      const lead = findLead(leads, leadKey);
      if (!lead || !goal.length) throw new Error('Usage: /outreach new lead | offer/goal (lead must exist: /crm add)');
      const raw = await ask(
        'You write cold outreach that gets replies: short, specific, one clear ask, zero hype, no "I hope this finds you well". Return ONLY a JSON array of 4 objects {subject, body}: step 1 cold open, step 2 value-add bump, step 3 different angle/social proof, step 4 polite breakup. Each follow-up must stand alone but reference the thread naturally. Plain text bodies, sign off with [Your name].',
        `${await clientContext(client)}Lead: ${lead.name}${lead.company ? ' at ' + lead.company : ''}\nNotes: ${lead.notes.map((n) => n.text).join('; ') || 'none'}\nOffer/goal: ${goal.join(' | ')}`);
      let arr; try { arr = JSON.parse(raw.replace(/```json|```/g, '').trim()); } catch { throw new Error('Draft came back unreadable — run it again.'); }
      if (!Array.isArray(arr) || arr.length < 2) throw new Error('Draft came back incomplete — run it again.');
      const now = Date.now();
      const s = { id: newId('o'), leadId: lead.id, status: 'active', auto: false, createdAt: now, goal: goal.join(' | '),
        steps: arr.slice(0, 4).map((x, i) => ({ n: i + 1, day: CADENCE_DAYS[i], subject: String(x.subject || '').slice(0, 150), body: String(x.body || ''), dueAt: now + CADENCE_DAYS[i] * DAY, status: 'pending' })) };
      seqs.push(s);
      await save();
      return { text: `Drafted \`${s.id}\` for ${lead.name} — nothing sent yet.\n\n${s.steps.map((st) => `**Step ${st.n} (day +${st.day})**\nSubject: ${st.subject}\n${st.body}`).join('\n\n---\n\n')}\n\n\`/outreach send ${s.id}\` sends step 1 · \`/outreach auto ${s.id} on\` lets the hourly job send each step on schedule.` };
    }
    if (sub === 'list' || !sub) {
      return { text: seqs.length ? seqs.map((s) => `\`${s.id}\` ${leads.find((l) => l.id === s.leadId)?.name || '?'} — ${s.status}${s.auto ? ' (auto)' : ''} · ${s.steps.filter((x) => x.status === 'sent').length}/${s.steps.length} sent`).join('\n') : 'No sequences.' };
    }
    if (sub === 'show') { const s = seq(); return { text: s.steps.map(stepLine).join('\n') + (s.error ? `\n\n⚠ ${s.error}` : '') }; }
    if (sub === 'due') {
      const due = seqs.filter((s) => s.status === 'active').map((s) => ({ s, st: s.steps.find((x) => x.status === 'pending') })).filter((x) => x.st && x.st.dueAt <= Date.now());
      return { text: due.length ? due.map(({ s, st }) => `\`${s.id}\` ${leads.find((l) => l.id === s.leadId)?.name} — step ${st.n} due → /outreach send ${s.id}`).join('\n') : 'Nothing due.' };
    }
    if (sub === 'send') {
      const s = seq(); const st = s.steps.find((x) => x.status === 'pending');
      if (!st) throw new Error('Nothing left to send in that sequence.');
      if (s.status === 'paused') throw new Error('Sequence is paused. /outreach resume ' + s.id);
      await sendStep(s, leads, st); await save();
      return { text: `Sent step ${st.n}: ${st.subject}`, log: `outreach step ${st.n} → ${leads.find((l) => l.id === s.leadId)?.name}` };
    }
    if (sub === 'auto') {
      const s = seq(); const on = /\bon\b/i.test(rest);
      s.auto = on; if (on && s.status === 'paused') { s.status = 'active'; delete s.error; }
      await save();
      return { text: on ? `Auto-send ON for ${s.id}: the hourly job sends each step when it's due, and stops the moment you mark it replied.` : `Auto-send off for ${s.id}.` };
    }
    if (sub === 'replied') {
      const s = seq(); s.status = 'replied';
      const l = leads.find((x) => x.id === s.leadId); if (l) { l.status = 'replied'; l.updatedAt = Date.now(); l.notes.push({ text: 'Replied to outreach', at: Date.now() }); }
      await save();
      return { text: `Cadence stopped. ${l?.name || 'Lead'} → replied.` };
    }
    if (sub === 'pause' || sub === 'resume') {
      const s = seq(); s.status = sub === 'pause' ? 'paused' : 'active'; await save();
      return { text: `${s.id} ${s.status}.` };
    }
    throw new Error('Usage: /outreach new | list | show | due | send | auto | replied | pause | resume');
  },
};

const proposal = {
  name: 'proposal', group: 'Ops',
  summary: 'Client proposal from a lead + your scope and price notes.',
  usage: '/proposal lead | scope, deliverables, price, timeline',
  async run({ args, client }) {
    const [key, ...notes] = pipes(args);
    const lead = findLead(await readCol('crm', []), key);
    if (!lead || !notes.length) throw new Error('Usage: /proposal lead | scope/price notes (lead must be in /crm)');
    const out = await ask('You write winning agency proposals: lead with their problem and the outcome, then scope, deliverables, timeline, investment, terms, next step. Concrete, no fluff. Use only the price/terms given; if something is missing write [TBD] — never invent numbers.',
      `${await clientContext(client)}Client: ${lead.name}${lead.company ? ' (' + lead.company + ')' : ''}\nHistory: ${lead.notes.map((n) => n.text).join('; ')}\nNotes: ${notes.join(' | ')}`, { maxTokens: 3500 });
    return { text: out };
  },
};

const contract = {
  name: 'contract', group: 'Ops',
  summary: 'Contract draft: services agreement, NDA, retainer, etc., with standard clauses.',
  usage: '/contract services agreement | parties, scope, fee, term, jurisdiction',
  async run({ args }) {
    const [type, ...terms] = pipes(args);
    if (!type || !terms.length) throw new Error('Usage: /contract type | parties, scope, fee, term, jurisdiction');
    const out = await ask('You draft plain-English commercial contracts with the standard protective clauses (scope, payment, IP, confidentiality, termination, liability cap, indemnity, dispute resolution). Use only the terms given; mark anything missing as [TBD]. End with one line: this is a draft for a lawyer to review.',
      `Type: ${type}\nTerms: ${terms.join(' | ')}`, { maxTokens: 4500 });
    return { text: out };
  },
};

export default [crm, outreach, proposal, contract];
