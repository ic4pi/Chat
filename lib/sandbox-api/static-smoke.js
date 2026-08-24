/**
 * Shared static-site smoke check used by detect-test-command and git-push.
 * Catches the "ugly broken review site shipped with no tests" failure mode:
 * missing index.html, empty title, broken local asset links.
 */

/** Must stay a single shell-safe line (no raw newlines inside -e). */
export const STATIC_SMOKE_COMMAND =
  "node --input-type=module -e " +
  JSON.stringify(
    [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "import { execSync } from 'node:child_process';",
      "function fail(m){ console.error('SMOKE FAIL:', m); process.exit(1); }",
      "const root = process.cwd();",
      "const index = ['index.html','index.htm','public/index.html','dist/index.html'].map(p => path.join(root, p)).find(p => fs.existsSync(p));",
      "if (!index) fail('no index.html (or public/dist/index.html) — site has no entry page');",
      "const html = fs.readFileSync(index, 'utf8');",
      "if (html.trim().length < 80) fail('index.html is nearly empty');",
      "if (!/<html[\\s>]/i.test(html)) fail('index.html missing <html>');",
      "const title = html.match(/<title[^>]*>([^<]*)<\\/title>/i);",
      "if (!title || !title[1].trim() || /untitled|document/i.test(title[1].trim())) fail('index.html needs a real <title> (not empty/Untitled)');",
      "const baseDir = path.dirname(index);",
      "const hrefs = [...html.matchAll(/(?:href|src)=[\"']([^\"']+)[\"']/gi)].map(m => m[1]);",
      "const missing = [];",
      "for (const href of hrefs) {",
      "  if (!href || /^(https?:|data:|mailto:|tel:|#|\\/\\/)/i.test(href)) continue;",
      "  const clean = href.split('?')[0].split('#')[0];",
      "  if (!clean || clean.endsWith('/')) continue;",
      "  const abs = path.resolve(baseDir, clean);",
      "  if (!abs.startsWith(root)) continue;",
      "  if (!fs.existsSync(abs)) missing.push(href);",
      "}",
      "if (missing.length) fail('broken local asset links: ' + missing.slice(0, 8).join(', '));",
      "const scriptSrcs = [...html.matchAll(/<script[^>]+src=[\"']([^\"']+)[\"'][^>]*>/gi)].map(m => m[1]);",
      "const jsErrors = [];",
      "for (const src of scriptSrcs) {",
      "  if (/^(https?:|data:|\\/\\/)/i.test(src)) continue;",
      "  const clean = src.split('?')[0].split('#')[0];",
      "  if (!clean) continue;",
      "  const abs = path.resolve(baseDir, clean);",
      "  if (!abs.startsWith(root) || !fs.existsSync(abs)) continue;",
      "  try { execSync('node --check ' + JSON.stringify(abs), { stdio: 'pipe' }); }",
      "  catch (e) { jsErrors.push(src + ': ' + String(e.stderr || e.message || '').trim().split('\\n')[0]); }",
      "}",
      "if (jsErrors.length) fail('JS syntax error(s): ' + jsErrors.slice(0, 5).join(' | '));",
      "const text = html.replace(/<script[\\s\\S]*?<\\/script>/gi,' ').replace(/<style[\\s\\S]*?<\\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\\s+/g,' ').trim();",
      "if (text.length < 40) fail('page has almost no visible text — looks unfinished');",
      "console.log('SMOKE OK:', path.relative(root, index), '· title:', title[1].trim());",
    ].join(''),
  );

export async function hasStaticEntry(sandbox, repoDir, fileExists) {
  for (const p of ['index.html', 'index.htm', 'public/index.html', 'dist/index.html']) {
    if (await fileExists(sandbox, p)) return true;
  }
  try {
    const r = await sandbox.runCommand({
      cmd: 'bash',
      args: ['-lc', `ls -1 "${repoDir}"/*.html 2>/dev/null | head -1`],
    });
    const out = String(await r.stdout() || '').trim();
    return !!out;
  } catch {
    return false;
  }
}
