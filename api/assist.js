/**
 * POST /api/assist
 *
 * Small side-features that don't warrant their own serverless function slot
 * (Vercel cap is 20; see scripts/check-api.mjs). One JSON-in/JSON-out
 * endpoint, dispatched by `mode`. Uses the same llmJSON()/UTILITY_MODEL
 * OpenRouter wrapper the Hub sweep already uses (lib/hub.js) — needs only
 * OPENROUTER_API_KEY, no Supabase/Hub dependency.
 *
 * Body: { mode: 'summary' | 'smart-replies', messages: [{role, content}] }
 */

import { llmJSON, UTILITY_MODEL } from '../lib/hub.js';

const SUMMARY_PROMPT = `You read a chat conversation between a user and an AI assistant and produce a
short structured summary of it so far.

Return JSON: { "tldr": "...", "decisions": [...], "openQuestions": [...] }

TLDR: one or two sentences, what this conversation is actually about right now.
DECISIONS: things that got settled or agreed on — short, standalone strings.
Skip if nothing has actually been decided yet.
OPEN QUESTIONS: things left unresolved or still being figured out — short,
standalone strings. Skip if nothing is open.

Empty arrays and a short tldr are correct answers for a short or early-stage
conversation. Do not pad these out with filler.`;

const SMART_REPLY_PROMPT = `You read the tail end of a chat conversation and suggest 2-3 short things
the USER (not the assistant) might want to say next.

Return JSON: { "replies": [...] }

Each entry is a short, ready-to-send message written AS the user, in first
person, plausible as their actual next line — not a question posed to them,
not a description of what they could say. Keep each under ~12 words. If the
conversation just ended cleanly (thanks, goodbye, resolved) it's fine to
return fewer than 3, or none.`;

function transcript(messages, maxChars) {
  return messages
    .filter((m) => m && typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n\n')
    .slice(-maxChars);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { mode, messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  if (!process.env.OPENROUTER_API_KEY) {
    return res.status(503).json({ error: 'OPENROUTER_API_KEY not configured' });
  }

  try {
    if (mode === 'summary') {
      const out = await llmJSON({
        model: UTILITY_MODEL,
        system: SUMMARY_PROMPT,
        messages: [{ role: 'user', content: transcript(messages, 20000) }],
        maxTokens: 800,
      });
      return res.status(200).json({
        tldr: typeof out?.tldr === 'string' ? out.tldr : '',
        decisions: Array.isArray(out?.decisions) ? out.decisions.filter((d) => typeof d === 'string') : [],
        openQuestions: Array.isArray(out?.openQuestions)
          ? out.openQuestions.filter((q) => typeof q === 'string')
          : [],
      });
    }

    if (mode === 'smart-replies') {
      const out = await llmJSON({
        model: UTILITY_MODEL,
        system: SMART_REPLY_PROMPT,
        messages: [{ role: 'user', content: transcript(messages, 4000) }],
        maxTokens: 300,
      });
      const replies = Array.isArray(out?.replies)
        ? out.replies.filter((r) => typeof r === 'string' && r.trim()).slice(0, 3)
        : [];
      return res.status(200).json({ replies });
    }

    return res.status(400).json({ error: "mode must be 'summary' or 'smart-replies'" });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
