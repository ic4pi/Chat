// Context hub shared helpers.
// Plain ESM to match the rest of api/ — no TypeScript toolchain in this repo.

import { createClient } from '@supabase/supabase-js';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { kvIncr, kvExpire, KV_ENABLED } from './kv.js';

/**
 * The Supabase project memory lives in.
 *
 * In the repo on purpose. It is not a secret — the browser puts this hostname
 * in every request — and keeping it in an environment variable is what made a
 * memory outage untraceable: nothing in the code could say which database was
 * in use, so "no notes yet" and "pointed at an entirely different project"
 * looked identical from here. If the project ever changes, change it here, in
 * a reviewable commit.
 *
 * The service-role key is the opposite and must stay in the environment: this
 * repository is public, and that key bypasses row-level security completely.
 */
export const SUPABASE_URL = 'https://uaocqkrbihubxdyqlhcz.supabase.co';

/** Project ref of whatever SUPABASE_URL points at, e.g. "uaocqkrbihubxdyqlhcz". */
export const SUPABASE_PROJECT_REF = (() => {
  try {
    return new URL(SUPABASE_URL).host.split('.')[0];
  } catch {
    return null;
  }
})();

/**
 * The project ref the service-role key was issued for, read from the key's own
 * payload. A Supabase key is a JWT carrying a `ref` claim; this only decodes
 * it, never verifies or logs it, so it stays a secret while still being
 * checkable. Returns null for the newer opaque `sb_secret_...` format, which
 * carries no readable claims.
 */
function keyProjectRef(key) {
  if (!key || key.startsWith('sb_')) return null;
  try {
    const payload = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString('utf8'));
    return payload?.ref || null;
  } catch {
    return null;
  }
}

export const SUPABASE_KEY_REF = keyProjectRef(process.env.SUPABASE_SERVICE_ROLE_KEY);

/**
 * True when the key in the environment belongs to a different project than
 * SUPABASE_URL. Every request would fail auth, so it is worth naming outright
 * rather than letting it surface as a pile of unexplained 401s.
 */
export const SUPABASE_KEY_MISMATCH = !!(
  SUPABASE_KEY_REF && SUPABASE_PROJECT_REF && SUPABASE_KEY_REF !== SUPABASE_PROJECT_REF
);

export const HUB_ENABLED = !!(SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

export const db = HUB_ENABLED
  ? createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    })
  : null;

// Cheap model for extraction/classification. Never a persona model.
export const UTILITY_MODEL = process.env.HUB_UTILITY_MODEL || 'openai/gpt-4o-mini';
// Used for moderator closing statements and document drafting.
export const WRITER_MODEL = process.env.HUB_WRITER_MODEL || 'anthropic/claude-sonnet-4.5';

// ---------------------------------------------------------------------------
// Owner identity
// ---------------------------------------------------------------------------
// Memory is per-owner. An owner is minted here on first contact and carried
// in an HttpOnly cookie — no login screen, no accounts to manage, and no tap
// spent before the app is usable. Only the SHA-256 of the secret is stored,
// so a database dump never yields a usable cookie.
//
// This is a bearer secret, not a claim the client makes about itself: the
// browser cannot name an owner id it was not given, which is what makes the
// per-owner scoping below actually hold rather than being a suggestion.

const OWNER_COOKIE = 'chat_owner';
const OWNER_COOKIE_MAX_AGE = 60 * 60 * 24 * 3650; // ten years

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

function readCookie(req, name) {
  const header = req.headers?.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function setOwnerCookie(res, secret) {
  // Secure + HttpOnly + SameSite=Lax: not readable by page scripts, not sent
  // cross-site, never over plain HTTP.
  const cookie = [
    `${OWNER_COOKIE}=${encodeURIComponent(secret)}`,
    'Path=/',
    `Max-Age=${OWNER_COOKIE_MAX_AGE}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ');

  const existing = res.getHeader('Set-Cookie');
  if (!existing) res.setHeader('Set-Cookie', cookie);
  else res.setHeader('Set-Cookie', [].concat(existing, cookie));
}

/**
 * Resolves the owner for this request, minting one (and setting the cookie)
 * when the caller arrives without a recognised secret. Every hub read and
 * write is scoped by the id this returns.
 *
 * Returns null only when the hub is unconfigured — callers already guard on
 * requireHub() before reaching here.
 */
export async function resolveOwner(req, res) {
  if (!db) return null;

  const presented = readCookie(req, OWNER_COOKIE);
  if (presented) {
    const hash = sha256(presented);
    const { data: owner } = await db
      .from('owners')
      .select('id')
      .eq('token_hash', hash)
      .maybeSingle();
    if (owner?.id) {
      // Doubles as the free-tier keepalive: every request the app makes is a
      // database write, so the project cannot drift into an idle pause.
      void db
        .from('owners')
        .update({ last_seen_at: new Date().toISOString() })
        .eq('id', owner.id);
      return owner.id;
    }
    // An unrecognised secret (database reset, or a forged value) falls through
    // to minting a fresh owner rather than erroring — the caller still gets a
    // working, empty memory instead of a dead app.
  }

  const secret = randomBytes(32).toString('base64url');
  const { data: created, error } = await db
    .from('owners')
    .insert({ token_hash: sha256(secret) })
    .select('id')
    .single();
  if (error) throw new Error(`could not create owner: ${error.message}`);

  setOwnerCookie(res, secret);
  return created.id;
}

/** Constant-time compare, for anywhere a secret is checked by value. */
export function secretsMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

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
  ownerId,
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
    .insert({ owner_id: ownerId, type: toType, title, seed_prompt: seedContent, metadata })
    .select('id')
    .single();
  if (error) throw error;

  const { error: linkErr } = await db.from('links').insert({
    owner_id: ownerId,
    from_thread_id: fromThreadId,
    to_thread_id: thread.id,
    relation,
    seed_message_id: seedMessageId,
    seed_content: seedContent,
  });
  if (linkErr) throw linkErr;

  await db.from('messages').insert({
    owner_id: ownerId,
    thread_id: thread.id,
    role: 'user',
    content: seedContent,
  });

  return thread.id;
}

/** Everything pointing INTO a thread — what workspace uses to compile. */
export async function gatherIncoming(ownerId, threadId) {
  const { data: incoming } = await db
    .from('links')
    .select('from_thread_id, relation, seed_content')
    .eq('owner_id', ownerId)
    .eq('to_thread_id', threadId);
  if (!incoming?.length) return [];

  const ids = incoming.map((l) => l.from_thread_id);
  const { data: msgs } = await db
    .from('messages')
    .select('thread_id, role, content, created_at')
    .eq('owner_id', ownerId)
    .in('thread_id', ids)
    .order('created_at');

  return incoming.map((l) => ({
    relation: l.relation,
    seed: l.seed_content,
    messages: (msgs || []).filter((m) => m.thread_id === l.from_thread_id),
  }));
}

/**
 * Memory context to inject into any module's system prompt.
 *
 * ownerId is required rather than optional: this text goes into a prompt
 * under the heading "Known about this user", and an unscoped version of this
 * query is exactly how one person's private facts would end up described to
 * another person's persona.
 */
export async function memoryContext(ownerId, topicId = null) {
  if (!ownerId) throw new Error('memoryContext requires an ownerId');

  const { data: facts } = await db
    .from('memory_facts')
    .select('category, content')
    .eq('owner_id', ownerId)
    .order('confidence', { ascending: false })
    .limit(25);

  let notes = [];
  if (topicId) {
    const { data } = await db
      .from('notes')
      .select('content')
      .eq('owner_id', ownerId)
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
    fail(
      res,
      503,
      `Hub not configured — set SUPABASE_SERVICE_ROLE_KEY for project ${SUPABASE_PROJECT_REF}`,
    );
    return false;
  }
  if (SUPABASE_KEY_MISMATCH) {
    // Named outright, because the alternative is every query failing auth for
    // no stated reason — the exact shape of failure this whole subsystem has
    // already lost days to.
    fail(
      res,
      503,
      `SUPABASE_SERVICE_ROLE_KEY belongs to project ${SUPABASE_KEY_REF}, but this app uses ` +
        `${SUPABASE_PROJECT_REF}. Replace the key with ${SUPABASE_PROJECT_REF}'s service_role key.`,
    );
    return false;
  }
  return true;
}

/**
 * Fixed-window rate limit, shared across every serverless instance via KV
 * (a per-instance in-memory counter would reset on every cold start and
 * cap nothing). Every Hub route is reachable by anyone — owners auto-mint
 * on first contact, there is no login — so this is the only thing standing
 * between one visitor and an unbounded number of LLM/embedding calls.
 *
 * Fails OPEN when KV isn't configured, same posture as every other
 * KV-optional feature in this app: a missing optional dependency degrades
 * the app, it does not take it down.
 */
export async function rateLimit(req, res, { bucket, limit, windowSeconds }) {
  if (!KV_ENABLED) return true;
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket?.remoteAddress
    || 'unknown';
  const windowId = Math.floor(Date.now() / 1000 / windowSeconds);
  const key = `ratelimit:${bucket}:${ip}:${windowId}`;

  let count;
  try {
    count = await kvIncr(key);
    if (count === 1) await kvExpire(key, windowSeconds);
  } catch {
    return true; // a KV hiccup should block nothing — this is a cap, not a gate
  }

  if (count !== null && count > limit) {
    fail(res, 429, 'Too many requests', `Limit is ${limit} per ${windowSeconds}s. Try again shortly.`);
    return false;
  }
  return true;
}

// ---- Generated-media asset storage --------------------------------------

// Generation endpoints hand back raw bytes (base64), but a thread message must
// only ever carry a URL — a single 1024px image is ~1-2MB of base64, and
// writing that into `messages.content` bloats every later thread read and
// pushes responses past Vercel's 4.5MB body limit. Video is far worse.
//
// Supabase Storage is the destination because the hub already holds a
// service-role client. The bucket is created on first use so a fresh project
// needs no manual setup.
export const MEDIA_BUCKET = process.env.HUB_MEDIA_BUCKET || 'hub-media';

let bucketReady = false;

async function ensureMediaBucket() {
  if (bucketReady || !db) return bucketReady;
  // createBucket is idempotent enough for this: an already-exists error is a
  // success for our purposes, and any other error means storage is unusable.
  const { error } = await db.storage.createBucket(MEDIA_BUCKET, { public: true });
  if (error && !/exist/i.test(error.message || '')) return false;
  bucketReady = true;
  return true;
}

const EXT_BY_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};

/**
 * Upload generated bytes and return a public URL.
 *
 * Returns null rather than throwing when storage is unavailable, so callers
 * can fall back to an inline data URL instead of losing the generation.
 *
 * @param {Buffer|Uint8Array} bytes
 * @param {string} mimeType
 * @param {string} [prefix]  path prefix, e.g. the thread id
 * @returns {Promise<string|null>}
 */
export async function storeMediaAsset(bytes, mimeType, prefix = 'generated') {
  if (!db || !bytes?.length) return null;
  if (!(await ensureMediaBucket())) return null;

  const ext = EXT_BY_MIME[mimeType] || 'bin';
  const path = `${prefix}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;

  const { error } = await db.storage
    .from(MEDIA_BUCKET)
    .upload(path, bytes, { contentType: mimeType, upsert: false });
  if (error) return null;

  const { data } = db.storage.from(MEDIA_BUCKET).getPublicUrl(path);
  return data?.publicUrl || null;
}

/** Split a `data:` URL into bytes + mime. Returns null for anything else. */
export function decodeDataUrl(input) {
  const m = String(input || '').match(/^data:([^;,]+);base64,(.+)$/s);
  if (!m) return null;
  return { bytes: Buffer.from(m[2], 'base64'), mimeType: m[1] };
}
