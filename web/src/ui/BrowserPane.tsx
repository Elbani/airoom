import { useCallback, useEffect, useRef, useState } from 'react';
import { normalizeUrl } from '@shared/browserUrl';
import type { BrowserAgents, BrowserDriver, ChromeCheck } from '@shared/types';
import { platform as hostPlatform } from '../platform';

/**
 * The browser pane: a real browser on the stage, where the office usually is.
 *
 * It is laid out the way Chrome is, because that is the browser everyone's
 * hands already know: tabs with the page's icon and title and a new-tab
 * button, back / forward / reload, the address bar, a profile button at the
 * right. Each tab is one Electron <webview>; they all stay mounted while the
 * pane exists, so a tab you are not looking at keeps running, as in Chrome.
 *
 * Agents drive the same pages through the shell (desktop/browser.js). Each
 * agent works in a tab of its own; this component draws the chrome around
 * the pages, says who is driving where, and tells the shell which tab is
 * which page.
 *
 * Profiles work as they do in Chrome: each has its own cookies and sign-ins.
 * Switching keeps the address of the tab you are on and opens it as the
 * other profile, in a fresh set of tabs.
 */

/** What the desktop shell asks of the UI: the pane opened, an agent acting in a tab, tabs to open, show or close, keys pressed in a page. */
export type BrowserShellEvent =
  | { type: 'open'; driver: BrowserDriver }
  | { type: 'driver'; driver: BrowserDriver; tab: string }
  | { type: 'newTab'; requestId: string; after: string | null }
  | { type: 'selectTab'; tab: string }
  | { type: 'closeTab'; tab: string }
  | { type: 'shortcut'; key: string };

export interface BrowserProfile {
  id: string;
  name: string;
  /** Which colour of the palette its avatar wears. */
  color: number;
  /** Held in memory only: emptied on leaving it. */
  guest?: boolean;
}
export interface BrowserProfiles {
  current: BrowserProfile;
  profiles: BrowserProfile[];
}
/** The shell's answer to a profile request: the profiles after it, or why it could not be done. */
export type BrowserProfilesAnswer = ({ ok: true } & BrowserProfiles) | { ok: false; error: string };
export type BrowserProfileRequest =
  | { op: 'list' }
  | { op: 'use' | 'remove' | 'clear'; id: string }
  | { op: 'add'; name: string }
  | { op: 'rename'; id: string; name: string };
/** What the UI tells the shell about its tabs. */
export interface BrowserTabsReport {
  tabs: { id: string; wcId: number }[];
  active: string;
  shown: boolean;
  created: Record<string, string>;
}

/** Where agents browse, and what is known about the user's own Chrome. */
export interface AgentsBrowse {
  use: BrowserAgents;
  status: ChromeCheck | null;
  set(use: BrowserAgents): void;
}
type Bridge = NonNullable<NonNullable<Window['airoomNative']>['browser']>;

/** The parts of Electron's <webview> element this pane uses. */
interface WebviewEl extends HTMLElement {
  loadURL(url: string): Promise<void>;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  openDevTools(): void;
  getWebContentsId(): number;
}
type WebviewEvent = Event & {
  url?: string;
  title?: string;
  favicons?: string[];
  isMainFrame?: boolean;
  errorCode?: number;
  errorDescription?: string;
  validatedURL?: string;
};

interface Tab {
  id: string;
  url: string;
  title: string;
  favicon: string | null;
  loading: boolean;
  back: boolean;
  forward: boolean;
  /** Why the page did not open, in a sentence. */
  problem: string | null;
}

const RECENT_KEY = 'airoom.browser.recent';
/** As many tabs as the shell lets one pane hold. */
const MAX_TABS = 16;
/** `allowpopups` as the literal attribute Electron looks for; React's typing wants a boolean it would not render. */
const POPUPS = { allowpopups: 'true' };
/** Avatar colours. Flat, and told apart at a glance. */
const AVATARS = ['#5eead4', '#5b9dff', '#fbbf24', '#f87171', '#c084fc', '#4ade80', '#fb923c', '#94a3b8'];
const isBlank = (url: string) => !url || url === 'about:blank';
const isWeb = (url: string) => /^https?:\/\//.test(url);
const MOD = hostPlatform === 'darwin' ? '⌘' : 'Ctrl+';
const blankTab = (): Tab => ({
  id: `t${Math.random().toString(36).slice(2, 10)}`,
  url: '',
  title: '',
  favicon: null,
  loading: false,
  back: false,
  forward: false,
  problem: null,
});

function loadRecent(profile: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(`${RECENT_KEY}.${profile}`) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 5) : [];
  } catch {
    return [];
  }
}

/** A load failure, in a sentence. Chromium's codes mean nothing to most people. */
function explainFailure(code: number | undefined, description: string | undefined, url: string): string {
  let where = url;
  try {
    where = new URL(url).host;
  } catch {
    /* keep the raw text */
  }
  if (code === -102) return `Nothing is listening at ${where}. Is the dev server running?`;
  if (code === -105) return `${where} could not be found.`;
  if (code === -106) return 'This machine is offline.';
  return `${where} could not be opened${description ? ` (${description.replace(/^ERR_/, '').replace(/_/g, ' ').toLowerCase()})` : ''}.`;
}

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d={d} />
  </svg>
);
const GLOBE = 'M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18M3 12h18M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18';
const PERSON = 'M12 12a4 4 0 1 0 0-8a4 4 0 0 0 0 8M4.5 20a7.5 7.5 0 0 1 15 0';
const CROSS = 'M6 6l12 12M18 6L6 18';
const PLUS = 'M12 5v14M5 12h14';

/** A profile's face: its initial on its colour, or an outline for Guest. */
function Avatar({ profile, size = 'sm' }: { profile: BrowserProfile; size?: 'sm' | 'lg' }) {
  if (profile.guest)
    return (
      <span className={`bp__face bp__face--${size} bp__face--guest`}>
        <Icon d={PERSON} />
      </span>
    );
  return (
    <span className={`bp__face bp__face--${size}`} style={{ background: AVATARS[Math.abs(profile.color) % AVATARS.length] }}>
      {[...profile.name.trim()][0]?.toUpperCase() ?? '?'}
    </span>
  );
}

export function BrowserPane({
  bridge,
  shown,
  driving,
  focusTab,
  agents,
  onClose,
}: {
  /** The shell's side of the pane. */
  bridge: Bridge;
  /** Is the pane on the stage right now? Hidden, its pages keep running. */
  shown: boolean;
  /** The agent acting on a page at the moment, by name, and in which tab. */
  driving: { name: string; tab: string } | null;
  /** Bring this tab to the front; a new `seq` asks again. */
  focusTab: { tab: string; seq: number } | null;
  /** Where agents browse, once the server has said. */
  agents: AgentsBrowse | null;
  /** Back to the office. */
  onClose: () => void;
}) {

  const [tabs, setTabs] = useState<Tab[]>(() => [blankTab()]);
  const [active, setActive] = useState('');
  const activeId = tabs.some((t) => t.id === active) ? active : (tabs[0]?.id ?? '');
  const cur = tabs.find((t) => t.id === activeId) ?? tabs[0];
  const [draft, setDraft] = useState<string | null>(null);
  /** Bumped when a page becomes ready, so the shell hears about it. */
  const [tick, setTick] = useState(0);

  // Per tab, outside React state: the element, and which page it is once it is ready.
  const views = useRef(new Map<string, WebviewEl>());
  const wcIds = useRef(new Map<string, number>());
  /** An address to open in a tab as soon as its page is ready. */
  const pending = useRef(new Map<string, string>());
  /** Tabs created because the shell asked: tab id → the shell's request id. */
  const createdFor = useRef(new Map<string, string>());
  const cleanups = useRef(new Map<string, () => void>());
  const refFns = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const addr = useRef<HTMLInputElement>(null);

  // ---- profiles ----
  /** null until the shell has said which profile is in use: a page must not open in the wrong one. */
  const [who, setWho] = useState<BrowserProfiles | null>(null);
  const [menu, setMenu] = useState<'profile' | 'more' | null>(null);
  /** The little form in the profile menu, when it is open. */
  const [form, setForm] = useState<{ kind: 'add' | 'rename'; text: string } | null>(null);
  const [sure, setSure] = useState(false);
  const [oops, setOops] = useState<string | null>(null);
  const profileId = who?.current.id ?? null;
  const profileRef = useRef(profileId);
  profileRef.current = profileId;
  const [recent, setRecent] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    void bridge.profiles({ op: 'list' }).then((v) => alive && v.ok && setWho({ current: v.current, profiles: v.profiles }));
    return () => {
      alive = false;
    };
  }, [bridge]);
  useEffect(() => {
    if (profileId) setRecent(loadRecent(profileId));
  }, [profileId]);
  useEffect(() => setDraft(null), [activeId]);

  const patch = useCallback((id: string, p: Partial<Tab>) => setTabs((all) => all.map((t) => (t.id === id ? { ...t, ...p } : t))), []);
  const remember = useCallback((url: string) => {
    const pid = profileRef.current;
    if (!pid) return;
    setRecent((prev) => {
      const next = [url, ...prev.filter((u) => u !== url)].slice(0, 5);
      try {
        localStorage.setItem(`${RECENT_KEY}.${pid}`, JSON.stringify(next));
      } catch {
        /* the list just won't stick */
      }
      return next;
    });
  }, []);

  /** Wire one tab's <webview> up, or let go of it. */
  const bind = useCallback(
    (id: string, el: WebviewEl | null) => {
      if (views.current.get(id) === el) return;
      cleanups.current.get(id)?.();
      cleanups.current.delete(id);
      if (!el) {
        views.current.delete(id);
        wcIds.current.delete(id);
        pending.current.delete(id);
        return;
      }
      views.current.set(id, el);
      const sync = () => {
        try {
          patch(id, { back: el.canGoBack(), forward: el.canGoForward() });
        } catch {
          /* not attached yet */
        }
      };
      const on = (name: string, fn: (e: WebviewEvent) => void) => {
        el.addEventListener(name, fn as EventListener);
        return () => el.removeEventListener(name, fn as EventListener);
      };
      const landed = (e: WebviewEvent) => {
        // A failed load parks the page on Chromium's own error document.
        if (e.isMainFrame === false || !e.url || e.url.startsWith('chrome-error:')) return;
        patch(id, { url: e.url, problem: null });
        sync();
        if (isWeb(e.url)) remember(e.url);
      };
      const offs = [
        on('dom-ready', () => {
          if (!wcIds.current.has(id)) {
            wcIds.current.set(id, el.getWebContentsId());
            setTick((n) => n + 1);
          }
          sync();
          const next = pending.current.get(id);
          pending.current.delete(id);
          if (next) el.loadURL(next).catch(() => {});
        }),
        on('did-start-loading', () => patch(id, { loading: true })),
        on('did-stop-loading', () => {
          patch(id, { loading: false });
          sync();
        }),
        on('did-navigate', (e) => {
          patch(id, { favicon: null }); // the next page brings its own
          landed(e);
        }),
        on('did-navigate-in-page', landed),
        on('page-title-updated', (e) => patch(id, { title: e.title ?? '' })),
        on('page-favicon-updated', (e) => patch(id, { favicon: e.favicons?.find((f) => /^(https?:|data:image\/)/.test(f)) ?? null })),
        on('did-fail-load', (e) => {
          // -3 is "aborted": a redirect, or the next navigation taking over.
          if (e.isMainFrame === false || e.errorCode === -3) return;
          patch(id, { ...(e.validatedURL ? { url: e.validatedURL } : {}), problem: explainFailure(e.errorCode, e.errorDescription, e.validatedURL ?? '') });
        }),
      ];
      cleanups.current.set(id, () => offs.forEach((f) => f()));
    },
    [patch, remember],
  );
  /** One stable ref callback per tab: a new function each render would unbind and rebind it every time. */
  const refFor = (id: string) => {
    let fn = refFns.current.get(id);
    if (!fn) {
      fn = (el) => bind(id, el as WebviewEl | null);
      refFns.current.set(id, fn);
    }
    return fn;
  };

  // Tell the shell which tab is which page, which is showing, and whether the pane is on the stage.
  const ids = tabs.map((t) => t.id).join(',');
  useEffect(() => {
    const list = tabs.filter((t) => wcIds.current.has(t.id)).map((t) => ({ id: t.id, wcId: wcIds.current.get(t.id)! }));
    void bridge.tabs({ tabs: list, active: activeId, shown, created: Object.fromEntries(createdFor.current) });
    // `tabs` changes with every title; only which tabs exist matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, activeId, shown, tick, bridge]);

  // ---- tabs ----
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeRef = useRef(activeId);
  activeRef.current = activeId;

  const openTab = (opts: { after?: string | null; requestId?: string; focusAddress?: boolean } = {}) => {
    const all = tabsRef.current;
    if (all.length >= MAX_TABS) return null;
    const tab = blankTab();
    if (opts.requestId) createdFor.current.set(tab.id, opts.requestId);
    const at = opts.after ? all.findIndex((t) => t.id === opts.after) : -1;
    const next = all.slice();
    next.splice(at >= 0 ? at + 1 : next.length, 0, tab);
    tabsRef.current = next;
    setTabs(next);
    setActive(tab.id);
    if (opts.focusAddress) setTimeout(() => addr.current?.focus(), 0);
    return tab.id;
  };
  const closeTab = (id: string) => {
    const all = tabsRef.current;
    const i = all.findIndex((t) => t.id === id);
    if (i < 0) return;
    createdFor.current.delete(id);
    refFns.current.delete(id);
    const rest = all.filter((t) => t.id !== id);
    if (!rest.length) {
      // The last tab closes the browser, as closing Chrome's last tab closes its
      // window. A new tab is waiting for next time.
      const fresh = blankTab();
      tabsRef.current = [fresh];
      setTabs([fresh]);
      setActive(fresh.id);
      onClose();
      return;
    }
    tabsRef.current = rest;
    setTabs(rest);
    if (activeRef.current === id) setActive(rest[Math.min(i, rest.length - 1)].id);
  };
  const cycle = (dir: 1 | -1) => {
    const all = tabsRef.current;
    const i = all.findIndex((t) => t.id === activeRef.current);
    if (all.length > 1) setActive(all[(i + dir + all.length) % all.length].id);
  };
  const nth = (n: number) => {
    const all = tabsRef.current;
    const t = n === 9 ? all[all.length - 1] : all[n - 1];
    if (t) setActive(t.id);
  };
  const activeView = () => {
    const id = activeRef.current;
    return wcIds.current.has(id) ? views.current.get(id) : undefined;
  };

  /** Chrome's tab keys, caught by the shell wherever they were pressed. */
  const shortcut = (key: string) => {
    if (key === 't') openTab({ after: activeRef.current, focusAddress: true });
    else if (key === 'w') closeTab(activeRef.current);
    else if (key === 'l') {
      addr.current?.focus();
      addr.current?.select();
    } else if (key === 'r') activeView()?.reload();
    else if (key === 'next') cycle(1);
    else if (key === 'prev') cycle(-1);
    else if (/^[1-9]$/.test(key)) nth(Number(key));
  };
  const latest = useRef({ shortcut, openTab, closeTab, shown });
  latest.current = { shortcut, openTab, closeTab, shown };

  // What the shell asks of the tabs: a page or an agent wants a new one, an agent switches or closes one.
  useEffect(
    () =>
      bridge.onEvent((ev) => {
        const l = latest.current;
        if (ev.type === 'newTab') l.openTab({ after: ev.after, requestId: ev.requestId });
        else if (ev.type === 'selectTab') {
          if (tabsRef.current.some((t) => t.id === ev.tab)) setActive(ev.tab);
        } else if (ev.type === 'closeTab') l.closeTab(ev.tab);
        else if (ev.type === 'shortcut' && l.shown) l.shortcut(ev.key);
      }),
    [bridge],
  );

  useEffect(() => {
    if (focusTab && tabsRef.current.some((t) => t.id === focusTab.tab)) setActive(focusTab.tab);
  }, [focusTab]);

  // ---- addresses ----
  const go = useCallback(
    (raw: string) => {
      const id = activeRef.current;
      const n = normalizeUrl(raw);
      if (!n.ok) {
        patch(id, { problem: n.error });
        return;
      }
      patch(id, { problem: null });
      setDraft(null);
      const el = views.current.get(id);
      if (!el || !wcIds.current.has(id)) {
        pending.current.set(id, n.url); // the page is not ready yet; it opens the moment it is
        return;
      }
      // A load superseded by another one rejects; that is not a failure to show.
      el.loadURL(n.url).catch(() => {});
    },
    [patch],
  );

  const closeMenu = () => {
    setMenu(null);
    setForm(null);
    setSure(false);
    setOops(null);
  };
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenu();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu]);

  /** Ask the shell to change something about the profiles, and follow what it answers. */
  const profile = async (req: BrowserProfileRequest) => {
    if (!who) return;
    const next = await bridge.profiles(req);
    if (!next.ok) return setOops(next.error);
    if (next.current.id !== who.current.id) {
      // Another profile is another browser: a fresh set of tabs, the one you
      // were on opened again as the other profile.
      const keep = cur && isWeb(cur.url) ? cur.url : null;
      const fresh = blankTab();
      if (keep) pending.current.set(fresh.id, keep);
      createdFor.current.clear();
      refFns.current.clear();
      tabsRef.current = [fresh];
      setTabs([fresh]);
      setActive(fresh.id);
      setDraft(null);
    }
    setWho({ current: next.current, profiles: next.profiles });
    closeMenu();
  };

  const blank = !!cur && isBlank(cur.url) && !cur.problem;
  const act = (fn: (el: WebviewEl) => void) => () => {
    const el = activeView();
    if (el) fn(el);
  };
  const me = who?.current;
  const others = who ? who.profiles.filter((p) => p.id !== me?.id) : [];
  const chrome = agents?.use === 'chrome';

  return (
    <section className={`bp ${shown ? '' : 'bp--away'}`} aria-label="Browser" aria-hidden={!shown}>
      <div className="bp__frame">
        <div
          className="bp__tabs"
          role="tablist"
          onDoubleClick={(e) => {
            if (e.target === e.currentTarget) openTab({ after: activeId, focusAddress: true });
          }}
        >
          {tabs.map((t) => {
            const on = t.id === activeId;
            const label = isBlank(t.url) && !t.problem ? 'New Tab' : t.title || t.url.replace(/^https?:\/\//, '');
            return (
              <div
                key={t.id}
                className={`bp__tab ${on ? 'bp__tab--on' : ''}`}
                role="tab"
                aria-selected={on}
                title={t.title || t.url || 'New Tab'}
                onMouseDown={(e) => {
                  if (e.button === 0) setActive(t.id);
                }}
                onAuxClick={(e) => {
                  if (e.button === 1) closeTab(t.id);
                }}
              >
                {t.loading ? (
                  <span className="bp__spin" aria-hidden="true" />
                ) : t.favicon ? (
                  <img className="bp__fav" src={t.favicon} alt="" referrerPolicy="no-referrer" onError={() => patch(t.id, { favicon: null })} />
                ) : (
                  <span className="bp__fav bp__fav--none">
                    <Icon d={GLOBE} />
                  </span>
                )}
                <span className="bp__tabname">{label}</span>
                {driving?.tab === t.id && <span className="bp__dot" title={`${driving.name} is working in this tab`} />}
                <button
                  className="bp__b bp__b--x"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => closeTab(t.id)}
                  title="Close tab"
                  aria-label="Close tab"
                >
                  <Icon d={CROSS} />
                </button>
              </div>
            );
          })}
          <button
            className="bp__b bp__b--new"
            onClick={() => openTab({ after: activeId, focusAddress: true })}
            disabled={tabs.length >= MAX_TABS}
            title={`New tab (${MOD}T)`}
            aria-label="New tab"
          >
            <Icon d={PLUS} />
          </button>
        </div>
        <div className="bp__bar">
          <button className="bp__b" onClick={act((el) => el.goBack())} disabled={!cur?.back} title="Back" aria-label="Back">
            <Icon d="M15 5l-7 7 7 7" />
          </button>
          <button className="bp__b" onClick={act((el) => el.goForward())} disabled={!cur?.forward} title="Forward" aria-label="Forward">
            <Icon d="M9 5l7 7-7 7" />
          </button>
          {cur?.loading ? (
            <button className="bp__b" onClick={act((el) => el.stop())} title="Stop loading" aria-label="Stop loading">
              <Icon d={CROSS} />
            </button>
          ) : (
            <button className="bp__b" onClick={act((el) => el.reload())} disabled={blank} title={`Reload (${MOD}R)`} aria-label="Reload">
              <Icon d="M20 12a8 8 0 1 1-2.6-5.9M20 4v5h-5" />
            </button>
          )}
          <form
            className="bp__addr"
            onSubmit={(e) => {
              e.preventDefault();
              go(draft ?? cur?.url ?? '');
              addr.current?.blur();
            }}
          >
            <span
              className="bp__site"
              title={cur?.url.startsWith('https://') ? 'The connection is secure' : isBlank(cur?.url ?? '') ? '' : 'Not a secure connection'}
              aria-hidden="true"
            >
              {cur?.url.startsWith('https://') ? (
                <Icon d="M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z" />
              ) : isBlank(cur?.url ?? '') ? (
                <Icon d="M11 4a7 7 0 1 0 0 14a7 7 0 0 0 0-14M16 16l4.5 4.5" />
              ) : (
                <Icon d="M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18M12 11v6M12 7.5v.5" />
              )}
            </span>
            <input
              ref={addr}
              value={draft ?? (isBlank(cur?.url ?? '') ? '' : (cur?.url ?? ''))}
              onChange={(e) => setDraft(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              onBlur={() => setDraft(null)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') e.currentTarget.blur();
              }}
              placeholder="Type an address: localhost:5173"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              aria-label="Address"
            />
          </form>
          {driving && (
            <span className="bp__driver" title="This agent is acting on a page">
              <span className="bp__dot" />
              {driving.name} is driving
            </span>
          )}
          {me && (
            <button
              className={`bp__b ${menu === 'profile' ? 'bp__b--on' : ''}`}
              onClick={() => (menu === 'profile' ? closeMenu() : (closeMenu(), setMenu('profile')))}
              title={`${me.name}: browser profile`}
              aria-label={`Browser profile: ${me.name}`}
              aria-haspopup="menu"
              aria-expanded={menu === 'profile'}
            >
              <Avatar profile={me} />
            </button>
          )}
          <button
            className={`bp__b ${menu === 'more' ? 'bp__b--on' : ''}`}
            onClick={() => (menu === 'more' ? closeMenu() : (closeMenu(), setMenu('more')))}
            title="More"
            aria-label="More"
            aria-haspopup="menu"
            aria-expanded={menu === 'more'}
          >
            <Icon d="M12 5v.01M12 12v.01M12 19v.01" />
          </button>
        </div>
        <div className="bp__body">
          {/* React does not know `allowpopups`, so it goes in as a plain attribute.
              The shell overrides every security-relevant setting of these
              elements (desktop/browser.js), the storage they use above all: the
              profile in use decides that, not what is written here. */}
          {me &&
            tabs.map((t) => (
              <webview
                key={`${me.id}:${t.id}`}
                ref={refFor(t.id) as React.Ref<HTMLWebViewElement>}
                className={`bp__view ${t.id === activeId ? 'bp__view--on' : ''}`}
                src="about:blank"
                partition="persist:airoom-browser"
                {...(POPUPS as object)}
              />
            ))}
          {blank && me && (
            <div className="bp__cover">
              <div className="bp__card">
                <h2>{me.guest ? 'You are browsing as Guest' : 'New Tab'}</h2>
                <p>
                  {me.guest
                    ? 'Nothing is kept: no cookies, no sign-ins. Leaving Guest empties it. Good for seeing a page the way a stranger does.'
                    : chrome
                      ? 'Try the app you are building here. Your agents use your own Chrome right now; you can change that in the ⋮ menu.'
                      : 'Open the app you are building and try it here. Your agents can use these tabs too: ask one to test something and it clicks, types and reads the result while you watch.'}
                </p>
                {recent.length > 0 && (
                  <div className="bp__recent">
                    {recent.map((u) => (
                      <button key={u} onClick={() => go(u)} title={u}>
                        {u.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
          {cur?.problem && (
            <div className="bp__cover">
              <div className="bp__card">
                <h2>That page did not open</h2>
                <p>{cur.problem}</p>
                <div className="bp__recent">
                  <button onClick={() => go(cur.url)} disabled={isBlank(cur.url)}>
                    Try again
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {menu && <div className="bp__scrim" onClick={closeMenu} />}
        {menu === 'profile' && me && (
          <div className="bp__menu" role="menu" aria-label="Browser profiles">
            <div className="bp__who">
              <Avatar profile={me} size="lg" />
              <div>
                <b>{me.name}</b>
                <small>{me.guest ? 'Nothing is kept after you leave Guest' : 'Its own cookies and sign-ins'}</small>
              </div>
            </div>
            {form ? (
              <form
                className="bp__form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void profile(form.kind === 'add' ? { op: 'add', name: form.text } : { op: 'rename', id: me.id, name: form.text });
                }}
              >
                <input
                  autoFocus
                  value={form.text}
                  onChange={(e) => setForm({ ...form, text: e.target.value })}
                  placeholder={form.kind === 'add' ? 'Name, for example Admin' : 'New name'}
                  maxLength={40}
                  aria-label="Profile name"
                />
                <button type="submit" disabled={!form.text.trim()}>
                  {form.kind === 'add' ? 'Add' : 'Rename'}
                </button>
              </form>
            ) : (
              <>
                {(others.length > 0 || !me.guest) && <div className="bp__sep">Other profiles</div>}
                {others.map((p) => (
                  <button key={p.id} className="bp__mi" role="menuitem" onClick={() => void profile({ op: 'use', id: p.id })}>
                    <Avatar profile={p} />
                    {p.name}
                  </button>
                ))}
                {!me.guest && (
                  <button className="bp__mi" role="menuitem" onClick={() => void profile({ op: 'use', id: 'guest' })}>
                    <Avatar profile={{ id: 'guest', name: 'Guest', color: -1, guest: true }} />
                    Guest
                  </button>
                )}
                <div className="bp__rule" />
                <button className="bp__mi" role="menuitem" onClick={() => setForm({ kind: 'add', text: '' })}>
                  <span className="bp__glyph">
                    <Icon d={PLUS} />
                  </span>
                  Add profile
                </button>
                {!me.guest && (
                  <button className="bp__mi" role="menuitem" onClick={() => setForm({ kind: 'rename', text: me.name })}>
                    <span className="bp__glyph">
                      <Icon d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" />
                    </span>
                    Rename {me.name}
                  </button>
                )}
                {!me.guest && me.id !== 'default' && (
                  <button className="bp__mi bp__mi--risk" role="menuitem" onClick={() => (sure ? void profile({ op: 'remove', id: me.id }) : setSure(true))}>
                    <span className="bp__glyph">
                      <Icon d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13" />
                    </span>
                    {sure ? `Yes, remove ${me.name} and everything it is signed in to` : `Remove ${me.name}`}
                  </button>
                )}
              </>
            )}
            {oops && <p className="bp__oops">{oops}</p>}
          </div>
        )}
        {menu === 'more' && (
          <div className="bp__menu bp__menu--more" role="menu" aria-label="More">
            <button
              className="bp__mi"
              role="menuitem"
              disabled={tabs.length >= MAX_TABS}
              onClick={() => {
                closeMenu();
                openTab({ after: activeId, focusAddress: true });
              }}
            >
              <span className="bp__glyph">
                <Icon d={PLUS} />
              </span>
              New tab
              <kbd className="bp__kbd">{MOD}T</kbd>
            </button>
            <div className="bp__rule" />
            <button
              className="bp__mi"
              role="menuitem"
              disabled={blank}
              onClick={() => {
                act((el) => el.openDevTools())();
                closeMenu();
              }}
            >
              <span className="bp__glyph">
                <Icon d="M8 8l-4 4 4 4M16 8l4 4-4 4M13 5l-2 14" />
              </span>
              Inspect the page
            </button>
            <button
              className="bp__mi"
              role="menuitem"
              disabled={!cur || !isWeb(cur.url)}
              onClick={() => {
                // The shell hands this to the system: only ever a web address.
                if (cur && isWeb(cur.url)) window.open(cur.url, '_blank', 'noopener');
                closeMenu();
              }}
            >
              <span className="bp__glyph">
                <Icon d="M14 4h6v6M20 4l-9 9M18 14v5H5V6h5" />
              </span>
              Open in your own browser
            </button>
            {me && (
              <button className="bp__mi bp__mi--risk" role="menuitem" onClick={() => (sure ? void profile({ op: 'clear', id: me.id }) : setSure(true))}>
                <span className="bp__glyph">
                  <Icon d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13" />
                </span>
                {sure ? `Yes, sign ${me.name} out of everything` : `Clear browsing data for ${me.name}`}
              </button>
            )}
            {agents && (
              <>
                <div className="bp__sep">Agents browse in</div>
                <button className="bp__mi" role="menuitemradio" aria-checked={!chrome} onClick={() => agents.set('pane')}>
                  <span className="bp__glyph">{!chrome && <Icon d="M5 12l5 5L19 8" />}</span>
                  <span className="bp__opt">
                    These tabs
                    <small>airoom's browser, its own profiles</small>
                  </span>
                </button>
                <button className="bp__mi" role="menuitemradio" aria-checked={chrome} onClick={() => agents.set('chrome')}>
                  <span className="bp__glyph">{chrome && <Icon d="M5 12l5 5L19 8" />}</span>
                  <span className="bp__opt">
                    My Chrome
                    <small>your profiles and sign-ins, through Claude in Chrome</small>
                  </span>
                </button>
                {chrome && agents.status && (
                  <p className={`bp__status bp__status--${agents.status.state}`}>{agents.status.text}</p>
                )}
              </>
            )}
            <div className="bp__rule" />
            <button
              className="bp__mi"
              role="menuitem"
              onClick={() => {
                closeMenu();
                onClose();
              }}
            >
              <span className="bp__glyph">
                <Icon d="M3 11 12 3l9 8M5 10v10h14V10" />
              </span>
              Back to the office
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
