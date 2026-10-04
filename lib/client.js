// One marketing client = one isolated state record.
//
// Isolation rule: all of a client's data (personas, schedule, drafts, posts,
// replies, reports) lives under a single storage key derived from its id, and
// every read or write goes through this class. Nothing else in the agency code
// builds a storage key, so one client's run cannot touch another's state.
//
// Safety defaults: auto-posting and auto-replying are OFF until a human turns
// them on, and new drafts wait for approval unless `requireApproval` is
// switched off. Posting only ever happens on behalf of a connected account the
// client owner configured.

import { randomBytes } from 'node:crypto';

const ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const INDEX_KEY = 'clients:index';

export const DEFAULT_SETTINGS = Object.freeze({
  autoPost: false,           // opt-in: publish approved drafts at their slot
  autoReply: false,          // opt-in: reply to new comments
  requireApproval: true,     // drafts need a human "approve" before posting
  maxPostsPerDay: 2,
  maxRepliesPerRun: 10,
  maxRepliesPerDay: 30,
  engagementDropThreshold: 0.3, // 30% below baseline triggers fresh ideas
  contentBatchSize: 3,
  pendingDraftTarget: 6,     // don't generate more when this many are waiting
});

export const DEFAULT_SCHEDULE = Object.freeze({
  // day: 0 = Sunday ... 6 = Saturday, hour: 0-23 in the client's timezone
  slots: [
    { day: 1, hour: 10 },
    { day: 3, hour: 10 },
    { day: 5, hour: 10 },
  ],
});

const DRAFT_STATUSES = new Set([
  'pending_review', 'approved', 'rejected', 'posting', 'posted', 'failed', 'expired',
]);

export function newId(prefix) {
  return `${prefix}_${randomBytes(5).toString('hex')}`;
}

function str(v, max) {
  return String(v ?? '').slice(0, max);
}

function normalizePersona(p, i) {
  return {
    id: str(p?.id || `persona-${i + 1}`, 60),
    name: str(p?.name || `Persona ${i + 1}`, 80),
    // The voice description is the persona's whole brief: tone, vocabulary,
    // what it cares about. It is what the debate and the replies are written in.
    voice: str(p?.voice, 1200),
    role: p?.role === 'community' ? 'community' : 'strategist',
  };
}

function normalizeState(raw) {
  const s = raw || {};
  const settings = { ...DEFAULT_SETTINGS, ...(s.settings || {}) };
  return {
    id: s.id,
    name: str(s.name || s.id, 120),
    timezone: str(s.timezone || 'UTC', 60),
    accountId: str(s.accountId, 120),       // id of a socialAccount in /admin config
    brief: str(s.brief, 4000),               // what the business is, offers, avoids
    personas: (Array.isArray(s.personas) ? s.personas : []).map(normalizePersona),
    schedule: { slots: Array.isArray(s.schedule?.slots) ? s.schedule.slots : [...DEFAULT_SCHEDULE.slots] },
    settings,
    drafts: Array.isArray(s.drafts) ? s.drafts : [],
    posts: Array.isArray(s.posts) ? s.posts : [],
    replies: Array.isArray(s.replies) ? s.replies : [],
    seenComments: s.seenComments && typeof s.seenComments === 'object' ? s.seenComments : {},
    reports: Array.isArray(s.reports) ? s.reports : [],
    rejectedIdeas: Array.isArray(s.rejectedIdeas) ? s.rejectedIdeas : [],
    lastContentCycleAt: s.lastContentCycleAt || null,
    lastDailyDate: s.lastDailyDate || null,
    lastRunAt: s.lastRunAt || null,
    createdAt: s.createdAt || new Date().toISOString(),
  };
}

export class Client {
  constructor(state, store) {
    this.state = normalizeState(state);
    this.store = store;
  }

  static key(id) {
    if (!ID_RE.test(id || '')) throw new Error(`Invalid client id: ${JSON.stringify(id)}`);
    return `client:${id}`;
  }

  static async ids(store) {
    const idx = await store.get(INDEX_KEY);
    return Array.isArray(idx?.ids) ? idx.ids : [];
  }

  static async create(store, input) {
    const id = String(input?.id || '').toLowerCase();
    const key = Client.key(id);
    if (await store.get(key)) throw new Error(`Client "${id}" already exists`);
    const client = new Client({ ...input, id }, store);
    await client.save();
    const ids = await Client.ids(store);
    await store.set(INDEX_KEY, { ids: [...new Set([...ids, id])] });
    return client;
  }

  static async load(store, id) {
    const raw = await store.get(Client.key(id));
    return raw ? new Client(raw, store) : null;
  }

  static async loadAll(store) {
    const out = [];
    for (const id of await Client.ids(store)) {
      const c = await Client.load(store, id);
      if (c) out.push(c);
    }
    return out;
  }

  get id() { return this.state.id; }
  get settings() { return this.state.settings; }

  async save() {
    await this.store.set(Client.key(this.state.id), this.state);
  }

  // --- personas --------------------------------------------------------

  /** The persona that speaks to commenters: first "community" persona, else the first one. */
  replyPersona() {
    const p = this.state.personas;
    return p.find((x) => x.role === 'community') || p[0] || null;
  }

  // --- drafts ----------------------------------------------------------

  addDraft({ text, imageUrl, scheduledFor, idea, personaId, score }) {
    const draft = {
      id: newId('draft'),
      text: str(text, 2200),
      imageUrl: imageUrl || null,
      scheduledFor: scheduledFor ? new Date(scheduledFor).toISOString() : null,
      idea: str(idea, 300),
      personaId: personaId || null,
      score: typeof score === 'number' ? score : null,
      status: this.settings.requireApproval ? 'pending_review' : 'approved',
      createdAt: new Date().toISOString(),
    };
    this.state.drafts.push(draft);
    return draft;
  }

  getDraft(id) {
    return this.state.drafts.find((d) => d.id === id) || null;
  }

  setDraftStatus(id, status, extra = {}) {
    if (!DRAFT_STATUSES.has(status)) throw new Error(`Unknown draft status: ${status}`);
    const d = this.getDraft(id);
    if (!d) throw new Error(`No such draft: ${id}`);
    Object.assign(d, extra, { status, updatedAt: new Date().toISOString() });
    return d;
  }

  approveDraft(id) { return this.setDraftStatus(id, 'approved'); }

  rejectDraft(id, reason) {
    const d = this.setDraftStatus(id, 'rejected');
    if (d.idea) this.state.rejectedIdeas.push({ idea: d.idea, reason: str(reason, 200), at: d.updatedAt });
    return d;
  }

  /** Approved drafts whose slot has arrived and is still fresh (< maxAgeMs old). */
  dueDrafts(now = Date.now(), maxAgeMs = 24 * 3600 * 1000) {
    return this.state.drafts
      .filter((d) => d.status === 'approved' && d.scheduledFor)
      .filter((d) => {
        const t = Date.parse(d.scheduledFor);
        return t <= now && now - t <= maxAgeMs;
      })
      .sort((a, b) => Date.parse(a.scheduledFor) - Date.parse(b.scheduledFor));
  }

  pendingDraftCount() {
    return this.state.drafts.filter((d) => d.status === 'pending_review' || d.status === 'approved').length;
  }

  // --- posts / replies -------------------------------------------------

  recordPost({ draftId, platformPostId, text, at = new Date().toISOString() }) {
    const post = { id: newId('post'), draftId, platformPostId, text, postedAt: at, metrics: null };
    this.state.posts.push(post);
    return post;
  }

  postsSince(sinceMs) {
    return this.state.posts.filter((p) => Date.parse(p.postedAt) >= sinceMs);
  }

  hasSeenComment(commentId) {
    return Object.prototype.hasOwnProperty.call(this.state.seenComments, commentId);
  }

  markCommentSeen(commentId, at = new Date().toISOString()) {
    this.state.seenComments[commentId] = at;
  }

  recordReply({ commentId, postId, text, status, reason, at = new Date().toISOString() }) {
    const r = { id: newId('reply'), commentId, postId, text: str(text, 1000), status, reason: reason || null, at };
    this.state.replies.push(r);
    return r;
  }

  repliesSince(sinceMs, status = 'sent') {
    return this.state.replies.filter((r) => r.status === status && Date.parse(r.at) >= sinceMs);
  }
}
