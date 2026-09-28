/**
 * Deterministic static-analysis pass for the security personas.
 *
 * Not a replacement for Semgrep/tfsec — those are Python/Go binaries that
 * don't fit in a Vercel Node function. This is a real pattern-matching
 * scanner (not the LLM guessing): it greps recent messages for known-bad
 * code and infra-config patterns and hands the persona actual line-numbered
 * hits to reason about, same shape as web search results.
 */

const CODE_RULES = [
  {
    id: 'hardcoded-aws-key',
    severity: 'high',
    re: /AKIA[0-9A-Z]{16}/g,
    message: 'Hardcoded AWS access key ID.',
  },
  {
    id: 'hardcoded-private-key',
    severity: 'high',
    re: /-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/g,
    message: 'Private key embedded directly in source/text.',
  },
  {
    id: 'hardcoded-secret-assignment',
    severity: 'medium',
    re: /\b(api[_-]?key|secret|password|passwd|token)\b\s*[:=]\s*['"][^'"\n]{8,}['"]/gi,
    message: 'Secret-looking value assigned as a literal string.',
  },
  {
    id: 'eval-usage',
    severity: 'high',
    re: /\beval\s*\(|new\s+Function\s*\(/g,
    message: 'eval()/Function() on dynamic input — arbitrary code execution risk.',
  },
  {
    id: 'shell-exec-concat',
    severity: 'high',
    re: /\b(exec|execSync|spawn)\s*\(\s*(`[^`]*\$\{|['"][^'"]*['"]\s*\+)/g,
    message: 'Shell command built via string concatenation/template literal — command injection risk if any part is user input.',
  },
  {
    id: 'sql-string-concat',
    severity: 'high',
    re: /\b(SELECT|INSERT|UPDATE|DELETE)\b[\s\S]{0,120}?(\+\s*\w+|\$\{)/gi,
    message: 'SQL built via concatenation/template literal — likely SQL injection unless parameterized.',
  },
  {
    id: 'disabled-tls-verify',
    severity: 'high',
    re: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0/g,
    message: 'TLS certificate verification explicitly disabled.',
  },
  {
    id: 'insecure-random-for-secret',
    severity: 'medium',
    re: /Math\.random\(\)[^\n]{0,40}(token|session|password|secret|nonce|csrf)/gi,
    message: 'Math.random() used near a security-sensitive value — not cryptographically secure, use crypto.randomBytes.',
  },
  {
    id: 'unsafe-innerhtml',
    severity: 'medium',
    re: /\.innerHTML\s*=\s*[^'"`;]*[a-zA-Z_$][\w.]*\s*;/g,
    message: 'innerHTML assigned from a variable — XSS risk unless the value is sanitized.',
  },
  {
    id: 'unsafe-yaml-load',
    severity: 'high',
    re: /yaml\.load\s*\((?!.*safe)/g,
    message: 'Unsafe YAML deserialization (yaml.load instead of safe_load/FAILSAFE_SCHEMA).',
  },
  {
    id: 'python-pickle',
    severity: 'high',
    re: /pickle\.loads?\s*\(/g,
    message: 'pickle.load on untrusted data can execute arbitrary code.',
  },
];

const INFRA_RULES = [
  {
    id: 'open-cidr',
    severity: 'high',
    re: /0\.0\.0\.0\/0/g,
    message: 'Rule scoped to 0.0.0.0/0 — open to the entire internet. Confirm this is actually meant to be public.',
  },
  {
    id: 'wildcard-iam-action',
    severity: 'high',
    re: /"Action"\s*:\s*"\*"/g,
    message: 'IAM statement grants Action: "*" — full-privilege wildcard.',
  },
  {
    id: 'wildcard-iam-resource',
    severity: 'medium',
    re: /"Resource"\s*:\s*"\*"/g,
    message: 'IAM statement grants Resource: "*" — applies to every resource, not scoped.',
  },
  {
    id: 'public-acl',
    severity: 'high',
    re: /(public-read|publicRead|"BlockPublicAcls"\s*:\s*false)/g,
    message: 'Storage ACL/flag allows public access.',
  },
  {
    id: 'unencrypted-storage',
    severity: 'medium',
    re: /"Encrypted"\s*:\s*false|encrypted\s*=\s*false/gi,
    message: 'Storage/volume explicitly marked unencrypted.',
  },
  {
    id: 'privileged-container',
    severity: 'high',
    re: /--privileged\b|"privileged"\s*:\s*true/g,
    message: 'Container runs with full host privileges.',
  },
  {
    id: 'exposed-admin-port',
    severity: 'medium',
    re: /\b(port|Port)\s*[:=]\s*(22|3389|2375|9200|6379|27017)\b/g,
    message: 'Admin/DB port referenced near a rule — verify it is not exposed publicly.',
  },
];

function findMatches(text, rules) {
  const lines = text.split('\n');
  const hits = [];
  for (const rule of rules) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text))) {
      const upTo = text.slice(0, m.index);
      const line = upTo.split('\n').length;
      hits.push({
        id: rule.id,
        severity: rule.severity,
        message: rule.message,
        line,
        snippet: (lines[line - 1] || '').trim().slice(0, 160),
      });
      // Rules without the global flag would loop forever; all of ours are
      // global, but guard anyway against zero-width matches.
      if (m.index === rule.re.lastIndex) rule.re.lastIndex++;
    }
  }
  // Stable order: worst first, then by line.
  const rank = { high: 0, medium: 1, low: 2 };
  hits.sort((a, b) => rank[a.severity] - rank[b.severity] || a.line - b.line);
  return hits.slice(0, 20);
}

/** Pull fenced ```code``` blocks out of chat text; falls back to the raw text if there are none. */
function extractBlocks(text) {
  const fenced = [...String(text || '').matchAll(/```[\w-]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  return fenced.length ? fenced.join('\n\n') : String(text || '');
}

export function scanCode(rawText) {
  return findMatches(extractBlocks(rawText), CODE_RULES);
}

export function scanInfraConfig(rawText) {
  return findMatches(extractBlocks(rawText), INFRA_RULES);
}

/** Same shape/purpose as formatSearchContext in lib/websearch.js — a system-message block the persona is told to cite from. */
export function formatScanContext(kind, findings) {
  const label = kind === 'infra' ? 'Static config scan' : 'Static code scan';
  if (!findings.length) {
    return `${label}: no matches for this scanner's known bad-pattern list in the text shared so far. ` +
      `That means nothing on the checklist tripped — it does NOT mean the code/config is safe, only that ` +
      `this pattern scan found nothing. Say that plainly rather than implying a clean bill of health.`;
  }
  const lines = findings.map(
    (f) => `[${f.severity.toUpperCase()}] line ${f.line} — ${f.message}\n    ${f.snippet}`,
  );
  return (
    `${label} results (deterministic pattern match, not the model guessing):\n\n` +
    lines.join('\n\n') +
    `\n\nThese are real matches against known-bad patterns in the text above — reference them by line ` +
    `number. This list is not exhaustive; say so if you also suspect issues outside it.`
  );
}
