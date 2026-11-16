document.documentElement.classList.add('js');

// soft light that follows the cursor
const root = document.documentElement;
let raf = 0;
addEventListener('pointermove', (e) => {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    root.style.setProperty('--mx', e.clientX + 'px');
    root.style.setProperty('--my', e.clientY + 'px');
    raf = 0;
  });
}, { passive: true });

// reveal on scroll, staggered inside each group
const groups = new Map();
document.querySelectorAll('.reveal').forEach((el) => {
  const p = el.parentElement;
  const i = groups.get(p) || 0;
  groups.set(p, i + 1);
  el.style.setProperty('--d', Math.min(i, 5) * 0.08 + 's');
});
const io = new IntersectionObserver((entries) => {
  entries.forEach((en) => { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } });
}, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
document.querySelectorAll('.reveal').forEach((el) => io.observe(el));

document.getElementById('yr').textContent = new Date().getFullYear();

// Contact form: posts to the agency's lead intake. Any failure falls back to plain email.
(() => {
  const form = document.getElementById('leadForm');
  if (!form) return;
  const status = document.getElementById('leadStatus');
  const url = document.querySelector('meta[name="leads-url"]')?.content || '';
  const say = (t, bad) => { status.textContent = t; status.classList.toggle('bad', !!bad); };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(data.email || '').trim())) return say('Please enter a valid email so we can reply.', true);
    if (String(data.message || '').trim().length < 5) return say('Tell us a little about what you need.', true);
    const button = form.querySelector('button[type=submit]');
    button.disabled = true; say('Sending…');
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...data, source: 'semantiq-site' }) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || 'Could not send');
      form.reset();
      say('Thanks — we got it. You’ll hear from us shortly.');
    } catch (err) {
      say(`${err.message || 'Could not send'} You can also email hello@thesemantiq.com.`, true);
    } finally { button.disabled = false; }
  });
})();

// Free site checker: score first (nothing saved), then an optional email unlocks the full list and becomes a lead.
(() => {
  const form = document.getElementById('checkForm');
  if (!form) return;
  const leadsUrl = document.querySelector('meta[name="leads-url"]')?.content || '';
  const checkUrl = leadsUrl.replace('op=lead', 'op=check');
  const status = document.getElementById('checkStatus');
  const box = document.getElementById('checkResult');
  const say = (t, bad) => { status.textContent = t; status.classList.toggle('bad', !!bad); };
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; };
  const ICON = { pass: '✓', warn: '!', fail: '✕' };

  function show(report) {
    box.replaceChildren();
    if (report.blocked) { box.append(el('p', 'check-blocked', report.blocked)); box.hidden = false; return; }
    const head = el('div', 'check-head');
    const score = el('div', `check-score g-${report.grade}`); score.append(el('b', '', String(report.score)), el('span', '', `/100 · grade ${report.grade}`));
    head.append(score, el('p', '', report.score >= 80 ? 'A solid base — a few fixes would still win you more customers.' : report.score >= 55 ? 'There are real gaps here that are likely costing you visitors and rankings.' : 'This site has serious problems that are almost certainly costing you customers.'));
    box.append(head);
    box.append(el('h3', '', 'Your top fixes'));
    const top = el('ol', 'check-top');
    report.topFixes.forEach((c) => { const li = el('li'); li.append(el('strong', '', c.label), el('span', '', c.detail), el('em', '', c.fix)); top.append(li); });
    box.append(top);

    const full = el('div', 'check-full'); full.hidden = true;
    report.checks.forEach((c) => { const row = el('div', `check-row s-${c.status}`); row.append(el('i', '', ICON[c.status]), el('span', '', c.label), el('small', '', c.status === 'pass' ? c.detail : c.fix)); full.append(row); });

    const gate = el('form', 'check-gate'); gate.noValidate = true;
    const email = el('input'); email.type = 'email'; email.placeholder = 'Your email'; email.required = true; email.autocomplete = 'email'; email.maxLength = 200;
    const hp = el('input', 'lf-hp'); hp.type = 'text'; hp.name = 'website'; hp.tabIndex = -1; hp.autocomplete = 'off';
    const go = el('button', 'btn'); go.type = 'submit'; go.append(el('span', '', 'Get the full report + a free walkthrough'));
    const msg = el('p', 'lf-status'); msg.setAttribute('role', 'status');
    gate.append(el('p', '', `There are ${report.checks.length - report.topFixes.length} more checks. Enter your email to see all of them and get a free 15-minute walkthrough.`), email, hp, go, msg);
    gate.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.value.trim())) { msg.textContent = 'Please enter a valid email.'; msg.classList.add('bad'); return; }
      go.disabled = true; msg.classList.remove('bad'); msg.textContent = 'Sending…';
      const lines = [`Site check for ${report.finalUrl}: ${report.score}/100 (grade ${report.grade}).`, 'Biggest problems:', ...report.topFixes.map((c, i) => `${i + 1}. ${c.label} — ${c.detail}`)];
      const rest = report.checks.filter((c) => c.status !== 'pass' && !report.topFixes.some((t) => t.id === c.id)).map((c) => c.label);
      if (rest.length) lines.push(`Also: ${rest.join(', ')}.`);
      lines.push('They asked for the full report and a free walkthrough.');
      try {
        const res = await fetch(leadsUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email.value.trim(), website: hp.value, message: lines.join('\n'), source: 'site-checker' }) });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(out.error || 'Could not send');
        full.hidden = false; gate.replaceChildren(el('p', 'lf-status', 'Thanks — the full report is below, and we’ll email you about the walkthrough.'));
      } catch (err) { msg.textContent = err.message || 'Could not send'; msg.classList.add('bad'); go.disabled = false; }
    });
    box.append(full, gate); box.hidden = false;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const site = new FormData(form).get('site');
    if (!String(site || '').trim()) return say('Enter your website address.', true);
    const button = form.querySelector('button'); button.disabled = true; box.hidden = true; say('Checking your site… this takes a few seconds.');
    try {
      const res = await fetch(checkUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ site }) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || 'Could not check that site.');
      say(''); show(out.report);
    } catch (err) { say(err.message || 'Could not check that site.', true); }
    finally { button.disabled = false; }
  });
})();
