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
 *       { mode: 'episode', provider, model, apiKey, premise, shots,
 *         series: { title, style }, cast: [{ name, look }] }
 *
 * 'episode' is the cartoon-series writers' room: a premise plus the character
 * bank in, a shot list with attributed dialogue out, ready for the media
 * studio to render one clip per shot. Unlike the other two modes it runs on
 * whichever provider/model the studio has selected, so it does not need
 * OPENROUTER_API_KEY.
 */

import { llmJSON, UTILITY_MODEL } from '../lib/hub.js';
import {
  resolveProvider,
  withProviderChatExtras,
  formatProviderError,
} from '../lib/providers.js';

const MAX_SHOTS = 24;

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

const EPISODE_PROMPT = `You are the writers' room for a short animated cartoon series. You turn an
episode premise into a shot list with dialogue, ready to be rendered one clip
at a time by an image-to-video model.

Return JSON: { "title": "...", "scenes": [ { "shot": "...", "speaker": "...", "line": "..." } ] }

TITLE: the episode title. Short.

SHOT: what the camera SEES, and nothing else. Present tense, one sentence.
Describe staging, action, framing and setting — "stands at the school bus stop
in falling snow, hands in pockets", "leans over the counter, pointing at the
menu board".
CRITICAL: never describe what a character LOOKS like. Their appearance and the
art style are appended automatically from a character bank, and repeating them
here fights that and makes the character drift. No hair, no clothing, no colors,
no "cartoon style" — staging and action only.
Never put spoken words in the shot. Never write camera jargon the model cannot
draw ("hard cut to", "match dissolve").

SPEAKER: the exact name of the ONE character speaking in this shot, copied
character-for-character from the cast list you are given. Each clip carries a
single voice, so never name two. Use "" for a silent shot — silent shots are
good pacing, use them.

LINE: what that character says. Under 25 words — each clip is only about five
seconds long, so a long line gets cut off. Natural spoken dialogue, in that
character's voice as the cast list describes them. Use "" when speaker is "".

Write the requested number of shots, in order, as one continuous scene-to-scene
story that opens and pays off inside the episode. Only use characters from the
cast list.`;

/** Compact the character bank into a cast list the writer can attribute to. */
function castBlock(cast) {
  const rows = (Array.isArray(cast) ? cast : [])
    .map((c) => ({
      name: String(c?.name || '').trim(),
      look: String(c?.look || '').trim(),
    }))
    .filter((c) => c.name);
  if (!rows.length) return '';
  return rows
    .map((c) => (c.look ? `- ${c.name}: ${c.look}` : `- ${c.name}`))
    .join('\n');
}

/**
 * One JSON completion from whichever provider/model the user picked in the
 * media studio. The OpenRouter-only llmJSON() in lib/hub.js cannot do this —
 * the studio's model picker offers Venice and the rest too — so this mirrors
 * the resolveProvider path api/chat.js and api/group-chat.js already use, and
 * salvages the first {...} block the same way llmJSON does when a model
 * ignores response_format.
 */
async function providerJSON({ providerId, model, apiKey, system, user, maxTokens }) {
  const resolved = resolveProvider(providerId, apiKey);
  const res = await fetch(resolved.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${resolved.apiKey}`,
      ...resolved.extraHeaders(),
    },
    body: JSON.stringify(
      withProviderChatExtras(
        {
          model,
          max_tokens: maxTokens,
          temperature: 0.9,
          stream: false,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          response_format: { type: 'json_object' },
        },
        providerId || resolved.id,
      ),
    ),
  });
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(formatProviderError(resolved.label, res.status, raw, model));
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`${resolved.label} returned a non-JSON response.`);
  }
  const content = String(data?.choices?.[0]?.message?.content ?? '').trim();
  const cleaned = content.replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end <= start) {
      throw new Error(`${model} did not return a script as JSON. Try another model.`);
    }
    return JSON.parse(cleaned.slice(start, end + 1));
  }
}

/** Keep only shots the renderer can actually use, and only real cast names. */
function normalizeScenes(raw, cast, wanted) {
  const names = new Map(
    (Array.isArray(cast) ? cast : [])
      .map((c) => String(c?.name || '').trim())
      .filter(Boolean)
      .map((n) => [n.toLowerCase(), n]),
  );
  const out = [];
  for (const s of Array.isArray(raw) ? raw : []) {
    const shot = String(s?.shot || '').trim();
    if (!shot) continue;
    // A speaker the bank does not know has no voice and no look to inject, so
    // the line is dropped rather than rendered in a default voice.
    const speaker = names.get(String(s?.speaker || '').trim().toLowerCase()) || '';
    const line = speaker ? String(s?.line || '').trim() : '';
    out.push({ shot, speaker, line });
    if (out.length >= wanted) break;
  }
  return out;
}

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

  // The episode writer takes a premise and a cast, not a chat transcript, and
  // runs on the studio's selected provider — so both of the checks the chat
  // modes need would reject a perfectly valid request.
  if (mode === 'episode') {
    try {
      return await handleEpisode(req, res);
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message || 'Script generation failed' });
    }
  }

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

    return res.status(400).json({ error: "mode must be 'summary', 'smart-replies' or 'episode'" });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}


/**
 * The writers' room. Everything the script needs to stay on-model comes from
 * the character bank the studio already keeps, so the premise can stay as
 * short as one line.
 */
async function handleEpisode(req, res) {
  const {
    provider: providerId,
    model,
    apiKey,
    premise = '',
    shots,
    series = {},
    cast = [],
  } = req.body || {};

  const premiseText = String(premise || '').trim();
  if (!premiseText) {
    const err = new Error('Give the episode a premise — one line is enough.');
    err.status = 400;
    throw err;
  }
  const roster = castBlock(cast);
  if (!roster) {
    const err = new Error('Save at least one character in the bank first — the writer casts from it.');
    err.status = 400;
    throw err;
  }
  if (!model) {
    const err = new Error('Pick a model to write with.');
    err.status = 400;
    throw err;
  }

  const wanted = Math.max(1, Math.min(MAX_SHOTS, Number(shots) || 8));
  const seriesTitle = String(series?.title || '').trim();
  const seriesStyle = String(series?.style || '').trim();

  // `false` drops a line; '' keeps a blank one, which is what separates the
  // blocks the model is meant to read as separate.
  const user = [
    seriesTitle ? `SERIES: ${seriesTitle}` : 'SERIES: (untitled)',
    seriesStyle && `ART STYLE (already applied to every shot — do not restate it): ${seriesStyle}`,
    '',
    'CAST (use these names exactly; their looks are injected automatically):',
    roster,
    '',
    'EPISODE PREMISE:',
    premiseText,
    '',
    `Write exactly ${wanted} shots.`,
  ]
    .filter((l) => l !== false && l != null)
    .join('\n');

  const out = await providerJSON({
    providerId,
    model,
    apiKey,
    system: EPISODE_PROMPT,
    user,
    // Roughly 60 tokens of JSON per shot, plus room for the title.
    maxTokens: Math.min(4000, 400 + wanted * 120),
  });

  const scenes = normalizeScenes(out?.scenes, cast, wanted);
  if (!scenes.length) {
    const err = new Error('The model returned no usable shots. Try again, or pick another model.');
    err.status = 502;
    throw err;
  }

  return res.status(200).json({
    title: String(out?.title || '').trim() || seriesTitle || 'Untitled episode',
    scenes,
    requested: wanted,
  });
}
