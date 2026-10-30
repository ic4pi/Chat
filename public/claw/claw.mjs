#!/usr/bin/env node
/**
 * Dr Claw helper — runs on YOUR computer and does the jobs you approved in the
 * Code Space. Plain Node (18+), no packages, Mac and Linux.
 *
 *   node claw.mjs pair ABCD-EFGH [--server https://your-site] [--dir ~/Jive-Workspace] [--name "My Mac"] [--allow-outside]
 *   node claw.mjs            (or: node claw.mjs run)   start helping; Ctrl+C to stop
 *   node claw.mjs status | log | unpair
 *
 * What it will and won't do:
 *  - It only ever does jobs YOU approved with one tap on the Run card.
 *  - Files are confined to the working folder (default ~/Jive-Workspace); anything
 *    that resolves outside it (.., absolute paths, symlinks) is refused.
 *  - It has its own list of things it never does (sudo, wiping disks, private keys,
 *    password stores, ...), checked here, whatever the server or the AI says.
 *  - It stops at the first failed step, enforces a time limit, and a Stop in the
 *    Code Space kills what is running.
 *  - Everything it does is written to ~/.jive-claw/log.jsonl.
 *  - The OUTPUT of commands is sent back to your Code Space (and so to your AI).
 *    Do not run commands that print secrets.
 *
 * `--allow-outside` lets a command start in a folder other than the working folder.
 * Commands themselves can still touch anything your user can; the Run card tells you.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// ── safety rules (inlined from lib/claw-risk.js; do not edit here) ──
/**
 * Claw safety rules — shared by the server (validates before a job is stored),
 * the Code Space (plain-English Run card with risk labels) and the helper on
 * your computer (which re-checks everything itself before running anything).
 * The helper never trusts the server or the AI: if these rules say "blocked",
 * it does not run, whoever asked.
 *
 * Pure functions, no I/O. The helper gets an inlined copy of this file built by
 * scripts/build-claw.mjs; a test fails if the two drift apart.
 */

const MAX_ACTIONS = 20;
const MAX_CMD_CHARS = 2000;
const MAX_FILE_CHARS = 200_000;
const MAX_TIMEOUT_S = 600;
const DEFAULT_TIMEOUT_S = 120;

const KINDS = ['run', 'read', 'write', 'append', 'move', 'mkdir', 'delete', 'list', 'open'];

const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : null);

/**
 * One action in, one clean action out (or an error). Unknown fields are dropped.
 *   run    {cmd, cwd?, timeout?}      read {path}        list {path}
 *   write  {path, content}            append {path, content}
 *   move   {from, to}                 mkdir {path}       delete {path}
 *   open   {target}  (http/https URL, or an app name on macOS)
 */
function cleanAction(a) {
  if (!a || typeof a !== 'object') return { error: 'action must be an object' };
  const kind = a.do;
  if (!KINDS.includes(kind)) return { error: `unknown action "${String(kind).slice(0, 30)}"` };
  switch (kind) {
    case 'run': {
      const cmd = str(a.cmd, MAX_CMD_CHARS);
      if (!cmd || !cmd.trim()) return { error: 'run needs a cmd (max 2000 characters)' };
      const out = { do: 'run', cmd: cmd.trim() };
      if (a.cwd !== undefined) {
        const cwd = str(a.cwd, 500);
        if (cwd === null) return { error: 'cwd must be a short path' };
        out.cwd = cwd;
      }
      if (a.timeout !== undefined) {
        const t = Number(a.timeout);
        if (!Number.isFinite(t) || t <= 0) return { error: 'timeout must be a number of seconds' };
        out.timeout = Math.min(Math.round(t), MAX_TIMEOUT_S);
      }
      return { action: out };
    }
    case 'read': case 'list': case 'mkdir': case 'delete': {
      const path = str(a.path, 500);
      if (!path || !path.trim()) return { error: `${kind} needs a path` };
      return { action: { do: kind, path: path.trim() } };
    }
    case 'write': case 'append': {
      const path = str(a.path, 500);
      const content = str(a.content, MAX_FILE_CHARS);
      if (!path || !path.trim()) return { error: `${kind} needs a path` };
      if (content === null) return { error: `${kind} needs content (max ${MAX_FILE_CHARS} characters)` };
      return { action: { do: kind, path: path.trim(), content } };
    }
    case 'move': {
      const from = str(a.from, 500);
      const to = str(a.to, 500);
      if (!from || !to) return { error: 'move needs from and to' };
      return { action: { do: 'move', from: from.trim(), to: to.trim() } };
    }
    case 'open': {
      const target = str(a.target, 1000);
      if (!target || !target.trim()) return { error: 'open needs a target' };
      return { action: { do: 'open', target: target.trim() } };
    }
    default:
      return { error: 'unsupported action' };
  }
}

/** A whole batch. Never partially valid: one bad action rejects the lot. */
function validateActions(list) {
  if (!Array.isArray(list) || list.length === 0) return { ok: false, error: 'no actions' };
  if (list.length > MAX_ACTIONS) return { ok: false, error: `at most ${MAX_ACTIONS} actions per run` };
  const actions = [];
  for (let i = 0; i < list.length; i++) {
    const r = cleanAction(list[i]);
    if (r.error) return { ok: false, error: `action ${i + 1}: ${r.error}` };
    const risk = classifyAction(r.action);
    if (risk.level === 'blocked') {
      return { ok: false, error: `action ${i + 1} is blocked: ${risk.reasons.join('; ')}` };
    }
    actions.push(r.action);
  }
  return { ok: true, actions };
}

// ── what is never allowed ────────────────────────────────────────────────

// Matched against the whole command text. Deliberately blunt: a false "blocked"
// costs you a rephrase; a false "allowed" costs you your files.
const BLOCKED_COMMANDS = [
  [/(^|[\s;&|(`])sudo(\s|$)/, 'sudo (running as administrator)'],
  [/(^|[\s;&|(`])su(\s+-|\s*$)/, 'switching user with su'],
  [/(^|[\s;&|(`])(doas|pkexec)(\s|$)/, 'running as another user'],
  [/\bmkfs(\.\w+)?\b/, 'formatting a disk'],
  [/\bdiskutil\s+(erase|partition|apfs\s+delete|secureerase|zero)/i, 'erasing or repartitioning a disk'],
  [/\bdd\b[^|;&]*\bof=\/dev\//, 'writing straight to a disk'],
  [/>\s*\/dev\/(sd|nvme|disk|hd)/, 'writing straight to a disk'],
  [/:\(\)\s*\{[^}]*:\s*\|\s*:/, 'a fork bomb'],
  [/\brm\s+(-[a-zA-Z-]+\s+)*(\/|~\/?|\$HOME\/?|\*|\.\.\/?|\/\*|~\/\*|\$HOME\/\*)(\s|$)/, 'deleting your whole drive, home folder or "everything"'],
  [/\brm\s+[^|;&]*\s(\/|~|\$HOME)(\s|$)/, 'deleting your whole drive or home folder'],
  [/\bchmod\s+(-R\s+)?[0-7]*7[0-7]*7\s+\/(\s|$)/, 'opening up permissions on the whole drive'],
  [/\b(chown|chmod)\s+-R\s+[^|;&]*\s\/(\s|$)/, 'changing ownership or permissions of the whole drive'],
  [/\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(sh|bash|zsh|python3?|node|perl|ruby)\b/, 'running a downloaded script without reading it'],
  [/\b(shutdown|reboot|halt|poweroff|init\s+0|init\s+6)\b/, 'shutting down or restarting the computer'],
  [/\b(launchctl|systemctl|crontab)\b/, 'changing services or scheduled jobs'],
  [/\b(killall|pkill)\s+-9\s+(-1|loginwindow|Finder|WindowServer)/, 'killing system processes'],
  [/\/etc\/(passwd|shadow|sudoers|hosts)\b/, 'system account or network files'],
  [/(^|[\s'"=\/~])\.(ssh|gnupg|aws|kube|docker)(\/|\s|$|'|")/, 'private keys and cloud credentials'],
  [/\b(id_rsa|id_ed25519|id_ecdsa)\b|\.pem\b|\.p12\b|\.keychain/i, 'private keys and certificates'],
  [/\bsecurity\s+(find-generic-password|find-internet-password|dump-keychain|export)/i, 'reading saved passwords'],
  [/\b(passwd|chpasswd)\b/, 'changing passwords'],
  [/\bnc\b[^|;&]*\s-[a-zA-Z]*e\b|\bbash\s+-i\s*>&|\/dev\/tcp\//, 'opening a remote shell'],
];

// Paths for read/write/etc. that are never allowed, even inside the working folder
// (the helper additionally keeps every file action inside the working folder).
const BLOCKED_PATHS = [
  [/(^|\/)\.(ssh|gnupg|aws|kube|docker)(\/|$)/, 'private keys and cloud credentials'],
  [/(^|\/)(id_rsa|id_ed25519|id_ecdsa)(\.pub)?$|\.pem$|\.p12$|\.keychain(-db)?$/i, 'private keys and certificates'],
  [/(^|\/)(Library\/Keychains|\.password-store)(\/|$)/, 'saved passwords'],
  [/^\/(etc|System|private|boot|dev|proc|sys|usr|bin|sbin|var\/root)(\/|$)/, 'system folders'],
];

// Flagged on the Run card, still allowed (after your one Run tap).
const DANGER_COMMANDS = [
  [/(^|[\s;&|(`])rm(\s|$)/, 'deletes files'],
  [/(^|[\s;&|(`])(rmdir|shred|unlink|trash)(\s|$)/, 'deletes files'],
  [/(^|[\s;&|(`])(mv|cp)\s/, 'moves or overwrites files'],
  [/(^|[\s;&|(`])git\s+(push|reset\s+--hard|clean|checkout\s+--|rebase|branch\s+-D|stash\s+drop)/, 'changes or discards git history'],
  [/(^|[\s;&|(`])(npm|npx|yarn|pnpm|pip3?|pipx|brew|apt(-get)?|dnf|yum|gem|cargo|go)\s+(i|install|add|uninstall|remove|update|upgrade|get)\b/, 'installs or removes software'],
  [/(^|[\s;&|(`])(curl|wget|scp|rsync|ssh|ftp|sftp)\b/, 'uses the network'],
  [/(^|[\s;&|(`])(chmod|chown|chgrp)\s/, 'changes permissions'],
  [/(^|[\s;&|(`])(kill|killall|pkill)\s/, 'stops programs'],
  [/(^|[\s;&|(`])(defaults\s+write|osascript|open\s+-a)\b/, 'changes settings or controls other apps'],
  [/(^|[^>])>\s*[^&\s]|>>\s*\S/, 'writes to a file'],
  [/\b(eval|exec)\b|\$\(|`/, 'runs a command built from other text'],
];

const NETWORK_RE = /^(https?:)\/\//i;

/** {level: 'safe'|'caution'|'danger'|'blocked', reasons: string[]} */
function classifyAction(a) {
  const reasons = [];
  const push = (list, text) => { for (const [re, why] of list) if (re.test(text)) reasons.push(why); };
  switch (a.do) {
    case 'run': {
      push(BLOCKED_COMMANDS, a.cmd);
      if (reasons.length) return { level: 'blocked', reasons: [...new Set(reasons)] };
      push(DANGER_COMMANDS, a.cmd);
      if (a.cwd && /^(\/|~|\.\.)/.test(a.cwd)) reasons.push('runs outside the working folder');
      return reasons.length
        ? { level: 'danger', reasons: [...new Set(reasons)] }
        : { level: 'caution', reasons: ['runs a command'] };
    }
    case 'read': case 'list': {
      push(BLOCKED_PATHS, a.path);
      if (reasons.length) return { level: 'blocked', reasons: [...new Set(reasons)] };
      if (/^(\/|~|\.\.)/.test(a.path)) return { level: 'danger', reasons: ['reads outside the working folder'] };
      return { level: 'safe', reasons: [] };
    }
    case 'write': case 'append': case 'mkdir': {
      push(BLOCKED_PATHS, a.path);
      if (reasons.length) return { level: 'blocked', reasons: [...new Set(reasons)] };
      if (/^(\/|~|\.\.)/.test(a.path)) return { level: 'danger', reasons: ['writes outside the working folder'] };
      return { level: 'caution', reasons: [a.do === 'mkdir' ? 'makes a folder' : a.do === 'append' ? 'adds to a file' : 'creates or overwrites a file'] };
    }
    case 'move': {
      push(BLOCKED_PATHS, a.from); push(BLOCKED_PATHS, a.to);
      if (reasons.length) return { level: 'blocked', reasons: [...new Set(reasons)] };
      const out = /^(\/|~|\.\.)/.test(a.from) || /^(\/|~|\.\.)/.test(a.to);
      return { level: 'danger', reasons: [out ? 'moves files outside the working folder' : 'moves or overwrites files'] };
    }
    case 'delete': {
      push(BLOCKED_PATHS, a.path);
      if (reasons.length) return { level: 'blocked', reasons: [...new Set(reasons)] };
      if (/^(\/|~|\.\.)/.test(a.path) || a.path === '.' || a.path === './' || a.path === '*') {
        return { level: 'blocked', reasons: ['deleting outside the working folder or the whole working folder'] };
      }
      return { level: 'danger', reasons: ['deletes files'] };
    }
    case 'open': {
      if (NETWORK_RE.test(a.target)) return { level: 'caution', reasons: ['opens a web page in your browser'] };
      if (/^[a-z][a-z0-9+.-]*:/i.test(a.target)) return { level: 'blocked', reasons: ['only http and https links can be opened'] };
      if (/[\/\\]|\.\.|\.(app|sh|command|exe|bat|py|js)$/i.test(a.target)) {
        return { level: 'blocked', reasons: ['open takes a web link or the plain name of an app'] };
      }
      return { level: 'danger', reasons: ['opens an app'] };
    }
    default:
      return { level: 'blocked', reasons: ['unknown action'] };
  }
}

/** The line a person reads on the Run card. */
function describeAction(a) {
  switch (a.do) {
    case 'run': return `Run: ${a.cmd}${a.cwd ? `   (in ${a.cwd})` : ''}`;
    case 'read': return `Read the file ${a.path}`;
    case 'list': return `List the folder ${a.path}`;
    case 'write': return `Create or overwrite ${a.path} (${a.content.length} characters)`;
    case 'append': return `Add to ${a.path} (${a.content.length} characters)`;
    case 'mkdir': return `Make the folder ${a.path}`;
    case 'move': return `Move ${a.from} → ${a.to}`;
    case 'delete': return `Delete ${a.path}`;
    case 'open': return `Open ${a.target}`;
    default: return 'Unknown action';
  }
}

/** The worst level across a batch, for the card's headline. */
function worstLevel(actions) {
  const order = ['safe', 'caution', 'danger', 'blocked'];
  let worst = 'safe';
  for (const a of actions) {
    const l = classifyAction(a).level;
    if (order.indexOf(l) > order.indexOf(worst)) worst = l;
  }
  return worst;
}

// ── the CLAW block an orchestrator writes ─────────────────────────────────

const CLAW_RE = /<<<\s*CLAW\b[^\n]*\n?([\s\S]*?)(?:\n?\s*CLAW\s*>>>|$)/i;

/**
 * The reply minus its CLAW block, and the parsed actions. The block is JSON
 * lines (one action per line). Lines that do not parse are reported, never
 * silently dropped: `errors` is shown to the user.
 */
function extractClawBlock(raw) {
  const m = CLAW_RE.exec(String(raw || ''));
  if (!m) return { text: String(raw || ''), actions: null, errors: [] };
  const text = (raw.slice(0, m.index) + raw.slice(m.index + m[0].length)).replace(/\n{3,}/g, '\n\n').trim();
  const rawActions = [];
  const errors = [];
  for (const line of (m[1] || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { rawActions.push(JSON.parse(t)); } catch { errors.push(`could not read this line: ${t.slice(0, 80)}`); }
  }
  return { text, actions: rawActions.length ? rawActions : null, errors };
}

// ── end safety rules ──

const HOME = process.env.JIVE_CLAW_HOME || path.join(os.homedir(), '.jive-claw');
const CONFIG = path.join(HOME, 'config.json');
const LOG = path.join(HOME, 'log.jsonl');
const OUTPUT_CAP = 20_000;
const POLL_IDLE_MS = Number(process.env.JIVE_CLAW_POLL_MS) || 2500;

const say = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return null; }
}
function writeConfig(cfg) {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.chmodSync(CONFIG, 0o600);
}
function logLine(obj) {
  try {
    fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
    fs.appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n', { mode: 0o600 });
  } catch { /* logging must never stop a run */ }
}

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// ── confinement ──────────────────────────────────────────────────────────
// Everything file-shaped must resolve (symlinks included) inside the working folder.
function realWorkdir(workdir) {
  fs.mkdirSync(workdir, { recursive: true });
  return fs.realpathSync(workdir);
}

function isInside(root, p) {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Resolve a path the job gave us to a real absolute path inside `root`, or throw. */
function confine(root, given) {
  if (typeof given !== 'string' || given.includes('\0')) throw new Error('bad path');
  if (/^~/.test(given) || path.isAbsolute(given)) {
    const abs = path.resolve(expandHome(given));
    if (!isInside(root, abs)) throw new Error(`"${given}" is outside the working folder (${root}) — refused`);
  }
  const target = path.resolve(root, expandHome(given));
  // Walk up to the nearest ancestor that exists and check ITS real location.
  let probe = target;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const real = fs.realpathSync(probe);
  const full = path.join(real, path.relative(probe, target));
  if (!isInside(root, full)) throw new Error(`"${given}" leads outside the working folder (${root}) — refused`);
  return full;
}

function capOutput(s) {
  if (s.length <= OUTPUT_CAP) return s;
  const keep = Math.floor(OUTPUT_CAP / 2) - 40;
  return `${s.slice(0, keep)}\n… [${s.length - keep * 2} characters cut] …\n${s.slice(-keep)}`;
}

// ── running one command ──────────────────────────────────────────────────
function runCommand(cmd, cwd, timeoutS, onChild) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn('/bin/sh', ['-c', cmd], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    onChild(child);
    let out = '';
    let timedOut = false;
    const add = (b) => { if (out.length < OUTPUT_CAP * 4) out += b.toString(); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const killGroup = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* gone */ } } };
    const timer = setTimeout(() => { timedOut = true; killGroup('SIGTERM'); setTimeout(() => killGroup('SIGKILL'), 2000); }, timeoutS * 1000);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, output: capOutput(out), error: e.message, ms: Date.now() - started }); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const ms = Date.now() - started;
      if (timedOut) return resolve({ ok: false, output: capOutput(out), error: `Timed out after ${timeoutS}s and was stopped`, ms });
      if (signal) return resolve({ ok: false, output: capOutput(out), error: `Stopped (${signal})`, ms });
      resolve({ ok: code === 0, output: capOutput(out), error: code === 0 ? '' : `Exited with code ${code}`, ms });
    });
  });
}

// ── running one action ───────────────────────────────────────────────────
async function doAction(a, ctx) {
  const started = Date.now();
  const done = (output = '') => ({ ok: true, output: capOutput(String(output)), error: '', ms: Date.now() - started });
  const risk = classifyAction(a);
  if (risk.level === 'blocked') {
    return { ok: false, output: '', error: `Blocked by the helper's own safety rules: ${risk.reasons.join('; ')}`, ms: 0 };
  }
  const root = ctx.root;
  try {
    switch (a.do) {
      case 'run': {
        let cwd = root;
        if (a.cwd) {
          if (ctx.allowOutside) cwd = path.resolve(root, expandHome(a.cwd));
          else cwd = confine(root, a.cwd);
        }
        if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return { ok: false, output: '', error: `folder not found: ${a.cwd || '.'}`, ms: 0 };
        return await runCommand(a.cmd, cwd, a.timeout || DEFAULT_TIMEOUT_S, (c) => { ctx.child = c; });
      }
      case 'read': {
        const p = confine(root, a.path);
        const st = fs.statSync(p);
        if (!st.isFile()) throw new Error('not a file');
        if (st.size > 1_000_000) throw new Error(`file is too big to read (${st.size} bytes)`);
        return done(fs.readFileSync(p, 'utf8'));
      }
      case 'list': {
        const p = confine(root, a.path);
        const names = fs.readdirSync(p, { withFileTypes: true }).slice(0, 500).map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
        return done(names.join('\n') || '(empty)');
      }
      case 'write': case 'append': {
        const p = confine(root, a.path);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        if (fs.existsSync(p) && fs.statSync(p).isDirectory()) throw new Error('that path is a folder');
        (a.do === 'write' ? fs.writeFileSync : fs.appendFileSync)(p, a.content);
        return done(`${a.do === 'write' ? 'wrote' : 'added'} ${a.content.length} characters: ${path.relative(root, p)}`);
      }
      case 'mkdir': {
        const p = confine(root, a.path);
        fs.mkdirSync(p, { recursive: true });
        return done(`made folder ${path.relative(root, p)}`);
      }
      case 'move': {
        const from = confine(root, a.from);
        const to = confine(root, a.to);
        if (from === root) throw new Error('cannot move the working folder itself');
        if (!fs.existsSync(from)) throw new Error(`not found: ${a.from}`);
        if (fs.existsSync(to) && fs.statSync(to).isDirectory() && !fs.statSync(from).isDirectory()) throw new Error('target is a folder');
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.renameSync(from, to);
        return done(`moved ${path.relative(root, from)} → ${path.relative(root, to)}`);
      }
      case 'delete': {
        const p = confine(root, a.path);
        if (p === root) throw new Error('cannot delete the working folder itself');
        if (!fs.existsSync(p) && !fs.lstatSync(p, { throwIfNoEntry: false })) throw new Error(`not found: ${a.path}`);
        fs.rmSync(p, { recursive: true });
        return done(`deleted ${path.relative(root, p)}`);
      }
      case 'open': {
        const isUrl = /^https?:\/\//i.test(a.target);
        let cmd, args;
        if (process.platform === 'darwin') { cmd = 'open'; args = isUrl ? [a.target] : ['-a', a.target]; }
        else if (isUrl) { cmd = 'xdg-open'; args = [a.target]; }
        else return { ok: false, output: '', error: 'opening apps by name is only supported on a Mac', ms: 0 };
        const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
        child.on('error', () => {});
        child.unref();
        return done(`asked the system to open ${a.target}`);
      }
      default:
        return { ok: false, output: '', error: 'unknown action', ms: 0 };
    }
  } catch (e) {
    return { ok: false, output: '', error: String(e.message || e).slice(0, 500), ms: Date.now() - started };
  }
}

// ── talking to the server ────────────────────────────────────────────────
async function api(cfg, action, body, { auth = true } = {}) {
  const res = await fetch(`${cfg.server.replace(/\/$/, '')}/api/hub/claw?route=claw&action=${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${cfg.token}` } : {}) },
    body: JSON.stringify(body || {}),
  });
  let data = {};
  try { data = await res.json(); } catch { /* not json */ }
  return { status: res.status, data };
}

async function runJob(cfg, job, ctx) {
  say(`\n▶ Job ${job.id.slice(0, 8)} — ${job.actions.length} step${job.actions.length === 1 ? '' : 's'}`);
  const results = [];
  let stopped = false;
  ctx.cancelled = false;
  const watcher = setInterval(async () => {
    try {
      const r = await api(cfg, 'check', { id: job.id });
      if (r.data?.cancelled && !ctx.cancelled) {
        ctx.cancelled = true;
        say('  ■ Stopped from the Code Space');
        if (ctx.child) { try { process.kill(-ctx.child.pid, 'SIGTERM'); } catch { /* done */ } setTimeout(() => { try { process.kill(-ctx.child.pid, 'SIGKILL'); } catch { /* done */ } }, 1500); }
      }
    } catch { /* offline for a moment */ }
  }, 1500);
  for (let i = 0; i < job.actions.length; i++) {
    const a = job.actions[i];
    if (ctx.cancelled) { results.push({ i, do: a.do, ok: false, output: '', error: 'Stopped before this step', ms: 0 }); stopped = true; continue; }
    say(`  ${i + 1}. ${describeAction(a)}`);
    const r = await doAction(a, ctx);
    ctx.child = null;
    results.push({ i, do: a.do, ...r });
    logLine({ job: job.id, step: i + 1, action: describeAction(a), ok: r.ok, ms: r.ms, error: r.error || undefined });
    say(`     ${r.ok ? '✓' : '✗'} ${r.ok ? (r.output.split('\n')[0] || 'done').slice(0, 100) : r.error}`);
    if (!r.ok) {
      for (let j = i + 1; j < job.actions.length; j++) results.push({ i: j, do: job.actions[j].do, ok: false, output: '', error: `Skipped because step ${i + 1} failed`, ms: 0 });
      break;
    }
  }
  clearInterval(watcher);
  const allOk = !stopped && results.every((r) => r.ok);
  for (let tries = 0; tries < 3; tries++) {
    try { await api(cfg, 'report', { id: job.id, status: allOk ? 'done' : 'failed', results }); break; } catch { await sleep(1500); }
  }
  say(allOk ? '✔ Finished' : '✖ Finished with a problem');
}

async function run() {
  const cfg = readConfig();
  if (!cfg?.token) { say('Not paired yet. In the Code Space open the Dr Claw panel, get a code, then run:\n  node claw.mjs pair ABCD-EFGH --server https://your-site'); process.exit(1); }
  const root = realWorkdir(cfg.workdir);
  const ctx = { root, allowOutside: !!cfg.allowOutside, child: null, cancelled: false };
  say(`Dr Claw helper is running.\n  Working folder: ${root}\n  Server: ${cfg.server}\n  Ctrl+C to stop.\n  Note: command output is sent to your Code Space and its AI.`);
  let lastErr = '';
  for (;;) {
    try {
      const r = await api(cfg, 'poll', { workdir: root });
      if (r.status === 401) { say('This helper was removed in the Code Space. Pair it again to use it.'); process.exit(1); }
      lastErr = '';
      if (r.data?.job) { await runJob(cfg, r.data.job, ctx); continue; }
    } catch (e) {
      const msg = String(e.message || e);
      if (msg !== lastErr) { say(`(can't reach the server — will keep trying: ${msg})`); lastErr = msg; }
    }
    await sleep(POLL_IDLE_MS);
  }
}

async function pair(args) {
  const code = args[0];
  const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
  const server = opt('server', process.env.JIVE_CLAW_SERVER || '');
  if (!code || !server) { say('Usage: node claw.mjs pair ABCD-EFGH --server https://your-site [--dir ~/Jive-Workspace] [--name "My Mac"] [--allow-outside]'); process.exit(1); }
  const workdir = path.resolve(expandHome(opt('dir', path.join(os.homedir(), 'Jive-Workspace'))));
  if (workdir === path.parse(workdir).root || workdir === os.homedir()) {
    say('Pick a folder inside your home folder, not your whole home folder or drive (for example ~/Jive-Workspace).');
    process.exit(1);
  }
  realWorkdir(workdir);
  const cfg0 = { server, workdir };
  const r = await api(cfg0, 'pair-claim', { code, label: opt('name', os.hostname()), workdir }, { auth: false });
  if (r.status !== 200) { say(`Could not pair: ${r.data?.error || `HTTP ${r.status}`}`); process.exit(1); }
  writeConfig({ server, token: r.data.token, deviceId: r.data.deviceId, workdir, allowOutside: args.includes('--allow-outside') });
  say(`Paired. Working folder: ${workdir}\nNow start it with:  node claw.mjs`);
}

const [cmd = 'run', ...rest] = process.argv.slice(2);
if (cmd === 'pair') await pair(rest);
else if (cmd === 'run') await run();
else if (cmd === 'status') { const c = readConfig(); say(c ? `Paired with ${c.server}\nWorking folder: ${c.workdir}` : 'Not paired.'); }
else if (cmd === 'log') { try { say(fs.readFileSync(LOG, 'utf8').split('\n').slice(-60).join('\n')); } catch { say('No log yet.'); } }
else if (cmd === 'unpair') { try { fs.unlinkSync(CONFIG); say('Unpaired. (Also remove the helper in the Code Space.)'); } catch { say('Not paired.'); } }
else say('Commands: pair, run, status, log, unpair');
