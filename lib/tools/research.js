// Research / tools: competitor, seo, trends, audit.
import { searchWeb, formatSearchContext } from '../websearch.js';
import { ask, fetchPage, pageFacts, clientContext } from './util.js';

const isUrl = (s) => /^(https?:\/\/)?[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(s.trim());

async function safeSearch(q, count = 6) {
  try { return await searchWeb(q, { count }); } catch (e) { return { error: e.message }; }
}
const srcBlock = (q, r) => (Array.isArray(r) ? formatSearchContext(q, r) : `(search unavailable: ${r.error})`);

const competitor = {
  name: 'competitor', group: 'Research',
  summary: 'Teardown of a competitor: positioning, offers, messaging gaps, what to attack.',
  usage: '/competitor acme.com   ·   /competitor Acme Plumbing Denver',
  async run({ args, client }) {
    if (!args.trim()) throw new Error('Usage: /competitor url or name');
    let site = '';
    if (isUrl(args)) {
      try { const f = pageFacts((await fetchPage(args)).html, args); site = `SITE FACTS:\n${JSON.stringify({ ...f, textSample: undefined }, null, 1)}\nSITE COPY:\n${f.textSample}`; }
      catch (e) { site = `(could not fetch site: ${e.message})`; }
    }
    const q = `${args.trim()} reviews pricing alternatives`;
    const found = await safeSearch(q);
    const out = await ask(
      'You are a competitive strategist at a top digital marketing agency. Be specific and blunt. Only state what the evidence below supports; label inference as inference.',
      `${await clientContext(client)}Competitor: ${args}\n\n${site}\n\n${srcBlock(q, found)}\n\nWrite: 1) Positioning & who they target 2) Offers/pricing seen 3) Messaging they own 4) Weaknesses/complaints 5) Gaps we can take 6) Three concrete moves to beat them.`,
    );
    return { text: out };
  },
};

const seo = {
  name: 'seo', group: 'Research',
  summary: 'Keyword clusters + content plan from a topic, or on-page SEO read of a URL. No search-volume data — it reasons from live results.',
  usage: '/seo dog grooming austin   ·   /seo yoursite.com',
  async run({ args, client }) {
    if (!args.trim()) throw new Error('Usage: /seo topic or url');
    if (isUrl(args)) {
      const f = pageFacts((await fetchPage(args)).html, args);
      const out = await ask('You are a senior technical SEO. Give a prioritized fix list from the facts only.',
        `${await clientContext(client)}${JSON.stringify({ ...f, textSample: undefined }, null, 1)}\n\nCOPY SAMPLE:\n${f.textSample}\n\nOutput: target keyword guess, 5 highest-impact fixes (why + exact change), title + meta rewrite, content gaps.`);
      return { text: out };
    }
    const found = await safeSearch(args.trim(), 8);
    const out = await ask('You are a senior SEO strategist. Cluster keywords by intent. State clearly you have no volume data; rank by likely difficulty and fit.',
      `${await clientContext(client)}Topic: ${args}\n\n${srcBlock(args, found)}\n\nOutput: keyword clusters (informational / commercial / transactional), 10 content pieces to write with working titles, what the current top results cover and miss, quick wins.`);
    return { text: out };
  },
};

const trends = {
  name: 'trends', group: 'Research',
  summary: 'What is moving right now in a niche: topics, hashtags, angles to ride.',
  usage: '/trends vegan snacks',
  async run({ args, client }) {
    if (!args.trim()) throw new Error('Usage: /trends niche or topic');
    const q1 = `${args.trim()} trending now`;
    const q2 = `${args.trim()} viral tiktok instagram hashtags this week`;
    const [a, b] = await Promise.all([safeSearch(q1), safeSearch(q2)]);
    const out = await ask('You are a social trend analyst. Use only what the results show; flag anything speculative.',
      `${await clientContext(client)}Niche: ${args}\n\n${srcBlock(q1, a)}\n\n${srcBlock(q2, b)}\n\nOutput: 5 live trends, hashtags, 3 content angles per trend we could post this week, and what to avoid.`);
    return { text: out };
  },
};

const audit = {
  name: 'audit', group: 'Research',
  summary: 'Fetch a page and audit speed-of-read, SEO basics, copy and conversion.',
  usage: '/audit yoursite.com/pricing',
  async run({ args, client }) {
    if (!args.trim()) throw new Error('Usage: /audit url');
    const page = await fetchPage(args);
    const f = pageFacts(page.html, page.url);
    const out = await ask('You are a conversion and SEO auditor. Facts are measured; judge copy from the sample. Ruthless, specific, ranked by impact.',
      `${await clientContext(client)}MEASURED:\n${JSON.stringify({ ...f, textSample: undefined }, null, 1)}\n\nCOPY SAMPLE:\n${f.textSample}\n\nOutput: score /100 with the reason, top 7 fixes ranked (problem → exact fix), rewritten headline + CTA, what's already good.`);
    return { text: `**Measured**: ${f.wordCount} words · ${f.images} images (${f.imagesMissingAlt} no alt) · title ${f.title.length} chars · meta ${f.metaDescription ? f.metaDescription.length + ' chars' : 'MISSING'} · ${f.h1.length} H1 · viewport ${f.viewportMeta ? 'yes' : 'NO'} · canonical ${f.canonical ? 'yes' : 'no'} · OG ${f.openGraph ? 'yes' : 'no'}\n\n${out}` };
  },
};

export default [competitor, seo, trends, audit];
