/**
 * Coding teams — one agent (provider + model) per coding phase.
 *
 *   Plan    architecture and steps, no code         (the Plan role)
 *   Build   writes the code and every word in it    (the Write role)
 *   Review  reads the code and says what's wrong    (the Review role)
 *   Fix     repairs what auto-test catches          (the verify loop)
 *
 * Uncensored by default. A seat may go to a filtered (guardrailed) model only
 * when refusing taboo or illegal topics can never limit the job: Fix only
 * sees error output and the code it has to repair, and if it refuses anyway
 * the builder takes the fix over (ChatPane). Build and Review read and write
 * the actual content, so they stay uncensored.
 *
 * Seats are preferences matched against the live catalogs, never fixed slugs,
 * so a retired model just moves the seat to the next match.
 */

import type { CatalogModel, RoleId, RoleModel } from './providerPrefs.js';

export type SeatId = 'plan' | 'build' | 'review' | 'fix';
export type PresetId = 'uncensored' | 'free';
export interface SeatModel { provider: string; model: string }
export type TeamSeats = Record<SeatId, SeatModel>;

export interface TeamPrefs {
  preset: PresetId | 'custom';
  seats: TeamSeats | null;   // null until first resolved from the live catalogs
  /** Show "Who builds this?" before any code is written. */
  askFirst: boolean;
}

export const SEATS: Array<{ id: SeatId; label: string; job: string }> = [
  { id: 'plan', label: 'Plan', job: 'Architecture and steps — no code (Plan role).' },
  { id: 'build', label: 'Build', job: 'Writes the code and all the content in it.' },
  { id: 'review', label: 'Review', job: 'Reads the code and says what is wrong (Review role).' },
  { id: 'fix', label: 'Fix', job: 'Repairs what auto-test catches.' },
];

type Pref = { provider: string; match: RegExp } | { provider: 'openrouter'; live: 'chat' | 'coder' };

export const PRESETS: Record<PresetId, { label: string; blurb: string; seats: Record<SeatId, Pref[]> }> = {
  uncensored: {
    label: 'Uncensored',
    blurb: 'Every seat uncensored, except Fix: a filtered coder that only sees error output — and hands the fix to the builder if it ever refuses.',
    seats: {
      plan: [
        { provider: 'venice', match: /qwen3[^/]*uncensored/i },
        { provider: 'venice', match: /glm[^/]*heretic/i },
        { provider: 'venice', match: /^gemma-4-uncensored$/i },
      ],
      build: [
        { provider: 'venice', match: /glm[^/]*heretic/i },
        { provider: 'venice', match: /qwen3[^/]*uncensored/i },
        { provider: 'venice', match: /^gemma-4-uncensored$/i },
      ],
      review: [
        { provider: 'venice', match: /^gemma-4-uncensored$/i },
        { provider: 'venice', match: /glm[^/]*heretic/i },
        { provider: 'venice', match: /qwen3[^/]*uncensored/i },
      ],
      fix: [
        { provider: 'openrouter', match: /^qwen\/qwen3-coder$/i },
        { provider: 'openrouter', match: /devstral/i },
        { provider: 'openrouter', match: /codestral/i },
        { provider: 'openrouter', live: 'coder' },
      ],
    },
  },
  free: {
    label: 'Free',
    blurb: 'OpenRouter free models only — no unlock needed. Filtered, so not for uncensored content.',
    seats: {
      plan: [{ provider: 'openrouter', live: 'chat' }],
      build: [{ provider: 'openrouter', live: 'coder' }],
      review: [{ provider: 'openrouter', live: 'chat' }],
      fix: [{ provider: 'openrouter', live: 'coder' }],
    },
  },
};

/** Filtered (guardrailed) seats in the uncensored team — shown as such. */
export function isUncensoredModel(provider: string, model: string): boolean {
  return provider === 'venice' || /uncensored|heretic|dolphin|abliterated|hermes/i.test(model);
}

export interface TeamContext {
  catalogs: Record<string, CatalogModel[]>;
  liveDefaults: Record<string, { chat?: string; coder?: string }>;
  unlocked: boolean;
}

function usable(m: CatalogModel | undefined, unlocked: boolean): boolean {
  return !!m && (unlocked || m.free !== false);
}

function pickSeat(prefs: Pref[], ctx: TeamContext): SeatModel | null {
  for (const pref of prefs) {
    const list = ctx.catalogs[pref.provider] || [];
    if ('live' in pref) {
      const id = ctx.liveDefaults[pref.provider]?.[pref.live];
      const hit = list.find(m => m.id === id) ?? (id ? { id, free: true } as CatalogModel : undefined);
      if (id && usable(hit, ctx.unlocked)) return { provider: pref.provider, model: id };
      continue;
    }
    const hit = list.find(m => pref.match.test(m.id));
    if (hit && usable(hit, ctx.unlocked)) return { provider: pref.provider, model: hit.id };
  }
  return null;
}

/** A preset's seats against today's catalogs. Locked or missing seats fall
 *  back to the Free team's pick for that seat. */
export function resolvePreset(id: PresetId, ctx: TeamContext): TeamSeats {
  const out = {} as TeamSeats;
  for (const seat of SEATS.map(s => s.id)) {
    out[seat] = pickSeat(PRESETS[id].seats[seat], ctx)
      ?? pickSeat(PRESETS.free.seats[seat], ctx)
      ?? { provider: 'openrouter', model: 'openrouter/free' };
  }
  return out;
}

/** The roles the header's role switch uses, kept in step with the team. */
export function rolesFromSeats(seats: TeamSeats): Record<RoleId, RoleModel> {
  return { plan: seats.plan, write: seats.build, review: seats.review };
}

const KEY = 'workspace_coding_team_v1';

export function loadTeamPrefs(): TeamPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<TeamPrefs>;
      return {
        preset: p.preset === 'free' || p.preset === 'custom' ? p.preset : 'uncensored',
        seats: p.seats && p.seats.build ? p.seats : null,
        askFirst: p.askFirst !== false,
      };
    }
  } catch { /* ignore */ }
  return { preset: 'uncensored', seats: null, askFirst: true };
}

export function saveTeamPrefs(p: TeamPrefs): void {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* ignore */ }
}

/** "Refuses taboo or illegal stuff" — the signal to hand a fix back to the builder. */
export function looksLikeRefusal(reply: string): boolean {
  const text = String(reply || '').slice(0, 1200);
  if (/^\s*(?:File|Edit):/m.test(text)) return false;
  return /\b(?:I can['’]?t|I cannot|I won['’]?t|I(?:'m| am) (?:not able|unable) to|I must decline|I(?:'m| am) sorry, but)\b[^.]{0,120}\b(?:help|assist|comply|provide|create|write|continue|do (?:that|this))\b|against (?:my|our|the) (?:guidelines|policies|policy)|content policy|not (?:able|allowed) to (?:help|assist) with/i.test(text);
}
