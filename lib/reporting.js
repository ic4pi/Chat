// Daily engagement summary, built per client from that client's own state only.

/** Engagement score for one post's metrics. Comments weigh more than likes. */
export function postScore(metrics) {
  if (!metrics) return 0;
  return (metrics.likes || 0) + 3 * (metrics.comments || 0) + 2 * (metrics.shares || 0);
}

function avg(nums) {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

/**
 * Engagement drop check used by the autopilot: mean score of posts from the
 * last `recentDays` against the mean of the `baselineDays` before that.
 * Needs at least `minBaseline` baseline posts, otherwise there is not enough
 * history to call anything a drop.
 */
export function engagementTrend(client, now = Date.now(), { recentDays = 3, baselineDays = 14, minBaseline = 3 } = {}) {
  const day = 86400000;
  const measured = client.state.posts.filter((p) => p.metrics);
  const recent = measured.filter((p) => Date.parse(p.postedAt) >= now - recentDays * day);
  const baseline = measured.filter((p) => {
    const t = Date.parse(p.postedAt);
    return t < now - recentDays * day && t >= now - (recentDays + baselineDays) * day;
  });
  if (!recent.length || baseline.length < minBaseline) return { enough: false, recent: avg(recent.map((p) => postScore(p.metrics))), baseline: null, change: null };
  const r = avg(recent.map((p) => postScore(p.metrics)));
  const b = avg(baseline.map((p) => postScore(p.metrics)));
  return { enough: true, recent: r, baseline: b, change: b > 0 ? (r - b) / b : 0 };
}

export function buildDailyReport(client, { now = Date.now(), hours = 24 } = {}) {
  const since = now - hours * 3600000;
  const posts = client.postsSince(since);
  const sent = client.repliesSince(since, 'sent');
  const flagged = client.repliesSince(since, 'needs_human');
  const failed = client.state.drafts.filter((d) => d.status === 'failed' && Date.parse(d.updatedAt || 0) >= since);

  // Top content looks at the last week so a quiet day still shows what works.
  const week = client.postsSince(now - 7 * 86400000)
    .filter((p) => p.metrics)
    .map((p) => ({ text: p.text.slice(0, 140), postedAt: p.postedAt, score: postScore(p.metrics), metrics: p.metrics }))
    .sort((a, b) => b.score - a.score);

  const trend = engagementTrend(client, now);
  return {
    clientId: client.id,
    clientName: client.state.name,
    generatedAt: new Date(now).toISOString(),
    windowHours: hours,
    postsPublished: posts.length,
    repliesSent: sent.length,
    repliesNeedingHuman: flagged.map((r) => ({ commentId: r.commentId, reason: r.reason, at: r.at })),
    draftsAwaitingReview: client.state.drafts.filter((d) => d.status === 'pending_review').length,
    draftsFailed: failed.map((d) => ({ id: d.id, error: d.error })),
    topContent: week.slice(0, 3),
    engagement: {
      recentAvgScore: Number(trend.recent.toFixed(2)),
      baselineAvgScore: trend.baseline == null ? null : Number(trend.baseline.toFixed(2)),
      changePct: trend.change == null ? null : Math.round(trend.change * 100),
    },
  };
}

export function renderReport(r) {
  const lines = [
    `Daily report — ${r.clientName} (${r.generatedAt.slice(0, 10)})`,
    '',
    `Posts published: ${r.postsPublished}`,
    `Replies sent: ${r.repliesSent}`,
    `Comments needing a human: ${r.repliesNeedingHuman.length}`,
    `Drafts awaiting review: ${r.draftsAwaitingReview}`,
  ];
  if (r.draftsFailed.length) lines.push(`Failed drafts: ${r.draftsFailed.length} (${r.draftsFailed.map((d) => d.error).join('; ')})`);
  if (r.engagement.changePct != null) {
    lines.push(`Engagement vs prior baseline: ${r.engagement.changePct > 0 ? '+' : ''}${r.engagement.changePct}%`);
  }
  if (r.topContent.length) {
    lines.push('', 'Top content this week:');
    r.topContent.forEach((p, i) => lines.push(`${i + 1}. [${p.score}] ${p.text}`));
  }
  return lines.join('\n');
}
