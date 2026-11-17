// The Team page: leads and their approvals, the business the team works for, and what it did.
// Lead text comes from strangers, so every piece of it goes in with textContent — never innerHTML.

const root = document.getElementById('teamRoot');
let data = null;
let accounts = [];

const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid) n.append(kid);
  return n;
};
const btn = (label, onclick, cls = 'text-btn') => el('button', { class: cls, type: 'button', text: label, onclick });

async function api(op, { method = 'GET', id, body } = {}) {
  let res;
  try {
    res = await fetch(`/api/agency?op=${op}${id ? `&id=${encodeURIComponent(id)}` : ''}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      // Never spin forever: after a minute say so (the work may still have finished — reload to check).
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    throw new Error(err?.name === 'TimeoutError' ? 'That took over a minute with no answer. Reload the page and check whether it saved.' : (err?.message || 'Network error'));
  }
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
  return out;
}

/** Runs an action with a busy label on its button and shows any error beside it. */
async function act(button, errBox, fn, after = load) {
  const label = button.textContent;
  button.disabled = true; button.textContent = '…'; errBox.textContent = '';
  try {
    await fn(); await after();
    // A reload re-renders the page; anything else leaves this button in place, so give it back.
    if (after !== load) { button.disabled = false; button.textContent = label; }
  } catch (err) { errBox.textContent = err.message || String(err); button.disabled = false; button.textContent = label; }
}

const when = (iso) => { const d = new Date(iso); return Number.isNaN(+d) ? '' : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); };
const money = (n) => `$${Number(n || 0).toLocaleString()}`;

function leadCard(lead) {
  const err = el('div', { class: 'err' });
  if (lead.sendError) err.textContent = `Last send failed: ${lead.sendError}`;
  const needs = (lead.status === 'new' || lead.status === 'drafted');
  const subject = el('input', { type: 'text', value: lead.draft?.subject || '', placeholder: 'Subject' });
  subject.value = lead.draft?.subject || '';
  const body = el('textarea', { placeholder: lead.status === 'new' ? 'No draft yet — the team drafts new leads on the hour, or press Draft reply now.' : '' });
  body.value = lead.draft?.body || '';
  const value = el('input', { type: 'number', min: '0', placeholder: 'Deal value $' });
  if (lead.value != null) value.value = lead.value;
  const notes = el('input', { type: 'text', placeholder: 'Notes (only you see these)' });
  notes.value = lead.notes || '';

  const saveDraft = () => api('lead', { method: 'PUT', id: lead.id, body: { draft: { subject: subject.value, body: body.value, by: 'you' } } });
  const sendBtn = btn('Approve & send', () => {
    if (!data.emailReady) { err.textContent = 'No email account is set up yet — add one in Admin → Social accounts (platform: email).'; return; }
    if (!body.value.trim()) { err.textContent = 'Write or generate a draft first.'; return; }
    if (!confirm(`Send this email to ${lead.email}? It goes out immediately and cannot be recalled.`)) return;
    act(sendBtn, err, async () => { await saveDraft(); await api('send', { method: 'POST', id: lead.id }); });
  }, 'text-btn primary');
  const draftBtn = btn(lead.draft ? 'Redraft' : 'Draft reply now', () => act(draftBtn, err, () => api('draft', { method: 'POST', id: lead.id })));
  const saveBtn = btn('Save edits', () => act(saveBtn, err, saveDraft));
  const setStatus = (status) => (b) => act(b, err, () => api('lead', { method: 'PUT', id: lead.id, body: { status, value: value.value === '' ? null : value.value, notes: notes.value } }));
  const wonBtn = btn('Won', () => setStatus('won')(wonBtn));
  const lostBtn = btn('Lost', () => setStatus('lost')(lostBtn));
  const saveNotes = btn('Save notes/value', () => act(saveNotes, err, () => api('lead', { method: 'PUT', id: lead.id, body: { value: value.value === '' ? null : value.value, notes: notes.value } })));

  return el('div', { class: `lead${needs ? ' needs' : ''}` },
    el('div', { class: 'lead-head' },
      el('strong', { text: lead.name || lead.email }),
      el('span', { class: `pill ${lead.status}`, text: (lead.kind === 'outbound' ? 'outbound · ' : '') + (lead.status === 'drafted' ? 'ready — your approval' : lead.status) })),
    el('div', { class: 'lead-meta', text: [lead.email, lead.company, lead.source, when(lead.createdAt), lead.sentAt ? `sent ${when(lead.sentAt)}` : ''].filter(Boolean).join(' · ') }),
    el('div', { class: 'lead-msg', text: lead.message }),
    lead.status === 'sent' || lead.status === 'won' || lead.status === 'lost'
      ? el('details', {}, el('summary', { text: 'The reply that was sent / draft' }), el('div', { class: 'lead-msg', text: `${lead.draft?.subject || ''}\n\n${lead.draft?.body || ''}` }))
      : el('div', { class: 'field' },
          el('label', { text: `Reply${lead.draft?.by ? ` — drafted by ${lead.draft.by}` : ''}` }), subject, body,
          el('div', { class: 'row' }, sendBtn, saveBtn, draftBtn)),
    el('div', { class: 'row' }, value, notes, saveNotes, wonBtn, lostBtn),
    err);
}

function businessSection() {
  const b = data.business;
  const err = el('div', { class: 'err' });
  const profile = el('textarea', { rows: '9', spellcheck: 'false', placeholder: 'Who you are, who you serve, your voice, what you never say…' });
  profile.value = b.profile || '';
  const offers = el('textarea', { rows: '6', spellcheck: 'false', placeholder: 'One offer per line, with the price and what is included. e.g.\nStarter website — $900 — 5 pages, mobile, live in 2 weeks\nMonthly content — $600/mo — 12 posts + 1 campaign\nPayment link: https://…' });
  offers.value = b.offers || '';
  const save = btn('Save', () => act(save, err, () => api('business', { method: 'PUT', body: { profile: profile.value, offers: offers.value } })), 'text-btn primary');
  const discuss = btn('Have the team discuss it now', () => act(discuss, err, async () => {
    await api('business', { method: 'PUT', body: { profile: profile.value, offers: offers.value } });
    await api('discuss', { method: 'POST' });
  }));
  return el('section', { class: 'admin-section' },
    el('h2', { text: 'The business' }),
    el('p', { class: 'admin-hint', text: 'Every team persona (Vera, Dez, Nia, Priya, Marcus, Cole…) reads this in every chat, the autoposter reads it for every post, the comment replies read it, and Marcus quotes only the offers and prices below. Personal personas never see it.' }),
    el('div', { class: 'field' }, el('label', { text: 'About the business' }), profile),
    el('div', { class: 'field' }, el('label', { text: 'Offers and prices (what we sell)' }), offers),
    el('div', { class: 'row' }, save, discuss),
    err,
    b.notes ? el('details', { open: '' }, el('summary', { text: `The team's current strategy${b.notesAt ? ` — ${when(b.notesAt)}` : ''}` }), el('div', { class: 'lead-msg', text: b.notes })) : el('p', { class: 'admin-hint', text: 'No team strategy yet. Save the profile, then have the team discuss it (it also re-discusses weekly on its own).' }));
}

/** Outbound: check a prospect's own site, save it as a lead, and have the team draft a first email about what we found. You approve every send. */
function prospectSection() {
  const err = el('div', { class: 'err' });
  const site = el('input', { type: 'text', placeholder: 'Their website, e.g. sweetco-bakery.com' });
  const email = el('input', { type: 'text', placeholder: 'Their email (where the first message goes)' });
  const name = el('input', { type: 'text', placeholder: 'Contact name (optional)' });
  const company = el('input', { type: 'text', placeholder: 'Company (optional)' });
  const out = el('div', { class: 'admin-hint' });
  const go = btn('Check their site & draft the email', () => act(go, err, async () => {
    out.textContent = '';
    const r = await api('prospect', { method: 'POST', body: { site: site.value, email: email.value, name: name.value, company: company.value } });
    out.textContent = `${r.report.finalUrl}: ${r.report.score}/100 (${r.report.grade}). Drafting the email…`;
    await api('draft', { method: 'POST', id: r.lead.id });
  }), 'text-btn primary');
  return el('section', { class: 'admin-section' },
    el('h2', { text: 'Check a prospect’s site' }),
    el('p', { class: 'admin-hint', text: 'Cole-style outreach built on proof: we score their real site, then the closer drafts a first email that leads with what we found. It lands in “Needs your approval” — nothing is sent until you approve it. The draft includes an opt-out line; keep to your local email rules (a real sender address, honor “no thanks”).' }),
    el('div', { class: 'row' }, site, email), el('div', { class: 'row' }, name, company),
    el('div', { class: 'row' }, go), out, err);
}

/** Connections: the email account (paste your Resend key here — works on a phone) and each social account's autopost. */
function connectionsSection() {
  const emailAcct = accounts.find((a) => a.platform === 'email');
  const err = el('div', { class: 'err' });
  const ok = el('div', { class: 'admin-hint' });
  const from = el('input', { type: 'text', placeholder: 'From address, e.g. hello@yourdomain.com', autocomplete: 'off', autocapitalize: 'off' });
  from.value = emailAcct?.fromEmail || '';
  const key = el('input', { type: 'password', placeholder: emailAcct?.connected ? 'Key saved — leave blank to keep it' : 'Resend API key (starts with re_)', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  const test = el('input', { type: 'text', placeholder: 'Send a test email to (your email — optional)', autocomplete: 'off', autocapitalize: 'off' });
  const save = btn('Save email account', () => act(save, err, async () => {
    ok.textContent = '';
    const r = await api('email', { method: 'POST', body: { fromEmail: from.value, resendApiKey: key.value, testTo: test.value } });
    ok.textContent = r.test ? (r.test.ok ? 'Saved. Test email sent — check your inbox.' : `Saved, but the test failed: ${r.test.error}`) : 'Saved.';
  }), 'text-btn primary');

  const cards = accounts.filter((a) => a.platform !== 'email').map((a) => {
    const e = el('div', { class: 'err' });
    const out = el('div', { class: 'admin-hint' });
    const every = el('select', {}, ...['off', 'daily', 'hourly', 'weekly'].map((v) => el('option', { value: v, text: v === 'off' ? 'Autopost off' : `Autopost ${v}` })));
    every.value = a.autopostEvery || 'off';
    const per = el('input', { type: 'number', min: '1', max: '6', value: String(a.autopostPerDay || 1), title: 'Posts per day (used with daily)' });
    per.value = String(a.autopostPerDay || 1);
    const saveB = btn('Save schedule', () => act(saveB, e, () => api('account', { method: 'PUT', id: a.id, body: { autopostEvery: every.value, autopostPerDay: per.value } })));
    const now = btn('Post once now', async () => {
      now.disabled = true; now.textContent = 'Posting…'; e.textContent = ''; out.textContent = '';
      try {
        const res = await fetch(`/api/cron/run-standing-tasks?autopost=${encodeURIComponent(a.id)}`, { cache: 'no-store' });
        const body = await res.json().catch(() => ({}));
        const r = (body.autopost || [])[0];
        if (!res.ok || !r) throw new Error(body.error || `HTTP ${res.status}`);
        if (r.ok) out.textContent = `Posted: ${String(r.text || '').slice(0, 160)}`; else e.textContent = `Not posted: ${r.error}`;
      } catch (x) { e.textContent = x.message || String(x); }
      now.disabled = false; now.textContent = 'Post once now';
    });
    // Reconnect: paste a fresh token; the server swaps it for the Page's own never-expiring token.
    const reconnect = (a.platform === 'facebook' || a.platform === 'instagram') ? (() => {
      const re = el('div', { class: 'err' }); const rok = el('div', { class: 'admin-hint' });
      const tok = el('input', { type: 'password', placeholder: 'Paste a new Facebook token here', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
      const go = btn('Reconnect', () => act(go, re, async () => {
        rok.textContent = '';
        const r = await api('facebook-token', { method: 'POST', id: a.id, body: { token: tok.value } });
        rok.textContent = `Reconnected${r.pageName ? ` to ${r.pageName}` : ''}. This token does not expire. Tap “Post once now” to test.`;
      }, async () => {}), 'text-btn primary');
      const asIs = btn('Save it as-is', () => act(asIs, re, async () => {
        await api('facebook-token', { method: 'POST', id: a.id, body: { token: tok.value, asIs: true } });
        rok.textContent = 'Saved as-is (it may expire). Tap “Post once now” to test.';
      }, async () => {}));
      return el('details', { open: a.lastError || !a.connected ? '' : undefined },
        el('summary', { text: 'Reconnect this page (new token)' }),
        el('p', { class: 'admin-hint' }, 'Open ', el('a', { href: 'https://developers.facebook.com/tools/explorer/', target: '_blank', rel: 'noopener', text: 'developers.facebook.com/tools/explorer' }), ', pick your app, tap Generate Access Token, tick pages_show_list, pages_manage_posts and pages_read_engagement, approve, copy the token and paste it below. We turn it into a token that does not expire.'),
        el('div', { class: 'field' }, tok), el('div', { class: 'row' }, go, asIs), rok, re);
    })() : null;
    return el('div', { class: 'lead' },
      el('div', { class: 'lead-head' }, el('strong', { text: `${a.label} (${a.platform})` }),
        el('span', { class: `pill ${a.connected ? 'sent' : 'new'}`, text: a.connected ? 'connected' : 'missing token' })),
      el('div', { class: 'lead-meta', text: a.autopostEvery === 'off' ? 'Autopost is OFF — nothing posts on its own.' : `Autopost: ${a.autopostEvery}${a.autopostEvery === 'daily' ? `, ${a.autopostPerDay}/day` : ''}. Last post: ${a.lastPostAt ? when(a.lastPostAt) : 'never'}.` }),
      a.lastError ? el('div', { class: 'err', text: `Last error: ${a.lastError}` }) : null,
      el('div', { class: 'row' }, every, per, saveB, now), out, e, reconnect);
  });

  return el('section', { class: 'admin-section' },
    el('h2', { text: 'Connections' }),
    el('p', { class: 'admin-hint', text: emailAcct?.connected ? `Email is connected (${emailAcct.fromEmail}${emailAcct.fromEnv ? ', from your Vercel settings' : ''}). Approved replies send from it.` : 'Email is not connected yet, so approved replies cannot send. Paste your Resend details below.' }),
    el('div', { class: 'field' }, el('label', { text: 'Email account (Resend)' }), from, key, test),
    el('div', { class: 'row' }, save), ok, err,
    cards.length ? cards : el('p', { class: 'admin-hint', text: 'No social accounts yet. Add one in Admin → Social accounts.' }));
}

const HANDOFF_KEY = 'chat_to_team_v1';

/** Text sent here from a chat reply ("Send to… → Team"): adopt it as strategy, profile or offers, or dismiss it. */
function incomingCard() {
  let inc = null;
  try { inc = JSON.parse(sessionStorage.getItem(HANDOFF_KEY) || 'null'); } catch { /* ignore */ }
  if (!inc || !inc.content) return null;
  const err = el('div', { class: 'err' });
  const done = () => { try { sessionStorage.removeItem(HANDOFF_KEY); } catch { /* ignore */ } return load(); };
  const append = (cur, add) => `${cur ? `${cur.trim()}\n\n` : ''}${add.trim()}`;
  const asStrategy = btn('Make this the team’s strategy', () => act(asStrategy, err, () => api('business', { method: 'PUT', body: { notes: inc.content } }), done), 'text-btn primary');
  const toProfile = btn('Add to the business profile', () => act(toProfile, err, () => api('business', { method: 'PUT', body: { profile: append(data.business.profile, inc.content) } }), done));
  const toOffers = btn('Add to offers', () => act(toOffers, err, () => api('business', { method: 'PUT', body: { offers: append(data.business.offers, inc.content) } }), done));
  const dismiss = btn('Dismiss', () => { try { sessionStorage.removeItem(HANDOFF_KEY); } catch { /* ignore */ } render(); });
  return el('section', { class: 'admin-section' },
    el('h2', { text: `From your chat — ${inc.from || 'a reply'}` }),
    el('div', { class: 'lead-msg', text: inc.content }),
    el('div', { class: 'row' }, asStrategy, toProfile, toOffers, dismiss),
    err);
}

function render() {
  const s = data.summary;
  const needs = data.leads.filter((l) => l.status === 'new' || l.status === 'drafted');
  const rest = data.leads.filter((l) => !(l.status === 'new' || l.status === 'drafted'));
  const pauseErr = el('div', { class: 'err' });
  const pauseBtn = btn(data.control.paused ? 'Resume the team' : 'Pause everything automatic', () =>
    act(pauseBtn, pauseErr, () => api('control', { method: 'PUT', body: { paused: !data.control.paused, reason: data.control.paused ? '' : 'Paused from the Team page' } })));

  root.replaceChildren(
    incomingCard(),
    data.kv ? null : el('div', { class: 'banner', text: 'Storage (KV) is not configured, so leads, the profile and the team strategy cannot be saved.' }),
    data.control.paused ? el('div', { class: 'banner', text: `The team is paused — no autoposts, lead drafts or standing tasks run. ${data.control.reason || ''}` }) : null,
    !data.emailReady ? el('div', { class: 'banner', text: 'Replies cannot be sent yet: add an email account (Resend key + from-address) in Admin → Social accounts. Drafts still work.' }) : null,
    !data.notifyReady ? el('div', { class: 'banner', text: 'You will not be emailed when a lead arrives. Set LEAD_NOTIFY_EMAIL in Vercel to get a message (this page is the source of truth either way).' }) : null,
    el('section', { class: 'admin-section' },
      el('h2', { text: 'Money loop' }),
      el('div', { class: 'tiles' },
        el('div', { class: `tile${s.new + s.drafted ? ' hot' : ''}` }, el('b', { text: String(s.new + s.drafted) }), el('span', { text: 'waiting on you' })),
        el('div', { class: 'tile' }, el('b', { text: String(s.sent) }), el('span', { text: 'replied' })),
        el('div', { class: 'tile' }, el('b', { text: String(s.won) }), el('span', { text: 'won' })),
        el('div', { class: 'tile' }, el('b', { text: money(s.wonValue) }), el('span', { text: 'won value' })),
        el('div', { class: 'tile' }, el('b', { text: `${data.usage.posts}/${data.limits.postsPerDay}` }), el('span', { text: 'posts today' }))),
      el('div', { class: 'row' }, pauseBtn, pauseErr)),
    el('section', { class: 'admin-section' },
      el('h2', { text: `Needs your approval (${needs.length})` }),
      needs.length ? needs.map(leadCard) : el('p', { class: 'admin-hint', text: 'Nothing waiting. New inquiries from the website land here with a reply already drafted.' })),
    connectionsSection(),
    prospectSection(),
    businessSection(),
    rest.length ? el('section', { class: 'admin-section' }, el('h2', { text: `Handled (${rest.length})` }), rest.map(leadCard)) : null,
    el('section', { class: 'admin-section' },
      el('h2', { text: 'What the team did' }),
      data.activity.length
        ? el('ul', { class: 'activity' }, data.activity.map((a) => el('li', {}, `${a.personaName || 'Team'} ${a.verb || 'acted'}${a.platform ? ` (${a.platform})` : ''}`, el('small', { text: `${when(a.at)} — ${a.summary || ''}` }))))
        : el('p', { class: 'admin-hint', text: 'Nothing yet. Posts, comment replies and lead drafts show up here.' })));
}

async function load() {
  try {
    data = await api('overview');
    accounts = (await api('accounts').catch(() => ({ accounts: [] }))).accounts || [];
    render();
  }
  catch (err) { root.replaceChildren(el('div', { class: 'banner', text: `Could not load the Team page: ${err.message}` })); }
}
load();
