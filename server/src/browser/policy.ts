/**
 * Which pages an agent may touch without asking.
 *
 * Agents test the app they are building, and that app lives on this machine:
 * local pages never raise a card. Anything else is somebody's website,
 * possibly one the user is signed in to, so the first call that would read or
 * act on it goes through the ordinary approval. One yes covers that site, in
 * that browser profile, for the rest of the run.
 */

import { normalizeUrl, siteOf } from '../../../shared/browserUrl';

export { normalizeUrl, siteOf } from '../../../shared/browserUrl';

/** What one yes covers: a site in one profile. Another profile is another identity. */
export function approvalKey(site: string, profile?: string): string {
  return profile ? `${profile} ${site}` : site;
}

/** Words `navigate` accepts in place of an address. */
export const HISTORY_WORDS = new Set(['back', 'forward', 'reload']);

/**
 * The site a call is judged by: the address it opens, or else the page in the
 * run's own tab. Null when there is nothing to clear: a page on this machine,
 * a blank tab, an address the tool will refuse anyway, or a tab call that
 * reads nothing (list, select, close).
 */
export function judgedSite(action: string, input: Record<string, unknown>, currentUrl: string): string | null {
  const opening =
    action === 'tabs' ? (input.do === 'new' ? input.url : '') : action === 'navigate' && !HISTORY_WORDS.has(String(input.url ?? '').trim()) ? input.url : undefined;
  if (opening === undefined) return siteOf(currentUrl);
  const n = typeof opening === 'string' && opening.trim() ? normalizeUrl(opening) : null;
  return n?.ok ? siteOf(n.url) : null;
}

/** Would this call read or act on a site the run has not been cleared for? */
export function needsApproval(
  action: string,
  input: Record<string, unknown>,
  now: { currentUrl: string; approved: ReadonlySet<string>; profile?: string },
): boolean {
  const site = judgedSite(action, input, now.currentUrl);
  return site !== null && !now.approved.has(approvalKey(site, now.profile));
}
