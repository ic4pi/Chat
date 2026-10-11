/**
 * A marketing plan the team can execute today: the brief (read from the
 * project and the team's meeting, same reader as the campaign engine), then
 * a plan whose every task belongs to one team member and can be finished
 * right now with what they have — writing, web research, images and
 * ready-to-publish post drafts.
 */

import { completeJSON, extractBrief } from './campaign-engine.js';

const PLAN_SYSTEM = `You head a marketing team. Turn the product brief and the team's meeting into a plan the team executes TODAY.
- Every task goes to exactly one team member, by their id, matched to what they are good at.
- Every task must be finishable right now by that member with what they have: writing, live web research, image generation, and ready-to-publish post and email drafts. Nothing that needs a budget, a hire, a call, or software they do not have.
- Research comes before the copy that depends on it. Copy and posts name the platform they are for.
- day = the launch day the work goes live (0 = today). Spread posts over the first two weeks.
- Use only the facts in the brief. Never invent numbers, results, prices or testimonials.
- 4 to 8 tasks. Concrete deliverables ("3 Instagram posts with images for days 0, 3, 7"), never "improve brand awareness".`;

const PLAN_SHAPE = '{"goal":"","audience":"","positioning":"","offer":"","channels":[""],"kpis":[""],"tasks":[{"owner":"member id","title":"","deliverable":"exactly what they hand over","day":0}]}';

const text = (o, k, max = 600) => (typeof o?.[k] === 'string' ? o[k].trim().slice(0, max) : '');
const list = (o, k, max = 8) => (Array.isArray(o?.[k])
  ? o[k].filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, 200)).slice(0, max)
  : []);

function meetingNotes(conversation) {
  return conversation
    .filter((m) => m.role === 'assistant' && m.name && typeof m.content === 'string')
    .slice(-12)
    .map((m) => `${m.name}: ${m.content.slice(0, 900)}`)
    .join('\n\n');
}

export function validatePlan(o, team) {
  const goal = text(o, 'goal');
  if (!goal) throw new Error('"goal" is empty');
  const byId = new Map(team.map((p) => [p.id, p]));
  const byName = (owner) => team.find((p) => {
    const first = String(p.name || '').split(/\s+[—–-]\s+|\s+/)[0].toLowerCase();
    return first && String(owner).toLowerCase().includes(first);
  });
  const raw = Array.isArray(o?.tasks) ? o.tasks : [];
  const tasks = [];
  for (const t of raw.slice(0, 8)) {
    const title = text(t, 'title', 160);
    if (!title) continue;
    const owner = byId.get(String(t.owner || '').trim()) || byName(t.owner);
    if (!owner) throw new Error(`task "${title}" has owner "${t.owner}", which is not a team member id. Use one of: ${[...byId.keys()].join(', ')}`);
    const day = Math.round(Number(t.day));
    tasks.push({
      owner: owner.id,
      ownerName: owner.name,
      title,
      deliverable: text(t, 'deliverable', 400) || title,
      day: Number.isFinite(day) ? Math.min(30, Math.max(0, day)) : 0,
    });
  }
  if (tasks.length < 3) throw new Error('"tasks" needs at least 4 concrete tasks, each with a team member id as owner');
  return {
    goal,
    audience: text(o, 'audience'),
    positioning: text(o, 'positioning'),
    offer: text(o, 'offer'),
    channels: list(o, 'channels'),
    kpis: list(o, 'kpis'),
    tasks: tasks.sort((a, b) => a.day - b.day),
  };
}

export async function writeMarketingPlan(complete, { conversation, team, accounts }) {
  const brief = await extractBrief(complete, conversation);
  if (brief.question) return { question: brief.question };
  const user = [
    'PRODUCT BRIEF',
    `Product: ${brief.product}`,
    `Audience: ${brief.audience}${brief.audienceAssumed ? ' (assumed)' : ''}`,
    brief.offer ? `Offer: ${brief.offer}` : '',
    `Facts (the only claims allowed): ${brief.facts.length ? brief.facts.join(' | ') : 'none'}`,
    brief.direction ? `Direction agreed: ${brief.direction}` : '',
    '',
    'TEAM (id: name — specialty)',
    team.map((p) => `${p.id}: ${p.name} — ${String(p.description || '').slice(0, 200)}`).join('\n'),
    '',
    `CONNECTED ACCOUNTS: ${accounts.length ? accounts.map((a) => `${a.label} (${a.platform})`).join(', ') : 'none yet — still plan posts for the channels that fit'}`,
    '',
    'THE MEETING',
    meetingNotes(conversation) || '(no meeting notes)',
  ].filter((l) => l !== '').join('\n');
  const plan = await completeJSON(complete, {
    label: 'plan',
    system: PLAN_SYSTEM,
    shape: PLAN_SHAPE,
    user,
    temperature: 0.4,
    maxTokens: 2000,
    validate: (o) => validatePlan(o, team),
  });
  return { brief, plan };
}
