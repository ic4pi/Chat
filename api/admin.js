// Serves the admin UI at /admin (via a rewrite in vercel.json) behind HTTP
// Basic authentication. Credentials come from the ADMIN_USERNAME and
// ADMIN_PASSWORD environment variables. If either is missing, the endpoint
// serves a short explanation instead of the admin page — no accidental
// unauthenticated access.
//
// The admin page itself is a static HTML shell that fetches /admin.js and
// /admin.css from the public/ folder. Those two files contain only UI logic
// and stylesheet rules — no secrets, no server-side data — so they are safe
// to be served without auth. The persona and master-prompt data live in
// localStorage on the client, so this endpoint only gates the *editor UI*.

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
<title>Jive — Admin</title>
<meta name="theme-color" content="#000000" />
<link rel="icon" href="/favicon.ico" sizes="any" />
<link rel="icon" type="image/png" href="/favicon.png" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
<link rel="stylesheet" href="/styles.css" />
<link rel="stylesheet" href="/admin.css" />
</head>
<body class="admin-body">

<div id="bootError" style="display:none;position:fixed;left:0;right:0;top:0;padding:14px 18px;background:#2a1010;color:#ff9b9b;border-bottom:1px solid #5a1f1f;font-family:monospace;font-size:12px;z-index:200;white-space:pre-wrap;"></div>

<header class="admin-topbar">
  <h1>Admin</h1>
  <div class="admin-topbar-actions">
    <a class="text-btn" href="/" target="_blank" rel="noopener">Open chat →</a>
    <button id="signOutBtn" class="text-btn danger" title="Ends this browser's basic-auth session">Sign out</button>
  </div>
</header>

<main class="admin-main">

  <section class="admin-section">
    <h2>Master prompt</h2>
    <p class="admin-hint">
      Prepended to every persona's system prompt on every chat, across every
      model and provider. Use this for a project-wide rule that must never be
      overridden — e.g. "Always reply in Markdown", "The user's name is Alex",
      or a global persona base layer. Leave blank to disable.
    </p>
    <textarea id="masterPromptInput" spellcheck="false" placeholder="(no master prompt — every persona runs with just its own system prompt)"></textarea>
    <div class="admin-actions">
      <button id="saveMasterBtn" class="text-btn primary">Save master prompt</button>
      <button id="clearMasterBtn" class="text-btn danger">Clear</button>
    </div>
  </section>

  <section class="admin-section">
    <h2>Personas</h2>
    <p class="admin-hint">
      Named system prompts. The chat page has a persona selector — whichever
      one is selected is what the model gets (after the master prompt above).
      Edit any persona here — including NEXUS and Plain. What you save is exactly
      what the model receives. Nothing else is added on top.
    </p>
    <div class="persona-manager">
      <div class="persona-list-pane">
        <button id="newPersonaBtn" class="text-btn primary">+ New persona</button>
        <ul id="personaList" class="persona-list"></ul>
      </div>
      <div class="persona-edit-pane">
        <label class="field">
          <span>Name</span>
          <input id="personaNameInput" type="text" placeholder="e.g. Terse code reviewer" />
        </label>
        <label class="field">
          <span>Description <em>(shown to users)</em></span>
          <textarea id="personaDescriptionInput" rows="2" maxlength="400" spellcheck="true" placeholder="A short, user-facing summary of what this persona does. This is the only thing the chat page shows about the persona."></textarea>
        </label>
        <label class="field grow">
          <span>System prompt <em>(never shown to users)</em></span>
          <textarea id="personaPromptInput" spellcheck="false" placeholder="You are..."></textarea>
        </label>
        <div class="persona-actions">
          <button id="savePersonaBtn" class="text-btn primary">Save</button>
          <button id="deletePersonaBtn" class="text-btn danger">Delete</button>
        </div>
      </div>
    </div>
  </section>

  <section class="admin-section">
    <h2>Social accounts</h2>
    <p class="admin-hint">
      Facebook Pages / Instagram Business accounts marketing personas can
      publish to from chat, via the "Post to…" button on their replies.
      Page tokens are stored server-side only — they never reach the main
      chat page, only the publish endpoint uses them.
    </p>
    <div class="persona-manager">
      <div class="persona-list-pane">
        <button id="newAccountBtn" class="text-btn primary">+ New account</button>
        <ul id="accountList" class="persona-list"></ul>
      </div>
      <div class="persona-edit-pane">
        <label class="field">
          <span>Label <em>(shown in the picker)</em></span>
          <input id="accountLabelInput" type="text" placeholder="e.g. Client A — Main Page" />
        </label>
        <label class="field">
          <span>Platform</span>
          <select id="accountPlatformInput">
            <option value="facebook">Facebook Page</option>
            <option value="instagram">Instagram Business</option>
            <option value="twitter">X (Twitter)</option>
            <option value="email">Email (Resend)</option>
          </select>
        </label>
        <div id="accountMetaFields">
          <label class="field">
            <span>Page ID</span>
            <input id="accountPageIdInput" type="text" placeholder="Facebook Page ID" />
          </label>
          <label class="field">
            <span>Page access token</span>
            <input id="accountPageTokenInput" type="password" placeholder="Long-lived Page access token" autocomplete="off" />
          </label>
          <label class="field" id="accountIgUserField">
            <span>Instagram Business account ID <em>(only for Instagram)</em></span>
            <input id="accountIgUserInput" type="text" placeholder="IG Business account ID" />
          </label>
        </div>
        <div id="accountTwitterFields">
          <label class="field">
            <span>Consumer Key</span>
            <input id="accountConsumerKeyInput" type="text" placeholder="X API Consumer Key" autocomplete="off" />
          </label>
          <label class="field">
            <span>Consumer Secret</span>
            <input id="accountConsumerSecretInput" type="password" placeholder="X API Consumer Secret" autocomplete="off" />
          </label>
          <label class="field">
            <span>Access Token</span>
            <input id="accountAccessTokenInput" type="text" placeholder="X Access Token" autocomplete="off" />
          </label>
          <label class="field">
            <span>Access Token Secret</span>
            <input id="accountAccessTokenSecretInput" type="password" placeholder="X Access Token Secret" autocomplete="off" />
          </label>
        </div>
        <div id="accountEmailFields">
          <label class="field">
            <span>Resend API Key</span>
            <input id="accountResendApiKeyInput" type="password" placeholder="re_..." autocomplete="off" />
          </label>
          <label class="field">
            <span>From address <em>(must be verified in Resend)</em></span>
            <input id="accountFromEmailInput" type="text" placeholder="cole@yourdomain.com" autocomplete="off" />
          </label>
        </div>
        <div class="persona-actions">
          <button id="saveAccountBtn" class="text-btn primary">Save</button>
          <button id="deleteAccountBtn" class="text-btn danger">Delete</button>
        </div>
      </div>
    </div>
  </section>

  <section class="admin-section" id="dailySection">
    <h2>Daily pages</h2>
    <p class="admin-hint">
      Makes a new interactive web page on a schedule and posts it somewhere
      that is not this app: a GitHub repo (turn on GitHub Pages for it) or any
      website that accepts a webhook. Every page is checked before it goes
      out: one file, no network calls, its scripts must compile, and it must
      have working controls. Use Preview to see what it makes before you turn
      it on.
    </p>
    <div id="dailyStatus" class="admin-hint daily-status"></div>
    <label class="field field-check">
      <input id="dailyEnabled" type="checkbox" />
      <span>Turned on <em>(posts at the hours below, every day)</em></span>
    </label>
    <label class="field">
      <span>What the pages are about <em>(blank = surprising, useful little toys and tools)</em></span>
      <textarea id="dailyBrief" rows="3" spellcheck="true" placeholder="e.g. Money and math tools for freelancers. Games that teach probability."></textarea>
    </label>
    <label class="field">
      <span>Hours it posts <em>(24-hour clock, comma separated: two numbers = two pages a day)</em></span>
      <input id="dailyHours" type="text" placeholder="8, 20" autocomplete="off" />
    </label>
    <label class="field">
      <span>Timezone <em>(for those hours)</em></span>
      <input id="dailyTimezone" type="text" placeholder="America/New_York" autocomplete="off" />
    </label>
    <label class="field">
      <span>Model provider <em>(its key must be set in Vercel)</em></span>
      <select id="dailyProvider">
        <option value="openrouter">OpenRouter</option>
        <option value="venice">Venice</option>
        <option value="cerebras">Cerebras</option>
        <option value="groq">Groq</option>
        <option value="xai">xAI (Grok)</option>
        <option value="nvidia">NVIDIA</option>
      </select>
    </label>
    <label class="field">
      <span>Model <em>(blank = the best free coding model right now; a stronger model makes better pages)</em></span>
      <input id="dailyModel" type="text" placeholder="e.g. anthropic/claude-sonnet-4.5" autocomplete="off" />
    </label>
    <label class="field">
      <span>Post to</span>
      <select id="dailyTargetType">
        <option value="github">A GitHub repo</option>
        <option value="webhook">A website (webhook)</option>
      </select>
    </label>
    <div id="dailyGithubFields">
      <label class="field">
        <span>Repo <em>(owner/name, must already have one commit)</em></span>
        <input id="dailyRepo" type="text" placeholder="yourname/daily-pages" autocomplete="off" />
      </label>
      <label class="field">
        <span>Branch</span>
        <input id="dailyBranch" type="text" placeholder="main" autocomplete="off" />
      </label>
      <label class="field">
        <span>Folder in the repo <em>(GitHub Pages "/docs" = docs; blank = repo root)</em></span>
        <input id="dailyDir" type="text" placeholder="docs" autocomplete="off" />
      </label>
      <label class="field">
        <span>GitHub token <em>(fine-grained, only that repo, Contents: read and write)</em></span>
        <input id="dailyGhToken" type="password" placeholder="github_pat_…" autocomplete="off" />
      </label>
    </div>
    <div id="dailyWebhookFields">
      <label class="field">
        <span>Webhook URL <em>(https; gets a POST with title, slug, html)</em></span>
        <input id="dailyHookUrl" type="text" placeholder="https://yoursite.com/api/daily-page" autocomplete="off" />
      </label>
      <label class="field">
        <span>Secret <em>(optional, sent as Authorization: Bearer …)</em></span>
        <input id="dailyHookToken" type="password" placeholder="optional" autocomplete="off" />
      </label>
    </div>
    <label class="field">
      <span>Public address of the pages <em>(optional, so the log links to the live page)</em></span>
      <input id="dailySiteUrl" type="text" placeholder="https://yourname.github.io/daily-pages/" autocomplete="off" />
    </label>
    <div class="admin-actions">
      <button id="dailySaveBtn" class="text-btn primary">Save</button>
      <button id="dailyPreviewBtn" class="text-btn">Preview one (posts nothing)</button>
      <button id="dailyRunBtn" class="text-btn">Make &amp; post one now</button>
    </div>
    <div id="dailyResult" class="admin-hint daily-result" aria-live="polite"></div>
    <iframe id="dailyPreview" class="daily-preview" sandbox="allow-scripts" title="Preview of the generated page" hidden></iframe>
    <ul id="dailyHistory" class="media-recent-list"></ul>
  </section>

  <section class="admin-section">
    <h2>Recent media</h2>
    <p class="admin-hint">
      Images and videos generated in Media Studio, newest first — pulled
      straight from Supabase Storage. This page's login is the only thing
      gating this list.
    </p>
    <div class="admin-actions">
      <button id="refreshMediaBtn" class="text-btn">Refresh</button>
    </div>
    <ul id="mediaList" class="media-recent-list"></ul>
  </section>

  <section class="admin-section">
    <h2>Backup</h2>
    <p class="admin-hint">
      Master prompt and personas are stored in your browser's localStorage on
      this device. To move them to another device, export here and import in
      the main chat's sidebar (or vice versa).
    </p>
    <div class="admin-actions">
      <button id="exportAdminBtn" class="text-btn">Export config</button>
      <button id="importAdminBtn" class="text-btn">Import config</button>
      <input id="importAdminFile" type="file" accept="application/json" hidden />
    </div>
  </section>

</main>

<script>
  (function () {
    function show(msg) {
      var el = document.getElementById('bootError');
      if (!el) return;
      el.style.display = 'block';
      el.textContent = 'Boot error: ' + msg;
    }
    window.addEventListener('error', function (e) {
      show((e.error && (e.error.stack || e.error.message)) || e.message || String(e));
    });
    window.addEventListener('unhandledrejection', function (e) {
      show((e.reason && (e.reason.stack || e.reason.message)) || String(e.reason));
    });
  })();
</script>
<script src="/admin.js" type="module"></script>

</body>
</html>`;

const UNCONFIGURED_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" /><title>Admin — not configured</title>
<style>
  body { background:#0a0a0a; color:#e8e8e8; font-family: ui-monospace, monospace; padding: 32px; line-height: 1.6; }
  code { background:#1a1a1a; padding:2px 6px; border-radius:4px; }
  h1 { color:#d4ff3f; }
  .warn { color:#ff9b9b; }
</style>
</head><body>
<h1>Admin is not configured</h1>
<p class="warn">Both <code>ADMIN_USERNAME</code> and <code>ADMIN_PASSWORD</code> environment variables must be set for /admin to be accessible.</p>
<p>Set them in your Vercel project:</p>
<ol>
  <li>Dashboard → Settings → Environment Variables</li>
  <li>Add <code>ADMIN_USERNAME</code> and <code>ADMIN_PASSWORD</code> (all environments)</li>
  <li>Redeploy — Vercel only injects env vars into deployments built after they were added.</li>
</ol>
<p>Refusing to serve /admin unauthenticated for safety.</p>
</body></html>`;

function unauthorized(res) {
  res.setHeader('WWW-Authenticate', 'Basic realm="Uncensored Chat Admin", charset="UTF-8"');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  return res.status(401).send('Authentication required.');
}

// Constant-time-ish string compare to reduce timing-attack surface a bit,
// though for a single-user personal app the risk is negligible.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).send('Method not allowed');
  }

  const user = process.env.ADMIN_USERNAME;
  const pass = process.env.ADMIN_PASSWORD;

  if (!user || !pass) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(503).send(UNCONFIGURED_HTML);
  }

  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Basic ')) return unauthorized(res);

  let decoded;
  try {
    decoded = Buffer.from(auth.slice(6), 'base64').toString('utf-8');
  } catch {
    return unauthorized(res);
  }

  const idx = decoded.indexOf(':');
  if (idx < 0) return unauthorized(res);
  const submittedUser = decoded.slice(0, idx);
  const submittedPass = decoded.slice(idx + 1);

  if (!safeEqual(submittedUser, user) || !safeEqual(submittedPass, pass)) {
    return unauthorized(res);
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(ADMIN_HTML);
}
