// "---\nkey: value\n---\nbody" parser shared by personas/, roles/ and agencies/.
// Values: plain text, [a, b] lists, or a=b, c=d maps.
export function parseFrontmatter(raw) {
  const text = String(raw).replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const fm = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  const meta = {};
  if (!fm) return { meta, body: text.trim() };
  for (const line of fm[1].split('\n')) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const v = kv[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    if (/^\[.*\]$/.test(v)) meta[kv[1]] = v.slice(1, -1).split(',').map((x) => x.trim()).filter(Boolean);
    else if (/^[\w-]+=[^=]+(,\s*[\w-]+=.+)*$/.test(v)) meta[kv[1]] = Object.fromEntries(v.split(',').map((p) => { const i = p.indexOf('='); return [p.slice(0, i).trim(), p.slice(i + 1).trim()]; }));
    else meta[kv[1]] = v;
  }
  return { meta, body: fm[2].trim() };
}
