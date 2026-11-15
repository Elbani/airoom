import type { BrowserAction, BrowserDriver, BrowserPaneState, ServerMessage } from '../../../shared/types';

/**
 * The server's end of the browser pane.
 *
 * The pane lives in the desktop shell. The shell already holds a socket to
 * this server, so commands go down that socket and answers come back up it:
 * no extra port. Whoever announces itself with `browserHost` is the host; the
 * server is loopback-only and refuses pages from other origins, so that is the
 * same trust every other client message carries.
 */

const NO_PANE: BrowserPaneState = { available: false, profile: null, tabs: [], active: null, drivers: {} };

/** The pane could not be reached at all (as opposed to a command failing). */
export class BrowserUnavailable extends Error {}

/** Opaque handle for the host's socket; the bridge only compares and forwards it. */
export type HostSocket = object;

interface Pending {
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
  host: HostSocket;
}

/** The shell's report, taken as untrusted input. */
function paneOf(v: unknown): BrowserPaneState {
  const s = (v ?? {}) as Record<string, unknown>;
  const p = s.profile as { id?: unknown; name?: unknown } | null;
  const profile = p && typeof p.id === 'string' && p.id && typeof p.name === 'string' ? { id: p.id.slice(0, 40), name: p.name.slice(0, 60) } : null;
  const tabs = (Array.isArray(s.tabs) ? s.tabs : [])
    .filter((t): t is { id: string; url?: unknown } => !!t && typeof (t as { id?: unknown }).id === 'string')
    .slice(0, 32)
    .map((t) => ({ id: t.id.slice(0, 24), url: typeof t.url === 'string' ? t.url.slice(0, 4000) : '' }));
  const ids = new Set(tabs.map((t) => t.id));
  const drivers: Record<string, string> = {};
  if (s.drivers && typeof s.drivers === 'object')
    for (const [run, tab] of Object.entries(s.drivers as Record<string, unknown>).slice(0, 64))
      if (typeof tab === 'string' && ids.has(tab)) drivers[run.slice(0, 200)] = tab;
  const active = typeof s.active === 'string' && ids.has(s.active) ? s.active : null;
  return { available: s.available === true, profile, tabs, active, drivers };
}

export class BrowserBridge {
  private host: HostSocket | null = null;
  private pane: BrowserPaneState = NO_PANE;
  private pending = new Map<string, Pending>();
  private seq = 0;

  constructor(private send: (host: HostSocket, msg: ServerMessage) => void) {}

  /** The shell announced itself, or its pane changed. */
  attachHost(host: HostSocket, state: unknown) {
    if (this.host && this.host !== host) this.failPending(this.host, 'The browser pane moved to another window.');
    this.host = host;
    this.pane = paneOf(state);
  }

  /** A socket closed. If it was the host, every command waiting on it fails now. */
  detachHost(host: HostSocket) {
    if (this.host !== host) return;
    this.failPending(host, 'airoom closed while the browser was working.');
    this.host = null;
    this.pane = NO_PANE;
  }

  private failPending(host: HostSocket, why: string) {
    for (const [id, p] of this.pending) {
      if (p.host !== host) continue;
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(new BrowserUnavailable(why));
    }
  }

  /** An answer from the host. Answers from anyone else, or for unknown ids, are dropped. */
  onResult(host: HostSocket, msg: { id?: unknown; ok?: unknown; result?: unknown; error?: unknown }) {
    if (host !== this.host || typeof msg.id !== 'string') return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    if (msg.ok === true) p.resolve(msg.result);
    else p.reject(new Error(typeof msg.error === 'string' && msg.error ? msg.error.slice(0, 2000) : 'The browser could not do that.'));
  }

  /** Is a shell connected at all? */
  get connected(): boolean {
    return this.host !== null;
  }

  get state(): BrowserPaneState {
    return this.pane;
  }

  /** The address in the tab this run acts on: its own, or the one showing, which it would take. */
  urlFor(runKey: string): string {
    const tab = this.pane.drivers[runKey] ?? this.pane.active;
    return this.pane.tabs.find((t) => t.id === tab)?.url ?? '';
  }

  /** Send one command to the pane and wait for its answer. */
  run(action: BrowserAction, args: Record<string, unknown>, driver: BrowserDriver, timeoutMs = 30_000): Promise<unknown> {
    const host = this.host;
    if (!host) return Promise.reject(new BrowserUnavailable('The browser pane needs the airoom desktop app, and it is not connected.'));
    if (!this.pane.available)
      return Promise.reject(new BrowserUnavailable('The airoom window is closed, so the browser pane cannot be used. Ask the user to open airoom.'));
    const id = `b${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The browser did not answer within ${Math.round(timeoutMs / 1000)} seconds.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, host });
      this.send(host, { v: 1, type: 'browserCmd', id, action, args, driver });
    });
  }

  /** For /health: enough to see from outside whether the pane is wired up. */
  status() {
    return {
      host: this.connected,
      available: this.pane.available,
      open: this.pane.tabs.some((t) => t.url && t.url !== 'about:blank'),
      waiting: this.pending.size,
    };
  }
}
