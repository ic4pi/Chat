/**
 * Daily pages: twice a day (or whatever hours you set) the app has a model
 * invent an interactive one-file HTML page, checks it, and posts it to a
 * place that is NOT this app — a GitHub repo (committed in one atomic
 * commit, ready for GitHub Pages / Vercel / Netlify to serve) or any website
 * that takes a webhook.
 *
 * Config and state live in Vercel KV under their own keys, so saving
 * settings in /admin can never race the cron that is writing results.
 * The hourly cron (api/cron/daily-pages.js) calls runDueSlots().
 */

import vm from 'node:vm';
import { kvGet, kvSet, kvIncr, kvExpire, KV_ENABLED } from './kv.js';
import { PROVIDERS, resolveProvider, withProviderChatExtras, formatProviderError } from './providers.js';
import { liveModels, pickDefault, isModelGoneError, replacementFor } from './model-health.js';
import { completeJSON } from './campaign-engine.js';

const CONFIG_KEY = 'uncensored-chat:daily-pages:config:v1';
const STATE_KEY = 'uncensored-chat:daily-pages:state:v1';
const LOCK_PREFIX = 'uncensored-chat:daily-pages:lock:';

const MAX_ATTEMPTS_PER_SLOT = 3;
const MAX_SLOTS_PER_RUN = 2;
/** Don't start another page once this much of the function's budget is gone. */
const RUN_BUDGET_MS = 420_000;
const HISTORY_KEPT = 60;
const MAX_HTML_BYTES = 250_000;
const MIN_HTML_BYTES = 1_000;

const DEFAULT_BRIEF = 'Small, surprising, genuinely fun or useful interactive web toys and tools for curious people.';

const KINDS = [
  'an interactive game you can finish in two minutes',
  'a calculator or planner that answers a real everyday question',
  'a simulation or toy you can poke at and watch react',
  'a data or visual explorer driven by sliders',
  'a quiz or flashcard trainer that teaches something real',
  'a creative tool that makes something you would want to keep',
  'a puzzle with a satisfying solution',
  'a step-by-step visual explainer of one idea',
];

// ── config ───────────────────────────────────────────────────────────────

export function defaultConfig() {
  return {
    enabled: false,
    brief: '',
    hours: [8, 20],
    timezone: 'UTC',
    provider: 'openrouter',
    model: '',
    target: { type: 'github', repo: '', branch: 'main', dir: 'docs', token: '', url: '', siteUrl: '' },
  };
}

function validTimezone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

function cleanDir(d) {
  const parts = String(d || '').split('/').map((p) => p.trim()).filter(Boolean);
  if (parts.some((p) => p === '..' || p === '.' || !/^[\w.-]+$/.test(p))) return null;
  return parts.join('/');
}

/** Normalizes what the admin page sends. `prev` supplies the token when the form leaves it blank. */
export function normalizeConfig(input, prev = null) {
  const base = defaultConfig();
  const c = input && typeof input === 'object' ? input : {};
  const t = c.target && typeof c.target === 'object' ? c.target : {};
  const hours = [...new Set((Array.isArray(c.hours) ? c.hours : base.hours)
    .map((h) => Math.round(Number(h))).filter((h) => Number.isFinite(h) && h >= 0 && h <= 23))]
    .sort((a, b) => a - b).slice(0, 6);
  const type = t.type === 'webhook' ? 'webhook' : 'github';
  const dir = cleanDir(t.dir ?? base.target.dir);
  const siteRaw = String(t.siteUrl || '').trim();
  const prevTarget = prev?.target || {};
  const token = String(t.token || '').trim()
    || (prevTarget.type === type || !t.type ? String(prevTarget.token || '') : '');
  return {
    enabled: c.enabled === true,
    brief: String(c.brief || '').trim().slice(0, 2000),
    hours: hours.length ? hours : base.hours,
    timezone: validTimezone(String(c.timezone || '').trim()) ? String(c.timezone).trim() : 'UTC',
    provider: PROVIDERS[c.provider] ? c.provider : base.provider,
    model: String(c.model || '').trim().slice(0, 200),
    target: {
      type,
      repo: /^[\w.-]+\/[\w.-]+$/.test(String(t.repo || '').trim()) ? String(t.repo).trim() : '',
      branch: /^[\w./-]+$/.test(String(t.branch || '').trim()) ? String(t.branch).trim() : 'main',
      dir: dir ?? 'docs',
      token,
      url: /^https:\/\/\S+$/.test(String(t.url || '').trim()) ? String(t.url).trim() : '',
      siteUrl: /^https?:\/\/\S+$/.test(siteRaw) ? `${siteRaw.replace(/\/+$/, '')}/` : '',
    },
  };
}

/** What the browser may see: everything except the token. */
export function publicConfig(c) {
  const { token, ...target } = c.target || {};
  return { ...c, target: { ...target, hasToken: !!token } };
}

/** Why this config cannot publish yet, or null. */
export function configProblem(c) {
  if (c.target.type === 'github') {
    if (!c.target.repo) return 'Set the GitHub repo as owner/name.';
    if (!c.target.token) return 'Add a GitHub token with write access to that repo.';
  } else if (!c.target.url) {
    return 'Set the webhook URL (https).';
  }
  return null;
}

export async function loadConfig() {
  if (!KV_ENABLED) return defaultConfig();
  try {
    const raw = await kvGet(CONFIG_KEY);
    const stored = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return stored ? normalizeConfig(stored, stored) : defaultConfig();
  } catch {
    return defaultConfig();
  }
}

export async function saveConfig(input) {
  if (!KV_ENABLED) throw new Error('KV is not configured');
  const prev = await loadConfig();
  const next = normalizeConfig(input, prev);
  await kvSet(CONFIG_KEY, next);
  return next;
}

// ── state ────────────────────────────────────────────────────────────────

function emptyState() {
  return { done: {}, attempts: {}, history: [], lastRun: null };
}

export async function loadState() {
  if (!KV_ENABLED) return emptyState();
  try {
    const raw = await kvGet(STATE_KEY);
    const s = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return { ...emptyState(), ...(s && typeof s === 'object' ? s : {}) };
  } catch {
    return emptyState();
  }
}

async function saveState(state) {
  // Slot records only matter for a few days.
  const cutoff = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
  for (const k of Object.keys(state.done)) if (k.slice(0, 10) < cutoff) delete state.done[k];
  for (const k of Object.keys(state.attempts)) if (k.slice(0, 10) < cutoff) delete state.attempts[k];
  state.history = state.history.slice(0, HISTORY_KEPT);
  await kvSet(STATE_KEY, state);
}

// ── schedule ─────────────────────────────────────────────────────────────

/** Local date and hour in the configured timezone. */
export function localParts(now, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(now));
  const get = (t) => parts.find((p) => p.type === t)?.value || '00';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')), minute: Number(get('minute')) };
}

const slotKey = (date, hour) => `${date}@${String(hour).padStart(2, '0')}`;

/** Today's slots whose time has come and that nothing has handled yet, oldest first. */
export function dueSlots(config, state, now = Date.now()) {
  const { date, hour } = localParts(now, config.timezone);
  return config.hours
    .filter((h) => hour >= h)
    .map((h) => slotKey(date, h))
    .filter((k) => !state.done[k]);
}

/** The next slot after now, as "YYYY-MM-DD@HH", for the admin status line. */
export function nextSlot(config, state, now = Date.now()) {
  const due = dueSlots(config, state, now);
  if (due.length) return due[0];
  const { date, hour } = localParts(now, config.timezone);
  const later = config.hours.find((h) => h > hour && !state.done[slotKey(date, h)]);
  if (later != null) return slotKey(date, later);
  const tomorrow = localParts(now + 86_400_000, config.timezone).date;
  return slotKey(tomorrow, config.hours[0]);
}

// ── model calls ──────────────────────────────────────────────────────────

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('cancelled')); }, { once: true });
});

function reasoningOff(body, providerId) {
  if (providerId === 'venice') {
    return { ...body, venice_parameters: { ...(body.venice_parameters || {}), disable_thinking: true } };
  }
  if (providerId === 'openrouter') return { ...body, reasoning: { effort: 'low', exclude: true } };
  return body;
}

/** One chat completion with retries; a retired model is swapped once for the provider's current one. */
export function makeComplete({ resolved, model: chosen, providerId, signal }) {
  let model = chosen;
  let swapped = false;
  async function complete(messages, { temperature = 0.7, maxTokens = 1500, timeoutMs = 240_000 } = {}) {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(resolved.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resolved.apiKey}`, ...resolved.extraHeaders() },
          body: JSON.stringify(reasoningOff(
            withProviderChatExtras({ model, messages, stream: false, temperature, max_tokens: maxTokens }, providerId),
            providerId,
          )),
          signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        });
      } catch (err) {
        if (signal.aborted) throw new Error('cancelled');
        if (attempt >= 2) throw new Error(`${resolved.label} unreachable: ${err.message}`);
        await sleep(1500 * 2 ** attempt, signal);
        continue;
      }
      const raw = await res.text();
      if (!res.ok && !swapped && isModelGoneError(res.status, raw)) {
        swapped = true;
        const next = await replacementFor(providerId, model, 'coder').catch(() => null);
        if (next && next !== model) { model = next; continue; }
      }
      if (!res.ok) {
        const retryable = [408, 409, 429].includes(res.status) || res.status >= 500;
        if (!retryable || attempt >= 2) throw new Error(formatProviderError(resolved.label, res.status, raw, model));
        await sleep(Math.min(30_000, 2000 * 2 ** attempt), signal);
        continue;
      }
      let data;
      try { data = JSON.parse(raw); } catch { data = null; }
      const choice = data?.choices?.[0];
      complete.last = { finish: choice?.finish_reason || '', model };
      return String(choice?.message?.content ?? '').trim();
    }
  }
  complete.last = { finish: '', model: chosen };
  return complete;
}

async function pickModel(config) {
  if (config.model) return config.model;
  const models = await liveModels(config.provider);
  const m = pickDefault(models, 'coder', { providerId: config.provider });
  if (!m) throw new Error(`No usable model found for ${config.provider}. Set one in Daily pages settings.`);
  return m;
}

// ── the page ─────────────────────────────────────────────────────────────

const TOPIC_SYSTEM = `You are the editor of a daily site of small interactive web pages. Pick today's page.
- It must be something a person can DO in the browser — click, type, drag, slide — not an article.
- Fit the site's brief, and be clearly different from every recent page you are shown.
- Real and specific ("Compound interest with a monthly top-up slider"), never vague ("A fun tool").
- Buildable as ONE self-contained HTML file in about 300 lines of JavaScript, with no libraries, no network, no images.`;
const TOPIC_SHAPE = '{"title":"","slug":"kebab-case","description":"one sentence a visitor sees on the index","idea":"what it does and how you interact with it, 2-4 sentences"}';

const PAGE_SYSTEM = `You build ONE self-contained interactive web page. Reply with ONLY the complete HTML document, starting with <!doctype html>. No markdown fences, no commentary.
Rules, all of them checked by a machine before the page is published:
- One file: inline <style> and inline <script>. A plain <script> — no type="module", no import, no external anything.
- No network at all: no fetch, XMLHttpRequest, WebSocket, external images, fonts, scripts, iframes. Draw with CSS, inline SVG or <canvas>.
- Interactive: the visitor clicks, types, drags or moves sliders and the page visibly responds. Wire every control with addEventListener.
- Includes <meta name="viewport" content="width=device-width, initial-scale=1">, a <title>, and one line on the page saying how to use it.
- Works on a phone: controls at least 44px, nothing hover-only. Readable contrast. Respect prefers-reduced-motion.
- Robust: look up every element by id and make sure the id exists in your HTML; never assume a library. Keep the JavaScript under about 300 lines and re-read it for errors before you answer.
- Real content only: no lorem ipsum, no placeholder labels, no "coming soon".
- Keep the whole file under 35 KB.`;

/** Pulls the HTML document out of a reply that may be fenced or chatty. */
export function extractHtml(raw) {
  let text = String(raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fenced = /```(?:html)?\s*\n([\s\S]*?)(?:```|$)/i.exec(text);
  if (fenced && /<!doctype|<html/i.test(fenced[1])) text = fenced[1].trim();
  const start = text.search(/<!doctype\s+html|<html[\s>]/i);
  if (start > 0) text = text.slice(start);
  const end = text.toLowerCase().lastIndexOf('</html>');
  if (end !== -1) text = text.slice(0, end + 7);
  return text.trim();
}

const FORBIDDEN_CALLS = [
  [/\bfetch\s*\(/, 'fetch()'], [/\bXMLHttpRequest\b/, 'XMLHttpRequest'], [/\bWebSocket\b/, 'WebSocket'],
  [/\bEventSource\b/, 'EventSource'], [/\bsendBeacon\b/, 'sendBeacon'], [/\bimportScripts\b/, 'importScripts'],
  [/\beval\s*\(/, 'eval()'], [/\bnew\s+Function\s*\(/, 'new Function()'], [/\bdocument\.write\s*\(/, 'document.write()'],
  [/\bwindow\.open\s*\(/, 'window.open()'], [/\bdocument\.cookie\b/, 'document.cookie'],
  [/\b(?:window\.|document\.|top\.|parent\.)?location\s*(?:\.\s*(?:href|assign|replace)\s*)?(?:=[^=]|\()/, 'changing the page location'],
];

/**
 * Hard checks a page must pass before it can be published. Cheap and static:
 * structure, forbidden network/navigation, and every inline script must at
 * least compile. It cannot prove the page works — see the preview in /admin.
 */
export function validatePage(rawHtml) {
  const problems = [];
  let html = extractHtml(rawHtml);
  const bytes = Buffer.byteLength(html, 'utf8');
  if (bytes < MIN_HTML_BYTES) problems.push(`Too small (${bytes} bytes) — a real page is needed, not a stub.`);
  if (bytes > MAX_HTML_BYTES) problems.push(`Too large (${Math.round(bytes / 1000)} KB). Keep it under 35 KB.`);
  if (!/^<!doctype\s+html/i.test(html)) problems.push('Must start with <!doctype html>.');
  if (!/<\/html>\s*$/i.test(html)) problems.push('The document is cut off — it must end with </html>. Make it shorter and more compact.');
  if (!/<body[\s>]/i.test(html)) problems.push('Missing <body>.');
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '').replace(/\s+/g, ' ').trim();
  if (!title) problems.push('Missing a <title>.');

  if (/<(?:iframe|object|embed|base)\b/i.test(html)) problems.push('No <iframe>, <object>, <embed> or <base>.');
  if (/<meta[^>]+http-equiv\s*=\s*["']?refresh/i.test(html)) problems.push('No meta refresh.');
  if (/\bsrc\s*=\s*["']?(?:https?:)?\/\//i.test(html)) problems.push('No external src — nothing may load from the network.');
  if (/<link\b[^>]*\bhref\s*=\s*["']?(?:https?:)?\/\//i.test(html)) problems.push('No external <link>.');
  if (/@import|url\(\s*["']?(?:https?:)?\/\//i.test(html)) problems.push('No external CSS (@import or url(http…)).');

  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  let code = '';
  for (const [, attrs, body] of scripts) {
    if (/\bsrc\s*=/i.test(attrs)) { problems.push('No <script src> — inline script only.'); continue; }
    if (/type\s*=\s*["']?module/i.test(attrs)) { problems.push('No type="module" scripts — use a plain <script>.'); continue; }
    if (/type\s*=\s*["']?(?!text\/javascript|application\/javascript)[\w/+-]+/i.test(attrs)) continue;
    code += `${body}\n`;
    try {
      new vm.Script(body, { filename: 'page.js' });
    } catch (err) {
      const line = /page\.js:(\d+)/.exec(String(err.stack || ''))?.[1];
      problems.push(`JavaScript syntax error${line ? ` at script line ${line}` : ''}: ${String(err.message).slice(0, 160)}`);
    }
  }
  if (code.trim().length < 80) problems.push('Needs real JavaScript that makes it interactive.');
  for (const [re, label] of FORBIDDEN_CALLS) {
    if (re.test(code)) problems.push(`Not allowed: ${label}.`);
  }
  const wired = /\baddEventListener\s*\(/.test(code) || /\bon(?:click|input|change|keydown|keyup|pointer\w*|mouse\w*|touch\w*)\s*=/i.test(html);
  const hasControl = /<(?:button|input|select|textarea|canvas|svg)\b/i.test(html) || /\bon(?:click|pointer\w*)\s*=/i.test(html);
  if (!wired || !hasControl) problems.push('Not interactive: add controls (buttons, inputs, canvas…) and wire them with addEventListener.');

  // Safe fix-ups, not failures.
  if (!/<meta[^>]+name\s*=\s*["']viewport/i.test(html)) {
    html = /<head[^>]*>/i.test(html)
      ? html.replace(/<head[^>]*>/i, (m) => `${m}\n<meta name="viewport" content="width=device-width, initial-scale=1">`)
      : html.replace(/<html[^>]*>/i, (m) => `${m}\n<head><meta name="viewport" content="width=device-width, initial-scale=1"></head>`);
  }
  if (!/<meta[^>]+charset/i.test(html)) {
    html = html.replace(/<head[^>]*>/i, (m) => `${m}\n<meta charset="utf-8">`);
  }
  return { ok: problems.length === 0, problems, html, title, bytes };
}

const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

async function chooseTopic(complete, config, history) {
  const recent = history.slice(0, 40).map((h) => h.title);
  const recentSlugs = new Set(history.slice(0, 80).map((h) => slugify(h.title)));
  const kind = KINDS[history.length % KINDS.length];
  return completeJSON(complete, {
    label: 'topic',
    system: TOPIC_SYSTEM,
    shape: TOPIC_SHAPE,
    user: [
      `SITE BRIEF: ${config.brief || DEFAULT_BRIEF}`,
      `Today lean toward: ${kind}.`,
      recent.length ? `RECENT PAGES (do not repeat or closely resemble any):\n${recent.map((t) => `- ${t}`).join('\n')}` : 'No pages yet.',
    ].join('\n\n'),
    temperature: 0.9,
    maxTokens: 500,
    validate: (o) => {
      const title = String(o?.title || '').trim();
      if (title.length < 3 || title.length > 80) throw new Error('"title" must be 3-80 characters');
      const slug = slugify(o.slug || title);
      if (!slug) throw new Error('"slug" must be kebab-case text');
      if (recentSlugs.has(slug) || recentSlugs.has(slugify(title))) throw new Error(`"${title}" repeats a recent page. Pick something clearly different.`);
      const description = String(o?.description || '').trim().slice(0, 200);
      const idea = String(o?.idea || '').trim();
      if (description.length < 10) throw new Error('"description" must be one real sentence');
      if (idea.length < 20) throw new Error('"idea" must say what it does and how you interact with it');
      return { title, slug, description, idea: idea.slice(0, 700) };
    },
  });
}

async function writePage(complete, topic, onProgress) {
  const messages = [
    { role: 'system', content: PAGE_SYSTEM },
    { role: 'user', content: `Build this page.\nTitle: ${topic.title}\nWhat it is: ${topic.idea}` },
  ];
  let last = null;
  for (let attempt = 0; attempt <= 2; attempt++) {
    if (attempt) onProgress?.(`fixing the page (try ${attempt + 1})`);
    const raw = await complete(messages, { temperature: attempt ? 0.4 : 0.7, maxTokens: 14_000, timeoutMs: 280_000 });
    last = validatePage(raw);
    if (complete.last?.finish === 'length' && !last.problems.some((p) => /cut off/.test(p))) {
      last.problems.push('The reply was cut off at the length limit. Make the page shorter and more compact.');
      last.ok = false;
    }
    if (last.ok) return last;
    messages.push(
      { role: 'assistant', content: String(raw || '').slice(0, 20_000) },
      { role: 'user', content: `A machine check rejected this page:\n${last.problems.map((p) => `- ${p}`).join('\n')}\nReply again with the complete corrected HTML document only.` },
    );
  }
  throw new Error(`The model could not produce a page that passes the checks: ${last.problems.slice(0, 4).join(' | ')}`);
}

// ── publishing ───────────────────────────────────────────────────────────

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The index page that lists every page, newest first. Pure static HTML. */
export function buildIndexHtml(manifest) {
  const cards = manifest.map((p) => `    <li><a href="${esc(p.folder)}/"><strong>${esc(p.title)}</strong><span>${esc(p.description || '')}</span><time>${esc(p.date)}</time></a></li>`).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Daily pages</title>
<style>
  :root { --bg:#fff; --fg:#14161c; --muted:#5b6070; --card:#f3f4f8; --line:#dcdfe8; --accent:#c2185b; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0b0d12; --fg:#eceef3; --muted:#9198aa; --card:#12151d; --line:#232838; --accent:#ff6fae; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:17px/1.5 system-ui,-apple-system,Segoe UI,sans-serif; }
  main { max-width: 720px; margin: 0 auto; padding: 28px 16px 64px; }
  h1 { margin: 0 0 4px; font-size: 28px; }
  p.lead { margin: 0 0 24px; color: var(--muted); }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
  a { display: block; padding: 14px 16px; border: 1px solid var(--line); background: var(--card); border-radius: 12px; color: inherit; text-decoration: none; }
  a:hover, a:focus-visible { border-color: var(--accent); outline: none; }
  strong { display: block; font-size: 18px; }
  span { display: block; color: var(--muted); margin-top: 2px; }
  time { display: block; color: var(--muted); font-size: 13px; margin-top: 6px; }
</style>
</head>
<body>
<main>
  <h1>Daily pages</h1>
  <p class="lead">${manifest.length} interactive ${manifest.length === 1 ? 'page' : 'pages'}. New ones arrive every day.</p>
  <ul>
${cards}
  </ul>
</main>
</body>
</html>
`;
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const joinPath = (...p) => p.filter(Boolean).join('/');

async function ghFetch(token, path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'daily-pages',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  return res;
}

function ghError(res, body, what) {
  if (res.status === 401) return `GitHub rejected the token (401) while ${what}. Make a new token and save it.`;
  if (res.status === 403) return `GitHub refused (403) while ${what}: the token needs Contents read & write on this repo. ${String(body).slice(0, 120)}`;
  if (res.status === 404) return `GitHub says not found (404) while ${what}. Check the repo name, and that the token can see that repo.`;
  return `GitHub error ${res.status} while ${what}: ${String(body).slice(0, 200)}`;
}

/** All changes in ONE commit, so the site never shows a page its index doesn't know about. */
async function commitFiles(target, files, message) {
  const { repo, branch, token } = target;
  for (let attempt = 0; attempt < 2; attempt++) {
    const refRes = await ghFetch(token, `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch).replace(/%2F/g, '/')}`);
    const refBody = await refRes.text();
    if (refRes.status === 404) {
      throw new Error(`Branch "${branch}" was not found in ${repo}. Create the repo with at least one commit (a README is enough) first.`);
    }
    if (!refRes.ok) throw new Error(ghError(refRes, refBody, 'reading the branch'));
    const head = JSON.parse(refBody)?.object?.sha;
    if (!head) throw new Error(`GitHub did not return the head of ${branch}.`);

    const res = await ghFetch(token, '/graphql', {
      method: 'POST',
      body: JSON.stringify({
        query: 'mutation($input: CreateCommitOnBranchInput!){ createCommitOnBranch(input:$input){ commit{ oid url } } }',
        variables: {
          input: {
            branch: { repositoryNameWithOwner: repo, branchName: branch },
            message: { headline: message },
            expectedHeadOid: head,
            fileChanges: { additions: files.map((f) => ({ path: f.path, contents: b64(f.content) })) },
          },
        },
      }),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* handled below */ }
    if (res.ok && json?.data?.createCommitOnBranch?.commit) return json.data.createCommitOnBranch.commit;
    const msg = json?.errors?.map((e) => e.message).join('; ') || text;
    // Someone pushed between our read and our commit: re-read the head and go again.
    if (attempt === 0 && /expected branch to point|head oid|expectedHeadOid/i.test(msg)) continue;
    if (!res.ok) throw new Error(ghError(res, text, 'committing'));
    throw new Error(`GitHub would not take the commit: ${String(msg).slice(0, 240)}`);
  }
  throw new Error('GitHub kept moving the branch; try again next run.');
}

async function readManifest(target) {
  const path = joinPath(target.dir, 'manifest.json');
  const res = await ghFetch(target.token, `/repos/${target.repo}/contents/${path}?ref=${encodeURIComponent(target.branch)}`);
  if (res.status === 404) return [];
  const body = await res.text();
  if (!res.ok) throw new Error(ghError(res, body, 'reading manifest.json'));
  try {
    const j = JSON.parse(body);
    const list = JSON.parse(Buffer.from(j.content || '', 'base64').toString('utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    throw new Error('manifest.json in the repo is not valid JSON — fix or delete it, then the next run will rebuild it.');
  }
}

async function publishGithub(target, entry, html) {
  const manifest = await readManifest(target);
  let folder = entry.folder;
  for (let n = 2; manifest.some((m) => m.folder === folder); n++) folder = `${entry.folder}-${n}`;
  const full = { ...entry, folder };
  const next = [full, ...manifest].slice(0, 500);
  const commit = await commitFiles(target, [
    { path: joinPath(target.dir, folder, 'index.html'), content: html },
    { path: joinPath(target.dir, 'manifest.json'), content: `${JSON.stringify(next, null, 2)}\n` },
    { path: joinPath(target.dir, 'index.html'), content: buildIndexHtml(next) },
  ], `Daily page: ${entry.title}`);
  return {
    folder,
    commitUrl: commit.url,
    url: target.siteUrl ? `${target.siteUrl}${folder}/` : commit.url,
  };
}

async function publishWebhook(target, entry, html) {
  const res = await fetch(target.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(target.token ? { Authorization: `Bearer ${target.token}` } : {}) },
    body: JSON.stringify({ event: 'daily-page', ...entry, html }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`The website answered ${res.status}: ${text.slice(0, 200)}`);
  let url = '';
  try { url = String(JSON.parse(text)?.url || ''); } catch { /* plain body is fine */ }
  return { folder: entry.folder, url: /^https?:\/\//.test(url) ? url : (target.siteUrl ? `${target.siteUrl}${entry.folder}/` : target.url), commitUrl: '' };
}

// ── one page, start to finish ────────────────────────────────────────────

/**
 * Makes one page and (unless dryRun) posts it. Throws with a plain reason on
 * any failure. `slot` is "YYYY-MM-DD@HH" for scheduled runs or null for a manual one.
 */
export async function makeOnePage(config, state, { slot = null, dryRun = false, now = Date.now(), signal, onProgress } = {}) {
  const problem = dryRun ? null : configProblem(config);
  if (problem) throw new Error(problem);
  const resolved = resolveProvider(config.provider);
  const model = await pickModel(config);
  const complete = makeComplete({ resolved, model, providerId: config.provider, signal: signal || new AbortController().signal });

  onProgress?.('choosing the page');
  const topic = await chooseTopic(complete, config, state.history);
  onProgress?.(`writing "${topic.title}"`);
  const page = await writePage(complete, topic, onProgress);

  const { date, hour, minute } = localParts(now, config.timezone);
  const stamp = slot ? slot.slice(11).padStart(2, '0') + '00' : `${String(hour).padStart(2, '0')}${String(minute).padStart(2, '0')}`;
  const entry = {
    title: page.title || topic.title,
    description: topic.description,
    folder: `${date}-${stamp}-${topic.slug}`,
    date,
    createdAt: new Date(now).toISOString(),
  };
  if (dryRun) return { dryRun: true, ...entry, html: page.html, bytes: page.bytes, model: complete.last.model };

  onProgress?.('publishing');
  const out = config.target.type === 'webhook'
    ? await publishWebhook(config.target, entry, page.html)
    : await publishGithub(config.target, entry, page.html);
  return { ...entry, folder: out.folder, url: out.url, commitUrl: out.commitUrl, model: complete.last.model, bytes: page.bytes };
}

function recordSuccess(state, slot, result, now) {
  const rec = { title: result.title, folder: result.folder, url: result.url, at: new Date(now).toISOString(), slot: slot || 'manual', model: result.model };
  if (slot) state.done[slot] = rec;
  state.history.unshift(rec);
  state.lastRun = { ok: true, at: rec.at, slot: rec.slot, title: result.title, url: result.url };
}

function recordFailure(state, slot, err, now) {
  const at = new Date(now).toISOString();
  const error = String(err?.message || err).slice(0, 400);
  if (slot) {
    state.attempts[slot] = (state.attempts[slot] || 0) + 1;
    if (state.attempts[slot] >= MAX_ATTEMPTS_PER_SLOT) state.done[slot] = { failed: true, error, at };
  }
  state.lastRun = { ok: false, at, slot: slot || 'manual', error, attempts: slot ? state.attempts[slot] : undefined };
}

async function acquire(key) {
  const k = LOCK_PREFIX + key;
  const n = await kvIncr(k);
  if (n !== 1) return false;
  await kvExpire(k, 3300).catch(() => {});
  return true;
}

/** A manual run from /admin: publishes (or previews) one page right now. */
export async function runManual({ dryRun = false, now = Date.now() } = {}) {
  if (!KV_ENABLED) throw new Error('KV is not configured.');
  const config = await loadConfig();
  const state = await loadState();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 700_000);
  try {
    const result = await makeOnePage(config, state, { dryRun, now, signal: controller.signal });
    if (!dryRun) { recordSuccess(state, null, result, now); await saveState(state); }
    return result;
  } catch (err) {
    if (!dryRun) { recordFailure(state, null, err, now); await saveState(state).catch(() => {}); }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** The cron: publish every slot that is due and not yet done, within a time budget. */
export async function runDueSlots({ now = Date.now() } = {}) {
  if (!KV_ENABLED) return { skipped: 'KV is not configured' };
  const config = await loadConfig();
  if (!config.enabled) return { skipped: 'disabled' };
  const problem = configProblem(config);
  if (problem) return { skipped: problem };
  const state = await loadState();
  const due = dueSlots(config, state, now);
  if (!due.length) return { ran: [], next: nextSlot(config, state, now) };

  const started = Date.now();
  const ran = [];
  for (const slot of due.slice(0, MAX_SLOTS_PER_RUN)) {
    if (ran.length && Date.now() - started > RUN_BUDGET_MS) break;
    if (!(await acquire(slot))) { ran.push({ slot, skipped: 'another run has it' }); continue; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 600_000);
    try {
      const result = await makeOnePage(config, state, { slot, now, signal: controller.signal });
      recordSuccess(state, slot, result, now);
      ran.push({ slot, ok: true, title: result.title, url: result.url });
    } catch (err) {
      recordFailure(state, slot, err, now);
      ran.push({ slot, ok: false, error: String(err?.message || err).slice(0, 300) });
    } finally {
      clearTimeout(timer);
      await saveState(state).catch((e) => console.error('daily-pages saveState failed:', e));
    }
  }
  return { ran, next: nextSlot(config, state, now) };
}
