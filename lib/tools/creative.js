// Creative / tools: brand, variants, landing.
import { readCol, writeCol } from './store.js';
import { ask, pipes, splitSub, clientContext } from './util.js';

const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const brand = {
  name: 'brand', group: 'Creative',
  summary: 'Per-client brand kit. Add @slug to any other command and the kit is applied.',
  usage: '/brand set Acme | voice | audience | colors | dos/donts   ·   /brand show acme   ·   /brand list',
  async run({ args }) {
    const [sub, rest] = splitSub(args);
    const kits = await readCol('brand', {});
    if (sub === 'list' || !sub) {
      const names = Object.entries(kits).map(([slug, b]) => `- \`@${slug}\` ${b.name}`);
      return { text: names.length ? names.join('\n') : 'No brand kits yet. /brand set Name | voice | audience | colors | dos/donts' };
    }
    if (sub === 'show') {
      const b = kits[slugify(rest)];
      if (!b) throw new Error('No kit with that name. /brand list');
      return { text: Object.entries(b).map(([k, v]) => `**${k}**: ${v}`).join('\n') };
    }
    if (sub === 'set') {
      const [name, voice, audience, colors, rules] = pipes(rest);
      if (!name) throw new Error('Usage: /brand set Name | voice | audience | colors | dos/donts');
      const slug = slugify(name);
      kits[slug] = { ...(kits[slug] || {}), name, ...(voice && { voice }), ...(audience && { audience }), ...(colors && { colors }), ...(rules && { rules }), updatedAt: new Date().toISOString() };
      await writeCol('brand', kits);
      return { text: `Saved. Use it with \`@${slug}\` on any command.` };
    }
    if (sub === 'build') {
      const [name, ...desc] = pipes(rest);
      if (!name || !desc.length) throw new Error('Usage: /brand build Name | what they do and who for');
      const out = await ask('You are a brand strategist. Return ONLY a JSON object with string keys voice, audience, colors, rules, tagline.', desc.join(' '));
      let j; try { j = JSON.parse(out.replace(/```json|```/g, '').trim()); } catch { throw new Error('Brand builder returned unreadable output — try again.'); }
      const slug = slugify(name);
      kits[slug] = { name, ...Object.fromEntries(['voice', 'audience', 'colors', 'rules', 'tagline'].filter((k) => j[k]).map((k) => [k, String(j[k])])), updatedAt: new Date().toISOString() };
      await writeCol('brand', kits);
      return { text: `Built and saved as \`@${slug}\`:\n\n${Object.entries(kits[slug]).map(([k, v]) => `**${k}**: ${v}`).join('\n')}` };
    }
    throw new Error('Usage: /brand set | build | show | list');
  },
};

const variants = {
  name: 'variants', group: 'Creative',
  summary: 'N copy variants, each testing a different angle, ready for A/B.',
  usage: '/variants 5 | facebook ad | brief',
  async run({ args, client }) {
    const [n, format, ...brief] = pipes(args);
    const count = Math.min(Math.max(parseInt(n, 10) || 0, 2), 12);
    if (!count || !format || !brief.length) throw new Error('Usage: /variants 5 | format | brief');
    const out = await ask('You are a direct-response copywriter. Every variant tests a DIFFERENT angle (pain, desire, proof, curiosity, urgency, identity...). No filler.',
      `${await clientContext(client)}Format: ${format}\nBrief: ${brief.join(' | ')}\n\nWrite ${count} variants. For each: label the angle, the copy, and the hypothesis it tests. End with which two to launch first and why.`);
    return { text: out };
  },
};

const landing = {
  name: 'landing', group: 'Creative',
  summary: 'A complete deployable one-file landing page (HTML + CSS, mobile-first).',
  usage: '/landing @acme | offer, audience, CTA',
  async run({ args, client }) {
    if (!args.trim()) throw new Error('Usage: /landing brief');
    const out = await ask('You build high-converting landing pages. Output ONE complete HTML file in a single ```html block, inline CSS, no external deps except system fonts, mobile-first, semantic, fast, with a clear hero, proof, offer, FAQ and a single repeated CTA. No lorem ipsum — write real copy from the brief. After the block add 3 lines on what to test first.',
      `${await clientContext(client)}${args}`, { maxTokens: 6000 });
    return { text: out };
  },
};

export default [brand, variants, landing];
