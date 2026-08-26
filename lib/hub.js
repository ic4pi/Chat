// Context hub shared helpers.
// Plain ESM to match the rest of api/ — no TypeScript toolchain in this repo.

import { createClient } from '@supabase/supabase-js';

export const HUB_ENABLED = !!(
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
);

export const db = HUB_ENABLED
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    })
  : null;

// Cheap model for extraction/classification. Never a persona model.
export const UTILITY_MODEL = process.env.HUB_UTILITY_MODEL || 'openai/gpt-4o-mini';
// Used for moderator closing statements and document drafting.
export const WRITER_MODEL = process.env.HUB_WRITER_MODEL || 'anthropic/claude-sonnet-4.5';

const CF_ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const EMBED_MODEL = '@cf/baai/bge-base-en-v1.5'; // 768 dims, free tier

/** Single entry point for text generation. Routes through OpenRouter. */
export async function llm({ model, system, messages, json = false, maxTokens = 2000 }) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: system ? [{ role: 'system', content: system }, ...messages] : messages,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  if (!res.ok) throw new Error(`LLM ${model} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || '';
}

/**
 * JSON-mode call. Not every OpenRouter model honours response_format, so this
 * retries once without it and salvages the first {...} block from the text.
 */
export async function llmJSON(args) {
  let raw;
  try {
    raw = await llm({ ...args, json: true });
  } catch {
    raw = await llm({ ...args, json: false });
  }
  return parseLooseJSON(raw);
}

function parseLooseJSON(raw) {
  const cleaned = String(raw).replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('Model did not return JSON');
    return JSON.parse(cleaned.slice(start, end + 1));
  }
}

/**
 * Embeddings via Cloudflare Workers AI — free tier, and the credentials are
 * already set for media generation. Avoids adding an OpenAI key just for this.
 * Accepts a string or an array; always returns an array of vectors.
 */
export async function embed(input) {
  const texts = Array.isArray(input) ? input : [input];
  if (!texts.length) return [];
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/run/${EMBED_MODEL}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${CF_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: texts.map((t) => String(t).slice(0, 2000)) }),
    }
  );
  if (!res.ok) throw new Error(`Embed ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const vectors = data?.result?.data;
  if (!Array.isArray(vectors)) throw new Error('Unexpected embedding response shape');
  return vectors;
}

export async function embedOne(text) {
  const [v] = await embed(text);
  return v;
}

// ---------------------------------------------------------------
// Cross-module movement
// ---------------------------------------------------------------

/**
 * Creates the destination thread and the graph edge.
 *
 * seedContent is stored on threads.seed_prompt verbatim AND written as a
 * readable message. Keeping the clean copy separate matters: the media
 * endpoint needs the raw prompt, not a message that starts with
 * "Carried over from a previous thread".
 */
export async function promote({
  fromThreadId,
  toType,
  relation,
  title,
  seedContent,
  seedMessageId = null,
  metadata = {},
}) {
  const { data: thread, error } = await db
    .from('threads')
    .insert({ type: toType, title, seed_prompt: seedContent, metadata })
    .select('id')
    .single();
  if (error) throw error;

  const { error: linkErr } = await db.from('links').insert({
    from_thread_id: fromThreadId,
    to_thread_id: thread.id,
    relation,
    seed_message_id: seedMessageId,
    seed_content: seedContent,
  });
  if (linkErr) throw linkErr;

  await db.from('messages').insert({
    thread_id: thread.id,
    role: 'user',
    content: seedContent,
  });

  return thread.id;
}

/** Everything pointing INTO a thread — what workspace uses to compile. */
export async function gatherIncoming(threadId) {
  const { data: incoming } = await db
    .from('links')
    .select('from_thread_id, relation, seed_content')
    .eq('to_thread_id', threadId);
  if (!incoming?.length) return [];

  const ids = incoming.map((l) => l.from_thread_id);
  const { data: msgs } = await db
    .from('messages')
    .select('thread_id, role, content, created_at')
    .in('thread_id', ids)
    .order('created_at');

  return incoming.map((l) => ({
    relation: l.relation,
    seed: l.seed_content,
    messages: (msgs || []).filter((m) => m.thread_id === l.from_thread_id),
  }));
}

/** Memory context to inject into any module's system prompt. */
export async function memoryContext(topicId = null) {
  const { data: facts } = await db
    .from('memory_facts')
    .select('category, content')
    .order('confidence', { ascending: false })
    .limit(25);

  let notes = [];
  if (topicId) {
    const { data } = await db
      .from('notes')
      .select('content')
      .eq('topic_id', topicId)
      .order('created_at', { ascending: false })
      .limit(30);
    notes = data || [];
  }

  const parts = [];
  if (facts?.length)
    parts.push('Known about this user:\n' + facts.map((f) => `- [${f.category}] ${f.content}`).join('\n'));
  if (notes.length)
    parts.push('Relevant saved thoughts:\n' + notes.map((n) => `- ${n.content}`).join('\n'));
  return parts.join('\n\n');
}

/** Uniform JSON error helper so every endpoint fails the same way. */
export function fail(res, status, message, details) {
  return res.status(status).json({ error: message, ...(details ? { details } : {}) });
}

export function requireHub(res) {
  if (!HUB_ENABLED) {
    fail(res, 503, 'Hub not configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
    return false;
  }
  return true;
}
