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

const { persistVideoResult, persistImageResult, SAFE_JSON_BYTES, warmEndpointFor,
        modalEndpoint, clipsForSeconds, videoGeometry } = __test;

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

// Warm-endpoint derivation. Modal builds a web endpoint's URL from app name +
// function name, so `warm` on app `wan-video` sits at ic4pi--wan-video-warm.
// Getting this wrong fails silently, since warming is fire-and-forget.
for (const [model, want] of [
  ['wan2.2-5b',  'https://ic4pi--wan-video-warm.modal.run'],
  ['ltx-video',  'https://ic4pi--ltx-video-warm.modal.run'],
  ['lustify',    'https://ic4pi--sdxl-nsfw-v2-warm.modal.run'],
  ['',           'https://ic4pi--sdxl-nsfw-v2-warm.modal.run'],  // default = image app
]) {
  const got = warmEndpointFor(model);
  check(`warm endpoint for "${model || '(none)'}"`, got === want, `got ${got}`);
}
// The swap must not fire on a URL that is not a generate endpoint.
check('non-generate endpoint left alone',
      warmEndpointFor('wan') !== '' && !warmEndpointFor('wan').includes('-generate-'));

// Batched images. With storage unconfigured these must survive untouched —
// the oversize guard downstream is what catches a batch too big to return.
{
  const four = { kind: 'image', images: Array.from({ length: 4 }, () => (
    { base64: Buffer.alloc(1000, 0x61).toString('base64'), mimeType: 'image/webp' })) };
  const got = await persistImageResult(four);
  check('batch of 4 passes through without storage',
        got.images.length === 4 && got.images.every((i) => i.base64));
  check('batch reports it is not stored', got.stored === false);
}
{
  const hosted = { kind: 'image', images: [{ url: 'https://cdn/x.webp', mimeType: 'image/webp' }] };
  check('already-hosted images are left alone', (await persistImageResult(hosted)) === hosted);
}
{
  const vid = { kind: 'video', videoUrl: 'https://cdn/v.mp4' };
  check('video is not touched by the image path', (await persistImageResult(vid)) === vid);
}

// Async job endpoints. All four functions live on the same Modal app and
// differ only in the last URL segment.
for (const [fn, want] of [
  ['generate', 'https://ic4pi--wan-video-generate.modal.run'],
  ['warm',     'https://ic4pi--wan-video-warm.modal.run'],
  ['submit',   'https://ic4pi--wan-video-submit.modal.run'],
  ['result',   'https://ic4pi--wan-video-result.modal.run'],
]) {
  const got = modalEndpoint('wan2.2-5b', fn);
  check(`${fn} endpoint`, got === want, `got ${got}`);
}

// Length maps to whole ~5s clips, clamped to what the apps accept.
for (const [secs, want] of [[5,1],[10,2],[30,6],[60,6],[0,1],[undefined,1]]) {
  check(`${secs}s -> ${want} clip(s)`, clipsForSeconds(secs) === want,
        `got ${clipsForSeconds(secs)}`);
}

// Each model has its own native geometry; sending Wan's to LTX (or the
// reverse) produces frame counts the transformer rejects.
{
  const wan = videoGeometry('wan2.2-5b');
  check('wan geometry', wan.width === 832 && wan.fps === 16 && wan.num_frames === 81);
  const ltx = videoGeometry('ltx-video');
  check('ltx geometry', ltx.width === 704 && ltx.fps === 24 && ltx.num_frames === 121);
  const custom = videoGeometry('wan2.2-5b', '480x832');
  check('explicit size wins', custom.width === 480 && custom.height === 832);
}

console.log(failed ? `\n${failed} failing` : '\nall passing');
process.exit(failed ? 1 : 0);
