/**
 * GET /api/detect-test-command
 * Reads project files from the sandbox repo to detect the test command.
 * Static HTML sites (review pages, landing pages) get a built-in smoke check
 * so Auto-test / Push never run with "no tests → allow".
 */

import { requireSession, REPO_DIR } from '../sandbox-session.js';
import { STATIC_SMOKE_COMMAND, hasStaticEntry } from './static-smoke.js';

async function readFile(sandbox, relPath) {
  try {
    const result = await sandbox.runCommand({ cmd: 'cat', args: [`${REPO_DIR}/${relPath}`] });
    if (result.exitCode !== 0) return null;
    return (await result.stdout());
  } catch { return null; }
}

async function fileExists(sandbox, relPath) {
  const result = await sandbox.runCommand({ cmd: 'test', args: ['-f', `${REPO_DIR}/${relPath}`] });
  return result.exitCode === 0;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const sandbox = await requireSession(req);

    // package.json
    const pkgRaw = await readFile(sandbox, 'package.json');
    if (pkgRaw) {
      try {
        const pkg = JSON.parse(pkgRaw);
        const scripts = pkg.scripts ?? {};
        // Prefer a fast contract check over heavy/domain-specific scripts
        // (e.g. test:animate) so Auto-test and pre-push catch API breaks.
        if (scripts.check && !scripts.check.startsWith('echo') && !scripts.check.includes('exit 1')) {
          return res.json({ command: 'npm run check', source: 'package.json scripts.check', confidence: 'detected', note: scripts.check });
        }
        if (scripts.test && !scripts.test.startsWith('echo') && !scripts.test.includes('exit 1')) {
          return res.json({ command: 'npm test', source: 'package.json scripts.test', confidence: 'detected', note: scripts.test });
        }
        const testKey = Object.keys(scripts).find(k =>
          (k === 'check' || k.includes('test')) && !k.includes('animate'),
        );
        if (testKey) {
          return res.json({ command: `npm run ${testKey}`, source: `package.json scripts.${testKey}`, confidence: 'detected' });
        }
      } catch { /* parse failed */ }
    }

    // pyproject.toml
    const pyRaw = await readFile(sandbox, 'pyproject.toml');
    if (pyRaw) {
      if (pyRaw.includes('[tool.pytest') || pyRaw.includes('pytest')) {
        return res.json({ command: 'python3 -m pytest -v', source: 'pyproject.toml', confidence: 'detected' });
      }
      return res.json({ command: 'python3 -m pytest -v', source: 'pyproject.toml (inferred)', confidence: 'guessed' });
    }

    // Cargo.toml
    if (await fileExists(sandbox, 'Cargo.toml')) {
      return res.json({ command: 'cargo test', source: 'Cargo.toml', confidence: 'detected' });
    }

    // go.mod
    if (await fileExists(sandbox, 'go.mod')) {
      return res.json({ command: 'go test ./...', source: 'go.mod', confidence: 'detected' });
    }

    // Makefile
    const mkRaw = await readFile(sandbox, 'Makefile');
    if (mkRaw && /^test\s*:/m.test(mkRaw)) {
      return res.json({ command: 'make test', source: 'Makefile', confidence: 'detected' });
    }

    // Static / review websites — always have a smoke check so Push can gate.
    if (await hasStaticEntry(sandbox, REPO_DIR, fileExists)) {
      return res.json({
        command: STATIC_SMOKE_COMMAND,
        source: 'built-in static HTML smoke',
        confidence: 'guessed',
        note: 'Checks index.html title, structure, and local asset links',
      });
    }

    return res.json({ command: null, source: null, confidence: 'none' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
