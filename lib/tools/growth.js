// Growth / tools: ads, metrics, report, track.
import { loadConfig } from '../config.js';
import { readCol, writeCol, newId, storeIsDurable } from './store.js';
import { ask, pipes, splitSub, normalizeUrl, clientContext, money } from './util.js';

// Rough industry benchmark ranges (USD). Planning assumptions, not forecasts.
const BENCH = {
  meta: { cpc: [0.8, 1.8], cvr: [0.02, 0.04] },
  google: { cpc: [1.5, 4.0], cvr: [0.03, 0.06] },
  tiktok: { cpc: [0.5, 1.5], cvr: [0.01, 0.03] },
  linkedin: { cpc: [5, 12], cvr: [0.02, 0.05] },
};

export function budgetPlan(platform, monthly) {
  const b = BENCH[platform];
  const clicks = [Math.round(monthly / b.cpc[1]), Math.round(monthly / b.cpc[0])];
  const conv = [Math.round(clicks[0] * b.cvr[0]), Math.round(clicks[1] * b.cvr[1])];
  const test = monthly * 0.2;
  return { daily: monthly / 30, test, scale: monthly - test, clicks, conv, cpa: [Math.round(monthly / Math.max(conv[1], 1)), Math.round(monthly / Math.max(conv[0], 1))] };
}

const ads = {
  name: 'ads', group: 'Growth',
  summary: 'Paid ad drafts (audiences, creatives, copy) + budget math. Drafts only — nothing is launched.',
  usage: '/ads meta | $3000/mo | product/offer | goal',
  async run({ args, client }) {
    const [platform, budget, ...rest] = pipes(args);
    const p = (platform || '').toLowerCase();
    const monthly = Number(String(budget || '').replace(/[^0-9.]/g, ''));
    if (!BENCH[p] || !monthly || !rest.length) throw new Error(`Usage: /ads ${Object.keys(BENCH).join('|')} | $monthly budget | offer | goal`);
    const m = budgetPlan(p, monthly);
    const math = `**Budget plan (${p}, ${money(monthly)}/mo)** — benchmark assumptions, not guarantees\n- ${money(m.daily)}/day · ${money(m.test)} test (20%) / ${money(m.scale)} scale\n- Est. clicks ${m.clicks[0]}–${m.clicks[1]} · conversions ${m.conv[0]}–${m.conv[1]} · CPA ~${money(m.cpa[0])}–${money(m.cpa[1])}`;
    const out = await ask(`You are a senior paid-media strategist on ${p}. Concrete and platform-native; no vague advice.`,
      `${await clientContext(client)}Offer/goal: ${rest.join(' | ')}\nMonthly budget: ${money(monthly)}\n\nOutput: 3 audiences to test, 4 ad concepts (hook, body, CTA, creative direction), campaign structure, what to measure at day 3/7/14, kill/scale rules.`, { maxTokens: 3500 });
    return { text: `${math}\n\n${out}` };
  },
};

async function graph(path, token) {
  const r = await fetch(`https://graph.facebook.com/v19.0/${path}${path.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(10000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message || `Graph HTTP ${r.status}`);
  return j;
}

export async function collectMetrics() {
  const leads = await readCol('crm', []);
  const seqs = await readCol('outreach', []);
  const links = await readCol('links', []);
  const lines = [];
  lines.push(`**Pipeline**: ${['new', 'contacted', 'replied', 'meeting', 'proposal', 'won', 'lost'].map((s) => `${s} ${leads.filter((l) => l.status === s).length}`).join(' · ')}`);
  const steps = seqs.flatMap((s) => s.steps);
  const sent = steps.filter((s) => s.status === 'sent').length;
  const replied = seqs.filter((s) => s.status === 'replied').length;
  lines.push(`**Outreach**: ${seqs.length} sequences · ${sent} emails sent · ${replied} replied${seqs.length ? ` (${Math.round((replied / seqs.length) * 100)}% of sequences)` : ''}`);
  lines.push(`**Tracked links**: ${links.length}`);
  const config = await loadConfig();
  for (const a of (config.socialAccounts || []).filter((x) => x.pageToken && (x.platform === 'facebook' || x.platform === 'instagram'))) {
    try {
      if (a.platform === 'facebook') { const j = await graph(`${a.pageId}?fields=name,fan_count,followers_count`, a.pageToken); lines.push(`**${a.label}** (Facebook): ${j.followers_count ?? j.fan_count ?? '?'} followers`); }
      else { const j = await graph(`${a.igUserId}?fields=username,followers_count,media_count`, a.pageToken); lines.push(`**${a.label}** (Instagram @${j.username}): ${j.followers_count} followers · ${j.media_count} posts`); }
    } catch (e) { lines.push(`**${a.label}**: couldn't read (${e.message})`); }
  }
  if (!storeIsDurable) lines.push('⚠ Storage (KV) is not connected — CRM/outreach numbers reset on cold start.');
  return lines.join('\n');
}

const metrics = {
  name: 'metrics', group: 'Growth',
  summary: 'Live numbers: CRM pipeline, outreach results, tracked links, FB/IG follower counts. (Ad-platform and site analytics are not connected.)',
  usage: '/metrics',
  async run() { return { text: await collectMetrics() }; },
};

const report = {
  name: 'report', group: 'Growth',
  summary: 'Client-ready performance report from live metrics + the numbers/notes you paste.',
  usage: '/report @acme | period + any numbers (spend, leads, revenue) you want included',
  async run({ args, client }) {
    const m = await collectMetrics();
    const out = await ask('You write marketing performance reports for clients. Executive summary first, then wins, misses, what we learned, next-period priorities with owners. Use ONLY the numbers provided — if a metric is missing say it is not tracked; never invent figures.',
      `${await clientContext(client)}LIVE METRICS:\n${m}\n\nUSER-PROVIDED CONTEXT:\n${args || '(none)'}`, { maxTokens: 3500 });
    return { text: out };
  },
};

const track = {
  name: 'track', group: 'Growth',
  summary: 'Build a UTM-tagged link and log it. `/track list` shows all.',
  usage: '/track https://site.com/offer | source | medium | campaign | optional content',
  async run({ args }) {
    const [sub] = splitSub(args);
    const links = await readCol('links', []);
    if (sub === 'list' || !args.trim()) return { text: links.length ? links.map((l) => `\`${l.id}\` ${l.campaign} · ${l.source}/${l.medium}\n   ${l.url}`).join('\n') : 'No tracked links yet.' };
    const [url, source, medium, campaign, content] = pipes(args);
    if (!url || !source || !medium || !campaign) throw new Error('Usage: /track url | source | medium | campaign | content');
    const u = new URL(normalizeUrl(url));
    const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    u.searchParams.set('utm_source', slug(source)); u.searchParams.set('utm_medium', slug(medium)); u.searchParams.set('utm_campaign', slug(campaign));
    if (content) u.searchParams.set('utm_content', slug(content));
    links.push({ id: newId('t'), url: u.toString(), source, medium, campaign, at: Date.now() });
    await writeCol('links', links);
    return { text: u.toString() };
  },
};

export default [ads, metrics, report, track];
