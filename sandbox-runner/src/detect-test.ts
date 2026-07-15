/**
 * detect-test.ts — infer the test command for a repo by inspecting its
 * project files. Checks in priority order:
 *   1. package.json (scripts.test / scripts.check / scripts.test:*)
 *   2. pyproject.toml ([tool.pytest], [build-system] → pytest)
 *   3. requirements.txt + test directory → pytest
 *   4. Cargo.toml → cargo test
 *   5. go.mod → go test ./...
 *   6. Makefile with a "test" target → make test
 *   7. No test file found → null
 */

import * as fs   from 'fs';
import * as path from 'path';

export interface DetectedTest {
  command:    string | null;
  source:     string | null;
  confidence: 'detected' | 'guessed' | 'none';
  note?:      string;
}

function exists(p: string): boolean {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function read(p: string): string {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

// ---------------------------------------------------------------------------
// package.json
// ---------------------------------------------------------------------------

function detectFromPackageJson(root: string): DetectedTest | null {
  const pkgPath = path.join(root, 'package.json');
  if (!exists(pkgPath)) return null;

  let pkg: { scripts?: Record<string, string> };
  try { pkg = JSON.parse(read(pkgPath)); } catch { return null; }

  const scripts = pkg.scripts ?? {};

  // Prefer explicit "test" script
  if (scripts['test']) {
    const cmd = scripts['test'];
    // Avoid "echo" or "exit 1" placeholder scripts
    if (!cmd.startsWith('echo') && !cmd.includes('exit 1')) {
      return { command: 'npm test', source: 'package.json scripts.test', confidence: 'detected', note: cmd };
    }
  }

  // Look for any script whose key includes "test"
  const testKeys = Object.keys(scripts).filter(k =>
    k.includes('test') || k === 'check' || k === 'validate'
  );
  if (testKeys.length > 0) {
    const key = testKeys[0]!;
    return { command: `npm run ${key}`, source: `package.json scripts.${key}`, confidence: 'detected', note: scripts[key] };
  }

  // Infer from devDependencies
  const raw = read(pkgPath);
  if (raw.includes('"jest"') || raw.includes('"vitest"') || raw.includes('"mocha"')) {
    return { command: 'npm test', source: 'package.json (test framework detected)', confidence: 'guessed' };
  }

  return null;
}

// ---------------------------------------------------------------------------
// pyproject.toml  (no TOML parser dep — use regex)
// ---------------------------------------------------------------------------

function detectFromPyproject(root: string): DetectedTest | null {
  const p = path.join(root, 'pyproject.toml');
  if (!exists(p)) return null;
  const content = read(p);

  // Explicit test command in [tool.taskipy] or [tool.poe.tasks]
  const taskMatch = content.match(/\btest\s*=\s*["']([^"']+)["']/);
  if (taskMatch) {
    return { command: taskMatch[1]!, source: 'pyproject.toml task', confidence: 'detected' };
  }

  // pytest configured
  if (content.includes('[tool.pytest') || content.includes('pytest')) {
    return { command: 'python3 -m pytest -v', source: 'pyproject.toml (pytest)', confidence: 'detected' };
  }

  // hatch
  if (content.includes('[tool.hatch')) {
    return { command: 'hatch test', source: 'pyproject.toml (hatch)', confidence: 'guessed' };
  }

  return { command: 'python3 -m pytest -v', source: 'pyproject.toml (inferred)', confidence: 'guessed' };
}

// ---------------------------------------------------------------------------
// requirements.txt + test files
// ---------------------------------------------------------------------------

function detectFromRequirements(root: string): DetectedTest | null {
  if (!exists(path.join(root, 'requirements.txt')) &&
      !exists(path.join(root, 'setup.py')) &&
      !exists(path.join(root, 'setup.cfg'))) return null;

  // Look for test files
  const hasTests = ['tests', 'test'].some(d => exists(path.join(root, d))) ||
    (fs.readdirSync(root).some(f => f.startsWith('test_') && f.endsWith('.py')));

  if (hasTests) {
    return { command: 'python3 -m pytest -v', source: 'requirements.txt + test files', confidence: 'detected' };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Cargo.toml
// ---------------------------------------------------------------------------

function detectFromCargo(root: string): DetectedTest | null {
  if (!exists(path.join(root, 'Cargo.toml'))) return null;
  return { command: 'cargo test', source: 'Cargo.toml', confidence: 'detected' };
}

// ---------------------------------------------------------------------------
// go.mod
// ---------------------------------------------------------------------------

function detectFromGoMod(root: string): DetectedTest | null {
  if (!exists(path.join(root, 'go.mod'))) return null;
  return { command: 'go test ./...', source: 'go.mod', confidence: 'detected' };
}

// ---------------------------------------------------------------------------
// Makefile
// ---------------------------------------------------------------------------

function detectFromMakefile(root: string): DetectedTest | null {
  const p = path.join(root, 'Makefile');
  if (!exists(p)) return null;
  const content = read(p);
  if (/^test\s*:/m.test(content) || /^\.PHONY.*test/m.test(content)) {
    return { command: 'make test', source: 'Makefile', confidence: 'detected' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function detectTestCommand(root: string): DetectedTest {
  const detectors = [
    detectFromPackageJson,
    detectFromPyproject,
    detectFromRequirements,
    detectFromCargo,
    detectFromGoMod,
    detectFromMakefile,
  ];

  for (const detect of detectors) {
    const result = detect(root);
    if (result) return result;
  }

  return { command: null, source: null, confidence: 'none' };
}
