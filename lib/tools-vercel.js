/**
 * Vercel tool (read-only) — lets the team see what's actually deployed and
 * why a build failed, instead of guessing. No redeploys from a job; the
 * owner ships from the dashboard.
 *
 * Env: VERCEL_TOKEN (account token, read scope is enough).
 */

const API = 'https://api.vercel.com';

export function vercelConnected() {
  return !!(process.env.VERCEL_TOKEN || '').trim();
}

async function vapi(path) {
  const token = (process.env.VERCEL_TOKEN || '').trim();
  if (!token) throw new Error('Vercel is not connected (no VERCEL_TOKEN).');
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Vercel ${path}: HTTP ${res.status}`);
  return res.json();
}

/** Latest deployments across the account (+ build-log tail for a failed one). */
export async function getDeployStatus({ logLines = 30 } = {}) {
  const data = await vapi('/v6/deployments?limit=5');
  const deployments = (data.deployments || []).map((d) => ({
    name: d.name,
    state: d.readyState || d.state,
    url: d.url ? `https://${d.url}` : null,
    createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : null,
  }));

  const failed = (data.deployments || []).find((d) => (d.readyState || d.state) === 'ERROR');
  let errorLog = null;
  if (failed) {
    try {
      const events = await vapi(`/v2/deployments/${failed.uid || failed.id}/events?limit=100`);
      errorLog = (events || [])
        .map((e) => e.text || e.payload?.text || '')
        .filter(Boolean)
        .slice(-logLines)
        .join('\n')
        .slice(0, 4000);
    } catch { /* logs are best-effort */ }
  }
  return { deployments, errorLog };
}
