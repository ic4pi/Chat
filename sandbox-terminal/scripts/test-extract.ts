/**
 * Unit checks for File: block parsing + work-request detection.
 * Run: node --experimental-strip-types scripts/test-extract.ts
 */
import { extractFileChanges, looksLikeWorkRequest } from '../src/agentParse.ts';

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
assert(!looksLikeWorkRequest('what is a closure?'), 'ignores pure question');

if (failed) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log('\nAll extract tests passed.');
