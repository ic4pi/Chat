// Chat -> Code Space handoff: the instruction is opt-in and names the marker the client looks for.
import { readFileSync } from 'node:fs';
import { CODE_SPACE_MARKER, codeSpaceHandoffInstruction } from '../lib/code-space-handoff.js';

let failed = 0;
const ok = (name, cond) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`); if (!cond) failed++; };

ok('nothing is injected unless the client asks', codeSpaceHandoffInstruction(undefined) === '' && codeSpaceHandoffInstruction(false) === '' && codeSpaceHandoffInstruction('yes') === '');
const text = codeSpaceHandoffInstruction(true);
ok('the instruction carries the exact marker', text.includes(CODE_SPACE_MARKER));
ok('the instruction says not to rush and to act when the user is ready', /never in a hurry/.test(text) && /ready to build, do it now/.test(text));
const chatApi = readFileSync(new URL('../api/chat.js', import.meta.url), 'utf8');
ok('/api/chat only adds it when codeSpaceHandoff is sent', /codeSpaceHandoffInstruction\(codeSpaceHandoff\)/.test(chatApi));
const client = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
ok('the client looks for the same marker', client.includes('<<<OPEN_CODE_SPACE>>>'));

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nall handoff checks passed');
