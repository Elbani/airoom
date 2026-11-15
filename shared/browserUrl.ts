/**
 * What counts as an address in airoom's browser pane, and which addresses are
 * this machine. Shared by the server (which decides what an agent may open
 * without asking) and the UI (which completes what a person types).
 */

const LOCAL_NAMES = new Set(['localhost', '::1', '[::1]', '0.0.0.0']);
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** A hostname that can only be this machine. */
export function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return LOCAL_NAMES.has(h) || h.endsWith('.localhost') || /^127(\.\d{1,3}){3}$/.test(h);
}

/**
 * The site a page belongs to, for approval purposes: its origin, or null when
 * there is nothing to protect (a local page, a blank pane, a browser error
 * page).
 */
export function siteOf(url: string): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return isLocalHost(u.hostname) ? null : u.origin;
  } catch {
    return null;
  }
}

export type Normalized = { ok: true; url: string } | { ok: false; error: string };

/**
 * Turn what an agent (or a person) typed into an address the pane will load.
 * Only http and https ever get through: no file:, no javascript:, no data:.
 * A bare "localhost:5173" is http; a bare "example.com" is https.
 */
export function normalizeUrl(raw: string): Normalized {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, error: 'No address given.' };
  if (/\s/.test(text)) return { ok: false, error: `"${text.slice(0, 80)}" is not an address.` };
  if (text === 'about:blank') return { ok: true, url: text };

  let candidate = text;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    // No "scheme://". Either a host typed bare ("localhost:5173/app") or a
    // scheme that has no business here ("javascript:…", "mailto:…").
    const hostFirst = /^(\[::1\]|[\w-]+(\.[\w-]+)*)(:\d{1,5})?([/?#]|$)/.test(text);
    if (!hostFirst) {
      const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text)?.[1];
      return {
        ok: false,
        error: scheme ? `Only http and https pages can be opened, not ${scheme}: addresses.` : `"${text.slice(0, 80)}" is not an address.`,
      };
    }
    const host = text.split(/[/?#]/)[0].replace(/:\d+$/, '');
    const plain = isLocalHost(host) || IPV4.test(host) || !host.includes('.');
    candidate = `${plain ? 'http' : 'https'}://${text}`;
  }

  let u: URL;
  try {
    u = new URL(candidate);
  } catch {
    return { ok: false, error: `"${text.slice(0, 80)}" is not an address.` };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:')
    return { ok: false, error: `Only http and https pages can be opened, not ${u.protocol} addresses.` };
  // Dev servers print 0.0.0.0, which browsers refuse to open.
  if (u.hostname === '0.0.0.0') u.hostname = 'localhost';
  return { ok: true, url: u.href };
}
