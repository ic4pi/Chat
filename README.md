# Uncensored Chat

Minimal single-user chat UI → Vercel serverless functions → OpenRouter *or* Venice.

- Two providers side-by-side (Venice direct + OpenRouter).
- The Venice model list is fetched **live** from Venice's own catalog, so every
  uncensored fine-tune they ship is available in the dropdown without any
  code change on your side.
- Persistent local chats, editable personas, and auto-extracted code/document
  artifacts — all stored in your browser's `localStorage`.
- No silent model swapping. If your selected model errors, you see *that*
  model's real error message.

## Deploy

1. `vercel` (or push to GitHub and import in the Vercel dashboard).
2. In Vercel project settings → Environment Variables, add whichever key(s) you use:
   - `VENICE_API_KEY` — from https://venice.ai/settings/api  *(required for Venice models and for the live model list)*
   - `OPENROUTER_API_KEY` — from https://openrouter.ai/keys  *(required for OpenRouter models)*
   - `SITE_URL` — optional; used as the OpenRouter `HTTP-Referer` header.
3. Redeploy after adding env vars (Vercel only injects env vars into new builds).

Only add the key(s) for the provider(s) you actually plan to use. If a key is
missing when a request needs it, the server responds with a clear error naming
the missing env var — it will not fall back to a different model.

## Local dev

```
npm i -g vercel
vercel dev
```

## Features

### Providers and models
- **Provider select** in the header picks Venice or OpenRouter.
- **Model select** is rebuilt when you change provider:
  - **Venice** — fetched live from `GET /api/models?provider=venice` at load time. Models are grouped into "Uncensored" and "Other Venice models" (based on Venice's `most_uncensored` trait and known uncensored fine-tunes like Dolphin / Hermes). Hover a model to see its Venice description.
  - **OpenRouter** — small hard-coded free-tier list. Edit the `OPENROUTER_MODELS` array in `public/app.js` to add more.

### Personas
- Header has a **persona** dropdown. Selecting a persona uses its system prompt for the current chat.
- Click **⚙** (or press **⌘/Ctrl + K**) to open the hidden Persona Manager screen. There you can:
  - Create new personas with any system prompt you want.
  - Rename or delete your custom personas.
  - Apply a persona to the current chat with one click.
- Two built-in personas ship by default: **NEXUS** (the evil-genius coder) and **Plain assistant**. Built-ins can't be edited or deleted, but you can freely add your own.

### Chats
- **Left sidebar** lists every saved chat. Click to switch, hover for the ×-delete button.
- **New chat** button in the sidebar header.
- The chat title in the top bar is inline-editable (click on it, edit, press Enter or click away). New chats auto-title from the first message.
- Chats are saved to `localStorage` immediately after every message. They persist across reloads.

### Artifacts
- **Right sidebar** shows artifacts extracted from the current chat.
- Any fenced code block of at least 3 lines in a model response becomes an artifact automatically. Titles are inferred from `File: name.ext` hints or from a leading `# path/to/file.ext` comment; otherwise `snippet-N.<ext>`.
- Each artifact has **View**, **Copy**, and **Download** buttons.
- The artifacts panel auto-opens the first time the model produces one in a chat, and can be toggled with the 📎 button in the header.

### Data
- **Export** — dump all chats + personas + settings as a JSON file.
- **Import** — restore from an exported JSON file.
- **Clear all** — wipe every chat, persona, and setting from this browser.

## Files

- `api/chat.js` — chat-completions proxy. Accepts `{messages, model, provider, systemPrompt}`.
- `api/models.js` — lists Venice text models from `https://api.venice.ai/api/v1/models?type=text` (cached at the edge for 5 minutes).
- `public/index.html` — layout only.
- `public/styles.css` — all styling.
- `public/app.js` — application logic (state, rendering, storage, personas, artifacts).

## Errors

If the selected model fails (rate limit, provider outage, content refusal, …),
the UI shows the actual upstream error message tagged with `[Provider · model]`.
Switch models manually and try again — the app never quietly re-runs your
prompt against a different model.
