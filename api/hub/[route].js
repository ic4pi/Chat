/**
 * Single entry point for the whole context hub.
 *
 *   /api/hub/initiate?action=workspace|group|media
 *   /api/hub/moderate
 *   /api/hub/document
 *   /api/hub/media
 *   /api/hub/state?action=nudges|topics|inbox|dismiss|register|append|turn
 *   /api/hub/sweep          (cron, every 3 days)
 *
 * These were six separate files. Each serverless file counts against the
 * deployment's function cap, and six functions for one feature is not a good
 * trade when they share every dependency. One dynamic route, same behaviour.
 */

import {
  db,
  llm,
  llmJSON,
  embed,
  embedOne,
  promote,
  gatherIncoming,
  memoryContext,
  resolveOwner,
  UTILITY_MODEL,
  WRITER_MODEL,
  requireHub,
  fail,
  storeMediaAsset,
  decodeDataUrl,
} from '../../lib/hub.js';

/**
 * POST /api/hub/initiate?action=workspace|group|media
 *
 * The three cross-module moves. Each creates the destination thread and the
 * graph edge, and seeds it with the carried-over content.
 *
 * Documents are NOT here — they are built from topics, not promoted from a
 * thread, so they go through /api/hub/document instead.
 */


async function handle_initiate(req, res) {
  if (!requireHub(res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'POST only');

  const ownerId = await resolveOwner(req, res);
  const action = req.query?.action;
  const { fromThreadId, seedContent, title, messageId, personaIds, mode, rounds } = req.body || {};

  if (!fromThreadId) return fail(res, 400, 'fromThreadId required');
  if (!seedContent || !String(seedContent).trim()) return fail(res, 400, 'seedContent required');

  // The source thread must already exist in the hub, otherwise the foreign key
  // on links rejects the insert with an opaque error. Scoped by owner, so a
  // thread id belonging to someone else reads as simply not found.
  const { data: source } = await db
    .from('threads')
    .select('id')
    .eq('owner_id', ownerId)
    .eq('id', fromThreadId)
    .maybeSingle();
  if (!source) return fail(res, 404, 'fromThreadId not found in hub — create the thread first');

  try {
    if (action === 'workspace') {
      const id = await promote({
        ownerId,
        fromThreadId,
        toType: 'workspace',
        relation: 'promoted_to_workspace',
        title: title || 'Untitled workspace',
        seedContent,
        seedMessageId: messageId || null,
      });
      return res.json({ ok: true, workspaceThreadId: id });
    }

    if (action === 'group') {
      if (!Array.isArray(personaIds) || personaIds.length < 2)
        return fail(res, 400, 'personaIds must contain at least 2 personas');

      const id = await promote({
        ownerId,
        fromThreadId,
        toType: 'group',
        relation: 'spawned_group_discussion',
        title: title || 'Group discussion',
        seedContent,
        metadata: {
          personaIds,
          mode: mode || 'brainstorm',
          rounds: typeof rounds === 'number' ? rounds : 3,
          roundNum: 0,
        },
      });
      return res.json({ ok: true, groupThreadId: id, personaIds });
    }

    if (action === 'media') {
      const id = await promote({
        ownerId,
        fromThreadId,
        toType: 'media',
        relation: 'sent_to_media',
        title: title || 'Media generation',
        seedContent,
      });
      return res.json({ ok: true, mediaThreadId: id });
    }

    return fail(res, 400, 'unknown action', ['workspace', 'group', 'media']);
  } catch (e) {
    return fail(res, 500, 'promote failed', e.message);
  }
}


/**
 * POST /api/hub/moderate
 *   { threadId, moderatorPersonaId?, routeTo?: 'workspace'|'media' }
 *
 * Closes out a group discussion so it doesn't dead-end:
 *   1. Extract each persona's actual claim (not their vibe).
 *   2. One vote round on those claims. No further debate.
 *   3. Write a resolution: summary + tally + decision, or explicit forks.
 *   4. Optionally promote the decision into workspace or media.
 *
 * Needs maxDuration 300 in vercel.json — it fans out to every persona model.
 */


async function handle_moderate(req, res) {
  if (!requireHub(res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'POST only');

  const ownerId = await resolveOwner(req, res);
  const { threadId, moderatorPersonaId, routeTo } = req.body || {};
  if (!threadId) return fail(res, 400, 'threadId required');
  if (routeTo && !['workspace', 'media'].includes(routeTo))
    return fail(res, 400, "routeTo must be 'workspace' or 'media'");

  const { data: thread } = await db
    .from('threads')
    .select('id, title, type')
    .eq('owner_id', ownerId)
    .eq('id', threadId)
    .maybeSingle();
  if (!thread) return fail(res, 404, 'thread not found');
  if (thread.type !== 'group') return fail(res, 400, 'not a group thread');

  const { data: msgs } = await db
    .from('messages')
    .select('persona_id, content, round, role')
    .eq('owner_id', ownerId)
    .eq('thread_id', threadId)
    .order('created_at');

  // is_moderator must be selected explicitly — the previous version filtered on
  // a column it never fetched, so a designated moderator was always ignored.
  const { data: personas } = await db
    .from('personas')
    .select('id, name, model, system_prompt, is_moderator');

  const spoke = [...new Set((msgs || []).map((m) => m.persona_id).filter(Boolean))];
  const participants = (personas || []).filter((p) => spoke.includes(p.id));
  if (participants.length < 2) return fail(res, 400, 'need at least 2 participating personas');

  const moderator =
    (personas || []).find((p) => p.id === moderatorPersonaId) ||
    (personas || []).find((p) => p.is_moderator);
  // Falls back to the writer model, not the cheap utility model — the closing
  // statement is the most important output in the whole flow.
  const moderatorModel = moderator?.model || WRITER_MODEL;

  const nameOf = (id) => participants.find((p) => p.id === id)?.name || 'user';
  const transcript = (msgs || [])
    .map((m) => `${m.persona_id ? nameOf(m.persona_id) : 'user'}: ${m.content}`)
    .join('\n\n')
    .slice(0, 80000);

  // --- 1. Positions --------------------------------------------------------
  let positions;
  try {
    const out = await llmJSON({
      model: moderatorModel,
      system: `You are a neutral moderator. State each participant's ACTUAL POSITION —
the concrete claim or recommendation they landed on, not a description of their
personality or how they talked. One position per participant, one or two sentences.
If someone never committed, say so plainly in their claim.

Participants: ${participants.map((p) => `${p.name} (${p.id})`).join(', ')}

Return JSON: {"positions":[{"persona_id":"...","name":"...","claim":"..."}]}`,
      messages: [{ role: 'user', content: transcript }],
      maxTokens: 2000,
    });
    positions = Array.isArray(out?.positions) ? out.positions : [];
  } catch (e) {
    return fail(res, 502, 'moderator failed to extract positions', e.message);
  }
  if (!positions.length) return fail(res, 502, 'no positions extracted');

  // --- 2. One vote round ---------------------------------------------------
  // Voting is by INDEX, not by name. Name-matching was fragile: models return
  // nicknames, add honorifics, or misspell, and the tally silently fragments.
  const ballot = positions.map((p, i) => `${i + 1}. ${p.name}: ${p.claim}`).join('\n');

  const votes = await Promise.all(
    participants.map(async (p) => {
      try {
        const v = await llmJSON({
          model: p.model,
          system: `${p.system_prompt}

The discussion is over. Vote once. Do not argue further and do not raise new points.
Choose the single position you most support — your own only if you genuinely still
believe it is strongest. One sentence of reasoning.

Return JSON: {"choice": <number from the list>, "reason": "..."}`,
          messages: [{ role: 'user', content: `Positions:\n\n${ballot}` }],
          maxTokens: 300,
        });
        const idx = Number(v?.choice) - 1;
        const target = positions[idx];
        return {
          voter: p.name,
          supports: target ? target.name : 'abstain',
          reason: String(v?.reason || '').slice(0, 400),
        };
      } catch {
        return { voter: p.name, supports: 'abstain', reason: 'model did not respond' };
      }
    })
  );

  // --- 3. Resolution -------------------------------------------------------
  const tally = {};
  for (const v of votes) {
    if (v.supports === 'abstain') continue;
    tally[v.supports] = (tally[v.supports] || 0) + 1;
  }
  const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  const consensus = ranked.length > 0 && ranked[0][1] > (ranked[1]?.[1] || 0);

  let final;
  try {
    final = await llmJSON({
      model: moderatorModel,
      system: `You are the moderator writing the closing statement. Be direct and specific.

"summary": what was actually decided and why, 3-5 sentences. No blow-by-blow recap
of who said what. No hedging.
"decision": if there is a clear winner, the actionable decision in one or two
sentences — concrete enough to hand straight to a builder or a writer. Otherwise null.
"forks": if there is no consensus, the competing paths as short concrete options.
Empty array if there was consensus.

Return JSON: {"summary":"...","decision":null,"forks":[]}`,
      messages: [
        {
          role: 'user',
          content:
            `Positions:\n${ballot}\n\nVotes:\n` +
            votes.map((v) => `${v.voter} -> ${v.supports}: ${v.reason}`).join('\n') +
            `\n\nTally: ${JSON.stringify(tally)}\nClear winner: ${consensus}`,
        },
      ],
      maxTokens: 1500,
    });
  } catch (e) {
    return fail(res, 502, 'moderator failed to write resolution', e.message);
  }

  const decision = consensus ? final?.decision || null : null;
  const forks = consensus ? [] : Array.isArray(final?.forks) ? final.forks : [];

  const { data: resolution, error: resErr } = await db
    .from('resolutions')
    .insert({
      owner_id: ownerId,
      thread_id: threadId,
      summary: final?.summary || '',
      positions,
      votes,
      decision,
      forks,
    })
    .select('id')
    .single();
  if (resErr) return fail(res, 500, 'failed to save resolution', resErr.message);

  await db.from('messages').insert({
    owner_id: ownerId,
    thread_id: threadId,
    role: 'resolution',
    model_used: moderatorModel,
    content:
      (final?.summary || '') +
      (decision ? `\n\n**Decision:** ${decision}` : '') +
      (forks.length ? `\n\n**No consensus. Forks:**\n- ${forks.join('\n- ')}` : '') +
      (ranked.length ? `\n\n_Vote: ${ranked.map(([k, n]) => `${k} (${n})`).join(', ')}_` : ''),
  });

  // --- 4. Route onward -----------------------------------------------------
  let routedThreadId = null;
  if (routeTo && decision) {
    try {
      routedThreadId = await promote({
        ownerId,
        fromThreadId: threadId,
        toType: routeTo,
        relation: routeTo === 'workspace' ? 'promoted_to_workspace' : 'sent_to_media',
        title: thread.title ? `${thread.title} — ${routeTo}` : `From group discussion`,
        // Media gets the decision alone; a summary paragraph makes a poor prompt.
        seedContent: routeTo === 'media' ? decision : `${final.summary}\n\nDecision: ${decision}`,
      });
    } catch (e) {
      // The resolution is already saved; routing failure shouldn't lose it.
      return res.json({
        resolutionId: resolution.id,
        summary: final?.summary,
        decision,
        forks,
        tally,
        routedThreadId: null,
        routeError: e.message,
      });
    }
  }

  return res.json({
    resolutionId: resolution.id,
    summary: final?.summary,
    decision,
    forks,
    tally,
    routedThreadId,
  });
}


/**
 * POST /api/hub/document
 *   { type, title?, topicIds[], documentId? }
 *
 * Builds a document from everything filed under one or more topics.
 * Passing documentId regenerates: pulls only material newer than built_from_at
 * and merges into the existing draft instead of starting over.
 *
 * Needs maxDuration 300 in vercel.json.
 */


const TEMPLATES = {
  story_bible: `Build a story bible. Sections: Premise, Setting, Characters (one per
character with role/want/wound/voice), Factions, Rules of the World, Timeline, Themes,
Open Questions. Mark anything thin as "underdeveloped" rather than inventing filler.`,

  outline: `Build a working outline. Sections: Logline, Structure, Beat list in order
with 1-3 sentences per beat, Threads to Pay Off, Gaps. Beats must be in causal order —
each should make the next inevitable.`,

  manuscript: `Draft prose using the source material as substance. Sections are chapters
or scenes. Write actual prose, not summaries of prose. Where material runs out, stop
the section rather than padding.`,

  memoir: `Build a memoir structure. Sections: Throughline, Key Episodes in order,
Recurring People, What Changed, What Is Still Unresolved. Use the user's own phrasings
wherever they appear — their language is the point.`,

  mock_textbook: `Build a textbook structure played straight. Sections: Preface, Units
with Chapters, Key Terms per chapter, Exercises, Further Reading. Hold academic register
throughout regardless of how absurd the subject is.`,

  research_journal: `Build a research journal. Sections: Question, Method, Dated Entries
in chronological order, Findings, Contradictions, Next Steps. Preserve dates and the
order material was recorded.`,

  biography: `Build a biography structure. Sections: Subject, Chronology, Formative
Events, Relationships, Contested Accounts, Sources. Flag anything unsupported by the
source material rather than smoothing it over.`,

  ad_copy: `Build an ad copy package. Sections: Brief (audience, promise, proof,
objection), Headlines (10 options), Body Copy at 15/50/150 words, Calls to Action.
Every claim must trace to something in the source material.`,

  business_doc: `Build a business document. Sections: Summary, Background, Analysis,
Options with tradeoffs, Recommendation, Risks, Next Steps. Lead with the recommendation.`,

  newsletter: `Build a newsletter issue. Sections: Subject Line (5 options), Opening Hook,
2-4 Segments, One Thing Worth Clicking, Sign-off. Segments short and independently readable.`,

  joke_bank: `Build a running joke bank — a flat editable LIST, not an essay. One
section only, heading "Jokes". Body is every joke verbatim, one per line, newest
first, exactly as the user said it — never paraphrase, never rewrite, never punch
one up. If a joke has an obvious short label (subject, first few words), prefix
the line with it in brackets so the list is scannable, then the joke itself.
Do not group, categorize, or add commentary — this is a list they'll keep adding
to and read straight down.`,
};

async function handle_document(req, res) {
  if (!requireHub(res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'POST only');

  const ownerId = await resolveOwner(req, res);
  const { type, title, topicIds, documentId } = req.body || {};
  if (!type || !Array.isArray(topicIds) || !topicIds.length)
    return fail(res, 400, 'type and topicIds[] required');
  if (!TEMPLATES[type]) return fail(res, 400, `unknown type: ${type}`, Object.keys(TEMPLATES));

  // Topic ids arrive from the client, so they are claims, not credentials:
  // confirm every one belongs to this owner before any of them reaches a
  // query, or a guessed id would pull someone else's notes into a document.
  const { data: owned } = await db
    .from('topics')
    .select('id')
    .eq('owner_id', ownerId)
    .in('id', topicIds);
  if ((owned?.length || 0) !== topicIds.length)
    return fail(res, 404, 'one or more topicIds not found');

  const result = await buildDocumentInternal({ ownerId, type, title, topicIds, documentId });
  if (result.error) return fail(res, result.status || 500, result.error, result.details);
  return res.json(result);
}

/**
 * Shared by the HTTP endpoint and internal callers (the joke-bank auto-sync
 * after sweep). Returns a plain result object instead of writing to `res`,
 * so it works the same either way.
 */
async function buildDocumentInternal({ ownerId, type, title, topicIds, documentId }) {
  if (!TEMPLATES[type]) return { error: `unknown type: ${type}`, status: 400 };
  if (!ownerId) return { error: 'ownerId required', status: 500 };

  let watermark = '1970-01-01T00:00:00Z';
  let existing = null;
  if (documentId) {
    const { data } = await db
      .from('documents')
      .select('id, sections, outline, built_from_at')
      .eq('owner_id', ownerId)
      .eq('id', documentId)
      .maybeSingle();
    if (!data) return { error: 'documentId not found', status: 404 };
    existing = data;
    watermark = data.built_from_at || watermark;
  }

  const buildStart = new Date().toISOString();

  const { data: notes } = await db
    .from('notes')
    .select('content, created_at, source_thread_id')
    .eq('owner_id', ownerId)
    .in('topic_id', topicIds)
    .gt('created_at', watermark)
    .lte('created_at', buildStart)
    .order('created_at');

  const { data: topics } = await db
    .from('topics')
    .select('id, name')
    .eq('owner_id', ownerId)
    .in('id', topicIds);

  const threadIds = [...new Set((notes || []).map((n) => n.source_thread_id).filter(Boolean))];
  let resolutions = [];
  if (threadIds.length) {
    const { data } = await db
      .from('resolutions')
      .select('summary, decision')
      .eq('owner_id', ownerId)
      .in('thread_id', threadIds);
    resolutions = data || [];
  }

  // This is the user's own writing voice going into the prompt — unscoped it
  // would have the document written in a stranger's style.
  const { data: facts } = await db
    .from('memory_facts')
    .select('content')
    .eq('owner_id', ownerId)
    .in('category', ['style', 'preference'])
    .order('confidence', { ascending: false })
    .limit(20);

  if (!notes?.length && !existing)
    return { error: 'no material filed under these topics yet', status: 400 };
  if (!notes?.length && existing)
    return { ok: true, documentId, unchanged: true, newNotesUsed: 0 };

  const material = [
    `TOPICS: ${(topics || []).map((t) => t.name).join(', ')}`,
    notes?.length ? `NOTES:\n${notes.map((n) => `- ${n.content}`).join('\n')}` : '',
    resolutions.length
      ? `DECISIONS REACHED:\n${resolutions.map((r) => `- ${r.decision || r.summary}`).join('\n')}`
      : '',
    existing
      ? `EXISTING DRAFT (merge new material in, preserve what still holds):\n${JSON.stringify(
          existing.sections
        ).slice(0, 30000)}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 120000);

  const voice = facts?.length
    ? `\n\nWrite in this user's voice. What is known about how they write:\n${facts
        .map((f) => `- ${f.content}`)
        .join('\n')}`
    : '';

  let built;
  try {
    built = await llmJSON({
      model: WRITER_MODEL,
      system: `${TEMPLATES[type]}

The source material is scattered notes and decisions collected over time, not a clean
brief. Organise it into the structure above — do not invent content to fill gaps. Where
the material is thin, say so in that section explicitly.${voice}

Return JSON: {"title":"...","outline":{},"sections":[{"heading":"...","body":"..."}]}`,
      messages: [{ role: 'user', content: material }],
      maxTokens: 8000,
    });
  } catch (e) {
    return { error: 'document generation failed', status: 502, details: e.message };
  }

  if (!Array.isArray(built?.sections) || !built.sections.length)
    return { error: 'model returned no sections', status: 502 };

  const row = {
    owner_id: ownerId,
    type,
    title: title || built.title || 'Untitled',
    outline: built.outline || {},
    sections: built.sections,
    built_from_at: buildStart,
    updated_at: buildStart,
  };

  const { data: doc, error } = documentId
    ? await db
        .from('documents')
        .update(row)
        .eq('owner_id', ownerId)
        .eq('id', documentId)
        .select('id')
        .single()
    : await db.from('documents').insert(row).select('id').single();

  if (error) return { error: 'failed to save document', status: 500, details: error.message };

  if (!documentId) {
    await db
      .from('document_topics')
      .insert(topicIds.map((t) => ({ document_id: doc.id, topic_id: t })));
  }

  return {
    ok: true,
    documentId: doc.id,
    title: row.title,
    sectionCount: built.sections.length,
    newNotesUsed: notes?.length || 0,
    regenerated: !!documentId,
  };
}


/**
 * POST /api/hub/media
 *   { threadId, kind?: 'image'|'video', size?, negativePrompt?, model? }
 *
 * Runs a media thread's seed prompt through generation, then saves the result
 * back onto the thread.
 *
 * This deliberately delegates to the existing /api/media-generate rather than
 * calling providers directly. That endpoint already normalises every response
 * shape those providers return (result.image, images[0], b64_json, raw binary,
 * data URLs) and enforces the 4.5MB body limit. Re-implementing it here would
 * mean maintaining two copies of that logic, and the second copy would be the
 * wrong one.
 *
 * Provider order mirrors the Media Studio picker (public/media/media.js): the
 * self-hosted Modal apps are first because they are the ones actually
 * deployed and unfiltered. Cloudflare stays as a fallback for images only —
 * it is the sole remaining hosted image provider after Venice/NVIDIA were
 * dropped from the picker.
 */


const ORDER_BY_KIND = {
  image: [
    { provider: 'modal', model: 'lustify' },
    { provider: 'cloudflare', model: '@cf/black-forest-labs/flux-1-schnell' },
  ],
  video: [
    // LTX first: the Studio labels it the fast one and caps it at 30s, where
    // Wan is labelled slow and capped at 5s.
    { provider: 'modal', model: 'ltx-video' },
    { provider: 'modal', model: 'wan2.2-5b' },
  ],
};

function baseUrl(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}

async function handle_media(req, res) {
  if (!requireHub(res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'POST only');

  const ownerId = await resolveOwner(req, res);
  const { threadId, kind = 'image', size, negativePrompt, model, seconds, accessKey } =
    req.body || {};
  if (!threadId) return fail(res, 400, 'threadId required');
  if (!ORDER_BY_KIND[kind]) return fail(res, 400, "kind must be 'image' or 'video'");

  const { data: thread } = await db
    .from('threads')
    .select('id, type, title, seed_prompt')
    .eq('owner_id', ownerId)
    .eq('id', threadId)
    .maybeSingle();

  if (!thread) return fail(res, 404, 'thread not found');
  if (thread.type !== 'media') return fail(res, 400, 'not a media thread');

  // seed_prompt is the clean carried-over text. Reading the first message
  // instead would feed the wrapper prose into the image model.
  const prompt = (thread.seed_prompt || '').trim();
  if (!prompt) return fail(res, 400, 'thread has no seed prompt');

  const attempts = [];
  let success = null;

  // An explicit `model` pins the request to that one model rather than
  // silently falling through to a different one the caller didn't ask for.
  const order = model
    ? ORDER_BY_KIND[kind].filter((t) => t.model === model).concat(
        ORDER_BY_KIND[kind].some((t) => t.model === model)
          ? []
          : [{ provider: 'modal', model }],
      )
    : ORDER_BY_KIND[kind];

  for (const target of order) {
    try {
      const upstream = await fetch(`${baseUrl(req)}/api/media-generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind,
          provider: target.provider,
          model: target.model,
          prompt,
          ...(negativePrompt ? { negativePrompt } : {}),
          ...(size ? { size } : {}),
          ...(kind === 'video' && seconds ? { seconds } : {}),
          // Modal is metered per access key when VIDEO_ACCESS_KEYS is set.
          ...(target.provider === 'modal' && accessKey ? { accessKey } : {}),
        }),
      });

      const body = await upstream.json().catch(() => ({}));
      if (!upstream.ok) {
        attempts.push(`${target.provider}: ${upstream.status} ${body?.error || ''}`.trim());
        continue;
      }
      success = { ...body, provider: target.provider, model: target.model };
      break;
    } catch (e) {
      attempts.push(`${target.provider}: ${e.message}`);
    }
  }

  if (!success) return fail(res, 502, 'all providers failed', attempts);

  // /api/media-generate never returns a bare `url` — it returns
  // `images: [{ base64 | url, mimeType }]` for images and `videoUrl` (an http
  // URL or a data: URL) for video. Read those shapes, matching what Media
  // Studio does in public/media/media.js.
  const asset = extractAsset(success);
  if (!asset) {
    return fail(res, 502, 'provider returned no usable asset', [
      ...attempts,
      `${success.provider}: response had no images[] or videoUrl`,
    ]);
  }

  // Store a URL, never base64. A single 1024px image is ~1-2MB of base64;
  // writing that into a text column bloats every subsequent thread read and
  // pushes responses past Vercel's 4.5MB body limit. Video is far worse, so
  // an un-storable video is an error rather than an inline fallback.
  let url = asset.url;
  if (!url && asset.bytes) {
    url = await storeMediaAsset(asset.bytes, asset.mimeType, threadId);
  }
  if (!url) {
    if (success.kind === 'video') {
      return fail(res, 502, 'video generated but asset storage is unavailable', [
        ...attempts,
        'configure Supabase Storage (HUB_MEDIA_BUCKET) to persist generated video',
      ]);
    }
    // Images are small enough to survive inline while storage is unconfigured.
    url = `data:${asset.mimeType};base64,${asset.bytes.toString('base64')}`;
  }

  const title = thread.title || 'generated';
  const content =
    success.kind === 'video' ? `[${title} (video)](${url})` : `![${title}](${url})`;

  await db.from('messages').insert({
    owner_id: ownerId,
    thread_id: threadId,
    role: 'assistant',
    model_used: `${success.provider}/${success.model}`,
    content,
  });

  return res.json({
    ok: true,
    threadId,
    kind: success.kind || kind,
    provider: success.provider,
    model: success.model,
    url,
    stored: !url.startsWith('data:'),
    fallbacksTried: attempts,
  });
}

/**
 * Pull the generated bytes (or an already-hosted URL) out of a
 * /api/media-generate response.
 *
 * @returns {{url: string|null, bytes: Buffer|null, mimeType: string}|null}
 */
function extractAsset(result) {
  if (result?.kind === 'video' || result?.videoUrl) {
    const videoUrl = result.videoUrl;
    if (!videoUrl) return null;
    const decoded = decodeDataUrl(videoUrl);
    return decoded
      ? { url: null, bytes: decoded.bytes, mimeType: decoded.mimeType }
      : { url: videoUrl, bytes: null, mimeType: result.mime || 'video/mp4' };
  }

  const img = result?.images?.[0];
  if (!img) return null;
  if (img.url) {
    return { url: img.url, bytes: null, mimeType: img.mimeType || 'image/png' };
  }
  if (!img.base64) return null;
  // Some providers hand back a full data: URL in the base64 field.
  const decoded = decodeDataUrl(img.base64);
  if (decoded) return { url: null, ...decoded };
  return {
    url: null,
    bytes: Buffer.from(img.base64, 'base64'),
    mimeType: img.mimeType || 'image/png',
  };
}


/**
 * Small read/write endpoints the UI needs.
 *
 *   GET  /api/hub/state?action=nudges     -> open nudges + memory facts + topics
 *   GET  /api/hub/state?action=topics     -> all topics with note counts
 *   GET  /api/hub/state?action=inbox      -> notes that matched no topic
 *   POST /api/hub/state?action=dismiss    { nudgeId }
 *   POST /api/hub/state?action=register   { localId?, type, title, messages? } -> threadId
 *   POST /api/hub/state?action=append     { threadId, messages } -> inserted count
 *
 * `register` exists because the app stores chats in localStorage. A thread has
 * to exist in the hub before anything can be promoted out of it, or the links
 * foreign key rejects the insert. It's idempotent on `localId` (looked up via
 * `threads.local_id`), so continuous per-chat sync can call it on every turn
 * without creating a new thread each time — cache the returned id on the
 * local chat object. `append` then does the actual incremental sync: only
 * the messages sent since the caller's own last-synced cursor.
 */


async function handle_state(req, res) {
  if (!requireHub(res)) return;
  const action = req.query?.action;

  // Deliberately before resolveOwner: this is the endpoint you reach for when
  // the hub is broken, so it must not depend on the hub working. Answers the
  // question the code otherwise cannot — WHICH database is this deployment
  // actually talking to, and what can it see in there? Reports the project
  // ref only, which is already public in the API URL, never the keys.
  if (action === 'diag') return diagnose(res);

  const ownerId = await resolveOwner(req, res);

  if (req.method === 'GET') {
    // These reads used to destructure `data` only and return `data || []`, so
    // a database that was gone entirely answered 200 with an empty list. That
    // is indistinguishable from "nothing filed yet", and `hubReady()` probes
    // `topics` — so the app concluded memory was working and simply had no
    // content, every time, with no way for anyone to find out otherwise.
    // Surfacing the error is what lets the UI say memory is down.
    if (action === 'nudges') {
      const [{ data: nudges, error: nudgeErr }, { data: facts, error: factErr }] =
        await Promise.all([
          db
            .from('nudges')
            .select('id, topic_id, message, nudge_type, payload, created_at')
            .eq('owner_id', ownerId)
            .eq('dismissed', false)
            .order('created_at', { ascending: false })
            .limit(10),
          db
            .from('memory_facts')
            .select('id, category, content, confidence')
            .eq('owner_id', ownerId)
            .order('confidence', { ascending: false })
            .limit(15),
        ]);
      const err = nudgeErr || factErr;
      if (err) return fail(res, 503, 'memory database unreachable', err.message);
      return res.json({ nudges: nudges || [], facts: facts || [] });
    }

    if (action === 'topics') {
      const { data, error } = await db
        .from('topics')
        .select('id, name, note_count, last_seen_at')
        .eq('owner_id', ownerId)
        .order('last_seen_at', { ascending: false })
        .limit(100);
      if (error) return fail(res, 503, 'memory database unreachable', error.message);
      return res.json({ topics: data || [] });
    }

    if (action === 'inbox') {
      const { data, error } = await db
        .from('notes')
        .select('id, content, created_at, source_thread_id')
        .eq('owner_id', ownerId)
        .is('topic_id', null)
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) return fail(res, 503, 'memory database unreachable', error.message);
      return res.json({ notes: data || [] });
    }

    if (action === 'joke-bank-raw') {
      // Plain markdown, not JSON — this is what the Workspace file-open link
      // hits, so it reads and edits like a real file instead of app UI.
      const { data: doc } = await db
        .from('documents')
        .select('title, sections, updated_at')
        .eq('owner_id', ownerId)
        .eq('type', 'joke_bank')
        .limit(1)
        .maybeSingle();

      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');

      if (!doc) {
        return res.end('# Joke Bank\n\nNothing filed yet — tell one in chat and it lands here after the next sweep.\n');
      }

      const body = (doc.sections || [])
        .map((s) => `## ${s.heading}\n\n${s.body}`)
        .join('\n\n');
      const md = `# ${doc.title}\n\n_Last updated: ${doc.updated_at}_\n\n${body}\n`;
      return res.end(md);
    }

    return fail(res, 400, 'unknown action', ['nudges', 'topics', 'inbox', 'joke-bank-raw']);
  }

  if (req.method === 'POST') {
    if (action === 'dismiss') {
      const { nudgeId } = req.body || {};
      if (!nudgeId) return fail(res, 400, 'nudgeId required');
      const { error } = await db
        .from('nudges')
        .update({ dismissed: true })
        .eq('owner_id', ownerId)
        .eq('id', nudgeId);
      if (error) return fail(res, 500, 'dismiss failed', error.message);
      return res.json({ ok: true });
    }

    if (action === 'turn') {
      // One persona turn from a live group discussion. Without these the
      // moderator has an empty transcript to work from.
      const { threadId, personaId, name, model, content, round } = req.body || {};
      if (!threadId || !content) return fail(res, 400, 'threadId and content required');
      if (!(await ownsThread(ownerId, threadId))) return fail(res, 404, 'thread not found');

      // Personas are a shared, admin-defined catalog matched by slug, not
      // per-owner data — so this lookup is deliberately not owner-scoped.
      let pid = null;
      if (personaId) {
        const { data: p } = await db
          .from('personas')
          .select('id')
          .or(`id.eq.${personaId},slug.eq.${personaId}`)
          .limit(1)
          .maybeSingle();
        pid = p?.id || null;

        // Auto-register a persona the hub has not seen yet, so a discussion
        // never silently drops turns for an unknown speaker.
        if (!pid && name) {
          const { data: created } = await db
            .from('personas')
            .insert({ slug: personaId, name, model: model || 'unknown', system_prompt: '' })
            .select('id')
            .single();
          pid = created?.id || null;
        }
      }

      const { error } = await db.from('messages').insert({
        owner_id: ownerId,
        thread_id: threadId,
        persona_id: pid,
        role: 'assistant',
        model_used: model || null,
        content: String(content).slice(0, 20000),
        round: typeof round === 'number' ? round : null,
      });
      if (error) return fail(res, 500, 'turn insert failed', error.message);
      return res.json({ ok: true });
    }

    if (action === 'register') {
      const { type = 'chat', title, localId, messages } = req.body || {};

      // Idempotent: continuous sync calls this on every chat, every turn, so
      // a repeat call for the same local chat must reuse the existing thread
      // instead of creating a duplicate every time. Scoped by owner — local
      // ids come from another device's localStorage, so globally they are not
      // unique and a collision would have handed over someone else's thread.
      if (localId) {
        const { data: found } = await db
          .from('threads')
          .select('id')
          .eq('owner_id', ownerId)
          .eq('local_id', localId)
          .maybeSingle();
        if (found) return res.json({ ok: true, threadId: found.id });
      }

      const { data: thread, error } = await db
        .from('threads')
        .insert({
          owner_id: ownerId,
          type,
          title: title || 'Untitled',
          local_id: localId || null,
          metadata: localId ? { localId } : {},
        })
        .select('id')
        .single();
      if (error) return fail(res, 500, 'register failed', error.message);

      // Optionally backfill existing local messages so the sweep has something
      // to read on the first pass.
      if (Array.isArray(messages) && messages.length) {
        const rows = messages
          .filter((m) => m?.content)
          .slice(-200)
          .map((m) => ({
            owner_id: ownerId,
            thread_id: thread.id,
            role: m.role === 'user' ? 'user' : 'assistant',
            content: String(m.content).slice(0, 20000),
          }));
        if (rows.length) await db.from('messages').insert(rows);
      }

      return res.json({ ok: true, threadId: thread.id });
    }

    if (action === 'append') {
      // Incremental sync: only the messages the client hasn't sent yet, not
      // a re-send of the whole thread. Distinct from `turn` (one live
      // group-discussion turn) and `register`'s one-time backfill.
      const { threadId, messages } = req.body || {};
      if (!threadId) return fail(res, 400, 'threadId required');
      if (!(await ownsThread(ownerId, threadId))) return fail(res, 404, 'thread not found');
      if (!Array.isArray(messages) || !messages.length) return res.json({ ok: true, inserted: 0 });

      const rows = messages
        .filter((m) => m?.content)
        .slice(-200)
        .map((m) => ({
          owner_id: ownerId,
          thread_id: threadId,
          role: m.role === 'user' ? 'user' : 'assistant',
          content: String(m.content).slice(0, 20000),
        }));
      if (!rows.length) return res.json({ ok: true, inserted: 0 });

      const { error } = await db.from('messages').insert(rows);
      if (error) return fail(res, 500, 'append failed', error.message);
      return res.json({ ok: true, inserted: rows.length });
    }

    if (action === 'sweep-thread') {
      // The full sweep is a daily cron, so a chat you just had contributed
      // nothing to Memory until the next morning — which reads as "memory is
      // broken". This sweeps one thread on demand.
      // Deliberately scoped to a single thread (and skipped when that thread
      // has nothing new) so it stays cheap however often it's tapped.
      const { threadId } = req.body || {};
      if (!threadId) return fail(res, 400, 'threadId required');

      const { data: thread, error: findErr } = await db
        .from('threads')
        .select('id, owner_id, title, swept_at, last_activity')
        .eq('owner_id', ownerId)
        .eq('id', threadId)
        .maybeSingle();
      if (findErr) return fail(res, 500, 'thread lookup failed', findErr.message);
      if (!thread) return fail(res, 404, 'thread not found');

      let result;
      try {
        result = await sweepThread(thread);
      } catch (e) {
        return fail(res, 500, 'sweep failed', e.message);
      }

      // Nudges and the joke-bank document are what make the result visible in
      // the Memory sheet, so do the same follow-up work the cron does.
      const nudged = await raiseNudges(ownerId).catch(() => 0);
      const groupSuggestionsRaised =
        await raiseGroupSuggestions(ownerId, result.topicIds || []).catch(() => 0);
      let jokeBankDoc = null;
      if (result.jokes > 0) {
        jokeBankDoc = await syncJokeBankDocument(ownerId).catch(() => null);
      }

      return res.json({
        ok: true,
        notesFiled: result.notes,
        jokesFiled: result.jokes,
        jokeBankDoc,
        nudgesRaised: nudged,
        groupSuggestionsRaised,
      });
    }

    return fail(res, 400, 'unknown action', [
      'dismiss', 'register', 'append', 'turn', 'sweep-thread',
    ]);
  }

  return fail(res, 405, 'GET or POST only');
}

/**
 * Reports which Supabase project this deployment is pointed at and which hub
 * tables it can actually reach.
 *
 * This exists because a whole afternoon went into a memory failure that no
 * amount of reading the code could explain: SUPABASE_URL is an environment
 * variable, so the repo cannot say which database is in use, and every read
 * was swallowing its error and answering 200 with an empty list. Nothing in
 * the app or its logs could distinguish "no notes yet" from "pointed at the
 * wrong project entirely".
 *
 * Only the project ref is returned — the leading label of the API hostname,
 * which is already public in every request the browser makes. Keys are never
 * echoed, not even in part.
 */
async function diagnose(res) {
  let projectRef = null;
  let apiHost = null;
  try {
    apiHost = new URL(process.env.SUPABASE_URL).host;
    projectRef = apiHost.split('.')[0];
  } catch {
    apiHost = '(SUPABASE_URL is not a valid URL)';
  }

  const TABLES = [
    'owners', 'threads', 'personas', 'messages', 'links', 'topics',
    'notes', 'memory_facts', 'resolutions', 'documents', 'document_topics', 'nudges',
  ];

  const tables = {};
  for (const t of TABLES) {
    const { error, count } = await db
      .from(t)
      .select('*', { count: 'exact', head: true });
    tables[t] = error ? `ERROR: ${error.message}` : `ok (${count ?? 0} rows)`;
  }

  // The owner-scoped vector helpers are a separate failure mode: the table can
  // exist while the function is missing or still has its old unscoped shape.
  const fns = {};
  for (const [name, args] of [
    ['match_topics', { p_owner_id: null, p_embedding: null, p_threshold: 0, p_limit: 1 }],
    ['match_notes', { p_owner_id: null, p_topic_id: null, p_embedding: null, p_threshold: 0, p_limit: 1 }],
    ['match_facts', { p_owner_id: null, p_category: 'x', p_embedding: null, p_threshold: 0, p_limit: 1 }],
  ]) {
    const { error } = await db.rpc(name, args);
    // A null embedding is not valid input, so an argument complaint still
    // proves the function exists with the owner-scoped signature. Only a
    // "could not find the function" answer means it is actually missing.
    fns[name] = !error
      ? 'ok'
      : /could not find|does not exist/i.test(error.message)
        ? `MISSING: ${error.message}`
        : 'ok (exists; rejected the null probe args, as expected)';
  }

  return res.json({ apiHost, projectRef, tables, functions: fns });
}

/**
 * True when this thread belongs to this owner.
 *
 * Thread ids arrive in request bodies, so they are claims the caller makes,
 * not proof of anything. Reads are naturally safe because every query filters
 * on owner_id, but a write keyed only on thread_id would happily append to
 * someone else's conversation — so every write that takes a client-supplied
 * threadId checks here first, and a thread belonging to another owner reads
 * back as simply not found.
 */
async function ownsThread(ownerId, threadId) {
  if (!ownerId || !threadId) return false;
  const { data } = await db
    .from('threads')
    .select('id')
    .eq('owner_id', ownerId)
    .eq('id', threadId)
    .maybeSingle();
  return !!data?.id;
}


/**
 * GET /api/cron/sweep  — runs daily (vercel.json crons)
 *
 * Daily rather than every third day for two reasons: a conversation should
 * reach Memory the next day at worst, and Supabase pauses a Free-plan project
 * that goes a week without a few database requests a day — an every-3-days
 * cron is under that bar, which is how the notes database went away once
 * already.
 *
 * One pass per thread touched since its last sweep (so a quiet day is a
 * cheap no-op, not a re-read of everything):
 *   - pulls out side thoughts as notes, filed under auto-created topics
 *   - refreshes memory_facts
 *   - raises nudges for topics that have gone quiet
 *
 * Needs maxDuration 300 in vercel.json — a sweep over many threads will blow
 * through the 60s default.
 */


const TOPIC_MATCH_THRESHOLD = 0.78; // below this, create a new topic
const NOTE_DUPE_THRESHOLD = 0.92; // above this, already captured
const FACT_DUPE_THRESHOLD = 0.9;
const STALE_DAYS = 21;
const MIN_MESSAGES = 4;
const MAX_THREADS_PER_RUN = 100;

// Fixed name, not fuzzy-matched like other topics — every joke lands in the
// same bucket regardless of what it's about, instead of splitting across
// whatever topic the embedding happens to land nearest.
const JOKE_BANK_TOPIC = 'Joke Bank';

const EXTRACT_PROMPT = `You read a conversation and pull out what would otherwise be lost.

Return JSON: { "notes": [...], "facts": [...], "jokes": [...] }

NOTES = side thoughts, tangents and asides that are NOT the main subject but have
standalone value later: app ideas mentioned in passing, story beats, plans, names,
things the user said they should do. Each note must stand on its own and be
understandable months from now with no surrounding context. Do NOT capture the
main topic itself, small talk, or things the user only asked a question about.
Shape: {"content": "...", "confidence": 0.0-1.0}

FACTS = durable things about the user: how they write, what they find funny,
working preferences, ongoing projects, people in their life. Only things still
true in six months. Shape: {"category": "style|preference|project|person", "content": "..."}

JOKES = something the user said that IS a joke or bit — a punchline, a one-liner,
a bit they're working out, or anything they call "a joke" or "a bit" while saying
it, even mid-conversation and not set up as a formal joke. This is their own
material to keep, word for word — the actual joke text, not your paraphrase of it.
Do NOT include jokes the user is merely quoting, reacting to, or asking about
(someone else's joke, a meme, "is this joke funny") — only their own material.
Shape: {"text": "...", "confidence": 0.0-1.0}

If nothing is worth keeping, return empty arrays. Empty is a correct answer.`;

async function handle_sweep(req, res) {
  if (!requireHub(res)) return;
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return fail(res, 401, 'unauthorized');
  }

  // owner_id comes along so the per-owner follow-up work below can be grouped
  // by it. The cron has no cookie and therefore no single owner of its own —
  // it sweeps everyone's threads, but each thread's own owner scopes every
  // topic match, fact dedup and nudge it produces.
  const { data: threads, error } = await db
    .from('threads')
    .select('id, owner_id, title, swept_at, last_activity')
    .or('swept_at.is.null,swept_at.lt.last_activity')
    .order('last_activity', { ascending: false })
    .limit(MAX_THREADS_PER_RUN);

  if (error) return fail(res, 500, 'thread query failed', error.message);

  let notesFiled = 0;
  let jokesFiled = 0;
  const errors = [];
  // owner id -> { topicIds: Set, jokes: number }
  const perOwner = new Map();

  for (const thread of threads || []) {
    try {
      const result = await sweepThread(thread);
      notesFiled += result.notes;
      jokesFiled += result.jokes;

      if (!perOwner.has(thread.owner_id)) {
        perOwner.set(thread.owner_id, { topicIds: new Set(), jokes: 0 });
      }
      const bucket = perOwner.get(thread.owner_id);
      bucket.jokes += result.jokes;
      for (const id of result.topicIds || []) bucket.topicIds.add(id);
    } catch (e) {
      errors.push(`${thread.id}: ${e.message}`);
    }
  }

  // Nudges, group suggestions and the joke-bank document are all per-owner:
  // run once for each owner whose threads were actually touched, rather than
  // once globally over a merged pool.
  let nudged = 0;
  let groupSuggestionsRaised = 0;
  const jokeBankDocs = [];

  for (const [ownerId, bucket] of perOwner) {
    try {
      nudged += await raiseNudges(ownerId);
      groupSuggestionsRaised += await raiseGroupSuggestions(ownerId, [...bucket.topicIds]);

      // Keep the running joke-bank document in sync whenever new jokes landed
      // — no manual "build document" step. Regeneration only pulls what's new
      // since the last build, so this stays cheap even with nothing to do.
      if (bucket.jokes > 0) {
        const doc = await syncJokeBankDocument(ownerId);
        if (doc) jokeBankDocs.push(doc);
      }
    } catch (e) {
      errors.push(`owner ${ownerId}: ${e.message}`);
    }
  }

  return res.json({
    threadsScanned: threads?.length || 0,
    ownersSwept: perOwner.size,
    notesFiled,
    jokesFiled,
    jokeBankDocs,
    nudgesRaised: nudged,
    groupSuggestionsRaised,
    errors,
  });
}

async function sweepThread(thread) {
  // thread.owner_id scopes everything this pass writes or matches against.
  // Callers select it; a thread row without it is a programming error, not
  // something to guess a default for.
  const ownerId = thread.owner_id;
  if (!ownerId) throw new Error('sweepThread requires thread.owner_id');

  // Freeze the window BEFORE reading. Anything that lands mid-sweep stays
  // unswept and gets picked up next run instead of being skipped forever.
  const windowEnd = new Date().toISOString();
  const since = thread.swept_at || '1970-01-01T00:00:00Z';

  const { data: msgs } = await db
    .from('messages')
    .select('id, role, content, created_at')
    .eq('owner_id', ownerId)
    .eq('thread_id', thread.id)
    .gt('created_at', since)
    .lte('created_at', windowEnd)
    .order('created_at');

  // Filtered on owner as well as id. Redundant given callers already scoped
  // the thread, but it keeps the invariant local to this function rather than
  // resting on every future caller remembering it.
  const markSwept = () =>
    db
      .from('threads')
      .update({ swept_at: windowEnd })
      .eq('owner_id', ownerId)
      .eq('id', thread.id);

  if (!msgs || msgs.length < MIN_MESSAGES) {
    await markSwept();
    return { notes: 0, jokes: 0 };
  }

  const transcript = msgs
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n\n')
    .slice(0, 60000);

  const out = await llmJSON({
    model: UTILITY_MODEL,
    system: EXTRACT_PROMPT,
    messages: [{ role: 'user', content: transcript }],
    maxTokens: 3000,
  });

  await upsertFacts(ownerId, Array.isArray(out?.facts) ? out.facts : []);

  const candidates = (Array.isArray(out?.notes) ? out.notes : []).filter((n) =>
    String(n?.content || '').trim()
  );

  let filed = 0;
  const touchedTopicIds = new Set();
  if (candidates.length) {
    const vectors = await embed(candidates.map((c) => c.content));

    for (let i = 0; i < candidates.length; i++) {
      const note = candidates[i];
      const vec = vectors[i];
      if (!vec) continue;

      const { data: matches } = await db.rpc('match_topics', {
        p_owner_id: ownerId,
        p_embedding: vec,
        p_threshold: TOPIC_MATCH_THRESHOLD,
        p_limit: 1,
      });

      let topicId = matches?.[0]?.id || null;

      if (topicId) {
        const { data: dupes } = await db.rpc('match_notes', {
          p_owner_id: ownerId,
          p_topic_id: topicId,
          p_embedding: vec,
          p_threshold: NOTE_DUPE_THRESHOLD,
          p_limit: 1,
        });
        if (dupes?.length) continue; // already captured
      } else {
        topicId = await createTopic(ownerId, note.content, vec);
      }

      // note_count and last_seen_at are maintained by the DB trigger.
      const { error: insErr } = await db.from('notes').insert({
        owner_id: ownerId,
        topic_id: topicId,
        content: note.content,
        source_thread_id: thread.id,
        embedding: vec,
        confidence: typeof note.confidence === 'number' ? note.confidence : 0.5,
      });
      if (!insErr) {
        filed++;
        touchedTopicIds.add(topicId);
      }
    }
  }

  const jokesFiled = await fileJokes(thread, Array.isArray(out?.jokes) ? out.jokes : []);

  await markSwept();
  return { notes: filed, jokes: jokesFiled, topicIds: [...touchedTopicIds] };
}

/**
 * Every joke goes into the same fixed topic — never fuzzy-matched, never
 * split. Fixed by name, but one such topic PER OWNER: a single shared Joke
 * Bank would pile everyone's material into one list.
 */
async function fileJokes(thread, jokes) {
  const ownerId = thread.owner_id;
  const candidates = jokes.filter((j) => String(j?.text || '').trim());
  if (!candidates.length) return 0;

  const topicId = await getOrCreateJokeBankTopic(ownerId);
  const vectors = await embed(candidates.map((c) => c.text));

  let filed = 0;
  for (let i = 0; i < candidates.length; i++) {
    const joke = candidates[i];
    const vec = vectors[i];
    if (!vec) continue;

    const { data: dupes } = await db.rpc('match_notes', {
      p_owner_id: ownerId,
      p_topic_id: topicId,
      p_embedding: vec,
      p_threshold: NOTE_DUPE_THRESHOLD,
      p_limit: 1,
    });
    if (dupes?.length) continue; // already have this one, word for word

    const { error: insErr } = await db.from('notes').insert({
      owner_id: ownerId,
      topic_id: topicId,
      content: joke.text,
      source_thread_id: thread.id,
      embedding: vec,
      confidence: typeof joke.confidence === 'number' ? joke.confidence : 0.5,
    });
    if (!insErr) filed++;
  }
  return filed;
}

async function getOrCreateJokeBankTopic(ownerId) {
  const { data: existing } = await db
    .from('topics')
    .select('id')
    .eq('owner_id', ownerId)
    .eq('name', JOKE_BANK_TOPIC)
    .limit(1)
    .maybeSingle();
  if (existing?.id) return existing.id;

  const vec = await embedOne(JOKE_BANK_TOPIC);
  const { data, error } = await db
    .from('topics')
    .insert({
      owner_id: ownerId,
      name: JOKE_BANK_TOPIC,
      embedding: vec,
      summary: "The user's own jokes and bits, kept word for word.",
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

/**
 * Regenerates the running joke-bank document from whatever is new. Finds
 * the existing doc (there's only ever one) or creates it on first run.
 */
async function syncJokeBankDocument(ownerId) {
  const topicId = await getOrCreateJokeBankTopic(ownerId);

  const { data: existingDoc } = await db
    .from('documents')
    .select('id')
    .eq('owner_id', ownerId)
    .eq('type', 'joke_bank')
    .limit(1)
    .maybeSingle();

  return buildDocumentInternal({
    ownerId,
    type: 'joke_bank',
    title: 'Joke Bank',
    topicIds: [topicId],
    documentId: existingDoc?.id || null,
  });
}

async function createTopic(ownerId, seed, vec) {
  let name = seed.split(/[.!?\n]/)[0].slice(0, 60);
  try {
    const named = await llmJSON({
      model: UTILITY_MODEL,
      system: 'Name this topic in 2-4 words. Return JSON: {"name":"..."}',
      messages: [{ role: 'user', content: seed }],
      maxTokens: 60,
    });
    if (named?.name) name = named.name;
  } catch {
    /* fall back to the truncated seed */
  }

  const { data, error } = await db
    .from('topics')
    .insert({ owner_id: ownerId, name, embedding: vec })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

async function upsertFacts(ownerId, facts) {
  const clean = facts.filter((f) => String(f?.content || '').trim());
  if (!clean.length) return;

  const vectors = await embed(clean.map((f) => f.content));

  for (let i = 0; i < clean.length; i++) {
    const f = clean[i];
    const vec = vectors[i];
    if (!vec) continue;

    // Vector dedup. The previous version used full-text search against a
    // column with no tsvector index, so it never matched and every sweep
    // re-inserted the same facts. Scoped by owner: unscoped, two different
    // people saying something similar about themselves would dedup into one
    // shared row that then described neither of them.
    const { data: existing } = await db.rpc('match_facts', {
      p_owner_id: ownerId,
      p_category: f.category || 'preference',
      p_embedding: vec,
      p_threshold: FACT_DUPE_THRESHOLD,
      p_limit: 1,
    });

    if (existing?.length) {
      const hit = existing[0];
      await db
        .from('memory_facts')
        .update({
          times_seen: hit.times_seen + 1,
          confidence: Math.min(1, hit.confidence + 0.15),
          updated_at: new Date().toISOString(),
        })
        .eq('owner_id', ownerId)
        .eq('id', hit.id);
    } else {
      await db.from('memory_facts').insert({
        owner_id: ownerId,
        category: f.category || 'preference',
        content: f.content,
        embedding: vec,
      });
    }
  }
}

async function raiseNudges(ownerId) {
  const cutoff = new Date(Date.now() - STALE_DAYS * 864e5).toISOString();
  const { data: stale } = await db
    .from('topics')
    .select('id, name, note_count, last_seen_at')
    .eq('owner_id', ownerId)
    .lt('last_seen_at', cutoff)
    .gt('note_count', 2)
    .limit(5);

  let raised = 0;
  for (const t of stale || []) {
    const { data: open } = await db
      .from('nudges')
      .select('id')
      .eq('owner_id', ownerId)
      .eq('topic_id', t.id)
      .eq('dismissed', false)
      .limit(1);
    if (open?.length) continue; // don't nag twice

    const days = Math.floor((Date.now() - new Date(t.last_seen_at).getTime()) / 864e5);
    const { error } = await db.from('nudges').insert({
      owner_id: ownerId,
      topic_id: t.id,
      message: `${t.note_count} thoughts filed under "${t.name}" — nothing new in ${days} days.`,
    });
    if (!error) raised++;
  }
  return raised;
}

/**
 * Suggests grouping chats into a project when this sweep just filed notes
 * from two or more distinct threads under the same topic. Never applies the
 * grouping itself — the server has no "project" concept and no visibility
 * into localStorage, so it only proposes; the client decides whether to
 * create/assign the project when the user accepts the nudge (or to skip
 * silently if those chats already share one). Excludes the fixed Joke Bank
 * topic — every joke lands there regardless of subject, so sharing it says
 * nothing about the threads actually being related.
 */
async function raiseGroupSuggestions(ownerId, topicIds) {
  let raised = 0;
  for (const topicId of topicIds) {
    const { data: topic } = await db
      .from('topics')
      .select('id, name')
      .eq('owner_id', ownerId)
      .eq('id', topicId)
      .maybeSingle();
    if (!topic || topic.name === JOKE_BANK_TOPIC) continue;

    const { data: notes } = await db
      .from('notes')
      .select('source_thread_id')
      .eq('owner_id', ownerId)
      .eq('topic_id', topicId)
      .not('source_thread_id', 'is', null);
    const threadIds = [...new Set((notes || []).map((n) => n.source_thread_id))];
    if (threadIds.length < 2) continue;

    // The local ids in this payload go back to the client, which looks them up
    // in its own localStorage — so they must be this owner's chats or the
    // nudge would name chats the recipient has never seen.
    const { data: threads } = await db
      .from('threads')
      .select('local_id')
      .eq('owner_id', ownerId)
      .in('id', threadIds)
      .not('local_id', 'is', null);
    const localIds = [...new Set((threads || []).map((t) => t.local_id))];
    if (localIds.length < 2) continue; // need 2+ chats the client can actually locate and group

    const { data: open } = await db
      .from('nudges')
      .select('id')
      .eq('owner_id', ownerId)
      .eq('topic_id', topicId)
      .eq('nudge_type', 'group_suggestion')
      .eq('dismissed', false)
      .limit(1);
    if (open?.length) continue; // don't nag twice

    const { error } = await db.from('nudges').insert({
      owner_id: ownerId,
      topic_id: topicId,
      nudge_type: 'group_suggestion',
      message: `${localIds.length} chats look related to "${topic.name}" — group them into a project?`,
      payload: { topicName: topic.name, localIds },
    });
    if (!error) raised++;
  }
  return raised;
}


const ROUTES = {
  initiate: handle_initiate,
  moderate: handle_moderate,
  document: handle_document,
  media: handle_media,
  state: handle_state,
  sweep: handle_sweep,
};

export default async function handler(req, res) {
  const route = ROUTES[req.query?.route];
  if (!route) {
    return res.status(404).json({ error: 'unknown hub route', valid: Object.keys(ROUTES) });
  }
  try {
    return await route(req, res);
  } catch (e) {
    if (res.headersSent) return;
    return res.status(500).json({ error: 'hub failure', details: e.message });
  }
}

// Exposed for scripts/check-media-extract.mjs — same convention as
// lib/animate/providers.js. Not part of the HTTP surface.
export const __test = { extractAsset, ORDER_BY_KIND };
