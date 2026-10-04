// Client-aware memory cleaner. Runs once a day per client and only ever edits
// that client's own state. Retention is explicit so nothing is dropped by
// accident: published posts and reports are kept longest because reporting and
// the "don't repeat yourself" check read from them.

const DAY = 86400000;

export const RETENTION_DAYS = Object.freeze({
  draftsClosed: 14,      // rejected / failed / expired drafts
  draftsPosted: 30,      // the draft record of something already posted
  staleUnapproved: 3,    // unreviewed draft whose slot passed this long ago
  posts: 90,
  replies: 60,
  seenComments: 30,
  reports: 30,
  rejectedIdeas: 60,
});

const MAX_SEEN_COMMENTS = 1000;
const MAX_REJECTED_IDEAS = 50;

function olderThan(iso, now, days) {
  const t = Date.parse(iso);
  return Number.isFinite(t) && now - t > days * DAY;
}

export function pruneClient(client, { now = Date.now() } = {}) {
  const s = client.state;
  const removed = {};
  const count = (key, before, after) => { if (before !== after) removed[key] = before - after; };

  // Unreviewed or approved drafts whose slot is long gone become "expired",
  // so a stale draft can never be published weeks late by accident.
  let expired = 0;
  for (const d of s.drafts) {
    if ((d.status === 'pending_review' || d.status === 'approved') && d.scheduledFor &&
        olderThan(d.scheduledFor, now, RETENTION_DAYS.staleUnapproved)) {
      d.status = 'expired';
      d.updatedAt = new Date(now).toISOString();
      expired++;
    }
  }
  if (expired) removed.draftsExpired = expired;

  const before = {
    drafts: s.drafts.length, posts: s.posts.length, replies: s.replies.length,
    seen: Object.keys(s.seenComments).length, reports: s.reports.length, ideas: s.rejectedIdeas.length,
  };

  s.drafts = s.drafts.filter((d) => {
    const ref = d.updatedAt || d.createdAt;
    if (d.status === 'posted') return !olderThan(ref, now, RETENTION_DAYS.draftsPosted);
    if (['rejected', 'failed', 'expired'].includes(d.status)) return !olderThan(ref, now, RETENTION_DAYS.draftsClosed);
    return true;
  });
  s.posts = s.posts.filter((p) => !olderThan(p.postedAt, now, RETENTION_DAYS.posts));
  s.replies = s.replies.filter((r) => !olderThan(r.at, now, RETENTION_DAYS.replies));

  const seen = Object.entries(s.seenComments)
    .filter(([, at]) => !olderThan(at, now, RETENTION_DAYS.seenComments))
    .sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]))
    .slice(0, MAX_SEEN_COMMENTS);
  s.seenComments = Object.fromEntries(seen);

  s.reports = s.reports.filter((r) => !olderThan(r.generatedAt, now, RETENTION_DAYS.reports));
  s.rejectedIdeas = s.rejectedIdeas
    .filter((r) => !olderThan(r.at, now, RETENTION_DAYS.rejectedIdeas))
    .slice(-MAX_REJECTED_IDEAS);

  count('drafts', before.drafts, s.drafts.length);
  count('posts', before.posts, s.posts.length);
  count('replies', before.replies, s.replies.length);
  count('seenComments', before.seen, Object.keys(s.seenComments).length);
  count('reports', before.reports, s.reports.length);
  count('rejectedIdeas', before.ideas, s.rejectedIdeas.length);

  return removed;
}
