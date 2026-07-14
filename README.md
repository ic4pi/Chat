# Uncensored Chat

Chat UI backed by Vercel serverless functions with two providers (Venice + OpenRouter), a password-gated admin page for personas and a site-wide master prompt, and Vercel KV as the storage backend.

- Personas + master prompt live **server-side** in Vercel KV.
- The master prompt and each persona's system prompt are **never sent to the browser** — the client only sees persona IDs and names, and `/api/chat` resolves them at request time.
- `/admin` is HTTP Basic-auth-gated at the serverless-function layer, so the URL cannot be accessed without valid credentials.
- No silent model swapping. The one exception is a targeted, visible fallback from the OpenRouter free Dolphin-Venice model to Venice's own `venice-uncensored` — same model spirit, funded by your Venice credits.

## Deploy

### 1. Push to Vercel

`vercel` (or connect the repo in the Vercel dashboard).

### 2. Environment variables

In **Vercel → Project → Settings → Environment Variables** add:

| Name | Value | Purpose |
|------|-------|---------|
| `OPENROUTER_API_KEY` | from https://openrouter.ai/keys | OpenRouter models |
| `VENICE_API_KEY` | from https://venice.ai/settings/api | Venice models + live catalog |
| `ADMIN_USERNAME` | anything you want | Gate for `/admin` |
| `ADMIN_PASSWORD` | anything you want | Gate for `/admin` |
| `SITE_URL` | *(optional)* your deployment URL | Sent as OpenRouter's `HTTP-Referer` |

If any of `OPENROUTER_API_KEY` / `VENICE_API_KEY` is missing, the app still runs — the missing provider just returns a clear error. If `ADMIN_USERNAME` or `ADMIN_PASSWORD` is missing, `/admin` refuses to serve — never falls open.

### 3. Attach Vercel KV (required for admin edits to persist)

1. **Vercel Dashboard → Storage → Create → KV** (or attach an existing store).
2. Attach it to this project for all environments (Production / Preview / Development).
3. Vercel automatically populates `KV_REST_API_URL` and `KV_REST_API_TOKEN` in the project's env vars.
4. Redeploy — Vercel only injects new env vars into deployments built after they were added.

If KV isn't attached the app still runs: the site falls back to the built-in `NEXUS` + `Plain assistant` personas with no master prompt. The admin page will accept a login and load, but `Save` will return a 503 with instructions to connect KV.

### 4. Redeploy

Every env var change requires a fresh deployment — Vercel only injects env vars into new builds.

## What lives where

### On the server (Vercel KV, key `uncensored-chat:config:v1`)

```json
{
  "masterPrompt": "…text prepended to every persona…",
  "personas": [
    { "id": "abc123", "name": "Terse code reviewer", "systemPrompt": "…" }
  ]
}
```

Built-in personas (`nexus`, `plain`) are **not** stored — they are re-added at read time so a poisoned or empty KV cannot silently break the chat.

### In the browser (`localStorage`, key `uncensored_chat_state_v3`)

Chat history, active chat / persona / model selection, sidebar preferences, and generated artifacts. **No** system prompts or master prompt — those never leave the server.

## URLs

| Path | Purpose | Auth |
|------|---------|------|
| `/` | Main chat UI | none |
| `/admin` | Persona + master-prompt editor | HTTP Basic auth (`ADMIN_USERNAME` / `ADMIN_PASSWORD`) |
| `/api/chat` | Chat completions proxy | none (relies on API keys server-side) |
| `/api/models?provider=venice` | Live Venice model catalog | none |
| `/api/public-config` | Persona IDs and names (no prompts) | none |
| `/api/admin-config` | Full config incl. system prompts | HTTP Basic auth |

## Local dev

```
npm i -g vercel
vercel dev
```

`vercel dev` reads env vars from Vercel (or from a local `.env` file). Without a real KV connection you'll see the fallback behavior described above.

## Files

- `api/chat.js` — chat proxy; resolves persona + master prompt from KV every request.
- `api/models.js` — live Venice text-model list.
- `api/public-config.js` — persona IDs/names for the selector.
- `api/admin.js` — serves the admin HTML behind Basic auth.
- `api/admin-config.js` — GET/PUT the full config; Basic-auth-gated.
- `lib/kv.js` — thin REST client for Vercel KV / Upstash.
- `lib/config.js` — persona schema, load/save from KV, built-in defaults.
- `lib/auth.js` — shared Basic-auth check.
- `public/index.html`, `public/app.js`, `public/styles.css` — main chat UI.
- `public/admin.js`, `public/admin.css` — admin UI logic + styles (referenced by the inlined admin HTML in `api/admin.js`).
