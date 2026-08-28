/**
 * Single entry point for the whole context hub.
 *
 *   /api/hub/initiate?action=workspace|group|media
 *   /api/hub/moderate
 *   /api/hub/document
 *   /api/hub/media
 *   /api/hub/state?action=nudges|topics|inbox|dismiss|register|turn
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
  UTILITY_MODEL,
  WRITER_MODEL,
  requireHub,
  fail,
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

  const action = req.query?.action;
  const { fromThreadId, seedContent, title, messageId, personaIds, mode, rounds } = req.body || {};

  if (!fromThreadId) return fail(res, 400, 'fromThreadId required');
  if (!seedContent || !String(seedContent).trim()) return fail(res, 400, 'seedContent required');

  // The source thread must already exist in the hub, otherwise the foreign key
  // on links rejects the insert with an opaque error.
  const { data: source } = await db.from('threads').select('id').eq('id', fromThreadId).single();
  if (!source) return fail(res, 404, 'fromThreadId not found in hub — create the thread first');

  try {
    if (action === 'workspace') {
      const id = await promote({
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

  const { threadId, moderatorPersonaId, routeTo } = req.body || {};
  if (!threadId) return fail(res, 400, 'threadId required');
  if (routeTo && !['workspace', 'media'].includes(routeTo))
    return fail(res, 400, "routeTo must be 'workspace' or 'media'");

  const { data: thread } = await db
    .from('threads')
    .select('id, title, type')
    .eq('id', threadId)
    .single();
  if (!thread) return fail(res, 404, 'thread not found');
  if (thread.type !== 'group') return fail(res, 400, 'not a group thread');

  const { data: msgs } = await db
    .from('messages')
    .select('persona_id, content, round, role')
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

  const { type, title, topicIds, documentId } = req.body || {};
  if (!type || !Array.isArray(topicIds) || !topicIds.length)
    return fail(res, 400, 'type and topicIds[] required');
  if (!TEMPLATES[type]) return fail(res, 400, `unknown type: ${type}`, Object.keys(TEMPLATES));

  const result = await buildDocumentInternal({ type, title, topicIds, documentId });
  if (result.error) return fail(res, result.status || 500, result.error, result.details);
  return res.json(result);
}

/**
 * Shared by the HTTP endpoint and internal callers (the joke-bank auto-sync
 * after sweep). Returns a plain result object instead of writing to `res`,
 * so it works the same either way.
 */
async function buildDocumentInternal({ type, title, topicIds, documentId }) {
  if (!TEMPLATES[type]) return { error: `unknown type: ${type}`, status: 400 };

  let watermark = '1970-01-01T00:00:00Z';
  let existing = null;
  if (documentId) {
    const { data } = await db
      .from('documents')
      .select('id, sections, outline, built_from_at')
      .eq('id', documentId)
      .single();
    if (!data) return { error: 'documentId not found', status: 404 };
    existing = data;
    watermark = data.built_from_at || watermark;
  }

  const buildStart = new Date().toISOString();

  const { data: notes } = await db
    .from('notes')
    .select('content, created_at, source_thread_id')
    .in('topic_id', topicIds)
    .gt('created_at', watermark)
    .lte('created_at', buildStart)
    .order('created_at');

  const { data: topics } = await db.from('topics').select('id, name').in('id', topicIds);

  const threadIds = [...new Set((notes || []).map((n) => n.source_thread_id).filter(Boolean))];
  let resolutions = [];
  if (threadIds.length) {
    const { data } = await db
      .from('resolutions')
      .select('summary, decision')
      .in('thread_id', threadIds);
    resolutions = data || [];
  }

  const { data: facts } = await db
    .from('memory_facts')
    .select('content')
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
    type,
    title: title || built.title || 'Untitled',
    outline: built.outline || {},
    sections: built.sections,
    built_from_at: buildStart,
    updated_at: buildStart,
  };

  const { data: doc, error } = documentId
    ? await db.from('documents').update(row).eq('id', documentId).select('id').single()
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
 * Runs a media thread's seed prompt through generation, Cloudflare first and
 * Venice as fallback, then saves the result back onto the thread.
 *
 * This deliberately delegates to the existing /api/media-generate rather than
 * calling Cloudflare and Venice directly. That endpoint already normalises
 * every response shape those providers return (result.image, images[0],
 * b64_json, raw binary, data URLs) and enforces the 4.5MB body limit.
 * Re-implementing it here would mean maintaining two copies of that logic,
 * and the second copy would be the wrong one.
 */


const ORDER = [
  { provider: 'cloudflare', model: '@cf/black-forest-labs/flux-1-schnell' },
  { provider: 'venice', model: 'flux-2-pro' },
];

function baseUrl(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}

async function handle_media(req, res) {
  if (!requireHub(res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'POST only');

  const { threadId, kind = 'image', size, negativePrompt, model } = req.body || {};
  if (!threadId) return fail(res, 400, 'threadId required');

  const { data: thread } = await db
    .from('threads')
    .select('id, type, title, seed_prompt')
    .eq('id', threadId)
    .single();

  if (!thread) return fail(res, 404, 'thread not found');
  if (thread.type !== 'media') return fail(res, 400, 'not a media thread');

  // seed_prompt is the clean carried-over text. Reading the first message
  // instead would feed the wrapper prose into the image model.
  const prompt = (thread.seed_prompt || '').trim();
  if (!prompt) return fail(res, 400, 'thread has no seed prompt');

  const attempts = [];
  let success = null;

  for (const target of ORDER) {
    try {
      const upstream = await fetch(`${baseUrl(req)}/api/media-generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind,
          provider: target.provider,
          model: model || target.model,
          prompt,
          ...(negativePrompt ? { negativePrompt } : {}),
          ...(size ? { size } : {}),
        }),
      });

      const body = await upstream.json().catch(() => ({}));
      if (!upstream.ok) {
        attempts.push(`${target.provider}: ${upstream.status} ${body?.error || ''}`.trim());
        continue;
      }
      success = { ...body, provider: target.provider, model: model || target.model };
      break;
    } catch (e) {
      attempts.push(`${target.provider}: ${e.message}`);
    }
  }

  if (!success) return fail(res, 502, 'all providers failed', attempts);

  // Store a URL, never base64. A single 1024px image is ~1-2MB of base64;
  // writing that into a text column bloats every subsequent thread read and
  // pushes responses past Vercel's 4.5MB body limit.
  const url = success.url || success.imageUrl || success.assetUrl || null;
  const content = url
    ? `![${thread.title || 'generated'}](${url})`
    : `Generated with ${success.provider} (${success.model}) — image returned inline; ` +
      `store it via your existing asset path and update this message with the URL.`;

  await db.from('messages').insert({
    thread_id: threadId,
    role: 'assistant',
    model_used: `${success.provider}/${success.model}`,
    content,
  });

  return res.json({
    ok: true,
    threadId,
    provider: success.provider,
    model: success.model,
    url,
    fallbacksTried: attempts,
  });
}


/**
 * Small read/write endpoints the UI needs.
 *
 *   GET  /api/hub/state?action=nudges     -> open nudges + memory facts + topics
 *   GET  /api/hub/state?action=topics     -> all topics with note counts
 *   GET  /api/hub/state?action=inbox      -> notes that matched no topic
 *   POST /api/hub/state?action=dismiss    { nudgeId }
 *   POST /api/hub/state?action=register   { localId?, type, title } -> threadId
 *
 * `register` exists because the app stores chats in localStorage. A thread has
 * to exist in the hub before anything can be promoted out of it, or the links
 * foreign key rejects the insert. Call it lazily the first time a chat is
 * promoted, and cache the returned id on the local chat object.
 */


async function handle_state(req, res) {
  if (!requireHub(res)) return;
  const action = req.query?.action;

  if (req.method === 'GET') {
    if (action === 'nudges') {
      const [{ data: nudges }, { data: facts }] = await Promise.all([
        db
          .from('nudges')
          .select('id, topic_id, message, created_at')
          .eq('dismissed', false)
          .order('created_at', { ascending: false })
          .limit(10),
        db
          .from('memory_facts')
          .select('id, category, content, confidence')
          .order('confidence', { ascending: false })
          .limit(15),
      ]);
      return res.json({ nudges: nudges || [], facts: facts || [] });
    }

    if (action === 'topics') {
      const { data } = await db
        .from('topics')
        .select('id, name, note_count, last_seen_at')
        .order('last_seen_at', { ascending: false })
        .limit(100);
      return res.json({ topics: data || [] });
    }

    if (action === 'inbox') {
      const { data } = await db
        .from('notes')
        .select('id, content, created_at, source_thread_id')
        .is('topic_id', null)
        .order('created_at', { ascending: false })
        .limit(50);
      return res.json({ notes: data || [] });
    }

    if (action === 'joke-bank-raw') {
      // Plain markdown, not JSON — this is what the Workspace file-open link
      // hits, so it reads and edits like a real file instead of app UI.
      const { data: doc } = await db
        .from('documents')
        .select('title, sections, updated_at')
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
      const { error } = await db.from('nudges').update({ dismissed: true }).eq('id', nudgeId);
      if (error) return fail(res, 500, 'dismiss failed', error.message);
      return res.json({ ok: true });
    }

    if (action === 'turn') {
      // One persona turn from a live group discussion. Without these the
      // moderator has an empty transcript to work from.
      const { threadId, personaId, name, model, content, round } = req.body || {};
      if (!threadId || !content) return fail(res, 400, 'threadId and content required');

      // Personas are matched by slug so the client can send its local id.
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
      const { data: thread, error } = await db
        .from('threads')
        .insert({ type, title: title || 'Untitled', metadata: localId ? { localId } : {} })
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
            thread_id: thread.id,
            role: m.role === 'user' ? 'user' : 'assistant',
            content: String(m.content).slice(0, 20000),
          }));
        if (rows.length) await db.from('messages').insert(rows);
      }

      return res.json({ ok: true, threadId: thread.id });
    }

    return fail(res, 400, 'unknown action', ['dismiss', 'register', 'turn']);
  }

  return fail(res, 405, 'GET or POST only');
}


/**
 * GET /api/cron/sweep  — runs every 3 days (vercel.json crons)
 *
 * One pass per thread touched since its last sweep:
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

  const { data: threads, error } = await db
    .from('threads')
    .select('id, title, swept_at, last_activity')
    .or('swept_at.is.null,swept_at.lt.last_activity')
    .order('last_activity', { ascending: false })
    .limit(MAX_THREADS_PER_RUN);

  if (error) return fail(res, 500, 'thread query failed', error.message);

  let notesFiled = 0;
  let jokesFiled = 0;
  const errors = [];

  for (const thread of threads || []) {
    try {
      const result = await sweepThread(thread);
      notesFiled += result.notes;
      jokesFiled += result.jokes;
    } catch (e) {
      errors.push(`${thread.id}: ${e.message}`);
    }
  }

  const nudged = await raiseNudges();

  // Keep the running joke-bank document in sync whenever new jokes landed —
  // no manual "build document" step. Regeneration only pulls what's new
  // since the last build, so this stays cheap even with nothing to do.
  let jokeBankDoc = null;
  if (jokesFiled > 0) {
    try {
      jokeBankDoc = await syncJokeBankDocument();
    } catch (e) {
      errors.push(`joke-bank-doc: ${e.message}`);
    }
  }

  return res.json({
    threadsScanned: threads?.length || 0,
    notesFiled,
    jokesFiled,
    jokeBankDoc,
    nudgesRaised: nudged,
    errors,
  });
}

async function sweepThread(thread) {
  // Freeze the window BEFORE reading. Anything that lands mid-sweep stays
  // unswept and gets picked up next run instead of being skipped forever.
  const windowEnd = new Date().toISOString();
  const since = thread.swept_at || '1970-01-01T00:00:00Z';

  const { data: msgs } = await db
    .from('messages')
    .select('id, role, content, created_at')
    .eq('thread_id', thread.id)
    .gt('created_at', since)
    .lte('created_at', windowEnd)
    .order('created_at');

  const markSwept = () =>
    db.from('threads').update({ swept_at: windowEnd }).eq('id', thread.id);

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

  await upsertFacts(Array.isArray(out?.facts) ? out.facts : []);

  const candidates = (Array.isArray(out?.notes) ? out.notes : []).filter((n) =>
    String(n?.content || '').trim()
  );

  let filed = 0;
  if (candidates.length) {
    const vectors = await embed(candidates.map((c) => c.content));

    for (let i = 0; i < candidates.length; i++) {
      const note = candidates[i];
      const vec = vectors[i];
      if (!vec) continue;

      const { data: matches } = await db.rpc('match_topics', {
        p_embedding: vec,
        p_threshold: TOPIC_MATCH_THRESHOLD,
        p_limit: 1,
      });

      let topicId = matches?.[0]?.id || null;

      if (topicId) {
        const { data: dupes } = await db.rpc('match_notes', {
          p_topic_id: topicId,
          p_embedding: vec,
          p_threshold: NOTE_DUPE_THRESHOLD,
          p_limit: 1,
        });
        if (dupes?.length) continue; // already captured
      } else {
        topicId = await createTopic(note.content, vec);
      }

      // note_count and last_seen_at are maintained by the DB trigger.
      const { error: insErr } = await db.from('notes').insert({
        topic_id: topicId,
        content: note.content,
        source_thread_id: thread.id,
        embedding: vec,
        confidence: typeof note.confidence === 'number' ? note.confidence : 0.5,
      });
      if (!insErr) filed++;
    }
  }

  const jokesFiled = await fileJokes(thread, Array.isArray(out?.jokes) ? out.jokes : []);

  await markSwept();
  return { notes: filed, jokes: jokesFiled };
}

/** Every joke goes into the same fixed topic — never fuzzy-matched, never split. */
async function fileJokes(thread, jokes) {
  const candidates = jokes.filter((j) => String(j?.text || '').trim());
  if (!candidates.length) return 0;

  const topicId = await getOrCreateJokeBankTopic();
  const vectors = await embed(candidates.map((c) => c.text));

  let filed = 0;
  for (let i = 0; i < candidates.length; i++) {
    const joke = candidates[i];
    const vec = vectors[i];
    if (!vec) continue;

    const { data: dupes } = await db.rpc('match_notes', {
      p_topic_id: topicId,
      p_embedding: vec,
      p_threshold: NOTE_DUPE_THRESHOLD,
      p_limit: 1,
    });
    if (dupes?.length) continue; // already have this one, word for word

    const { error: insErr } = await db.from('notes').insert({
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

async function getOrCreateJokeBankTopic() {
  const { data: existing } = await db
    .from('topics')
    .select('id')
    .eq('name', JOKE_BANK_TOPIC)
    .limit(1)
    .maybeSingle();
  if (existing?.id) return existing.id;

  const vec = await embedOne(JOKE_BANK_TOPIC);
  const { data, error } = await db
    .from('topics')
    .insert({ name: JOKE_BANK_TOPIC, embedding: vec, summary: "The user's own jokes and bits, kept word for word." })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

/**
 * Regenerates the running joke-bank document from whatever is new. Finds
 * the existing doc (there's only ever one) or creates it on first run.
 */
async function syncJokeBankDocument() {
  const topicId = await getOrCreateJokeBankTopic();

  const { data: existingDoc } = await db
    .from('documents')
    .select('id')
    .eq('type', 'joke_bank')
    .limit(1)
    .maybeSingle();

  return buildDocumentInternal({
    type: 'joke_bank',
    title: 'Joke Bank',
    topicIds: [topicId],
    documentId: existingDoc?.id || null,
  });
}

async function createTopic(seed, vec) {
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
    .insert({ name, embedding: vec })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

async function upsertFacts(facts) {
  const clean = facts.filter((f) => String(f?.content || '').trim());
  if (!clean.length) return;

  const vectors = await embed(clean.map((f) => f.content));

  for (let i = 0; i < clean.length; i++) {
    const f = clean[i];
    const vec = vectors[i];
    if (!vec) continue;

    // Vector dedup. The previous version used full-text search against a
    // column with no tsvector index, so it never matched and every sweep
    // re-inserted the same facts.
    const { data: existing } = await db.rpc('match_facts', {
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
        .eq('id', hit.id);
    } else {
      await db.from('memory_facts').insert({
        category: f.category || 'preference',
        content: f.content,
        embedding: vec,
      });
    }
  }
}

async function raiseNudges() {
  const cutoff = new Date(Date.now() - STALE_DAYS * 864e5).toISOString();
  const { data: stale } = await db
    .from('topics')
    .select('id, name, note_count, last_seen_at')
    .lt('last_seen_at', cutoff)
    .gt('note_count', 2)
    .limit(5);

  let raised = 0;
  for (const t of stale || []) {
    const { data: open } = await db
      .from('nudges')
      .select('id')
      .eq('topic_id', t.id)
      .eq('dismissed', false)
      .limit(1);
    if (open?.length) continue; // don't nag twice

    const days = Math.floor((Date.now() - new Date(t.last_seen_at).getTime()) / 864e5);
    const { error } = await db.from('nudges').insert({
      topic_id: t.id,
      message: `${t.note_count} thoughts filed under "${t.name}" — nothing new in ${days} days.`,
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
