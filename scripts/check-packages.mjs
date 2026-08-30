#!/usr/bin/env node
/**
 * Verify the curated model packages against a LIVE catalog.
 *
 * public/model-packages.js lists candidate ids per brand, on the assumption
 * that providers rename and retire slugs. This script answers the question
 * that assumption raises: which of them actually exist right now?
 *
 *   node scripts/check-packages.mjs                      # localhost:3000
 *   node scripts/check-packages.mjs https://your.app     # a deployment
 *   node scripts/check-packages.mjs --json               # machine-readable
 *
 * Reads /api/models the same way the browser does, so it sees exactly what
 * the picker will see, server keys and all. Exits non-zero if any brand ends
 * up with nothing at all — that is the only outcome a user would read as
 * broken. A missing candidate that the resolver recovered from is reported as
 * DISCOVERED and does not fail: that is the fallback doing its job.
 */

import { MODEL_PACKAGES, resolveBrand } from '../public/model-packages.js';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const base = (args.find((a) => !a.startsWith('--')) || 'http://localhost:3000').replace(/\/$/, '');

const PROVIDERS = ['venice', 'openrouter', 'cerebras', 'groq', 'nvidia'];

/** Mirrors inferFree() in lib/model-meta.js — only OpenRouter :free is free. */
function inferFree(providerId, model) {
  if (model.free === true) return true;
  if (model.free === false) return false;
  const id = String(model.id || '');
  if (providerId !== 'openrouter') return false;
  if (id === 'openrouter/free' || /:free$/i.test(id)) return true;
  if (model.pricing?.prompt === '0' || model.pricing?.prompt === 0) return true;
  return /\(free\)/i.test(String(model.name || ''));
}

async function fetchCatalog(providerId) {
  const url = `${base}/api/models?provider=${encodeURIComponent(providerId)}`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    const data = await res.json();
    if (!res.ok) return { providerId, models: [], error: data.error || `HTTP ${res.status}` };
    const models = (Array.isArray(data.models) ? data.models : [])
      .filter((m) => m && m.id)
      .map((m) => ({ ...m, provider: providerId, free: inferFree(providerId, m) }));
    return { providerId, models };
  } catch (err) {
    return { providerId, models: [], error: err.message };
  }
}

const results = await Promise.all(PROVIDERS.map(fetchCatalog));
const catalog = results.flatMap((r) => r.models);
const reachable = results.filter((r) => !r.error);

if (!catalog.length) {
  console.error(
    `No models came back from ${base}/api/models.\n` +
    results.map((r) => `  ${r.providerId}: ${r.error || 'empty'}`).join('\n') +
    `\n\nIs the app running? Pass a deployment URL as the first argument.`,
  );
  process.exit(2);
}

/** Did this exact curated id survive, or did the resolver have to go looking? */
function verdictFor(entry, resolved) {
  // A brand declared `free: null` has no free option anywhere by design
  // (Claude, Grok, Venice). Reporting that as MISSING would cry wolf.
  if (!entry && !resolved) return { state: 'NONE', detail: 'no free tier by design' };
  if (!resolved) return { state: 'MISSING', detail: entry ? entry.ids[0] : '—' };
  if (!entry) return { state: 'BONUS', detail: `${resolved.provider}/${resolved.id}` };
  if (!resolved.curated) return { state: 'DISCOVERED', detail: `${resolved.provider}/${resolved.id}` };
  const first = entry.ids[0];
  return resolved.id === first
    ? { state: 'OK', detail: `${resolved.provider}/${resolved.id}` }
    : { state: 'ALTERNATE', detail: `${resolved.provider}/${resolved.id} (not ${first})` };
}

const report = [];
let emptyBrands = 0;

for (const pkg of MODEL_PACKAGES) {
  for (const brand of pkg.brands) {
    const r = resolveBrand(brand, catalog);
    const rows = [];
    rows.push({ tier: 'free', ...verdictFor(brand.free, r.free) });
    const paidEntries = brand.paid || [];
    r.paid.forEach((model, i) => rows.push({ tier: 'paid', ...verdictFor(paidEntries[i], model) }));
    for (let i = r.paid.length; i < paidEntries.length; i += 1) {
      rows.push({ tier: 'paid', state: 'MISSING', detail: paidEntries[i].ids[0] });
    }
    const total = (r.free ? 1 : 0) + r.paid.length;
    if (!total) emptyBrands += 1;
    report.push({ package: pkg.id, brand: brand.label, total, paidOnly: r.paidOnly, rows });
  }
}

if (asJson) {
  console.log(JSON.stringify({ base, catalogSize: catalog.length, report }, null, 2));
} else {
  console.log(`\nCatalog: ${catalog.length} models from ${reachable.length}/${PROVIDERS.length} providers @ ${base}`);
  for (const r of results.filter((x) => x.error)) console.log(`  ! ${r.providerId}: ${r.error}`);
  let pkg = '';
  for (const b of report) {
    if (b.package !== pkg) { pkg = b.package; console.log(`\n== ${pkg} ==`); }
    const flag = b.total === 0 ? '  ← EMPTY' : b.paidOnly ? '  (paid-only — greys out on free tier)' : '';
    console.log(` ${b.brand}${flag}`);
    for (const row of b.rows) console.log(`   ${row.state.padEnd(11)} ${row.tier}  ${row.detail}`);
  }
  console.log(
    '\nOK = the preferred id exists. ALTERNATE/DISCOVERED = a fallback resolved it ' +
    '(fine, but worth updating public/model-packages.js). MISSING = that row will not appear.',
  );
}

if (emptyBrands) {
  console.error(`\n${emptyBrands} brand(s) resolved to nothing and will not render.`);
  process.exit(1);
}
