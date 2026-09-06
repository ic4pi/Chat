/**
 * Verifies the chat -> media handoff reads every response shape
 * /api/media-generate actually returns. Run: node scripts/check-media-extract.mjs
 *
 * Each case below is copied from a real `return {...}` in api/media-generate.js;
 * the line reference is where that shape is produced.
 */
import { __test } from '../api/hub/[route].js';

const { extractAsset, ORDER_BY_KIND } = __test;
const PNG = Buffer.from('fakepngbytes').toString('base64');

const cases = [
  {
    name: 'modal SDXL image (media-generate.js:1363)',
    input: { kind: 'image', provider: 'modal', model: 'lustify',
             images: [{ base64: PNG, mimeType: 'image/png' }] },
    expect: { bytes: true, url: null, mimeType: 'image/png' },
  },
  {
    name: 'modal Wan video, data URL (media-generate.js:1424)',
    input: { kind: 'video', provider: 'modal', model: 'wan2.2-5b',
             videoUrl: `data:video/mp4;base64,${PNG}`, mime: 'video/mp4' },
    expect: { bytes: true, url: null, mimeType: 'video/mp4' },
  },
  {
    name: 'modal LTX video, data URL',
    input: { kind: 'video', provider: 'modal', model: 'ltx-video',
             videoUrl: `data:video/mp4;base64,${PNG}` },
    expect: { bytes: true, url: null, mimeType: 'video/mp4' },
  },
  {
    name: 'cloudflare image, base64 (media-generate.js:643)',
    input: { kind: 'image', provider: 'cloudflare',
             images: [{ mimeType: 'image/jpeg', base64: PNG }] },
    expect: { bytes: true, url: null, mimeType: 'image/jpeg' },
  },
  {
    name: 'fal image, hosted url (media-generate.js:1078)',
    input: { kind: 'image', provider: 'fal',
             images: [{ mimeType: 'image/jpeg', url: 'https://cdn.fal/x.jpg' }] },
    expect: { bytes: false, url: 'https://cdn.fal/x.jpg', mimeType: 'image/jpeg' },
  },
  {
    name: 'cloudflare video, hosted url (media-generate.js:814)',
    input: { kind: 'video', provider: 'cloudflare', videoUrl: 'https://cf/v.mp4' },
    expect: { bytes: false, url: 'https://cf/v.mp4', mimeType: 'video/mp4' },
  },
  {
    name: 'base64 field that is itself a data URL',
    input: { kind: 'image', images: [{ base64: `data:image/webp;base64,${PNG}` }] },
    expect: { bytes: true, url: null, mimeType: 'image/webp' },
  },
  { name: 'empty response', input: {}, expect: null },
  { name: 'image kind with no images[]', input: { kind: 'image', images: [] }, expect: null },
];

let failed = 0;
for (const c of cases) {
  const got = extractAsset(c.input);
  let ok;
  if (c.expect === null) {
    ok = got === null;
  } else {
    ok = !!got
      && (c.expect.bytes ? Buffer.isBuffer(got.bytes) && got.bytes.length > 0 : got.bytes === null)
      && got.url === c.expect.url
      && got.mimeType === c.expect.mimeType;
  }
  if (!ok) { failed++; console.error(`FAIL  ${c.name}\n      got ${JSON.stringify(got)}`); }
  else console.log(`ok    ${c.name}`);
}

// The old ORDER pointed at venice, which commit 520810f removed from the picker.
const models = Object.values(ORDER_BY_KIND).flat().map((t) => `${t.provider}:${t.model}`);
if (models.some((m) => m.startsWith('venice'))) {
  failed++; console.error('FAIL  provider order still references venice');
} else console.log(`ok    provider order: ${models.join(', ')}`);

console.log(failed ? `\n${failed} failing` : '\nall passing');
process.exit(failed ? 1 : 0);
