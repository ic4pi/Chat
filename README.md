# Uncensored Chat

Minimal chat UI → Vercel serverless function → OpenRouter *or* Venice.

Both providers are supported side-by-side. The model dropdown groups options by provider;
whichever one you pick is the model that actually answers you — no silent swap to some
random "free router" model that then refuses your request.

## Deploy

1. `vercel` (or push to GitHub and import in the Vercel dashboard)
2. In Vercel project settings → Environment Variables, add whichever keys you plan to use:
   - `OPENROUTER_API_KEY` — from https://openrouter.ai/keys (needed for OpenRouter models)
   - `VENICE_API_KEY` — from https://venice.ai/settings/api (needed for Venice models)
   - `SITE_URL` — your deployed URL (optional, sent as the OpenRouter referer header)
3. Redeploy after adding env vars.

You only need the key for the provider(s) you use. If you pick a Venice model and
`VENICE_API_KEY` is not set, the server returns a clear error telling you so — it will
not silently fall back to a different model.

## Local dev

```
npm i -g vercel
vercel dev
```

## Models

The dropdown in the UI is grouped:

- **Venice (direct)** — uses your `VENICE_API_KEY`. Includes `venice-uncensored`
  (Dolphin-Mistral 24B), Llama 3.3 70B, Mistral 3.1 24B, Qwen3 235B Instruct, and
  Hermes 3 405B. See the full list at https://docs.venice.ai/api-reference/endpoint/models/list
- **OpenRouter** — uses your `OPENROUTER_API_KEY`. Pre-populated with a handful of free
  models. Any slug from https://openrouter.ai/models works — just add an `<option>`
  with `data-provider="openrouter"` in `public/index.html`.

To add or swap models, edit the `<select>` in `public/index.html`. Each `<option>` needs
a `data-provider` attribute of either `venice` or `openrouter` so the backend routes to
the right upstream.

## Errors

If the selected model fails (rate limit, provider outage, content refusal, etc.), the
UI shows the actual upstream error message along with the provider and model name. Pick
a different model and try again — the app will never quietly hand your prompt to a
model you did not choose.
