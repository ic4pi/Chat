// POST /api/boardroom-mp3
// Body: { turns: [{personaName, content}, ...] }  — export a transcript directly
//    or { documentId: "uuid" }                     — export a saved standing-task document
// Returns audio/mpeg — one file, each speaker in a distinct voice.
import { db, HUB_ENABLED } from '../lib/hub.js';
import { buildBoardroomMp3 } from '../lib/boardroom-audio.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  let turns = Array.isArray(req.body?.turns) ? req.body.turns : null;
  const documentId = typeof req.body?.documentId === 'string' ? req.body.documentId : '';

  if (!turns && documentId) {
    if (!HUB_ENABLED) return res.status(503).json({ error: 'Hub/memory is not configured.' });
    const { data, error } = await db.from('documents').select('title, sections').eq('id', documentId).single();
    if (error || !data) return res.status(404).json({ error: `No document with id ${documentId}` });
    turns = Array.isArray(data.sections) ? data.sections : [];
  }

  if (!turns || !turns.length) {
    return res.status(400).json({ error: 'Provide turns (transcript array) or documentId.' });
  }

  try {
    const { audio, voiceMap } = await buildBoardroomMp3(turns);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', 'attachment; filename="boardroom.mp3"');
    res.setHeader('X-Voice-Map', encodeURIComponent(JSON.stringify(voiceMap)));
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(audio);
  } catch (err) {
    return res.status(502).json({ error: err.message || 'MP3 build failed' });
  }
}
