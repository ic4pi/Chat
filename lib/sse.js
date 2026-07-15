/**
 * Shared SSE helpers for Vercel serverless functions.
 * Uses res.write() + res.end() which works on Vercel Pro with maxDuration set.
 */

/** Set SSE headers and flush immediately so the client starts receiving. */
export function setupSSE(res) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();
}

/** Write one SSE event. data is JSON-encoded so the client always gets a plain string. */
export function sseEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
