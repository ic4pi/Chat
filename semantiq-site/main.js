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
