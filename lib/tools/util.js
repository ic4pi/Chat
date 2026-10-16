// Shared helpers for / tools: LLM calls, page fetching, arg parsing, brand context.
import { llm, WRITER_MODEL } from '../hub.js';
import { readCol } from './store.js';

export async function ask(system, user, { maxTokens = 2500 } = {}) {
  if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not configured — this tool writes with an LLM.');
  return (await llm({ model: WRITER_MODEL, system, messages: [{ role: 'user', content: user }], maxTokens })).trim();
}

/** "a | b | c" → ['a','b','c'] */
export const pipes = (s) => String(s || '').split('|').map((x) => x.trim());
/** "add the rest" → ['add', 'the rest'] */
export function splitSub(s) {
  const m = /^(\S+)\s*([\s\S]*)$/.exec(String(s || '').trim());
  return m ? [m[1].toLowerCase(), m[2].trim()] : ['', ''];
}

const PRIVATE_HOST = /^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[?::1|\[?f[cd])/i;

export function normalizeUrl(input) {
  let u = String(input || '').trim();
  if (!u) throw new Error('A URL is required.');
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  const parsed = new URL(u);
  if (PRIVATE_HOST.test(parsed.hostname)) throw new Error('That address is not reachable from here.');
  return parsed.toString();
}

export async function fetchPage(input) {
  const url = normalizeUrl(input);
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AgencyBot/1.0)', Accept: 'text/html,*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
  const html = (await res.text()).slice(0, 600_000);
  return { url: res.url || url, html, ms: 0 };
}

export function pageFacts(html, url) {
  const pick = (re) => (re.exec(html) || [])[1]?.replace(/\s+/g, ' ').trim() || '';
  const body = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, ' ');
  const text = body.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&amp;|&#?\w+;/g, ' ').replace(/\s+/g, ' ').trim();
  const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  const host = new URL(url).hostname;
  const links = [...html.matchAll(/<a\b[^>]*href=["']([^"'#]+)/gi)].map((m) => m[1]);
  const internal = links.filter((l) => l.startsWith('/') || l.includes(host)).length;
  return {
    url,
    title: pick(/<title[^>]*>([\s\S]*?)<\/title>/i),
    metaDescription: pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i) || pick(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i),
    h1: [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => m[1].replace(/<[^>]+>/g, '').trim()).slice(0, 5),
    h2Count: (html.match(/<h2\b/gi) || []).length,
    wordCount: text ? text.split(' ').length : 0,
    images: imgs.length,
    imagesMissingAlt: imgs.filter((i) => !/\balt=["'][^"']+["']/i.test(i)).length,
    internalLinks: internal,
    externalLinks: links.length - internal,
    viewportMeta: /<meta[^>]+name=["']viewport/i.test(html),
    canonical: pick(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']*)/i),
    openGraph: /<meta[^>]+property=["']og:/i.test(html),
    hasCTAButton: /<(button|a)\b[^>]*>(?:[^<]*)(get|start|book|buy|sign|try|contact|call|subscribe)/i.test(html),
    textSample: text.slice(0, 3500),
  };
}

/** Brand kit + lead context for an @client token. */
export async function clientContext(slug) {
  if (!slug) return '';
  const brands = await readCol('brand', {});
  const b = brands[slug];
  return b
    ? `BRAND KIT for ${b.name}:\n${Object.entries(b).filter(([k]) => k !== 'name' && k !== 'updatedAt').map(([k, v]) => `- ${k}: ${v}`).join('\n')}\n\n`
    : '';
}

export const money = (n) => '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
