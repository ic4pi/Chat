/**
 * Stripe tool (read-only) — real sales numbers for marketing jobs.
 * "What's selling" beats "what we think is selling."
 *
 * Env: STRIPE_SECRET_KEY — use a RESTRICTED key with read-only access to
 * charges and balance. Never the unrestricted secret in a browser.
 */

export function stripeConnected() {
  return !!(process.env.STRIPE_SECRET_KEY || '').trim();
}

async function sapi(path) {
  const key = (process.env.STRIPE_SECRET_KEY || '').trim();
  if (!key) throw new Error('Stripe is not connected (no STRIPE_SECRET_KEY).');
  const res = await fetch(`https://api.stripe.com${path}`, {
    headers: { Authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Stripe ${path}: HTTP ${res.status}`);
  return res.json();
}

/** Last ~30 days of successful charges, summed and listed. */
export async function getSalesSnapshot({ days = 30, limit = 25 } = {}) {
  const since = Math.floor(Date.now() / 1000) - days * 86_400;
  const data = await sapi(`/v1/charges?limit=${limit}`);
  const paid = (data.data || []).filter((c) => c.paid && !c.refunded && c.created >= since);
  const totalCents = paid.reduce((sum, c) => sum + (c.amount_captured ?? c.amount ?? 0), 0);
  return {
    days,
    count: paid.length,
    total: (totalCents / 100).toFixed(2),
    currency: paid[0]?.currency?.toUpperCase() || 'USD',
    recent: paid.slice(0, 10).map((c) => ({
      amount: ((c.amount_captured ?? c.amount ?? 0) / 100).toFixed(2),
      description: c.description || c.statement_descriptor || 'charge',
      at: new Date(c.created * 1000).toISOString().slice(0, 10),
    })),
  };
}
