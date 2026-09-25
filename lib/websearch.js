/**
 * Web search grounding for /api/chat and /api/group-chat.
 *
 * Uncensored models answer purely from training data unless something live
 * is put in front of them — this fetches real results and turns them into a
 * numbered context block the model is told to cite from ([1], [2], ...),
 * plus the same list back to the client so replies can link real sources
 * instead of the model inventing plausible-looking ones.
 */

const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';

/** Pull searchable text out of a message's content (string, or the text part of an array). */
export function extractQueryText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const textPart = content.find((p) => p && p.type === 'text');
    return textPart?.text || '';
  }
  return '';
}

/**
 * Search the web via Brave Search. Throws with a clear message on a missing
 * key or upstream failure — callers must surface this as a visible notice
 * rather than silently answering ungrounded while implying they searched.
 */
export async function searchWeb(query, { count = 5 } = {}) {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY || '';
  if (!apiKey) {
    throw new Error('web search is not configured on the server (missing BRAVE_SEARCH_API_KEY)');
  }
  const q = String(query || '').trim().slice(0, 400);
  if (!q) {
    throw new Error('nothing to search for');
  }

  const url = `${BRAVE_SEARCH_URL}?q=${encodeURIComponent(q)}&count=${count}`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': apiKey,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Brave Search error (${res.status}): ${text.slice(0, 300) || 'no detail'}`);
  }
  const data = await res.json();
  const results = Array.isArray(data?.web?.results) ? data.web.results : [];
  return results
    .slice(0, count)
    .map((r) => ({
      title: String(r.title || r.url || 'Untitled').trim(),
      url: String(r.url || '').trim(),
      snippet: String(r.description || '').replace(/<\/?strong>/g, '').trim(),
    }))
    .filter((r) => r.url);
}

/** Turns search results into a system-message block the model is told to cite from. */
export function formatSearchContext(query, results) {
  if (!results.length) {
    return `Live web search for "${query}" returned no results. Say so rather than guessing at an answer.`;
  }
  const lines = results.map(
    (r, i) => `[${i + 1}] ${r.title}\n${r.snippet}\nSource: ${r.url}`,
  );
  return (
    `Live web search results for "${query}" (retrieved ${new Date().toISOString().slice(0, 10)}):\n\n` +
    lines.join('\n\n') +
    `\n\nUse these to answer, and cite the source inline as [1], [2], etc. matching the numbers ` +
    `above wherever you use one. If the results don't cover the question, say so instead of guessing.`
  );
}
