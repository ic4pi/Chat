/**
 * Brands: the app runs more than one business. Each brand has its own profile, offers, strategy notes,
 * social accounts and — through its `kind` — its own goal, post formats and tone of voice.
 *
 *   semantiq  agency   websites, SEO and marketing for small businesses (the original brand; its data lives
 *                      where it always did, so nothing about it changes)
 *   swearjar  comedy   a stand-up comedy production company, 6-7 performers
 *   capicapi  comedy   one of those performers (parentId: swearjar, so it also reads the company's profile)
 *   ic4pi     dev      software development
 *
 * No imports: this file is read by config, autopost and the business profile alike.
 */

export const DEFAULT_BRAND = 'semantiq';

export const BRANDS = [
  { id: 'semantiq', name: 'Semantiq', kind: 'agency' },
  { id: 'swearjar', name: 'Swear Jar', kind: 'comedy' },
  { id: 'capicapi', name: 'Capí Capí', kind: 'comedy', parentId: 'swearjar', uncensored: true },   // the only brand written by an uncensored model
  { id: 'ic4pi', name: 'Ic4pI', kind: 'dev' },
];
export const BRAND_IDS = BRANDS.map((b) => b.id);

export function brandById(id) {
  return BRANDS.find((b) => b.id === id) || BRANDS[0];
}
export const isBrandId = (id) => BRAND_IDS.includes(id);
export const normalizeBrandId = (id) => (isBrandId(id) ? id : DEFAULT_BRAND);

/** Added to every autopost of a brand, whatever the account's own focus text says. */
export const GOALS = {
  agency:
    'THE GOAL OF EVERY POST: win customers for this business (websites, SEO and marketing for small businesses). Each post must make a business owner want to take the next step, so end with ONE clear call to action using the contact details and free site check from the business profile. '
    + 'Roughly two out of three posts should name a specific offer from the offers list with its real price and who it is for; the rest build trust with a genuinely useful tip that still ends with the call to action. '
    + 'Be confident and direct, never pushy; no hype or buzzwords; never invent clients, results, statistics, guarantees or prices.',
  comedy:
    'THE GOAL OF EVERY POST: grow the audience and fill seats for the live shows. Post things that make people laugh and want to come: a short original bit or observation in this brand\'s own voice, a show announcement, a performer spotlight, or a behind-the-scenes moment. '
    + 'When the briefing lists upcoming shows (dates, venues, ticket links), roughly one post in three promotes one of them with its real details and a clear way to get tickets; otherwise invite people to follow for the next show. '
    + 'Never invent show dates, venues, ticket prices, lineups, quotes or reviews. Never write a sales pitch for websites, SEO or marketing services. Be funny first: specific and observational, never generic.',
  dev:
    'THE GOAL OF EVERY POST: win software development clients and show the work. Post specific, useful engineering insight or a concrete showcase of what was built, ending with ONE clear call to action using the contact details in the briefing. '
    + 'Never invent clients, results, statistics, guarantees or prices; no hype or buzzwords. Never pitch websites for small businesses or comedy shows.',
};

export const FORMATS = {
  agency: [
    'offer spotlight (one offer from the list, its real price, who it is for, what they get)',
    'problem → fix → call to action', 'invitation to the free site check',
    'objection answer ("I already have Facebook", "websites are expensive", "does SEO really work")',
    'local SEO quick win that ends with the matching offer', 'website insight (what to ask a developer, costs, timelines, mistakes)',
    'myth vs. fact', 'checklist that ends with an offer', 'short lesson from a common mistake',
  ],
  comedy: [
    'a short original bit (setup and punchline) in the brand\'s voice', 'show announcement using only the real show details in the briefing',
    'performer spotlight', 'observational one-liner', 'behind-the-scenes moment', 'callback or running joke',
    'invitation to follow for the next show',
  ],
  dev: [
    'build log (what was built and the hard part)', 'engineering lesson from a real problem', 'before/after of a refactor or fix',
    'tool or technique worth knowing', 'project showcase with a call to action', 'myth vs. fact in software',
  ],
};

const BRIEFS = {
  agency:
    'Sell Semantiq\'s services to small business owners: websites, SEO and marketing. Lead with a pain they feel (no website, not showing up on Google, a site that gets no calls), show how our offer fixes it, and ask for the next step. Useful tips are welcome when they lead to an offer.',
  comedy:
    'Grow the audience for these live comedy shows: post funny original material and show promotion in the brand\'s voice from the briefing.',
  dev:
    'Win software development clients: concise engineering insight and project showcases that end with a call to action.',
};

export const brandGoal = (kind) => GOALS[kind] || GOALS.agency;
export const brandFormats = (kind) => FORMATS[kind] || FORMATS.agency;
export const brandBrief = (brandId) => BRIEFS[brandById(brandId).kind] || BRIEFS.agency;

/** What the brand's "offers" box means. Stored in the same field; only its heading and the Team page label differ. */
export const OFFERS_LABEL = {
  agency: 'WHAT WE SELL AND AT WHAT PRICE (authoritative — quote only these, never invent a price or a package):',
  comedy: 'UPCOMING SHOWS: DATES, VENUES AND TICKET LINKS (authoritative — mention only these, never invent a date, venue, price or lineup):',
  dev: 'WHAT WE BUILD AND AT WHAT PRICE (authoritative — quote only these, never invent a price or a package):',
};
export const offersLabel = (kind) => OFFERS_LABEL[kind] || OFFERS_LABEL.agency;

/** Starting text for the non-default brands, using only what is known. Edit it on the Team page; a saved value (even empty) wins. */
export const BRAND_DEFAULTS = {
  swearjar: {
    profile: 'Swear Jar is a stand-up comedy production company. It puts together live comedy shows, and six or seven comedians perform under it. Capí Capí is one of those performers.',
    offers: '',
  },
  capicapi: {
    profile: 'Capí Capí is a stand-up comedian and one of the performers under the Swear Jar production company.',
    offers: '',
  },
  ic4pi: {
    profile: 'Ic4pI is a software development brand.',
    offers: '',
  },
};
