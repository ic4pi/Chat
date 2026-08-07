/**
 * Regression tests for Workspace file-tree listing (no sandbox required).
 * Run: node scripts/test-file-tree.mjs
 */
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import {
  buildTreeFromEntries,
  parseFindTreeOutput,
  countTreeFiles,
  shouldHideRelPath,
  normalizeGitUrl,
} from '../lib/sandbox-api/file-tree.js';

assert.equal(
  normalizeGitUrl('https://github.com/ic4pi/Chat.git'),
  normalizeGitUrl('git@github.com:ic4pi/Chat'),
);
assert.equal(
  normalizeGitUrl('https://github.com/ic4pi/Chat/'),
  normalizeGitUrl('https://github.com/ic4pi/Chat'),
);

assert.equal(shouldHideRelPath('public/agent/assets/x.js'), true);
assert.equal(shouldHideRelPath('.env'), true);
assert.equal(shouldHideRelPath('.env.example'), false);
assert.equal(shouldHideRelPath('lib/auth.js'), false);

const synthetic = buildTreeFromEntries([
  { rel: 'api', type: 'dir' },
  { rel: 'api/chat.js', type: 'file', size: 1 },
  { rel: 'README.md', type: 'file', size: 2 },
]);
assert.equal(synthetic.find((n) => n.name === 'api')?.children?.[0]?.path, 'api/chat.js');
assert.equal(countTreeFiles(synthetic), 2);

const PRUNE = [
  "-name '.git'",
  "-name 'node_modules'",
  "-name 'dist'",
  "-name 'build'",
  "-name '.next'",
  "-name 'coverage'",
  "-name '__pycache__'",
  "-name '.cache'",
  "-name '.vercel'",
].join(' -o ');

const raw = execSync(
  `find /workspace -mindepth 1 -maxdepth 6 \\( ${PRUNE} \\) -prune -o \\( -type d -printf 'd\\t%P\\t0\\n' -o -type f -printf 'f\\t%P\\t%s\\n' \\) 2>/dev/null | head -n 8000`,
  { encoding: 'utf8', maxBuffer: 10_000_000 },
);
const tree = buildTreeFromEntries(parseFindTreeOutput(raw), { maxDepth: 6 });
const total = countTreeFiles(tree);
assert.ok(total > 50, `expected full workspace tree, got ${total}`);
const lib = tree.find((n) => n.name === 'lib');
assert.ok(lib, 'lib/ missing');
assert.equal(
  lib.children?.find((c) => c.name === 'auth.js')?.path,
  'lib/auth.js',
);

console.log(`ok — file-tree (${total} files, nested paths correct)`);
