/**
 * Job tools router — decides which connected tools a job needs, gathers
 * their live context into the brief, and executes the follow-through
 * (a GitHub pull request) once the team has written its answer.
 *
 * Every tool reports honestly: connected tools are listed in the brief,
 * unconnected ones are named as MISSING TOOL so the team says so instead
 * of faking the data.
 */

import { githubConnected, getRepoContext, parseFileChanges, openPullRequest } from './tools-github.js';
import { vercelConnected, getDeployStatus } from './tools-vercel.js';
import { stripeConnected, getSalesSnapshot } from './tools-stripe.js';
import { gscConnected, getSearchSnapshot } from './tools-search-console.js';

export function toolsStatus() {
  return {
    github: githubConnected(),
    vercel: vercelConnected(),
    stripe: stripeConnected(),
    searchConsole: gscConnected(),
  };
}

/** "…on ic4pi/capixelate" or "repo owner/name" → owner/name. Deliberately
 *  conservative: bare "and/or" style slashes never match. */
export function detectRepo(text) {
  const explicit = String(text || '').match(/\brepo(?:sitory)?\s+([a-z0-9_.-]+\/[a-z0-9_.-]+)/i);
  const bare = explicit ? null : String(text || '').match(/\b([a-z0-9_.-]+\/[a-z0-9_.-]+)\b/i);
  const candidate = (explicit || bare)?.[1]?.replace(/[.,;]$/, '');
  if (!candidate || !/^[\w.-]+\/[\w.-]+$/.test(candidate)) return null;
  if (!candidate.split('/').every((part) => part.length >= 2)) return null;
  // Bare "x/y" must look like a real repo (digit, dot or hyphen in the name) —
  // everyday slashes like "and/or" never count. "repo x/y" is always trusted.
  if (!explicit && !/[0-9.-]/.test(candidate)) return null;
  return candidate;
}

const NEEDS = {
  vercel: /\b(deploy|vercel|build (failed|error)|site (is )?down|production)\b/i,
  stripe: /\b(sales?|revenue|selling|stripe|swear ?jar|income|customers? bought)\b/i,
  gsc: /\b(seo|rankings?|google search|search console|keywords?|impressions?|clicks?)\b/i,
};

/**
 * Live context + the tools roster for the brief. Never throws — a tool
 * that fails degrades to a note, not a failed job.
 */
export async function gatherJobContext(task) {
  const text = `${task.name || ''}\n${task.objective || ''}`;
  const status = toolsStatus();
  const repo = detectRepo(text);
  const sections = [];
  const missing = [];

  // ── GitHub: repo code context ──
  if (repo && status.github) {
    try {
      const ctx = await getRepoContext(repo);
      sections.push(
        `GitHub repo ${repo} (branch ${ctx.base}) — real files:\n` +
        ctx.files.map((f) => `--- ${f.path} ---\n${f.content}`).join('\n\n') +
        `\n--- full file list (${ctx.paths.length}) ---\n${ctx.paths.slice(0, 150).join(', ')}`
      );
    } catch (err) { sections.push(`GitHub repo ${repo}: could not read (${err.message}).`); }
  } else if (repo && !status.github) {
    missing.push('GitHub (to read and change the repo code)');
  }

  // ── Read-only snapshots, only when the job calls for them ──
  if (NEEDS.vercel.test(text)) {
    if (status.vercel) {
      try {
        const s = await getDeployStatus();
        sections.push(
          'Vercel deployments (live):\n' +
          s.deployments.map((d) => `- ${d.name}: ${d.state} (${d.url || 'no url'}, ${d.createdAt || '?'})`).join('\n') +
          (s.errorLog ? `\n\nLatest failure log tail:\n${s.errorLog}` : '')
        );
      } catch (err) { sections.push(`Vercel status unavailable: ${err.message}`); }
    } else missing.push('Vercel (to see deploy status and build logs)');
  }
  if (NEEDS.stripe.test(text)) {
    if (status.stripe) {
      try {
        const s = await getSalesSnapshot();
        sections.push(
          `Stripe sales, last ${s.days} days: ${s.count} charges, $${s.total} ${s.currency}\n` +
          s.recent.map((r) => `- $${r.amount} ${r.description} (${r.at})`).join('\n')
        );
      } catch (err) { sections.push(`Stripe snapshot unavailable: ${err.message}`); }
    } else missing.push('Stripe (to see real sales numbers)');
  }
  if (NEEDS.gsc.test(text)) {
    if (status.searchConsole) {
      try {
        const s = await getSearchSnapshot();
        sections.push(
          `Google Search Console for ${s.site} (${s.range}) — top queries:\n` +
          s.queries.map((q) => `- "${q.query}": ${q.clicks} clicks, ${q.impressions} impressions, position ${q.position}`).join('\n')
        );
      } catch (err) { sections.push(`Search Console unavailable: ${err.message}`); }
    } else missing.push('Google Search Console (for real ranking data)');
  }

  // ── The roster the team sees ──
  const connected = [];
  if (status.github) connected.push(repo
    ? `GitHub — repo ${repo} is read in below. To change code, output each changed file as:\nFILE: path/in/repo.ext\n\`\`\`\n<complete new file content>\n\`\`\`\nA pull request will be opened for the owner to merge. Never claim a PR exists unless one is reported back to you.`
    : 'GitHub — connected. Name a repo as owner/name in the job and its code will be read in.');
  if (status.vercel) connected.push('Vercel — deploy status and failure logs (read-only).');
  if (status.stripe) connected.push('Stripe — real sales figures (read-only).');
  if (status.searchConsole) connected.push('Google Search Console — real queries, clicks and positions (read-only).');

  const roster = [
    connected.length ? `Connected tools:\n${connected.map((c) => `- ${c}`).join('\n')}` : 'No external tools are connected for this job.',
    missing.length ? `NOT connected — if a step needs one of these, write "MISSING TOOL: <name>":\n${missing.map((m) => `- ${m}`).join('\n')}` : null,
  ].filter(Boolean).join('\n');

  const contextBlock = sections.length ? `Live context gathered for this job:\n\n${sections.join('\n\n')}` : '';
  return { repo, roster, contextBlock, missing };
}

/**
 * After the team answers: turn any FILE: blocks into a real pull request.
 * Returns { prUrl, filesCommitted, notes } — never throws; failure is a note.
 */
export async function executeFollowThrough(task, repo) {
  const notes = [];
  if (!repo) return { prUrl: null, filesCommitted: 0, notes };
  if (!githubConnected()) {
    notes.push('MISSING TOOL: GitHub — code changes were written but no pull request could be opened (GITHUB_TOKEN not set).');
    return { prUrl: null, filesCommitted: 0, notes };
  }
  const files = (task.turnTexts || []).flatMap((t) => parseFileChanges(t));
  if (!files.length) return { prUrl: null, filesCommitted: 0, notes };
  try {
    const pr = await openPullRequest(repo, {
      branch: `agency/${task.id}`.slice(0, 60),
      title: `${task.name}`.slice(0, 120),
      body: `Opened by the agency team from job "${task.name}".\n\nReview before merging — the team wrote this, the owner decides.`,
      files,
    });
    notes.push(`Pull request opened: ${pr.prUrl} (${files.length} file${files.length === 1 ? '' : 's'})`);
    return { prUrl: pr.prUrl, filesCommitted: files.length, notes };
  } catch (err) {
    notes.push(`Pull request failed: ${err.message}. The proposed changes are in the write-up above.`);
    return { prUrl: null, filesCommitted: 0, notes };
  }
}
