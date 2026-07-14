// HTTP Basic-auth check used by /admin and /api/admin-config.
// Credentials come from ADMIN_USERNAME + ADMIN_PASSWORD env vars.
// If either is missing, the endpoint refuses to serve — never falls open.

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Result codes:
//   ok:              credentials matched, allow the request
//   not_configured:  env vars missing (503)
//   unauthenticated: no / malformed / wrong Authorization header (401)
export function checkAdminAuth(req) {
  const user = process.env.ADMIN_USERNAME;
  const pass = process.env.ADMIN_PASSWORD;
  if (!user || !pass) return { ok: false, code: 'not_configured' };
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Basic ')) return { ok: false, code: 'unauthenticated' };
  let decoded;
  try {
    decoded = Buffer.from(auth.slice(6), 'base64').toString('utf-8');
  } catch {
    return { ok: false, code: 'unauthenticated' };
  }
  const idx = decoded.indexOf(':');
  if (idx < 0) return { ok: false, code: 'unauthenticated' };
  const submittedUser = decoded.slice(0, idx);
  const submittedPass = decoded.slice(idx + 1);
  if (!safeEqual(submittedUser, user) || !safeEqual(submittedPass, pass)) {
    return { ok: false, code: 'unauthenticated' };
  }
  return { ok: true };
}

// Convenience: returns true if allowed, otherwise writes an appropriate
// error response and returns false. Callers can then early-return.
export function requireAdminAuth(req, res) {
  const r = checkAdminAuth(req);
  if (r.ok) return true;
  if (r.code === 'not_configured') {
    res.setHeader('Cache-Control', 'no-store');
    res.status(503).json({
      error: 'Admin is not configured. Set ADMIN_USERNAME and ADMIN_PASSWORD in Vercel env vars, then redeploy.',
    });
    return false;
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="Uncensored Chat Admin", charset="UTF-8"');
  res.setHeader('Cache-Control', 'no-store');
  res.status(401).json({ error: 'Authentication required.' });
  return false;
}
