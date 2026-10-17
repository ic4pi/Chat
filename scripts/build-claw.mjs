// Builds the single-file helper users download: claw/helper.src.mjs with the shared
// safety rules (lib/claw-risk.js) inlined. `--check` fails if the built file is stale.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const risk = fs.readFileSync(path.join(ROOT, 'lib/claw-risk.js'), 'utf8').replace(/^export /gm, '');
const src = fs.readFileSync(path.join(ROOT, 'claw/helper.src.mjs'), 'utf8');
if (!src.includes('// @@RISK@@')) throw new Error('helper.src.mjs lost its // @@RISK@@ marker');
const built = src.replace('// @@RISK@@', `// ── safety rules (inlined from lib/claw-risk.js; do not edit here) ──\n${risk}\n// ── end safety rules ──`);
const out = path.join(ROOT, 'public/claw/claw.mjs');

if (process.argv.includes('--check')) {
  const cur = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
  if (cur !== built) { console.error('public/claw/claw.mjs is out of date: run node scripts/build-claw.mjs'); process.exit(1); }
  console.log('claw helper build is up to date');
} else {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, built);
  fs.chmodSync(out, 0o755);
  console.log(`built ${path.relative(ROOT, out)} (${built.length} bytes)`);
}
