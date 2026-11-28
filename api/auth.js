// /api/auth — accounts and login, one function:
//
//   GET  /login (= ?op=page)      → the sign-in / create-account page
//   GET  ?op=me                   → { loggedIn, email, isOwner }
//   POST ?op=register { email, password }  → account tied to THIS browser's owner
//   POST ?op=login    { email, password }  → links this browser to the account's owner
//   POST ?op=logout                       → unlinks this browser
//
// The accounts themselves live in lib/accounts.js; the identity model (owners,
// owner_devices, the chat_owner cookie) is untouched — a login is just a
// device link you ask for with a password instead of a code.

import {
  sessionAccount,
  isOwnerSession,
  handleRegister,
  handleLogin,
  handleLogout,
} from '../lib/accounts.js';
import { resolveOwner, presentedOwnerHash, requireHub, fail } from '../lib/hub.js';

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
<title>Sign in — Jive</title>
<meta name="theme-color" content="#000000" />
<link rel="icon" href="/favicon.ico" sizes="any" />
<link rel="stylesheet" href="/styles.css" />
<link rel="stylesheet" href="/admin.css" />
</head>
<body class="admin-body">
<header class="admin-topbar">
  <h1>Sign in</h1>
  <div class="admin-topbar-actions">
    <a class="text-btn" href="/">Chat →</a>
  </div>
</header>
<main class="admin-main" style="max-width:22rem">
  <p class="admin-hint" id="msg"></p>
  <form id="f" style="display:grid;gap:.6rem">
    <input id="email" type="email" autocomplete="email" placeholder="Email" required
      style="padding:.6rem;font-size:1rem" />
    <input id="password" type="password" autocomplete="current-password" placeholder="Password (8+ characters)" required minlength="8"
      style="padding:.6rem;font-size:1rem" />
    <div class="row" style="display:flex;gap:.6rem">
      <button type="submit" data-op="login" style="flex:1;padding:.6rem;font-size:1rem">Log in</button>
      <button type="submit" data-op="register" style="flex:1;padding:.6rem;font-size:1rem">Create account</button>
    </div>
  </form>
  <p class="admin-hint">No account? The app works exactly as before without one — an account is what ties your devices together and marks the deployment's owner.</p>
</main>
<script>
const params = new URLSearchParams(location.search);
const next = params.get('next') || '/team';
const msg = document.getElementById('msg');
let op = 'login';
document.querySelectorAll('button[type=submit]').forEach((b) =>
  b.addEventListener('click', () => { op = b.dataset.op; }));
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  msg.textContent = 'One moment…';
  try {
    const r = await fetch('/api/auth?op=' + op, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: document.getElementById('email').value,
        password: document.getElementById('password').value,
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Something went wrong.');
    location.href = next;
  } catch (err) {
    msg.textContent = err.message;
  }
});
</script>
</body>
</html>`;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const op = req.query?.op || 'page';

  if (req.method === 'GET' && op === 'page') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(PAGE);
  }

  if (!requireHub(res)) return;

  if (req.method === 'GET' && op === 'me') {
    const account = await sessionAccount(req);
    if (!account) return res.json({ loggedIn: false });
    return res.json({ loggedIn: true, email: account.email, isOwner: await isOwnerSession(req) });
  }

  if (req.method === 'POST' && op === 'register') {
    // resolveOwner (not peekOwner) on purpose: a brand-new browser needs an
    // owner row for the account to point at, and minting one is exactly what
    // any first visit would have done anyway.
    const ownerId = await resolveOwner(req, res);
    return handleRegister(req, res, ownerId);
  }

  if (req.method === 'POST' && op === 'login') return handleLogin(req, res);
  if (req.method === 'POST' && op === 'logout') return handleLogout(req, res, presentedOwnerHash(req));

  return fail(res, 404, 'unknown auth op');
}
