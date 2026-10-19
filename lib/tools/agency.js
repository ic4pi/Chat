// Agency tools: /agency (see the firms and seats) and /ask (talk to a seat).
import { llm, WRITER_MODEL } from '../hub.js';
import { listAgencyIds, resolveAgency, runSeat } from '../agencies.js';
import { clientContext, pipes } from './util.js';

const agency = {
  name: 'agency', group: 'Agency',
  summary: 'List agencies, or show who sits where and what tools each seat has.',
  usage: '/agency   ·   /agency marketing',
  async run({ args }) {
    const id = args.trim().toLowerCase();
    if (!id) {
      const all = await listAgencyIds();
      return { text: all.map((a) => `- \`${a.id}\` **${a.name}** — ${a.description}`).join('\n') + '\n\n`/agency marketing` shows the seats · `/ask marketing | goal` talks to the lead.' };
    }
    const a = await resolveAgency(id);
    return { text: `**${a.name}** — ${a.description}\n\n${a.seats.map((s) => `- \`${s.id}\` **${s.persona?.name || `⚠ ${s.personaRef} (not set up)`}** — ${s.description}\n  tools: ${s.tools.map((t) => '/' + t).join(' ')}`).join('\n')}\n\n_Playbook:_ ${a.playbook}` };
  },
};

const ask = {
  name: 'ask', group: 'Agency',
  summary: 'Give a request to an agency seat. The seat uses its own persona, role, playbook and tools.',
  usage: '/ask marketing/copywriter | write 3 hooks for @acme   ·   /ask marketing | plan a launch (goes to the lead)',
  async run({ args, client, registry }) {
    const [target, ...rest] = pipes(args);
    const request = rest.join(' | ');
    if (!target || !request) throw new Error('Usage: /ask agency/role | request  (see /agency)');
    const [agencyId, roleId] = target.toLowerCase().split('/');
    const text = await runSeat({
      agencyId, roleId, request, client, registry,
      clientContext: await clientContext(client),
      llm: (a) => llm(a), model: WRITER_MODEL,
    });
    return { text };
  },
};

export default [agency, ask];
