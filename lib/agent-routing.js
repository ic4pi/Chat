/**
 * Workspace auto-routing for /api/agent-chat.
 *
 * Three moving parts, all heuristic:
 *  - pickInitialAttempt: simple ask -> free Qwen coder, tougher ask -> Sonnet 4.5.
 *    Only kicks in when the request is on Workspace's own default Qwen model
 *    (or sends no model at all) — an explicit manual pick from the model
 *    picker is left alone.
 *  - Free Qwen getting rate-limited (429/402) escalates to paid Qwen.
 *  - A refusal from ANY tier (including a manual pick) reroutes once to the
 *    uncensored default. Refusal detection requires both refusal language AND
 *    the absence of any actual code output, to avoid false positives on a
 *    reply that hedges but still delivers.
 */

export const TIERS = {
  simpleFree: { provider: 'openrouter', model: 'qwen/qwen3-coder:free', tier: 'simpleFree' },
  simplePaid: { provider: 'openrouter', model: 'qwen/qwen3-coder', tier: 'simplePaid' },
  tough: { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5', tier: 'tough' },
  uncensored: { provider: 'venice', model: 'e2ee-qwen3-6-35b-a3b-uncensored-p', tier: 'uncensored' },
};

/** Workspace's own baked-in defaults — safe for this router to override. */
const AUTO_MANAGED_MODELS = new Set(['', 'qwen/qwen3-coder:free', 'qwen/qwen3-coder']);

/** Rough signal for "this needs real engineering judgment, not just typing." */
const TOUGH_KEYWORDS =
  /architecture|refactor|concurren|race condition|migrat|database schema|distributed|multi-?thread|deadlock|security|authentication|encrypt|algorithm|optimi[sz]e|performance|design pattern|state machine|websocket|scal(?:e|ing)|thread-?safe/gi;

/** Heuristic, not a real classifier — tune the keyword list as it misfires. */
export function classifyDifficulty(messages, systemPrompt, tokens) {
  const text = [
    systemPrompt || '',
    ...(Array.isArray(messages) ? messages.map((m) => (typeof m.content === 'string' ? m.content : '')) : []),
  ].join('\n');
  const keywordHits = (text.match(TOUGH_KEYWORDS) || []).length;
  if (keywordHits >= 2) return 'tough';
  if ((tokens || 0) > 6000) return 'tough';
  return 'simple';
}

/**
 * First attempt for a request. `provider`/`model` are whatever the client
 * sent. `tokens` is the already-budgeted input token count.
 */
export function pickInitialAttempt({ provider, model, messages, systemPrompt, tokens }) {
  const requestedModel = (model || '').trim();
  if (!AUTO_MANAGED_MODELS.has(requestedModel)) {
    return { provider: provider || 'openrouter', model: requestedModel, tier: 'manual' };
  }
  const difficulty = classifyDifficulty(messages, systemPrompt, tokens);
  return difficulty === 'tough' ? TIERS.tough : TIERS.simpleFree;
}

export function isRateLimited(status) {
  return status === 429 || status === 402;
}

const REFUSAL_PATTERNS = [
  /\bI can(?:'|no)t (?:help|assist|create|write|generate|produce)\b/i,
  /\bI(?:’|')m (?:not able|unable) to\b/i,
  /\bI (?:must|have to) decline\b/i,
  /\bI won'?t (?:be able to )?(?:help|assist|create|write|generate)\b/i,
  /\b(?:against|violates?) (?:my|the) (?:guidelines|policy|policies)\b/i,
  /\bI'?m sorry,? but I (?:can'?t|cannot|won'?t)\b/i,
  /\bcontent policy\b/i,
  /\bnot (?:able|going) to (?:provide|generate|create) (?:this|that|the requested)\b/i,
];

/** A refusal is refusal language up front AND no actual file/code output. */
export function isRefusal(text) {
  if (!text || !text.trim()) return false;
  const hasOutput = /File:\s*\S/i.test(text) || /```/.test(text);
  if (hasOutput) return false;
  const head = text.slice(0, 600);
  return REFUSAL_PATTERNS.some((re) => re.test(head));
}
