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

export const MAX_ACTIONS = 20;
export const MAX_CMD_CHARS = 2000;
export const MAX_FILE_CHARS = 200_000;
export const MAX_TIMEOUT_S = 600;
export const DEFAULT_TIMEOUT_S = 120;

const KINDS = ['run', 'read', 'write', 'append', 'move', 'mkdir', 'delete', 'list', 'open'];

const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : null);

/**
 * One action in, one clean action out (or an error). Unknown fields are dropped.
 *   run    {cmd, cwd?, timeout?}      read {path}        list {path}
 *   write  {path, content}            append {path, content}
 *   move   {from, to}                 mkdir {path}       delete {path}
 *   open   {target}  (http/https URL, or an app name on macOS)
 */
export function cleanAction(a) {
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
export function validateActions(list) {
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
  [/(^|[\s;&|(`"'\/])sudo(\s|$|["'])/, 'sudo (running as administrator)'],
  [/(^|[\s;&|(`"'\/])su(\s+-|\s*$|["'])/, 'switching user with su'],
  [/(^|[\s;&|(`"'\/])(doas|pkexec)(\s|$|["'])/, 'running as another user'],
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
  [/Library\/Keychains|\.password-store/, 'saved passwords'],
  [/\bsecurity\s+(find-generic-password|find-internet-password|dump-keychain|export)/i, 'reading saved passwords'],
  [/\b(passwd|chpasswd)\b/, 'changing passwords'],
  [/\bnc\b[^|;&]*\s-[a-zA-Z]*e\b|\bbash\s+-i\s*>&|\/dev\/tcp\//, 'opening a remote shell'],
  [/\|\s*(sudo\s+)?(\/\S*\/)?(sh|bash|zsh|dash|ksh)(\s|$)/, 'feeding text straight into a shell'],
  [/<\(\s*(curl|wget)\b|\b(sh|bash|zsh)\s+<\(\s*(curl|wget)\b/, 'running a downloaded script without reading it'],
  [/\bfind\s+(\/|~|\$HOME|\.\.)(\/?\s)[^|;&]*(-delete\b|-exec\s+(rm|shred|unlink)\b)/, 'deleting everything under your drive or home folder'],
  [/\bxargs\b[^|;&]*\b(sudo|rm\s+(-[a-zA-Z]*\s+)*(\/|~|\$HOME)(\s|$))/, 'bulk-deleting your drive or home folder'],
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
  [/(^|[\s;&|(`])(python3?|node|deno|bun|ruby|perl|php|osascript)\s+(-[a-zA-Z]*[ceEpr]\b|--eval\b)/, 'runs code written inline — it can do anything, check it'],
  [/(^|[\s;&|(`])(sh|bash|zsh|dash|ksh)\s+-[a-zA-Z]*c\b/, 'runs a command inside another shell'],
  [/\bfind\b[^|;&]*(-delete\b|-exec\s+(rm|shred|unlink|mv)\b)/, 'deletes files in bulk'],
  [/\bxargs\b/, 'runs commands on a list of things'],
  [/(^|[;&|(`]\s*|^\s*)\$\{?\w+\}?(\s|$)/, 'runs a command named by a variable'],
  [/(^|[\s;&|(`])printenv\b|(^|[;&|(`]\s*|^\s*)env\s*($|[|;&>])|\bexport\s+-p\b/, 'prints environment variables (may hold secrets)'],
  [/(^|[\s\/='"])\.(env|npmrc|netrc|pypirc)(\.[\w-]+)?(\s|$|['"])|\.git\/config\b|(^|[\s\/])(credentials|secrets?)\.(json|ya?ml|txt)\b/i, 'touches a file that usually holds passwords or tokens'],
  [/\bbase64\s+(-d|--decode|-D)\b/, 'decodes hidden text'],
];

/**
 * Commands are matched in two forms — as written, and with the usual disguises
 * undone (empty quotes "", backslashes before letters, brace/quote splitting) —
 * so s""udo and r\m are seen as what they are. Both forms are checked; a hit
 * in either counts.
 */
export function normalizeCmd(cmd) {
  return String(cmd)
    .replace(/["']/g, '')
    .replace(/\\(?=[A-Za-z0-9._\/~-])/g, '')
    .replace(/\$\{(\w+)\}/g, '$$$1')
    .replace(/\s+/g, ' ');
}

const SECRET_FILE_RE = /(^|\/)\.(env|npmrc|netrc|pypirc)(\.[\w-]+)?$|(^|\/)\.git\/config$|(^|\/)(credentials|secrets?)\.(json|ya?ml|txt)$/i;

const NETWORK_RE = /^(https?:)\/\//i;

/** {level: 'safe'|'caution'|'danger'|'blocked', reasons: string[]} */
export function classifyAction(a) {
  const reasons = [];
  const push = (list, text) => { for (const [re, why] of list) if (re.test(text)) reasons.push(why); };
  switch (a.do) {
    case 'run': {
      const forms = [a.cmd, normalizeCmd(a.cmd)];
      for (const f of forms) push(BLOCKED_COMMANDS, f);
      if (reasons.length) return { level: 'blocked', reasons: [...new Set(reasons)] };
      for (const f of forms) push(DANGER_COMMANDS, f);
      if (a.cwd && /^(\/|~|\.\.)/.test(a.cwd)) reasons.push('runs outside the working folder');
      return reasons.length
        ? { level: 'danger', reasons: [...new Set(reasons)] }
        : { level: 'caution', reasons: ['runs a command'] };
    }
    case 'read': case 'list': {
      push(BLOCKED_PATHS, a.path);
      if (reasons.length) return { level: 'blocked', reasons: [...new Set(reasons)] };
      if (/^(\/|~|\.\.)/.test(a.path)) return { level: 'danger', reasons: ['reads outside the working folder'] };
      if (SECRET_FILE_RE.test(a.path)) return { level: 'danger', reasons: ['reads a file that usually holds passwords or tokens — it would be sent to the AI'] };
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
export function describeAction(a) {
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
export function worstLevel(actions) {
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
export function extractClawBlock(raw) {
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


// ── keeping secrets out of what is sent back ──────────────────────────────

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(sk-ant-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|jc_[A-Za-z0-9_-]{30,}|AIza[0-9A-Za-z_-]{30,}|sk_(live|test)_[A-Za-z0-9]{16,})/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /(Bearer\s+)[A-Za-z0-9._~+\/=-]{16,}/gi,
];
// NAME=value lines where the name says it is a secret: keep the name, hide the value.
const SECRET_ASSIGN_RE = /^([ \t]*(?:export[ \t]+)?["']?[A-Za-z0-9_.-]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL|AUTH)[A-Za-z0-9_.-]*["']?[ \t]*[=:][ \t]*)(?!\[redacted\])\S.*$/gim;

/** {text, count}: the text with anything that looks like a key, token or password hidden. */
export function redactSecrets(input) {
  let text = String(input ?? '');
  let count = 0;
  const hide = (re, repl) => { text = text.replace(re, (...m) => { count++; return typeof repl === 'function' ? repl(...m) : repl; }); };
  for (const re of SECRET_PATTERNS) hide(re, (m, g1) => (/^bearer/i.test(m) && typeof g1 === 'string' ? `${g1}[redacted]` : '[redacted]'));
  hide(SECRET_ASSIGN_RE, (_m, head) => `${head}[redacted]`);
  return { text, count };
}
