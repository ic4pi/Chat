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
import { noteSettingsChanged } from './settingsSync.js';

export type SeatId = 'plan' | 'build' | 'review' | 'fix';
export type PresetId = 'uncensored' | 'best' | 'budget' | 'value' | 'free';
export interface SeatModel { provider: string; model: string }
export type TeamSeats = Record<SeatId, SeatModel>;

export interface TeamPrefs {
  preset: PresetId | 'custom';
  seats: TeamSeats | null;   // null until first resolved from the live catalogs
  /** Show "Who builds this?" before any code is written. */
  askFirst: boolean;
  /** The saved team these seats came from, while they still match it. */
  savedId?: string | null;
}

/** A team you named and kept: fixed seats, exactly as you picked them. */
export interface SavedTeam { id: string; name: string; seats: TeamSeats; savedAt: number }

export const SEATS: Array<{ id: SeatId; label: string; job: string }> = [
  { id: 'plan', label: 'Plan', job: 'Architecture and steps — no code (Plan role).' },
  { id: 'build', label: 'Build', job: 'Writes the code and all the content in it.' },
  { id: 'review', label: 'Review', job: 'Reads the code and says what is wrong (Review role).' },
  { id: 'fix', label: 'Fix', job: 'Repairs what auto-test catches.' },
];

/** `latest`: among matches, the newest version (claude-opus-5.5 over -5). */
type Pref = { provider: string; match: RegExp; latest?: boolean } | { provider: 'openrouter'; live: 'chat' | 'coder' };

const OR = 'openrouter';
const latest = (match: RegExp): Pref => ({ provider: OR, match, latest: true });
const exact = (id: string): Pref => ({ provider: OR, match: new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`) });

/**
 * Five teams, in the order they're offered. Paid tiers are OpenRouter; seats
 * are preferences matched against the live catalog (first usable match wins),
 * so each one tracks the vendor's current model rather than a fixed slug.
 */
export const PRESETS: Record<PresetId, { label: string; blurb: string; seats: Record<SeatId, Pref[]> }> = {
  uncensored: {
    label: 'Uncensored',
    blurb: 'Paid Venice uncensored on every seat, except Fix: a filtered coder that only sees error output — and hands the fix to the builder if it ever refuses.',
    seats: {
      plan: [
        { provider: 'venice', match: /qwen3[^/]*uncensored/i },
        { provider: 'venice', match: /glm[^/]*heretic/i },
        { provider: 'venice', match: /gemma-4[^/]*uncensored/i },
      ],
      build: [
        { provider: 'venice', match: /glm[^/]*heretic/i },
        { provider: 'venice', match: /qwen3[^/]*uncensored/i },
        { provider: 'venice', match: /gemma-4[^/]*uncensored/i },
      ],
      // Review reads whole projects: the 256k-context Gemma, not the 64k one.
      review: [
        { provider: 'venice', match: /^gemma-4-uncensored$/i },
        { provider: 'venice', match: /glm[^/]*heretic/i },
        { provider: 'venice', match: /qwen3[^/]*uncensored/i },
      ],
      fix: [exact('qwen/qwen3-coder'), latest(/^qwen\/qwen3-coder-plus$/i), { provider: OR, live: 'coder' }],
    },
  },
  best: {
    label: 'Best',
    blurb: 'The strongest model for each seat, whatever it costs. Review is a different vendor than Build, for a real second opinion.',
    seats: {
      plan: [latest(/^anthropic\/claude-fable-[\d.]+$/i), latest(/^anthropic\/claude-opus-[\d.]+$/i), latest(/^openai\/gpt-[\d.]+-astra-pro$/i)],
      build: [latest(/^anthropic\/claude-fable-[\d.]+$/i), latest(/^anthropic\/claude-opus-[\d.]+$/i)],
      review: [latest(/^openai\/gpt-[\d.]+-astra-pro$/i), latest(/^openai\/gpt-[\d.]+-astra$/i), latest(/^google\/gemini-[\d.]+-pro(?:-preview)?$/i)],
      fix: [latest(/^anthropic\/claude-opus-[\d.]+$/i), latest(/^openai\/gpt-[\d.]+-codex-max$/i)],
    },
  },
  budget: {
    label: 'Budget',
    blurb: 'The cheapest models that still do the job well — cents per build.',
    seats: {
      plan: [latest(/^deepseek\/deepseek-v[\d.]+-pro$/i), latest(/^qwen\/qwen[\d.]+-flash$/i)],
      build: [latest(/^anthropic\/claude-haiku-[\d.]+$/i), latest(/^deepseek\/deepseek-v[\d.]+-pro$/i)],
      review: [latest(/^openai\/gpt-[\d.]+-luna$/i), latest(/^google\/gemini-[\d.]+-flash-lite$/i)],
      fix: [exact('qwen/qwen3-coder-30b-a3b-instruct'), latest(/^anthropic\/claude-haiku-[\d.]+$/i)],
    },
  },
  value: {
    label: 'Value',
    blurb: 'Best bang for the buck: near-top quality at a fraction of the Best team\'s price.',
    seats: {
      plan: [latest(/^anthropic\/claude-sonnet-[\d.]+$/i), latest(/^openai\/gpt-[\d.]+-sol$/i)],
      build: [latest(/^anthropic\/claude-sonnet-[\d.]+$/i), latest(/^openai\/gpt-[\d.]+-sol$/i)],
      review: [latest(/^google\/gemini-[\d.]+-flash$/i), latest(/^openai\/gpt-[\d.]+-mini$/i)],
      fix: [latest(/^moonshotai\/kimi-k[\d.]+-code$/i), latest(/^qwen\/qwen3-coder-plus$/i), exact('qwen/qwen3-coder')],
    },
  },
  free: {
    label: 'Free',
    blurb: 'OpenRouter free models only — no unlock needed. Filtered, so not for uncensored content.',
    seats: {
      plan: [{ provider: OR, live: 'chat' }],
      build: [{ provider: OR, live: 'coder' }],
      review: [{ provider: OR, live: 'chat' }],
      fix: [{ provider: OR, live: 'coder' }],
    },
  },
};

/**
 * Cost as stars, from ⭐ (free) to ⭐⭐⭐⭐ (Fable-class), by output price per
 * million tokens. Venice is cheap per token but paid: ⭐⭐.
 */
export function costStars(provider: string, meta?: { free?: boolean; pricing?: { completion?: string | number } }): number {
  if (provider === 'venice') return 2;
  const out = Number(meta?.pricing?.completion || 0) * 1e6;
  if (!out) return meta?.free === false ? 2 : 1;
  if (out < 5) return 2;
  if (out < 30) return 3;
  return 4;
}

export const stars = (n: number) => '⭐'.repeat(Math.max(1, Math.min(4, n)));

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

/** "anthropic/claude-opus-5.5" → [5, 5]; "openai/gpt-6.1-sol" → [6, 1]. */
function versionOf(id: string): number[] {
  const name = id.includes('/') ? id.slice(id.indexOf('/') + 1) : id;
  return (name.match(/\d+(?:\.\d+)*/g) || []).join('.').split('.').filter(Boolean).map(Number);
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d) return d;
  }
  return 0;
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
    const matches = list.filter(m => pref.match.test(m.id) && usable(m, ctx.unlocked));
    if (pref.latest) matches.sort((a, b) => compareVersions(versionOf(b.id), versionOf(a.id)));
    if (matches[0]) return { provider: pref.provider, model: matches[0].id };
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
        preset: p.preset && (p.preset === 'custom' || p.preset in PRESETS) ? p.preset : 'uncensored',
        seats: p.seats && p.seats.build ? p.seats : null,
        askFirst: p.askFirst !== false,
        savedId: typeof p.savedId === 'string' ? p.savedId : null,
      };
    }
  } catch { /* ignore */ }
  return { preset: 'uncensored', seats: null, askFirst: true };
}

export function saveTeamPrefs(p: TeamPrefs): void {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* ignore */ }
  noteSettingsChanged();
}

const SAVED_KEY = 'workspace_saved_teams_v1';

export function loadSavedTeams(): SavedTeam[] {
  try {
    const list = JSON.parse(localStorage.getItem(SAVED_KEY) || '[]') as SavedTeam[];
    return Array.isArray(list) ? list.filter(t => t && t.id && t.name && t.seats?.build && t.seats?.fix) : [];
  } catch { return []; }
}

export function saveSavedTeams(list: SavedTeam[]): void {
  try { localStorage.setItem(SAVED_KEY, JSON.stringify(list)); } catch { /* ignore */ }
  noteSettingsChanged();
}

/** Same name replaces that team; a new name adds one. Returns the new list and the team. */
export function upsertSavedTeam(list: SavedTeam[], name: string, seats: TeamSeats): { list: SavedTeam[]; team: SavedTeam } {
  const clean = name.trim().slice(0, 60);
  const prev = list.find(t => t.name.toLowerCase() === clean.toLowerCase());
  const team: SavedTeam = { id: prev?.id || Math.random().toString(36).slice(2, 10), name: clean, seats, savedAt: Date.now() };
  return { list: prev ? list.map(t => (t.id === prev.id ? team : t)) : [...list, team], team };
}

/** A retired model, swapped for its replacement in every saved team. */
export function renameModelInTeams(list: SavedTeam[], from: string, to: string): SavedTeam[] | null {
  let changed = false;
  const next = list.map(t => {
    const seats = { ...t.seats };
    for (const id of Object.keys(seats) as SeatId[]) {
      if (seats[id].model === from) { seats[id] = { ...seats[id], model: to }; changed = true; }
    }
    return { ...t, seats };
  });
  return changed ? next : null;
}

/** A team's cost: its priciest seat, ⭐ to ⭐⭐⭐⭐. */
export function seatsStars(seats: TeamSeats, catalogs: Record<string, CatalogModel[]>): number {
  return Math.max(...SEATS.map(({ id }) =>
    costStars(seats[id].provider, (catalogs[seats[id].provider] || []).find(m => m.id === seats[id].model))));
}

/** Paid seats that can't run on this device until it's unlocked. */
export function lockedSeats(seats: TeamSeats, catalogs: Record<string, CatalogModel[]>): SeatId[] {
  return SEATS.map(s => s.id).filter(id => {
    const sm = seats[id];
    const meta = (catalogs[sm.provider] || []).find(m => m.id === sm.model);
    return meta ? meta.free === false : sm.provider === 'venice';
  });
}

/** "Refuses taboo or illegal stuff" — the signal to hand a fix back to the builder. */
export function looksLikeRefusal(reply: string): boolean {
  const text = String(reply || '').slice(0, 1200);
  if (/^\s*(?:File|Edit):/m.test(text)) return false;
  return /\b(?:I can['’]?t|I cannot|I won['’]?t|I(?:'m| am) (?:not able|unable) to|I must decline|I(?:'m| am) sorry, but)\b[^.]{0,120}\b(?:help|assist|comply|provide|create|write|continue|do (?:that|this))\b|against (?:my|our|the) (?:guidelines|policies|policy)|content policy|not (?:able|allowed) to (?:help|assist) with/i.test(text);
}
