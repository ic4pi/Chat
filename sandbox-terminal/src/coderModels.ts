/**
 * The Coders package, for the Workspace model picker.
 *
 * Source of truth is the `coder` package in public/model-packages.js — this is
 * a typed copy, not an independent list, because the Workspace is a separate
 * Vite bundle that cannot import from the statically-served chat app. The
 * `coder-package parity` check in scripts/check-api.mjs fails the build if the
 * two drift, so edit the shared file first and mirror it here.
 *
 * Why the Workspace needs its own view of it: the provider dropdown loads one
 * catalog at a time, so the coding models a user actually wants here are
 * scattered across three providers and buried in a few hundred rows. This
 * gathers them into one list — free options always selectable, paid ones
 * selectable once the paid password is unlocked.
 */

import { fetchModels, type CatalogModel, type ProviderKeys } from './providerPrefs.js';

/** Mirrors OPENROUTER_FREE_LIMITS.short in public/model-packages.js. */
export const OPENROUTER_FREE_LIMIT_LABEL = '20/min · 50/day';

export interface CoderEntry {
  provider: string;
  /** Candidate ids, best first — providers rename and retire slugs. */
  ids: string[];
  name: string;
  blurb: string;
}

export interface CoderBrand {
  id: string;
  label: string;
  /** Used to re-discover a model when none of the candidate ids resolve. */
  match: RegExp;
  free: CoderEntry | null;
  paid: CoderEntry[];
}

export const CODER_BRANDS: CoderBrand[] = [
  {
    id: 'qwen-coder',
    label: 'Qwen Coder',
    match: /qwen.*coder/i,
    free: { provider: 'openrouter', ids: ['qwen/qwen3-coder:free'], name: 'Qwen3 Coder', blurb: 'Free coding model.' },
    paid: [
      { provider: 'openrouter', ids: ['qwen/qwen3-coder'], name: 'Qwen3 Coder', blurb: 'No rate limit.' },
    ],
  },
  {
    id: 'deepseek-coder',
    label: 'DeepSeek Coder',
    match: /deepseek/i,
    free: { provider: 'openrouter', ids: ['deepseek/deepseek-chat-v3.1:free'], name: 'DeepSeek Chat', blurb: 'Doubles as a coder.' },
    paid: [
      { provider: 'nvidia', ids: ['deepseek-ai/deepseek-v4-pro'], name: 'DeepSeek V4 Pro', blurb: 'The big one.' },
    ],
  },
  {
    id: 'gpt-oss',
    label: 'GPT OSS',
    match: /gpt-oss/i,
    free: { provider: 'openrouter', ids: ['openai/gpt-oss-20b:free'], name: 'GPT OSS 20B', blurb: 'Free tier.' },
    paid: [
      { provider: 'cerebras', ids: ['gpt-oss-120b'], name: 'GPT OSS 120B', blurb: 'Cerebras speed.' },
    ],
  },
];

/** Every provider the Coders package reaches into — the catalogs to fetch. */
export const CODER_PROVIDERS = [
  ...new Set(
    CODER_BRANDS.flatMap((b) => [
      ...(b.free ? [b.free.provider] : []),
      ...b.paid.map((p) => p.provider),
    ]),
  ),
];

/** A resolved row: a real catalog entry, labelled with our curated copy. */
export interface CoderModel extends CatalogModel {
  provider: string;
  brand: string;
  blurb: string;
  /** '' for paid models — only the free tier is rate-limited. */
  limit: string;
}

export interface ResolvedCoderBrand {
  id: string;
  label: string;
  models: CoderModel[];
  /** True when nothing here is usable without the paid unlock. */
  paidOnly: boolean;
}

/** Stable key for a <select> option, since ids alone collide across providers. */
export function coderKey(provider: string, id: string): string {
  return `${provider}::${id}`;
}

export function parseCoderKey(key: string): { provider: string; id: string } {
  const at = key.indexOf('::');
  return at < 0
    ? { provider: '', id: key }
    : { provider: key.slice(0, at), id: key.slice(at + 2) };
}

function decorate(hit: CatalogModel, brand: CoderBrand, name: string, blurb: string): CoderModel {
  const free = hit.free !== false;
  return {
    ...hit,
    provider: hit.provider || '',
    brand: brand.label,
    name,
    blurb,
    free,
    paid: !free,
    limit: free && hit.provider === 'openrouter' ? OPENROUTER_FREE_LIMIT_LABEL : '',
  };
}

/**
 * Match one curated entry against the fetched catalogs. Falls back to finding
 * any model of the right brand and tier, so a renamed slug costs one row's
 * label rather than emptying the group.
 */
function resolveEntry(
  entry: CoderEntry | null,
  brand: CoderBrand,
  catalogs: Map<string, CatalogModel[]>,
  wantFree: boolean,
): CoderModel | null {
  if (entry) {
    const list = catalogs.get(entry.provider) || [];
    for (const id of entry.ids) {
      const hit = list.find((m) => m.id === id);
      if (hit) return decorate(hit, brand, entry.name, entry.blurb);
    }
  }
  for (const list of catalogs.values()) {
    const hit = list.find(
      (m) => (m.free !== false) === wantFree && brand.match.test(String(m.id || '')),
    );
    if (hit) return decorate(hit, brand, hit.name || hit.id, '');
  }
  return null;
}

/**
 * Fetch the catalogs the Coders package spans and resolve it into brand
 * groups. Free models come first inside each brand — that is the one a locked
 * Workspace can actually run.
 */
export async function loadCoderModels(keys: ProviderKeys = {}): Promise<ResolvedCoderBrand[]> {
  const catalogs = new Map<string, CatalogModel[]>();
  await Promise.all(
    CODER_PROVIDERS.map(async (pid) => {
      const key = (keys[pid] || '').trim();
      catalogs.set(pid, await fetchModels(pid, key || undefined));
    }),
  );

  const out: ResolvedCoderBrand[] = [];
  for (const brand of CODER_BRANDS) {
    const models: CoderModel[] = [];
    const free = resolveEntry(brand.free, brand, catalogs, true);
    if (free) models.push(free);
    for (const entry of brand.paid) {
      const hit = resolveEntry(entry, brand, catalogs, false);
      if (hit && !models.some((m) => m.provider === hit.provider && m.id === hit.id)) {
        models.push(hit);
      }
    }
    if (models.length) {
      out.push({
        id: brand.id,
        label: brand.label,
        models,
        paidOnly: !models.some((m) => m.free),
      });
    }
  }
  return out;
}

/** Flattened, for lookups and for picking a sensible default. */
export function flattenCoderModels(brands: ResolvedCoderBrand[]): CoderModel[] {
  return brands.flatMap((b) => b.models);
}

/**
 * The model the Workspace should land on: a free coder if the paid tier is
 * locked, otherwise the first coder in the list.
 */
export function pickDefaultCoder(brands: ResolvedCoderBrand[], unlocked: boolean): CoderModel | null {
  const all = flattenCoderModels(brands);
  return all.find((m) => m.free) || (unlocked ? all[0] : null) || null;
}
