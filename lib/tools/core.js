// Core / tools: email, post, search, image, schedule.
import { loadConfig } from '../config.js';
import { publishToAccount } from '../social.js';
import { searchWeb } from '../websearch.js';
import { readCol, writeCol, newId } from './store.js';
import { pipes, splitSub } from './util.js';

export async function emailAccount(label) {
  const config = await loadConfig();
  const list = (config.socialAccounts || []).filter((a) => a.platform === 'email' && a.resendApiKey && a.fromEmail);
  if (!list.length) throw new Error('No email account configured. Add a Resend account in /admin → social accounts.');
  const want = String(label || '').toLowerCase();
  return (want && list.find((a) => a.label.toLowerCase() === want)) || list[0];
}

export async function sendViaAccount({ to, subject, body, accountLabel }) {
  const account = await emailAccount(accountLabel);
  await publishToAccount(account, { message: body, to, subject });
  return account;
}

const email = {
  name: 'email', group: 'Outbound', sensitive: true,
  summary: 'Send an email now.',
  usage: '/email to@x.com | subject | body',
  async run({ args }) {
    const [to, subject, ...rest] = pipes(args);
    const body = rest.join(' | ');
    if (!to || !body) throw new Error('Usage: /email to@x.com | subject | body');
    const a = await sendViaAccount({ to, subject, body });
    return { text: `Sent to ${to} from ${a.fromEmail}.`, log: `emailed ${to}: ${subject}` };
  },
};

const post = {
  name: 'post', group: 'Outbound', sensitive: (a) => !!String(a).trim(),
  summary: 'Publish to a connected social account (FB / IG / X). `/post` alone lists accounts.',
  usage: '/post account label | message | optional image url',
  async run({ args }) {
    const config = await loadConfig();
    const accounts = (config.socialAccounts || []).filter((a) => a.platform !== 'email');
    if (!args.trim()) {
      return { text: accounts.length ? 'Accounts:\n' + accounts.map((a) => `- ${a.label} (${a.platform})`).join('\n') : 'No social accounts connected in /admin.' };
    }
    const [label, message, imageUrl] = pipes(args);
    const account = accounts.find((a) => a.label.toLowerCase() === (label || '').toLowerCase());
    if (!account) throw new Error(`No account named "${label}". Run /post to list accounts.`);
    if (!message && !imageUrl) throw new Error('Usage: /post account | message | optional image url');
    const r = await publishToAccount(account, { message, imageUrl: imageUrl || undefined });
    return { text: `Posted to ${account.label}.${r?.permalink ? ' ' + r.permalink : ''}`, log: `posted to ${account.label}` };
  },
};

const search = {
  name: 'search', group: 'Research', summary: 'Live web search with sources.',
  usage: '/search your query',
  async run({ args }) {
    if (!args.trim()) throw new Error('Usage: /search your query');
    const results = await searchWeb(args.trim(), { count: 8 });
    if (!results.length) return { text: 'No results.' };
    return { text: results.map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet || r.description || ''}`).join('\n\n') };
  },
};

const image = {
  name: 'image', group: 'Creative', summary: 'Generate an image and get a hosted URL.',
  usage: '/image prompt',
  async run({ args, req }) {
    if (!args.trim()) throw new Error('Usage: /image prompt');
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const res = await fetch(`${proto}://${req.headers.host}/api/media-generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'image', provider: 'venice', prompt: args.trim(), size: '1024x1024' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Image generation failed (HTTP ${res.status})`);
    const img = (data.images || [])[0];
    if (!img?.url) throw new Error('Image generated but not hosted (needs SUPABASE_SERVICE_ROLE_KEY).');
    return { text: `![image](${img.url})\n\n${img.url}` };
  },
};

// ---- schedule: a queue the hourly cron drains -------------------------------------------------
export function parseWhen(s) {
  const t = String(s || '').trim();
  const rel = /^in\s+(\d+)\s*(m|min|h|hr|hour|d|day)s?$/i.exec(t);
  if (rel) {
    const n = Number(rel[1]);
    const u = rel[2][0].toLowerCase();
    return Date.now() + n * (u === 'm' ? 60e3 : u === 'h' ? 3600e3 : 86400e3);
  }
  const abs = Date.parse(t);
  if (!Number.isNaN(abs)) return abs;
  throw new Error('Time must be like "in 2h", "in 3d" or an ISO date (2026-11-02T09:00).');
}

const schedule = {
  name: 'schedule', group: 'Outbound',
  summary: 'Queue any / command to run later (checked hourly).',
  usage: '/schedule add in 2h | /post My Page | text   ·   /schedule list   ·   /schedule cancel id',
  async run({ args, authed, isSensitive }) {
    const [sub, rest] = splitSub(args);
    const q = await readCol('schedule', []);
    if (sub === 'list' || !sub) {
      const open = q.filter((j) => j.status === 'pending');
      return { text: open.length ? open.map((j) => `- \`${j.id}\` ${new Date(j.runAt).toISOString()} → ${j.command}`).join('\n') : 'Nothing scheduled.' };
    }
    if (sub === 'cancel') {
      const j = q.find((x) => x.id === rest.trim());
      if (!j) throw new Error('No scheduled job with that id.');
      j.status = 'cancelled';
      await writeCol('schedule', q);
      return { text: `Cancelled ${j.id}.` };
    }
    if (sub === 'add') {
      const [when, ...cmd] = pipes(rest);
      const command = cmd.join(' | ');
      if (!when || !command.startsWith('/')) throw new Error('Usage: /schedule add in 2h | /command args');
      const name = /^\/(\w+)/.exec(command)?.[1];
      if (name === 'schedule') throw new Error('Cannot schedule /schedule.');
      if (isSensitive(name) && !authed) throw new Error(`/${name} sends for real — unlock with the paid-models password to schedule it.`);
      const j = { id: newId('j'), runAt: parseWhen(when), command, status: 'pending', approved: !!authed, createdAt: Date.now() };
      q.push(j);
      await writeCol('schedule', q);
      return { text: `Scheduled \`${j.id}\` for ${new Date(j.runAt).toISOString()}: ${command}` };
    }
    throw new Error('Usage: /schedule add | list | cancel');
  },
};

export default [email, post, search, image, schedule];
