/**
 * Guards the fix for self-hosted video dying as an opaque HTTP 413.
 *
 * Vercel's 4.5MB cap is on the response this app sends the browser, not on
 * what it fetches from Modal — so a big clip arrives fine and then vanishes on
 * the way out. persistVideoResult() moves the bytes into object storage and
 * returns a URL instead.
 *
 * Runs with no SUPABASE_* env set, which is exactly the unconfigured path:
 * storeMediaAsset() returns null, so these cases prove the fallback behaves
 * (small clip still inlines, big clip fails loudly with a fixable message
 * rather than an opaque 413).
 *
 *   node scripts/check-video-persist.mjs
 */
import { __test } from '../api/media-generate.js';

const { persistVideoResult, SAFE_JSON_BYTES } = __test;

const dataUrl = (bytes) =>
  `data:video/mp4;base64,${Buffer.alloc(bytes, 0x61).toString('base64')}`;

let failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`ok    ${name}`);
  else { failed++; console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

// A clip already hosted somewhere must pass through untouched.
{
  const out = { kind: 'video', videoUrl: 'https://cdn.example/v.mp4', model: 'ltx-video' };
  const got = await persistVideoResult(out);
  check('hosted URL passes through unchanged', got.videoUrl === out.videoUrl && got === out);
}

// Nothing to persist.
{
  const out = { kind: 'video' };
  const got = await persistVideoResult(out);
  check('missing videoUrl is a no-op', got === out);
}

// Small enough to survive the response body with no storage configured.
{
  const out = { kind: 'video', videoUrl: dataUrl(200_000), model: 'ltx-video' };
  const got = await persistVideoResult(out);
  check('small clip still inlines without storage',
        got.stored === false && got.videoUrl.startsWith('data:'));
}

// The case that was silently breaking: too big to return, no storage.
{
  const bytes = 8 * 1_048_576; // ~8MB clip -> ~10.7MB base64
  const out = { kind: 'video', videoUrl: dataUrl(bytes), model: 'ltx-video' };
  let err = null;
  try { await persistVideoResult(out); } catch (e) { err = e; }
  check('oversized clip throws instead of an opaque 413', err?.status === 413, `got ${err?.status}`);
  check('the error names the actual size and the fix',
        /8\.0MB/.test(err?.message || '') && /SUPABASE_SERVICE_ROLE_KEY/.test(err?.message || ''),
        err?.message);
}

// Sanity: the threshold is under Vercel's real 4.5MB ceiling.
check('size threshold leaves headroom under 4.5MB', SAFE_JSON_BYTES < 4.5 * 1_048_576,
      `SAFE_JSON_BYTES=${SAFE_JSON_BYTES}`);

console.log(failed ? `\n${failed} failing` : '\nall passing');
process.exit(failed ? 1 : 0);
