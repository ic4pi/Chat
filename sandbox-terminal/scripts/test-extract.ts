/**
 * Unit checks for File: block parsing + work-request detection.
 * Run: node --experimental-strip-types scripts/test-extract.ts
 */
import {
  extractFileChangeReport,
  extractFileChanges,
  extractFilesForApply,
  formatRejectedSandboxWarning,
  looksLikeApplyRequest,
  looksLikeIncompleteFileContent,
  looksLikeWorkRequest,
  promoteBareFencesToFiles,
} from '../src/agentParse.ts';

let failed = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg);
    failed++;
  } else {
    console.log('ok:', msg);
  }
}

const basic = extractFileChanges(
  'Done.\n\nFile: src/a.ts\n```ts\nexport const x = 1;\n```\n',
);
assert(basic.length === 1 && basic[0]!.path === 'src/a.ts' && basic[0]!.content.includes('x = 1'), 'basic File: block');

const bold = extractFileChanges(
  '**File: lib/b.js**\n```js\nmodule.exports = 2;\n```',
);
assert(bold.length === 1 && bold[0]!.path === 'lib/b.js', 'markdown-bold File: marker');

const blank = extractFileChanges(
  'File: c.py\n\n```python\nprint(1)\n```',
);
assert(blank.length === 1 && blank[0]!.path === 'c.py', 'blank line before fence');

const crlf = extractFileChanges(
  'File: d.txt\r\n```\r\nhello\r\n```',
);
assert(crlf.length === 1 && crlf[0]!.path === 'd.txt' && crlf[0]!.content.includes('hello'), 'CRLF File: block');

const none = extractFileChanges('I will implement better error handling next.');
assert(none.length === 0, 'planning prose yields no changes');

assert(looksLikeWorkRequest('fix the auth bug'), 'detects fix request');
assert(looksLikeWorkRequest('build a todo app'), 'detects build request');
assert(looksLikeApplyRequest('write a hello world html page'), 'detects write a…');
assert(looksLikeApplyRequest('write me a todo app'), 'detects write me…');
assert(looksLikeApplyRequest('code a landing page'), 'detects code a…');
assert(looksLikeApplyRequest('make a button that counts'), 'detects make a…');
assert(looksLikeApplyRequest('generate an index.html'), 'detects generate…');
assert(looksLikeApplyRequest('apply this'), 'detects apply this');
assert(!looksLikeWorkRequest('what is a closure?'), 'ignores pure question');
assert(!looksLikeApplyRequest('suggest improvements'), 'suggest stays suggest');
assert(
  looksLikeApplyRequest('suggest improvements then apply this'),
  'suggest + apply this still applies',
);

const bareHtml = extractFilesForApply(
  'Sure — here is a page:\n\n```html\n<!doctype html>\n<html><head><title>Hi</title></head><body><h1>Hello</h1></body></html>\n```\n',
  { promoteBare: true },
);
assert(
  bareHtml.accepted.length === 1 && bareHtml.accepted[0]!.path === 'index.html',
  'promotes bare html fence to index.html',
);

const bareTrio = extractFilesForApply(
  '```html\n<!doctype html><title>App</title>\n```\n```css\nbody { margin: 0 }\n```\n```js\nconsole.log(1)\n```\n',
  { promoteBare: true },
);
assert(
  bareTrio.accepted.length === 3
    && bareTrio.accepted.some(f => f.path === 'index.html')
    && bareTrio.accepted.some(f => f.path === 'styles.css')
    && bareTrio.accepted.some(f => f.path === 'app.js'),
  'promotes html/css/js trio',
);

const noPromoteWhenFile = promoteBareFencesToFiles(
  'File: real.html\n```html\n<!doctype html><title>X</title>\n```\n```css\nbody{}\n```',
  extractFileChangeReport(
    'File: real.html\n```html\n<!doctype html><title>X</title>\n```\n```css\nbody{}\n```',
  ),
);
assert(
  noPromoteWhenFile.accepted.length === 1 && noPromoteWhenFile.accepted[0]!.path === 'real.html',
  'does not invent paths when File: already present',
);

const stub = `// ... existing imports ...\n\nfunction budgetMessages() {}\n// Then in handler:\n`;
assert(looksLikeIncompleteFileContent(stub, 'api/agent-chat.js'), 'flags incomplete patch stub');
assert(
  extractFileChanges(`File: api/agent-chat.js\n\`\`\`js\n${stub}\`\`\``).length === 0,
  'extract drops incomplete api stub',
);
assert(
  !looksLikeIncompleteFileContent(
    'export default async function handler(req, res) {\n  return res.status(200).end();\n}\n'.repeat(5),
    'api/agent-chat.js',
  ),
  'accepts complete api handler',
);

const report = extractFileChangeReport(
  `File: api/agent-chat.js\n\`\`\`js\n${stub}\`\`\`\n\nFile: src/ok.ts\n\`\`\`ts\nexport const ok = 1;\n\`\`\`\n`,
);
assert(report.accepted.length === 1 && report.accepted[0]!.path === 'src/ok.ts', 'report keeps good files');
assert(report.rejected.length === 1 && report.rejected[0]!.path === 'api/agent-chat.js', 'report lists rejected stubs');
const warn = formatRejectedSandboxWarning(report.rejected);
assert(warn.includes('SANDBOX PROTECTED') && warn.includes('api/agent-chat.js'), 'loud reject warning');

if (failed) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log('\nAll extract tests passed.');
