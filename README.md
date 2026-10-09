# Uncensored Chat

Six things in one Vercel project, sharing one set of provider keys and one
memory: an uncensored chat client, a coding workspace with real VMs, a
multi-persona round table, a media studio, a cross-chat memory, and an admin
page for the prompts behind all of it.

Everything runs as serverless functions on Vercel. The browser holds chat
history; the server holds every prompt and key.

---

## The modules

### 💬 Chat — `/`

- Six providers behind one picker: **Venice, OpenRouter, Cerebras, Groq,
  xAI (Grok), NVIDIA**. Catalogs come from each provider's own API, not a
  guessed list.
- **Personas** with server-side system prompts, plus a site-wide master
  prompt prepended to each. Neither ever reaches the browser — the client
  sees IDs and names, and `/api/chat` resolves the text per request.
- Nothing else is injected: no channel rules, role rules, or safety hedges
  stacked on top of an uncensored model.
- **BYOK** — paste your own key per provider, or use the server's.
- Paid models sit behind a password (`PAID_MODELS_PASSWORD` or
  `ADMIN_PASSWORD`); OpenRouter's free tier stays open.
- Streaming replies with visible reasoning, and auto-continue when a reply
  is cut off by length or timeout rather than by design.
- **Voice** — replies spoken as each sentence completes (free Edge TTS),
  dictation, or hands-free voice chat with auto-send.
- **Attachments** — text files inline; images are described by a
  vision-capable model when the chosen text model cannot see them
  (`lib/vision.js`), instead of failing the turn.
- **Web search** (🔎 toggle) — live Brave Search results fed into context per
  turn, with the model told to cite `[1]`, `[2]`, ... The same sources come
  back to the client and render as a clickable list under the reply, so a
  citation always points at a real, checkable page (`lib/websearch.js`).
- Smart-reply chips and conversation summaries via `/api/assist`.
- **Campaigns** — say "write a campaign for …" in any chat. It first offers a
  marketing meeting (Meeting first / Just write it): the personas debate the
  audience, angle, offer and proof for 2 rounds, and what they agree steers
  the copy — never as facts. The brief is read from the conversation; a
  strategist drafts, an editor sends it back until it
  scores 8/10 (buzzwords cost points, invented numbers are rejected), then X,
  LinkedIn, Instagram, Facebook, TikTok and email are written at once. Each
  post gets Copy, Post to…, and ⭐ Worked, which saves its opening as a proven
  hook (`campaign_hooks`, pgvector) that later campaigns build on
  (`lib/campaign-engine.js`, `/api/campaign`).

### 🧠 Memory — Supabase

- Topics, notes, facts and a joke bank, scoped **per owner** (a server-minted
  ID in an HttpOnly cookie — no login screen, no shared brain).
- Relevant memory is folded into the model's context automatically.
- A daily cron sweep extracts what a conversation was worth keeping;
  **Remember this chat** runs the same sweep on one thread on demand.
- Nudges and an inbox for things worth returning to.
- Reads that fail return 503 rather than an empty list, so "memory is down"
  and "nothing filed yet" cannot look the same.

### 🛠 Workspace — `/agent`

- A real **Vercel Sandbox VM** per session. Clone a GitHub repo (private
  repos use the token the push panel already saved) or start blank.
- File tree, editor, terminal, and `run-code` for Python / Rust / Go / Node —
  toolchains provision on first use.
- An agent that proposes file changes and applies them to the sandbox.
- **Auto-test** before push: the repo's own test/check command, or a built-in
  static smoke for plain HTML.
- Live preview server for web apps, proxied out of the sandbox.
- Commit and push back to GitHub, opening a PR automatically. Protected
  branches are never pushed to directly.
- Model auto-routing by task difficulty, escalating on rate limit or refusal.
- **Code slices** (`/api/generate`) — HTML, CSS, JS logic, state, tests and
  the rest each routed to their own model and generated in parallel.

### 🎭 Group chat

- Every persona speaks once per round, each on its own provider and model.
- The setup screen lets you check/uncheck who's actually at the table —
  each group chat keeps its own roster, so the same personas can sit as a
  marketing panel in one chat and get swapped for an accounting panel in
  another instead of all configured personas showing up every time.
- Each persona can get an assigned task for the round (e.g. "check current
  pricing"). With 🔎 search on, a persona with a task searches on that task
  specifically instead of the shared topic — real evidence differences
  between personas, not just differences in opinion. One search per tasked
  persona per round, so cost scales with how many personas you assign.
- Three modes: **boardroom** (serious), **brainstorm** (serious about the
  work, jokes allowed), **freechat** (anything).
- Context stays small — a rolling summary plus what others said this round,
  never the full history.
- **Call the question** runs a verdict phase: each persona commits to a
  position, confidence and one blocker, then a chair with no vote reports
  what the table actually agreed to.

### 🎬 Media Studio — `/media`

- **Images** — self-hosted SDXL on Modal, Venice, or Cloudflare FLUX/SDXL,
  with img2img, outpainting and pose control.
- **Video** — LTX (fast, up to ~30s) and Wan 2.2 (slow, ~5s) on Modal,
  text-to-video or image-to-video, with last-frame continuation for a longer
  scene without a cut.
- **Lip-sync** any clip to a voice track; stitch shots into one cut.
- **Character bank** — a saved character folded into every generation so a
  recurring face survives across shots.
- **Episode pipeline** — write the shot list and dialogue, draw each still,
  animate it, speak each line in its character's voice, assemble. Each stage
  is its own button and writes back to the same row, so a retry repeats only
  what failed.
- Optional prepaid metering for video (`VIDEO_ACCESS_KEYS`); unset means
  unmetered.

### 🔐 Admin — `/admin`

- Edit personas and the master prompt behind HTTP Basic auth, enforced at the
  function layer so the URL cannot be reached without credentials.
- Config lives in Vercel KV. If KV is missing the app still runs on the
  built-in `nexus` and `plain` personas with no master prompt; saving returns
  a 503 that says so.

---

## URLs

| Path | Purpose | Auth |
|------|---------|------|
| `/` | Chat UI | none |
| `/agent` | Workspace (coding VMs) | none |
| `/media` | Media Studio | none |
| `/admin` | Persona + master-prompt editor | Basic auth |
| `/api/chat` | Chat completions proxy (SSE or JSON) | none |
| `/api/agent-chat` | Workspace agent turns | none |
| `/api/group-chat` | Multi-persona round table (SSE) | none |
| `/api/campaign` | Campaign engine (SSE); `?op=hook` saves a winner | cookie-scoped hooks |
| `/api/generate` | Multi-LLM code-slice orchestrator (SSE) | none |
| `/api/media-generate` | Image / video generation | none |
| `/api/animate-sequence` | Frame-chain animation → video | none |
| `/api/tts` | Free neural TTS (Edge voices) | none |
| `/api/assist` | Summaries + smart replies | none |
| `/api/hub/*` | Memory: `initiate`, `state`, `document`, `media`, `moderate`, `sweep` | cookie-scoped |
| `/api/sandbox/*` | Workspace ops (rewritten from `/api/run`, `/api/files`, …) | session header |
| `/api/models?provider=…` | Live model catalog per provider | none |
| `/api/public-config` | Persona IDs and names — no prompts | none |
| `/api/admin-config` | Full config including system prompts | Basic auth |

---

## Where state lives

| Store | Holds |
|-------|-------|
| **Vercel KV** (`uncensored-chat:config:v1`) | Master prompt, personas, video balances |
| **Supabase** (`lib/hub.js`, project pinned in code) | Memory: topics, notes, facts, jokes, nudges, media |
| **Browser** `localStorage` (`uncensored_chat_state_v3`) | Chat history, selections, saved keys, artifacts |
| **Modal** | Self-hosted image/video/TTS/lip-sync GPU apps |

The Supabase **URL** is committed on purpose — the browser sends that hostname
on every request, and keeping it in an env var once made a memory outage
untraceable. The **service-role key** stays in the environment and must: it
bypasses row-level security entirely.

---

## Environment variables

### Chat providers — add whichever you use

| Name | Unlocks |
|------|---------|
| `VENICE_API_KEY` | Venice models + live catalog |
| `OPENROUTER_API_KEY` | OpenRouter models; also the memory sweep and `/api/assist` |
| `CEREBRAS_API_KEY` / `GROQ_API_KEY` / `XAI_API_KEY` | Those providers |
| `NVIDIA_API_KEY` | NVIDIA NIM chat models |
| `SITE_URL` | Sent as OpenRouter's `HTTP-Referer` |
| `BRAVE_SEARCH_API_KEY` | Web search grounding (the 🔎 toggle) in `/api/chat` |

A missing provider key is not fatal — that provider returns a clear error and
the rest keep working. Same for `BRAVE_SEARCH_API_KEY`: with the 🔎 toggle on
and no key set, the reply still goes out, ungrounded, with a visible notice
saying search was skipped — it never answers as if it searched when it didn't.

### Admin and paid gate

| Name | Purpose |
|------|---------|
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | `/admin` (refuses to serve if unset — never falls open) |
| `PAID_MODELS_PASSWORD` | Optional separate unlock for paid models. Either this **or** `ADMIN_PASSWORD` works |

### Memory

| Name | Purpose |
|------|---------|
| `SUPABASE_SERVICE_ROLE_KEY` | **Required** for memory. Must belong to the project pinned in `lib/hub.js` — a mismatch is detected and named |
| `HUB_UTILITY_MODEL`, `HUB_WRITER_MODEL` | Optional model overrides for sweeps |
| `HUB_MEDIA_BUCKET` | Optional storage bucket name |
| `CRON_SECRET` | Guards the daily sweep endpoint |

### Workspace

| Name | Purpose |
|------|---------|
| `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` | **Required** for coding VMs (Sandbox API). `VERCEL_OIDC_TOKEN` works in place of them where the platform injects it |
| `GITHUB_TOKEN` / `GH_TOKEN` | Optional server-side fallback for cloning private repos. Normally the browser's saved PAT is used instead |
| `AGENT_CHAT_TIMEOUT_MS`, `GENERATE_TIMEOUT_MS`, `GENERATE_TOTAL_MS` | Optional timeout tuning |

### Media

| Name | Purpose |
|------|---------|
| `MODAL_SDXL_ENDPOINT`, `MODAL_LTX_ENDPOINT`, `MODAL_WAN_ENDPOINT`, `MODAL_WAN_A14B_ENDPOINT`, `MODAL_TTS_ENDPOINT`, `MODAL_LIPSYNC_ENDPOINT`, `MODAL_STITCH_ENDPOINT` | Override the self-hosted Modal apps |
| `MODAL_SHARED_SECRET` | Authenticates calls to them |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | Cloudflare FLUX / SDXL images |
| `NVIDIA_MEDIA_BASE_URL`, `NVIDIA_NIM_API_KEY` | Optional self-hosted NIM for media |
| `VIDEO_ACCESS_KEYS` | Optional prepaid metering (JSON array of `{key, name, markupPct}`). Unset = unmetered |
| `MODAL_L4_RATE_PER_HOUR` | GPU rate used to price metered video |

### Storage

Vercel populates `KV_REST_API_URL` / `KV_REST_API_TOKEN` when you attach a KV
store. `STORAGE_*` and `UPSTASH_REDIS_REST_*` are accepted as aliases.

---

## Deploy

1. Push the repo to Vercel (or connect it in the dashboard).
2. Add the environment variables above.
3. **Storage → Create → KV**, attach to all environments — otherwise personas
   fall back to built-ins and admin saves fail.
4. Redeploy. Vercel only injects env vars into builds made after they exist,
   so every env change needs a fresh deployment.

### Local dev

```
npm i -g vercel
vercel dev
```

`vercel dev` pulls env vars from Vercel or a local `.env`. Without KV you get
the fallback behavior above.

### Before pushing

```
npm test          # scripts/check-api.mjs — syntax, handler exports,
                  # provider/auth contracts, function cap, package parity
```

Exit 0 means safe to push. This exists because a broken `lib/providers.js`
import took production chat down while the error only showed at request time.

---

## Layout

```
api/            serverless entry points (chat, agent-chat, group-chat,
                generate, media-generate, tts, assist, models, admin, …)
api/sandbox/    one entry, many ops — Hobby caps projects at 12 functions
api/hub/        one entry for every memory route
lib/            providers, vision, config, auth, kv, hub, model-meta,
                code-slices, video-billing
lib/sandbox-api/   the Workspace ops themselves (clone, run, push, preview)
public/         chat UI (index.html, app.js), /media, prebuilt /agent bundle
sandbox-terminal/  Workspace UI source (React + Vite) — build and copy
                   dist/ into public/agent to ship a change
modal/          the self-hosted GPU apps
scripts/        pre-push checks and local media pipelines
hub-schema.sql  the memory database, one migration, RLS on every table
```

### Two things that will bite you

- **The Workspace UI is a prebuilt bundle.** Editing `sandbox-terminal/src`
  changes nothing in production until you run `npx vite build` and copy
  `dist/` into `public/agent/`.
- **`modal/*.py` is reconstructed, not recovered.** The code actually running
  on Modal has never been in this repo — these files were rebuilt from the
  request/response contract the client encodes. See `modal/README.md`.
