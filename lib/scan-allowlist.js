/**
 * Fixed list of domains Ash/Rook are allowed to point real recon/live-scan
 * tools at, once those tools exist (Shodan/SecurityTrails/HIBP — see
 * README's persona-tools notes). This file only ever grows by the site
 * owner explicitly adding a domain they own or are authorized to test —
 * never by anything a chat user types.
 */

export const ALLOWED_SCAN_TARGETS = [
  'deviant-tau.vercel.app',
  'deviant-capi-s-projects.vercel.app',
  'deviant-git-main-capi-s-projects.vercel.app',
];

/** True if `host` (or a subdomain of it) is on the allowlist. */
export function isAllowedScanTarget(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  return ALLOWED_SCAN_TARGETS.some((allowed) => h === allowed || h.endsWith(`.${allowed}`));
}
