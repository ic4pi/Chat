# Uncensored OpenRouter Chat

Minimal chat UI → Vercel serverless function → OpenRouter free models.

## Deploy

1. `vercel` (or push to GitHub and import in the Vercel dashboard)
2. In Vercel project settings → Environment Variables, add:
   - `OPENROUTER_API_KEY` — from https://openrouter.ai/keys (free tier works)
   - `SITE_URL` — your deployed URL (optional, used for OpenRouter referer header)
3. Redeploy after adding env vars.

## Local dev

```
npm i -g vercel
vercel dev
```

## Models

Dropdown in the UI swaps between free OpenRouter models. Default is Dolphin 3.0 Mistral 24B,
an uncensored fine-tune. Swap/add models by editing the `<select>` in `public/index.html` —
any `:free`-suffixed model slug from https://openrouter.ai/models?max_price=0 works.

Note: free-tier models are rate-limited per OpenRouter account, not per-user — fine for personal
use, not for serving lots of concurrent strangers.
