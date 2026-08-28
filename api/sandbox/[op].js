/**
 * Single Hobby-safe serverless entry for all sandbox/workspace routes.
 *
 * Vercel Hobby caps projects at 12 serverless functions. This repo had 19
 * api/*.js files, so the linked `chat` Hobby project failed every deploy
 * while `deviant` (Pro) succeeded — leaving production chat stuck on an
 * old build.
 *
 * External URLs stay the same via vercel.json rewrites → /api/sandbox/:op
 */

import run from '../../lib/sandbox-api/run.js';
import runCode from '../../lib/sandbox-api/run-code.js';
import initRepo from '../../lib/sandbox-api/init-repo.js';
import initBlank from '../../lib/sandbox-api/init-blank.js';
import files from '../../lib/sandbox-api/files.js';
import file from '../../lib/sandbox-api/file.js';
import writeFiles from '../../lib/sandbox-api/write-files.js';
import search from '../../lib/sandbox-api/search.js';
import detectTestCommand from '../../lib/sandbox-api/detect-test-command.js';
import gitPush from '../../lib/sandbox-api/git-push.js';
import previewStart from '../../lib/sandbox-api/preview-start.js';
import keepalive from '../../lib/sandbox-api/keepalive.js';

const OPS = {
  run,
  'run-code': runCode,
  'init-repo': initRepo,
  'init-blank': initBlank,
  files,
  file,
  'write-files': writeFiles,
  search,
  'detect-test-command': detectTestCommand,
  'git-push': gitPush,
  'preview-start': previewStart,
  keepalive,
};

export default async function handler(req, res) {
  // Dynamic route: /api/sandbox/:op  (also used via rewrites from /api/run etc.)
  const op = String(req.query?.op || '').trim();
  const fn = OPS[op];
  if (!fn) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(404).json({
      error: `Unknown sandbox op "${op || '(empty)'}". Expected run|run-code|init-repo|init-blank|files|file|write-files|search|detect-test-command|git-push|preview-start|keepalive`,
    });
  }
  return fn(req, res);
}
