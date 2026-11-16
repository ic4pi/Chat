// Site checker: address safety, URL normalizing, extraction, scoring — no network.
import { isBlockedIp, normalizeUrl, extractFacts, scoreSite, reportText, safeLookup, safeFetch } from '../lib/site-check.js';

let failed = 0;
const ok = (name, cond) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`); if (!cond) failed++; };
const throws = async (fn) => { try { await fn(); return false; } catch { return true; } };

// ── never connect to private space ──────────────────────────────────────
for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:a9fe:a9fe', 'not-an-ip']) {
  ok(`blocks ${ip}`, isBlockedIp(ip));
}
for (const ip of ['8.8.8.8', '93.184.216.34', '172.32.0.1', '2606:4700:4700::1111']) ok(`allows public ${ip}`, !isBlockedIp(ip));

// ── what people type ────────────────────────────────────────────────────
ok('a bare domain gets https', normalizeUrl('Example.com/about') === 'https://example.com/about');
ok('the fragment is dropped', normalizeUrl('https://example.com/#top') === 'https://example.com/');
for (const bad of ['', 'localhost', 'http://localhost/', 'http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/', 'ftp://example.com', 'file:///etc/passwd', 'javascript:alert(1)', 'https://user:pw@example.com', 'https://example.com:8080', 'http://intranet', 'http://printer.local', 'a'.repeat(600)]) {
  ok(`refuses "${bad.slice(0, 40)}"`, await throws(() => normalizeUrl(bad)));
}
ok('a name that resolves to loopback is refused at connect time', await new Promise((res) => safeLookup('localhost', {}, (err) => res(err?.code === 'EBLOCKED'))));
ok('safeFetch refuses a loopback address outright', await throws(() => safeFetch('http://127.0.0.1/')));

// ── extraction and scoring ──────────────────────────────────────────────
const GOOD = `<!doctype html><html lang="en"><head><title>Wedding Bakery in Austin | Sweet Co.</title>
<meta name="description" content="Custom wedding cakes and pastries in Austin. Order a tasting today and get a quote within one business day.">
<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="canonical" href="https://x.com/">
<meta property="og:title" content="Sweet Co."><meta property="og:image" content="https://x.com/i.jpg">
<script type="application/ld+json">{"@type":"Bakery"}</script></head>
<body><h1>Custom wedding cakes in Austin</h1><img src="a.jpg" alt="A three tier cake"><a href="tel:+15125550100">Call</a>
<p>${'We bake every cake to order with local ingredients. '.repeat(60)}</p></body></html>`;
const BAD = `<html><head><title>Home</title><meta name="robots" content="noindex, nofollow"></head><body><img src="a.jpg"><img src="b.jpg"><p>Welcome</p></body></html>`;
const ctxGood = { https: true, ttfbMs: 200, totalMs: 500, htmlBytes: 40_000, robotsTxt: true, sitemap: true };
const ctxBad = { https: false, ttfbMs: 2000, totalMs: 4000, htmlBytes: 900_000, robotsTxt: false, sitemap: false };

const fg = extractFacts(GOOD);
ok('extracts title, one h1, viewport, json-ld, contact and no missing alt', fg.title.startsWith('Wedding Bakery') && fg.h1Count === 1 && fg.viewport && fg.jsonLd && fg.contact && fg.imgsNoAlt === 0 && fg.words > 300);
const good = scoreSite(fg, ctxGood);
ok('a well-built site scores an A', good.score >= 95 && good.grade === 'A' && good.topFixes.length === 0);
const fb = extractFacts(BAD);
ok('detects noindex and missing alt text', fb.noindex && fb.imgsNoAlt === 2 && !fb.viewport);
const bad = scoreSite(fb, ctxBad);
ok('a broken site scores an F', bad.score < 30 && bad.grade === 'F');
ok('noindex, https and mobile are among the top fixes (the biggest points)', ['indexable', 'https', 'mobile'].every((id) => bad.topFixes.some((c) => c.id === id)));
ok('every failing check explains the fix in words', bad.checks.filter((c) => c.status !== 'pass').every((c) => c.fix.length > 20 && c.detail.length > 5));
ok('points add to 100', good.checks.reduce((t, c) => t + c.points, 0) === 100);
const txt = reportText({ finalUrl: 'https://x.com/', ...bad });
ok('the lead text names the score and the real findings', /\d+\/100/.test(txt) && /Biggest problems/.test(txt) && /Allowed to appear on Google/.test(txt));

// ── the fetch pipeline, against a local server on port 80 (test seam lets only 127.0.0.1 through) ──
import http from 'node:http';
import { checkSite, __setBlockCheckForTests } from '../lib/site-check.js';
__setBlockCheckForTests((ip) => ip !== '127.0.0.1' && isBlockedIp(ip));
const srv = http.createServer((req, res) => {
  if (req.url === '/') { res.setHeader('content-type', 'text/html'); return res.end(GOOD); }
  if (req.url === '/robots.txt') { res.setHeader('content-type', 'text/plain'); return res.end('User-agent: *\nSitemap: /sitemap.xml'); }
  if (req.url === '/sitemap.xml') { res.setHeader('content-type', 'application/xml'); return res.end('<urlset></urlset>'); }
  if (req.url === '/hop') { res.statusCode = 302; res.setHeader('location', '/'); return res.end(); }
  if (req.url === '/evil') { res.statusCode = 302; res.setHeader('location', 'http://169.254.169.254/latest/meta-data/'); return res.end(); }
  if (req.url === '/loop') { res.statusCode = 302; res.setHeader('location', '/loop'); return res.end(); }
  if (req.url === '/pdf') { res.setHeader('content-type', 'application/pdf'); return res.end('%PDF'); }
  if (req.url === '/gone') { res.statusCode = 404; return res.end('nope'); }
  if (req.url === '/huge') { res.setHeader('content-type', 'text/html'); res.write('<html><head><title>Big</title></head><body>'); const big = 'x'.repeat(100_000); let n = 0; const t = setInterval(() => { if (res.destroyed || ++n > 60) { clearInterval(t); res.end(); } else res.write(big); }, 1); return; }
  res.statusCode = 404; res.end();
});
await new Promise((r, j) => srv.once('error', j).listen(80, '127.0.0.1', r)).catch((e) => { console.log('SKIP fetch pipeline (cannot bind port 80):', e.code); });
if (srv.listening) {
  const r = await checkSite('http://127.0.0.1/');
  ok('end to end: fetches, extracts, scores, finds robots and sitemap', r.checks.find((c) => c.id === 'sitemap').status === 'pass' && r.checks.find((c) => c.id === 'robots').status === 'pass' && r.checks.find((c) => c.id === 'title').status === 'pass');
  ok('it knows plain http is not secure', r.checks.find((c) => c.id === 'https').status === 'fail');
  ok('a redirect is followed', (await checkSite('http://127.0.0.1/hop')).finalUrl === 'http://127.0.0.1/');
  ok('a redirect INTO private space is refused', await throws(() => checkSite('http://127.0.0.1/evil')));
  ok('a redirect loop ends', await throws(() => checkSite('http://127.0.0.1/loop')));
  ok('a non-web-page is refused', await throws(() => checkSite('http://127.0.0.1/pdf')));
  ok('an error page is reported, not scored', await throws(() => checkSite('http://127.0.0.1/gone')));
  const huge = await checkSite('http://127.0.0.1/huge');
  ok('a huge page is cut at the size cap and still scored', huge.checks.find((c) => c.id === 'weight').status === 'fail');
  srv.closeAllConnections?.(); srv.close();
}
__setBlockCheckForTests(null);

process.exit(failed ? 1 : 0);
