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
