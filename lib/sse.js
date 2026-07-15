/**
 * Shared SSE helpers for Vercel serverless functions.
 * Uses res.write() + res.end() which works on Vercel Pro with maxDuration set.
 */

/** Set SSE headers and flush immediately so the client starts receiving.
 *  Returns false if this was a CORS preflight (OPTIONS) — caller should return. */
export function setupSSE(res, req) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Sandbox-Session');
  if (req?.method === 'OPTIONS') { res.status(204).end(); return false; }
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  return true;
}

/** Write one SSE event. data is JSON-encoded so the client always gets a plain string. */
export function sseEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
