/**
 * Brand automation: each brand can run itself on a schedule (off/daily/weekly).
 * The cron checks isAutomationDue() for every brand and runs each due one
 * through the same standing-task engine a manual job uses — same brief, same
 * house rules, same MISSING TOOL honesty, same draft-and-approve limits.
 *
 * State (schedule, last run, failures) lives in agency-control so this file
 * stays pure and testable. Guardrails mirror the rest of the agency: the
 * kill switch stops it, daily caps count it, and a brand that keeps failing
 * turns its own automation off instead of burning credits every run.
 */

import { businessBlock } from './business-profile.js';

export const AUTOMATION_MS = { daily: 86_400_000, weekly: 7 * 86_400_000 };
export const AUTO_MAX_FAILS = 5;

/** Is this brand's automation due to run right now? 'off' (or garbage) never is. */
export function isAutomationDue(entry, now = Date.now()) {
  const ms = AUTOMATION_MS[entry?.every];
  if (!ms) return false;
  if (!entry.lastRunAt) return true;   // switched on, never ran → due on the next cron tick
  const last = Date.parse(entry.lastRunAt);
  return Number.isNaN(last) || now - last >= ms;
}

/**
 * The task one automated run executes. The brand's real profile, offers and
 * strategy go straight into the objective: the team reads Semantiq's profile
 * unprompted, but any other brand has to be handed its own.
 */
export function buildBrandTask(brand, business, every = 'daily') {
  const when = every === 'weekly' ? 'weekly' : 'daily';
  const block = businessBlock(business);
  const objective = [
    `This is ${business.brandName}'s automated ${when} work session — the team runs this brand with nobody watching. Do the actual work, not a description of work that could be done.`,
    '',
    `1. Check what changed: new leads that need a reply drafted, deploy or build problems, and the latest numbers (sales, search rankings) whenever those tools are connected.`,
    `2. Do ${when === 'weekly' ? "this week's" : "today's"} marketing for ${business.brandName}: decide what should go out next and write it — drafts only. Nothing is emailed or posted by this session; the owner approves anything that goes out.`,
    `3. If a concrete code change to one of the owner's repos would clearly help and GitHub is connected, propose it as FILE: blocks so a pull request opens for the owner to merge.`,
    `4. End with a short "For the owner" list: what you did, what needs his tap, and what you could not do (name the missing tool).`,
    ...(block ? ['', block] : []),
  ].join('\n');
  return {
    id: `auto-${brand.id}`,
    name: `${business.brandName} — automated ${when} work`,
    objective,
    schedule: 'manual',
    enabled: true,
    assignments: {},
    personaIds: [],
    leadPersonaId: '',
  };
}
