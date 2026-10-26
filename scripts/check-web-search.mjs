// parseWebSearchRequest decides when a chat message triggers a live web search.
// It lives in public/app.js (browser module), so pull the function out and run it.
import fs from 'node:fs';
const src = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const a = src.indexOf('const SEARCH_WEB');
const b = src.indexOf('async function runInlineGroupDiscussion');
if (a < 0 || b < 0) { console.error('check-web-search: cannot find parseWebSearchRequest'); process.exit(1); }
const parse = new Function(`${src.slice(a, b)}; return parseWebSearchRequest;`)();

let bad = 0;
const eq = (input, want, prev = 'previous message') => {
  const got = parse(input, prev);
  const ok = want === null ? got === null : got === want;
  console.log(`${ok ? 'ok' : 'FAIL'}  ${JSON.stringify(input)} => ${JSON.stringify(got)}`);
  if (!ok) bad = 1;
};
eq('search the web for plumbers in ohio', 'plumbers in ohio');
eq('search for the best CRM for agencies', 'the best CRM for agencies');
eq('look up semantiq', 'semantiq');
eq('can you search the internet', 'previous message');
eq('google it', 'previous message');
eq('what is the latest on instagram algorithm changes', 'what is the latest on instagram algorithm changes');
eq('what time is it in tokyo right now', 'what time is it in tokyo right now');
eq('so you cant search the web?', 'previous message');
eq("so you can't search the web", 'previous message');
eq('are you able to search the internet?', 'previous message');
eq('how do I write a search algorithm', null);
eq('write me a caption for a coffee shop', null);
eq('what is a good marketing plan', null);
eq('explain how DNS works', null);
process.exit(bad);
