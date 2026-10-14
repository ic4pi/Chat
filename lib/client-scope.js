// Client workspaces: the wall, as pure functions.
//
// Every hub table is already scoped by owner_id, so a client is simply its own
// owner row that belongs to a parent. The server decides whose data a request
// touches in one place (resolveOwner in lib/hub.js); these helpers do the
// checking and take the database as an argument so they can be tested without
// one.

export class ClientAccessError extends Error {
  constructor(message = 'Unknown client') {
    super(message);
    this.name = 'ClientAccessError';
    this.status = 403;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The client the browser says it is working for, or null for Personal. */
export function clientIdFromHeaders(headers) {
  const raw = headers?.['x-client-id'];
  const v = String(Array.isArray(raw) ? raw[0] : raw ?? '').trim();
  return v || null;
}

/**
 * The owner id a request should use: the caller's own for Personal, or the
 * client's — but only when that client belongs to the caller and is not
 * archived. Anything else throws. It never falls back to the personal owner,
 * so a wrong or stolen client id can fail but can never read another space.
 */
export async function scopeToClient(db, parentOwnerId, clientId) {
  if (!clientId) return parentOwnerId;
  if (!UUID_RE.test(clientId)) throw new ClientAccessError();
  const { data, error } = await db
    .from('clients')
    .select('id')
    .eq('id', clientId)
    .eq('parent_owner_id', parentOwnerId)
    .eq('archived', false)
    .maybeSingle();
  if (error) throw new ClientAccessError('Could not verify the client');
  if (!data) throw new ClientAccessError();
  return data.id;
}

const clip = (s, n) => String(s ?? '').trim().slice(0, n);
const list = (v, maxItems, maxLen) =>
  (Array.isArray(v) ? v : [])
    .map((x) => clip(x, maxLen))
    .filter(Boolean)
    .slice(0, maxItems);

/** Normalizes whatever the browser sent into the stored profile shape. */
export function cleanProfile(p) {
  const src = p && typeof p === 'object' ? p : {};
  return {
    voice: clip(src.voice, 1500),
    audience: clip(src.audience, 1500),
    offer: clip(src.offer, 1500),
    facts: list(src.facts, 40, 400),
    links: list(src.links, 20, 300),
    dos: list(src.dos, 30, 300),
    donts: list(src.donts, 30, 300),
  };
}

/** The block added to the AI's system prompt while a client is active. */
export function clientBrief(name, profile) {
  const p = cleanProfile(profile);
  const lines = [`CLIENT BRIEF — you are working for the client "${clip(name, 120)}". Everything you write is for them.`];
  if (p.voice) lines.push(`Brand voice: ${p.voice}`);
  if (p.audience) lines.push(`Audience: ${p.audience}`);
  if (p.offer) lines.push(`Offer: ${p.offer}`);
  if (p.facts.length) lines.push(`Facts you may rely on:\n${p.facts.map((f) => `- ${f}`).join('\n')}`);
  if (p.links.length) lines.push(`Links:\n${p.links.map((f) => `- ${f}`).join('\n')}`);
  if (p.dos.length) lines.push(`Always:\n${p.dos.map((f) => `- ${f}`).join('\n')}`);
  if (p.donts.length) lines.push(`Never:\n${p.donts.map((f) => `- ${f}`).join('\n')}`);
  lines.push('Do not use facts, names or strategy from any other client. If something is not in this brief or the conversation, ask instead of inventing it.');
  return lines.join('\n');
}
