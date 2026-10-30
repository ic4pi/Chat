/**
 * /api/hub/claw — the server half of Dr Claw, the helper on your computer.
 *
 * Two kinds of caller, never mixed:
 *   • the app (your browser, cookie → owner): make a pairing code, see whether
 *     the helper is online, create a job (this IS the Run tap), stop it, read it;
 *   • the helper on your computer (Bearer device token → owner): pick up an
 *     approved job, report back, ask whether it was stopped.
 *
 * The server only ever stores and relays. It never runs anything. Everything is
 * scoped to one owner; a device token can only touch its own owner's jobs. A job
 * the helper has not picked up within two minutes is cancelled, so something you
 * approved while the helper was off can never run "later" without you.
 */

import { randomBytes, createHash } from 'node:crypto';
import { validateActions, MAX_ACTIONS } from './claw-risk.js';

const sha = (s) => createHash('sha256').update(s).digest('hex');
export const normalizePairCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const hashPairCode = (c) => sha(`claw:${normalizePairCode(c)}`);

export const ONLINE_MS = 20_000;       // a helper is "online" if it polled within this long
export const STALE_APPROVED_MS = 120_000; // an approved job nobody picked up expires
export const STALE_RUNNING_MS = 15 * 60_000;
const PAIR_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const MAX_OUTPUT = 20_000;
const MAX_WORKFLOWS = 50;
const MAX_WORKFLOW_NAME = 60;

const clip = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');

/** Results come from your computer: accept only the expected shape and sizes. */
export function cleanResults(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_ACTIONS).map((r, i) => ({
    i: Number.isInteger(r?.i) ? r.i : i,
    do: clip(r?.do, 20),
    ok: !!r?.ok,
    output: clip(r?.output, MAX_OUTPUT),
    error: clip(r?.error, 2000),
    ms: Number.isFinite(r?.ms) ? Math.round(r.ms) : 0,
  }));
}

export function makeClawRoute({ db, resolveOwner, fail, requireHub, rateLimit, now = () => Date.now() }) {
  const iso = (ms = now()) => new Date(ms).toISOString();

  async function expireStale(ownerId) {
    await db.from('claw_jobs')
      .update({ status: 'cancelled', results: [{ i: 0, do: '', ok: false, output: '', error: 'Expired: the helper did not pick this up within 2 minutes, so it was cancelled.', ms: 0 }], updated_at: iso() })
      .eq('owner_id', ownerId).eq('status', 'approved').lt('created_at', iso(now() - STALE_APPROVED_MS));
    await db.from('claw_jobs')
      .update({ status: 'failed', updated_at: iso() })
      .eq('owner_id', ownerId).eq('status', 'running').lt('updated_at', iso(now() - STALE_RUNNING_MS));
  }

  async function authDevice(req) {
    const m = /^Bearer\s+(\S{20,200})$/.exec(String(req.headers?.authorization || ''));
    if (!m) return null;
    const { data } = await db.from('claw_devices').select('id, owner_id, label, workdir').eq('token_hash', sha(m[1])).maybeSingle();
    return data || null;
  }

  return async function handle_claw(req, res) {
    if (!requireHub(res)) return;
    const action = req.query?.action;

    // ── helper side ────────────────────────────────────────────────────
    if (action === 'pair-claim') {
      if (req.method !== 'POST') return fail(res, 405, 'POST only');
      if (!(await rateLimit(req, res, { bucket: 'claw-pair-claim', limit: 10, windowSeconds: 600 }))) return;
      const code = normalizePairCode(req.body?.code);
      if (code.length !== 8) return fail(res, 400, 'Enter the 8-character code shown in the Code Space');
      const { data: row, error } = await db.from('claw_pair_codes')
        .select('owner_id, expires_at').eq('code_hash', hashPairCode(code)).maybeSingle();
      if (error) return fail(res, 503, 'database unreachable', error.message);
      if (!row || Date.parse(row.expires_at) < now()) {
        return fail(res, 404, 'That code is wrong or expired — make a new one in the Code Space');
      }
      await db.from('claw_pair_codes').delete().eq('code_hash', hashPairCode(code));
      const token = `jc_${randomBytes(32).toString('base64url')}`;
      const { data: dev, error: derr } = await db.from('claw_devices')
        .insert({ owner_id: row.owner_id, token_hash: sha(token), label: clip(req.body?.label, 60) || 'My computer', workdir: clip(req.body?.workdir, 300) })
        .select('id').single();
      if (derr) return fail(res, 503, 'could not register the helper', derr.message);
      return res.json({ token, deviceId: dev.id });
    }

    if (action === 'poll' || action === 'report' || action === 'check') {
      if (req.method !== 'POST') return fail(res, 405, 'POST only');
      const device = await authDevice(req);
      if (!device) return fail(res, 401, 'unknown helper — pair it again from the Code Space');
      const t = iso();

      if (action === 'poll') {
        await db.from('claw_devices').update({ last_seen_at: t, workdir: clip(req.body?.workdir, 300) || device.workdir }).eq('id', device.id);
        await expireStale(device.owner_id);
        const { data: next } = await db.from('claw_jobs').select('id, actions')
          .eq('owner_id', device.owner_id).eq('status', 'approved').order('created_at', { ascending: true }).limit(1).maybeSingle();
        if (!next) return res.json({ job: null });
        // Claim it atomically: if two polls race, only one update matches 'approved'.
        const { data: claimed } = await db.from('claw_jobs')
          .update({ status: 'running', device_id: device.id, updated_at: t })
          .eq('id', next.id).eq('status', 'approved').select('id');
        if (!claimed || claimed.length === 0) return res.json({ job: null });
        // Re-validate on the way out: the helper receives only what the safety rules allow.
        const v = validateActions(next.actions);
        if (!v.ok) {
          await db.from('claw_jobs').update({ status: 'failed', results: [{ i: 0, do: '', ok: false, output: '', error: `Rejected by safety rules: ${v.error}`, ms: 0 }], updated_at: t }).eq('id', next.id);
          return res.json({ job: null });
        }
        return res.json({ job: { id: next.id, actions: v.actions } });
      }

      const id = String(req.body?.id || '');
      const { data: job } = await db.from('claw_jobs').select('id, owner_id, status').eq('id', id).maybeSingle();
      if (!job || job.owner_id !== device.owner_id) return fail(res, 404, 'unknown job');

      if (action === 'check') {
        await db.from('claw_devices').update({ last_seen_at: t }).eq('id', device.id);
        return res.json({ cancelled: job.status === 'cancelled' });
      }

      // report
      if (job.status !== 'running' && job.status !== 'cancelled') return fail(res, 409, `job is ${job.status}`);
      const results = cleanResults(req.body?.results);
      const status = job.status === 'cancelled' ? 'cancelled' : req.body?.status === 'done' ? 'done' : 'failed';
      await db.from('claw_jobs').update({ status, results, updated_at: t }).eq('id', id);
      return res.json({ ok: true });
    }

    // ── app side (cookie → owner) ──────────────────────────────────────
    const ownerId = await resolveOwner(req, res);

    if (action === 'pair-start') {
      if (req.method !== 'POST') return fail(res, 405, 'POST only');
      if (!(await rateLimit(req, res, { bucket: 'claw-pair-start', limit: 10, windowSeconds: 600 }))) return;
      const raw = [...randomBytes(8)].map((b) => PAIR_ALPHABET[b % PAIR_ALPHABET.length]).join('');
      const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
      const expiresAt = iso(now() + 10 * 60_000);
      await db.from('claw_pair_codes').delete().eq('owner_id', ownerId);
      const { error } = await db.from('claw_pair_codes').insert({ code_hash: hashPairCode(code), owner_id: ownerId, expires_at: expiresAt });
      if (error) return fail(res, 503, 'database unreachable', error.message);
      return res.json({ code, expiresAt });
    }

    if (action === 'status') {
      await expireStale(ownerId);
      const { data: devices, error } = await db.from('claw_devices')
        .select('id, label, workdir, last_seen_at, created_at').eq('owner_id', ownerId).order('created_at', { ascending: true });
      if (error) return fail(res, 503, 'database unreachable', error.message);
      const list = (devices || []).map((d) => ({
        id: d.id, label: d.label, workdir: d.workdir,
        online: !!d.last_seen_at && now() - Date.parse(d.last_seen_at) < ONLINE_MS,
        lastSeen: d.last_seen_at,
      }));
      const { data: open } = await db.from('claw_jobs').select('id, status, created_at')
        .eq('owner_id', ownerId).in('status', ['approved', 'running']).order('created_at', { ascending: false }).limit(1).maybeSingle();
      return res.json({ devices: list, online: list.some((d) => d.online), openJob: open || null });
    }

    // One place that turns validated steps into an approved job. The caller has
    // already established that the user (or an auto-run workflow they opted in)
    // said go.
    async function createJob(actions) {
      await expireStale(ownerId);
      const { data: devs } = await db.from('claw_devices').select('id, last_seen_at').eq('owner_id', ownerId);
      const online = (devs || []).find((d) => d.last_seen_at && now() - Date.parse(d.last_seen_at) < ONLINE_MS);
      if (!online) return { status: 409, error: 'Your helper is not running. Start it on your computer, then tap Run again.' };
      const { data: open } = await db.from('claw_jobs').select('id').eq('owner_id', ownerId).in('status', ['approved', 'running']).limit(1).maybeSingle();
      if (open) return { status: 409, error: 'A run is already in progress. Wait for it, or stop it first.' };
      const { data: job, error } = await db.from('claw_jobs')
        .insert({ owner_id: ownerId, actions, status: 'approved' }).select('id').single();
      if (error) return { status: 503, error: 'database unreachable', detail: error.message };
      return { id: job.id };
    }

    if (action === 'job-create') {
      if (req.method !== 'POST') return fail(res, 405, 'POST only');
      if (!(await rateLimit(req, res, { bucket: 'claw-job', limit: 30, windowSeconds: 300 }))) return;
      const v = validateActions(req.body?.actions);
      if (!v.ok) return fail(res, 400, v.error);
      const made = await createJob(v.actions);
      if (made.error) return fail(res, made.status, made.error, made.detail);
      return res.json({ id: made.id });
    }

    // ── saved workflows ────────────────────────────────────────────────
    const wfOut = (w) => ({ id: w.id, name: w.name, actions: w.actions, autoRun: !!w.auto_run, runCount: w.run_count || 0, lastRunAt: w.last_run_at || null });
    const WF_COLS = 'id, name, actions, auto_run, run_count, last_run_at';

    if (action === 'workflow-list') {
      const { data, error } = await db.from('claw_workflows').select(WF_COLS).eq('owner_id', ownerId).order('created_at', { ascending: true });
      if (error) return fail(res, 503, 'database unreachable', error.message);
      return res.json({ workflows: (data || []).map(wfOut) });
    }

    if (action === 'workflow-save') {
      if (req.method !== 'POST') return fail(res, 405, 'POST only');
      const name = clip(String(req.body?.name || '').trim(), MAX_WORKFLOW_NAME);
      if (!name) return fail(res, 400, 'Give the workflow a name');
      const v = validateActions(req.body?.actions);
      if (!v.ok) return fail(res, 400, v.error);
      const { data: all, error: lerr } = await db.from('claw_workflows').select('id, name').eq('owner_id', ownerId);
      if (lerr) return fail(res, 503, 'database unreachable', lerr.message);
      const existing = (all || []).find((w) => String(w.name).toLowerCase() === name.toLowerCase());
      if (existing) {
        // Same name = update the steps, keep its auto-run choice unless one is sent.
        const patch = { actions: v.actions };
        if (typeof req.body?.autoRun === 'boolean') patch.auto_run = req.body.autoRun;
        const { data, error } = await db.from('claw_workflows').update(patch).eq('id', existing.id).eq('owner_id', ownerId).select(WF_COLS).single();
        if (error) return fail(res, 503, 'database unreachable', error.message);
        return res.json({ workflow: wfOut(data), updated: true });
      }
      if ((all || []).length >= MAX_WORKFLOWS) return fail(res, 400, `You can keep ${MAX_WORKFLOWS} workflows. Delete one first.`);
      const { data, error } = await db.from('claw_workflows')
        .insert({ owner_id: ownerId, name, actions: v.actions, auto_run: req.body?.autoRun === true }).select(WF_COLS).single();
      if (error) return fail(res, 503, 'database unreachable', error.message);
      return res.json({ workflow: wfOut(data), updated: false });
    }

    if (action === 'workflow-update') {
      if (req.method !== 'POST') return fail(res, 405, 'POST only');
      if (typeof req.body?.autoRun !== 'boolean') return fail(res, 400, 'autoRun must be true or false');
      const { data, error } = await db.from('claw_workflows').update({ auto_run: req.body.autoRun })
        .eq('id', String(req.body?.id || '')).eq('owner_id', ownerId).select(WF_COLS).maybeSingle();
      if (error) return fail(res, 503, 'database unreachable', error.message);
      if (!data) return fail(res, 404, 'unknown workflow');
      return res.json({ workflow: wfOut(data) });
    }

    if (action === 'workflow-delete') {
      if (req.method !== 'POST') return fail(res, 405, 'POST only');
      await db.from('claw_workflows').delete().eq('id', String(req.body?.id || '')).eq('owner_id', ownerId);
      return res.json({ ok: true });
    }

    // Run a saved workflow. `byPersona` means a persona asked for it, not you: that only
    // works when YOU switched auto-run on for this workflow. Otherwise it needs your tap
    // (the app then calls this without byPersona).
    if (action === 'workflow-run') {
      if (req.method !== 'POST') return fail(res, 405, 'POST only');
      if (!(await rateLimit(req, res, { bucket: 'claw-job', limit: 30, windowSeconds: 300 }))) return;
      const { data: wf, error: werr } = await db.from('claw_workflows').select(WF_COLS + ', owner_id')
        .eq('id', String(req.body?.id || '')).eq('owner_id', ownerId).maybeSingle();
      if (werr) return fail(res, 503, 'database unreachable', werr.message);
      if (!wf) return fail(res, 404, 'unknown workflow');
      if (req.body?.byPersona === true && !wf.auto_run) {
        return fail(res, 403, `"${wf.name}" is not set to run without asking. Tap Run on it yourself, or switch on auto-run for it.`);
      }
      const v = validateActions(wf.actions);   // re-check on the way out, whatever was stored
      if (!v.ok) return fail(res, 400, `This workflow no longer passes the safety rules: ${v.error}`);
      const made = await createJob(v.actions);
      if (made.error) return fail(res, made.status, made.error, made.detail);
      await db.from('claw_workflows').update({ run_count: (wf.run_count || 0) + 1, last_run_at: iso() }).eq('id', wf.id);
      return res.json({ id: made.id, name: wf.name });
    }

    if (action === 'job') {
      const { data: job, error } = await db.from('claw_jobs')
        .select('id, status, actions, results, created_at, updated_at').eq('id', String(req.query?.id || '')).eq('owner_id', ownerId).maybeSingle();
      if (error) return fail(res, 503, 'database unreachable', error.message);
      if (!job) return fail(res, 404, 'unknown job');
      return res.json({ job });
    }

    if (action === 'job-stop') {
      if (req.method !== 'POST') return fail(res, 405, 'POST only');
      const id = String(req.body?.id || '');
      const { data: stopped } = await db.from('claw_jobs')
        .update({ status: 'cancelled', updated_at: iso() })
        .eq('id', id).eq('owner_id', ownerId).in('status', ['approved', 'running']).select('id');
      return res.json({ ok: true, stopped: !!stopped && stopped.length > 0 });
    }

    if (action === 'device-remove') {
      if (req.method !== 'POST') return fail(res, 405, 'POST only');
      await db.from('claw_devices').delete().eq('id', String(req.body?.id || '')).eq('owner_id', ownerId);
      return res.json({ ok: true });
    }

    return fail(res, 400, 'unknown action', ['pair-start', 'pair-claim', 'status', 'job-create', 'job', 'job-stop', 'device-remove', 'workflow-list', 'workflow-save', 'workflow-update', 'workflow-delete', 'workflow-run', 'poll', 'check', 'report']);
  };
}
