/**
 * Free site checker: fetch a public web page, score it 0-100 on the things that decide whether a small-business
 * site gets found and converts, and say the top fixes in plain words.
 *
 * It is a PUBLIC endpoint that fetches a URL a stranger chose, so the fetcher is the dangerous part:
 *   - http/https on ports 80/443 only;
 *   - every address the name resolves to — checked AT CONNECT TIME (so DNS can't change between check and use) —
 *     must be a public one: no loopback, private, link-local (cloud metadata), CGNAT, multicast or reserved ranges;
 *   - redirects are followed by hand, each hop re-validated, at most 4;
 *   - 8s per request, 1.5MB of HTML at most, HTML only.
 * `analyzeHtml` is pure (no network) so the scoring is tested without any.
 */

import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';

// ── address safety ───────────────────────────────────────────────────────

/** True for any address a public checker must never connect to. */
export function isBlockedIp(ip) {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)      // CGNAT
      || (a === 169 && b === 254)                // link-local incl. cloud metadata
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0)                  // IETF protocol assignments
      || (a === 198 && (b === 18 || b === 19))   // benchmarking
      ;
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === '::' || s === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);          // IPv4-mapped
    if (mapped) return isBlockedIp(mapped[1]);
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(s);
    if (mappedHex) { const n = (parseInt(mappedHex[1], 16) << 16) | parseInt(mappedHex[2], 16); return isBlockedIp([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')); }
    return /^(fc|fd|fe[89ab]|ff)/.test(s) || s.startsWith('64:ff9b:') || s.startsWith('2001:db8');
  }
  return true;   // not an address at all
}

/** Normalizes what a person typed ("example.com", "https://x.co/a") to a checkable URL, or throws a readable error. */
export function normalizeUrl(input) {
  let raw = String(input || '').trim();
  if (!raw) throw new Error('Enter your website address.');
  if (raw.length > 500) throw new Error('That address is too long.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  let u;
  try { u = new URL(raw); } catch { throw new Error('That does not look like a website address.'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http and https addresses can be checked.');
  if (u.username || u.password) throw new Error('Remove the username/password from the address.');
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  if (port !== '80' && port !== '443') throw new Error('Only standard web ports can be checked.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) { if (blockCheck(host)) throw new Error('That address cannot be checked.'); }
  else if (!host.includes('.') || /\.(local|internal|localhost|lan|home|corp)$/i.test(host)) throw new Error('Enter a public website address, like example.com.');
  u.hash = '';
  return u.toString();
}

// Test seam only: lets a unit test point the fetcher at a local server. Nothing a request can reach calls this.
let blockCheck = isBlockedIp;
export function __setBlockCheckForTests(fn) { blockCheck = fn || isBlockedIp; }

/** dns.lookup that refuses to hand back a blocked address — the check happens where the connection is made. */
export function safeLookup(hostname, options, cb) {
  const opts = typeof options === 'function' ? {} : options;
  const done = typeof options === 'function' ? options : cb;
  dns.lookup(hostname, { ...opts, all: true }, (err, addrs) => {
    if (err) return done(err);
    const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: net.isIP(addrs) }];
    if (!list.length || list.some((a) => blockCheck(a.address))) return done(Object.assign(new Error('That address cannot be checked.'), { code: 'EBLOCKED' }));
    if (opts.all) return done(null, list);
    return done(null, list[0].address, list[0].family);
  });
}

export const FETCH_LIMITS = { timeoutMs: 8000, maxBytes: 1_500_000, maxRedirects: 4 };

function fetchOnce(url, { accept = 'text/html,application/xhtml+xml', maxBytes = FETCH_LIMITS.maxBytes } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const started = Date.now();
    let ttfb = null;
    const req = lib.request(u, {
      method: 'GET',
      lookup: safeLookup,
      timeout: FETCH_LIMITS.timeoutMs,
      headers: { 'User-Agent': 'SemantiqSiteChecker/1.0 (+https://thesemantiq.com)', Accept: accept, 'Accept-Encoding': 'identity' },
    }, (res) => {
      ttfb = Date.now() - started;
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) { res.resume(); return resolve({ status, location: res.headers.location, ttfb, headers: res.headers, body: '', bytes: 0, ms: Date.now() - started }); }
      const chunks = []; let bytes = 0; let truncated = false;
      res.on('data', (c) => {
        bytes += c.length;
        if (bytes > maxBytes) { truncated = true; res.destroy(); return; }
        chunks.push(c);
      });
      const finish = () => resolve({ status, ttfb, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), bytes, truncated, ms: Date.now() - started });
      res.on('end', finish);
      res.on('close', () => { if (truncated) finish(); });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('The site took too long to respond.'), { code: 'ETIMEDOUT' })));
    req.on('error', (err) => reject(err));
    req.end();
  });
}

/** GET with hand-followed, re-validated redirects. Returns { finalUrl, hops, ...response }. */
export async function safeFetch(startUrl, opts = {}) {
  let url = normalizeUrl(startUrl);
  for (let hop = 0; hop <= FETCH_LIMITS.maxRedirects; hop++) {
    let r;
    try { r = await fetchOnce(url, opts); }
    catch (err) {
      if (err.code === 'EBLOCKED') throw new Error('That address cannot be checked.');
      if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') throw new Error('We could not find that website. Check the spelling.');
      if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') throw new Error('The site did not accept our connection.');
      if (/certificate|SSL|TLS|self.signed/i.test(err.message || '')) { const e = new Error('The site has a security certificate problem.'); e.certError = true; throw e; }
      throw err;
    }
    if (r.location) { url = normalizeUrl(new URL(r.location, url).toString()); continue; }
    return { ...r, finalUrl: url, hops: hop };
  }
  throw new Error('The site redirects too many times.');
}

// ── analysis (pure) ──────────────────────────────────────────────────────

const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const metaContent = (html, key) => {
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const name = /(?:name|property)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (name && name.toLowerCase() === key) return decode(/content\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] || '');
  }
  return null;
};
const strip = (html) => html.replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ');

/** Every fact the scoring needs, from the page HTML. */
export function extractFacts(html) {
  const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '');
  const h1s = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => decode(strip(m[1]))).filter(Boolean);
  const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  const imgsNoAlt = imgs.filter((t) => !/\balt\s*=\s*["'][^"']+["']/i.test(t)).length;
  const text = decode(strip(html));
  const robots = (metaContent(html, 'robots') || '').toLowerCase();
  return {
    title,
    description: metaContent(html, 'description'),
    h1Count: h1s.length,
    h1: h1s[0] || '',
    viewport: metaContent(html, 'viewport') !== null,
    imgCount: imgs.length,
    imgsNoAlt,
    words: text ? text.split(' ').length : 0,
    noindex: /\bnoindex\b/.test(robots),
    canonical: /<link\b[^>]*rel\s*=\s*["']canonical["']/i.test(html),
    ogTitle: !!metaContent(html, 'og:title'),
    ogImage: !!metaContent(html, 'og:image'),
    jsonLd: /<script\b[^>]*application\/ld\+json/i.test(html),
    lang: /<html\b[^>]*\blang\s*=\s*["'][a-z]/i.test(html),
    contact: /href\s*=\s*["'](?:tel:|mailto:)/i.test(html) || /<form\b/i.test(html),
  };
}

const PASS = 'pass', WARN = 'warn', FAIL = 'fail';

/**
 * Scores the page. `ctx`: { https, ttfbMs, totalMs, htmlBytes, robotsTxt, sitemap, truncated }.
 * Returns the checks (each with plain-English detail and fix), the 0-100 score and a letter grade.
 */
export function scoreSite(f, ctx) {
  const checks = [];
  const add = (id, label, points, status, detail, fix) => checks.push({ id, label, points, status, earned: status === PASS ? points : status === WARN ? Math.round(points / 2) : 0, detail, fix: status === PASS ? '' : fix });

  add('https', 'Secure connection (HTTPS)', 10, ctx.https ? PASS : FAIL,
    ctx.https ? 'The site loads securely.' : 'The site loads without HTTPS.',
    'Visitors see a "Not secure" warning and Google ranks you lower. Install a free SSL certificate and redirect all pages to https.');

  const tl = f.title.length;
  add('title', 'Page title', 10, !tl ? FAIL : tl >= 25 && tl <= 65 ? PASS : WARN,
    !tl ? 'There is no page title.' : `Your title is ${tl} characters: “${f.title.slice(0, 70)}”.`,
    !tl ? 'Add a title that names what you do and where, e.g. “Wedding Bakery in Austin | Sweet Co.” It is the headline people see on Google.'
      : tl < 25 ? 'The title is too short to tell Google or people what you do. Aim for 30–60 characters with your main service and location.'
        : 'The title is long and will be cut off on Google. Keep it under about 60 characters with the main service first.');

  const dl = (f.description || '').length;
  add('description', 'Search description', 8, !dl ? FAIL : dl >= 70 && dl <= 170 ? PASS : WARN,
    !dl ? 'There is no meta description.' : `Your description is ${dl} characters.`,
    !dl ? 'Write a 120–155 character description that sells the click: what you offer, for whom, and one reason to choose you. Google shows it under your title.'
      : dl < 70 ? 'The description is too short to earn the click. Expand it to about 120–155 characters.' : 'The description is too long and will be cut off. Trim it to about 155 characters.');

  add('h1', 'One clear main heading', 8, f.h1Count === 1 ? PASS : f.h1Count === 0 ? FAIL : WARN,
    f.h1Count === 1 ? `Main heading: “${f.h1.slice(0, 70)}”.` : f.h1Count === 0 ? 'The page has no main heading (H1).' : `The page has ${f.h1Count} main headings.`,
    f.h1Count === 0 ? 'Add one H1 that says what you do for whom. It tells Google and visitors what the page is about.' : 'Use exactly one H1 per page; make the others H2s.');

  add('mobile', 'Works on phones', 10, f.viewport ? PASS : FAIL,
    f.viewport ? 'The page is set up for mobile screens.' : 'The page is missing the mobile setup tag.',
    'Most visitors are on phones. Without a mobile viewport the site shows as a tiny desktop page, and Google ranks mobile-unfriendly sites lower.');

  const slow = ctx.totalMs > 2500 || ctx.ttfbMs > 1500;
  const ok = ctx.totalMs <= 1200 && ctx.ttfbMs <= 800;
  add('speed', 'Loading speed', 7, ok ? PASS : slow ? FAIL : WARN,
    `The server answered in ${ctx.ttfbMs} ms and the page took ${(ctx.totalMs / 1000).toFixed(1)} s to arrive.`,
    'Slow sites lose visitors and rank lower. Typical fixes: better hosting, caching, and compressing images.');
  const kb = Math.round(ctx.htmlBytes / 1024);
  add('weight', 'Page weight', 3, ctx.htmlBytes <= 300_000 ? PASS : ctx.htmlBytes <= 800_000 ? WARN : FAIL,
    `The page itself is ${kb} KB${ctx.truncated ? ' or more' : ''} before images.`,
    'The page code is heavy. Remove unused plugins and scripts to speed it up.');

  const noAlt = f.imgCount ? f.imgsNoAlt / f.imgCount : 0;
  add('alt', 'Image descriptions (alt text)', 6, !f.imgCount ? WARN : noAlt === 0 ? PASS : noAlt <= 0.4 ? WARN : FAIL,
    !f.imgCount ? 'No images found on the page.' : `${f.imgsNoAlt} of ${f.imgCount} images have no description.`,
    !f.imgCount ? 'Real photos of your work build trust and show up in image search; add some with descriptive alt text.' : 'Add a short description to each image. It helps people using screen readers and gets you found in Google Images.');

  add('content', 'Enough real content', 6, f.words >= 300 ? PASS : f.words >= 120 ? WARN : FAIL,
    `About ${f.words} words of readable text.`,
    'Too little text for Google to understand what you do. Aim for at least 300 words on the home page: services, area, and why customers choose you.');

  add('indexable', 'Allowed to appear on Google', 10, f.noindex ? FAIL : PASS,
    f.noindex ? 'The page tells Google NOT to list it.' : 'Google is allowed to list this page.',
    'A “noindex” tag is hiding this page from Google entirely. Remove it — this is likely the single biggest problem on the site.');

  add('canonical', 'Canonical address', 2, f.canonical ? PASS : WARN, f.canonical ? 'A canonical address is set.' : 'No canonical address is set.',
    'Add a canonical tag so Google does not treat www/non-www or tracking-link versions as duplicates.');
  add('social', 'Looks good when shared', 4, f.ogTitle && f.ogImage ? PASS : f.ogTitle || f.ogImage ? WARN : FAIL,
    f.ogTitle && f.ogImage ? 'Share previews are set up.' : 'Share previews are missing or partial.',
    'Add Open Graph title and image so links to your site look professional on Facebook, LinkedIn and messages.');
  add('schema', 'Structured data for Google', 4, f.jsonLd ? PASS : FAIL, f.jsonLd ? 'Structured data found.' : 'No structured data found.',
    'Add Local Business structured data so Google can show your hours, address and reviews directly in results.');
  add('robots', 'robots.txt', 3, ctx.robotsTxt ? PASS : WARN, ctx.robotsTxt ? 'robots.txt found.' : 'No robots.txt found.', 'Add a robots.txt that points to your sitemap.');
  add('sitemap', 'Sitemap', 4, ctx.sitemap ? PASS : FAIL, ctx.sitemap ? 'A sitemap was found.' : 'No sitemap found at /sitemap.xml.',
    'Add an XML sitemap and submit it to Google Search Console so every page gets found and indexed.');
  add('contact', 'Easy way to contact you', 3, f.contact ? PASS : FAIL, f.contact ? 'A phone link, email link or form is on the page.' : 'No phone link, email link or contact form on the page.',
    'Visitors who cannot reach you in one tap leave. Put a click-to-call button and a short form near the top.');
  add('lang', 'Language declared', 2, f.lang ? PASS : WARN, f.lang ? 'Language is declared.' : 'The page does not declare its language.', 'Add lang="en" to the page so browsers and Google handle it correctly.');

  const earned = checks.reduce((t, c) => t + c.earned, 0);
  const total = checks.reduce((t, c) => t + c.points, 0);
  const score = Math.round((earned / total) * 100);
  const grade = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 65 ? 'C' : score >= 50 ? 'D' : 'F';
  // Biggest wins first: the points still on the table.
  const topFixes = checks.filter((c) => c.status !== PASS).sort((a, b) => (b.points - b.earned) - (a.points - a.earned)).slice(0, 3);
  return { score, grade, checks, topFixes };
}

/** Plain-text summary of a report, for the lead's message (so the reply Marcus drafts cites real findings). */
export function reportText(report) {
  const lines = [`Site check for ${report.finalUrl || report.url}: ${report.score}/100 (grade ${report.grade}).`];
  if (report.topFixes?.length) {
    lines.push('Biggest problems:');
    report.topFixes.forEach((c, i) => lines.push(`${i + 1}. ${c.label} — ${c.detail}`));
  }
  const rest = (report.checks || []).filter((c) => c.status !== 'pass' && !(report.topFixes || []).some((t) => t.id === c.id));
  if (rest.length) lines.push(`Also: ${rest.map((c) => c.label).join(', ')}.`);
  return lines.join('\n');
}

/** Fetch the page (+ robots.txt and sitemap.xml) and produce the full report. Throws readable errors. */
export async function checkSite(input) {
  const url = normalizeUrl(input);
  let page;
  try { page = await safeFetch(url); }
  catch (err) {
    // A bad certificate is itself a finding: say so rather than failing.
    if (err.certError) return { url, finalUrl: url, score: 0, grade: 'F', checks: [], topFixes: [], blocked: 'The site has a security certificate problem, so browsers warn visitors away. Fix the certificate first.' };
    throw err;
  }
  if (page.status >= 400) throw new Error(`The site returned an error (${page.status}).`);
  const type = String(page.headers['content-type'] || '').toLowerCase();
  if (type && !type.includes('html')) throw new Error('That address is not a web page.');
  const origin = new URL(page.finalUrl).origin;
  const probe = async (p) => { try { const r = await safeFetch(`${origin}${p}`, { accept: '*/*', maxBytes: 60_000 }); return r.status === 200 && r.body.trim().length > 0 && !/<html[\s>]/i.test(r.body.slice(0, 500)); } catch { return false; } };
  const [robotsTxt, sitemap] = await Promise.all([probe('/robots.txt'), probe('/sitemap.xml')]);
  const facts = extractFacts(page.body);
  const scored = scoreSite(facts, {
    https: page.finalUrl.startsWith('https:'),
    ttfbMs: page.ttfb, totalMs: page.ms, htmlBytes: page.bytes, truncated: !!page.truncated, robotsTxt, sitemap,
  });
  return { url, finalUrl: page.finalUrl, facts: { title: facts.title, words: facts.words }, ...scored };
}
