// airoom's browser pane, shell side.
//
// The pane is a row of tabs, one <webview> each, inside the airoom window.
// People use it like any browser. Agents drive the same pages: the server
// relays their tool calls over the socket this shell already holds
// (connectFleet in main.js), so no debugging port is opened for it.
//
// An agent acts from inside the page: a click is the events a click fires,
// dispatched in the page, and text goes in through the browser's own editing
// commands. Input sent through the window would move its keyboard focus into
// the page, out from under whoever is typing to an agent beside it.
const { app, ipcMain, session } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Profiles, as in Chrome: each has its own cookies, storage and sign-ins, so
 * the same page can be seen as an admin, as a customer, and signed out. None
 * of them shares anything with airoom's own window. Guest is held in memory
 * only: it is emptied on leaving it and gone when airoom quits.
 */
const DEFAULT_PARTITION = 'persist:airoom-browser';
const GUEST_PARTITION = 'airoom-browser-guest';
const GUEST = { id: 'guest', name: 'Guest', color: -1, guest: true };
const PROFILE_COLORS = 8; // the UI owns the palette; a profile only remembers which of them it wears
const NAME_MAX = 40;
/** As many tabs as one pane holds. */
const MAX_TABS = 16;
/** What a page under test may have. Camera, microphone, location, notifications and the rest are refused without a prompt. */
const PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen']);
/** How long a tab stays with the agent that acted in it, as far as other agents go. */
const HOLD_MS = 20_000;
/** Screenshots are at most this many pixels across: enough to read, not a page of tokens. */
const SHOT_WIDTH = 1280;

const partitionOf = (id) => (id === 'guest' ? GUEST_PARTITION : id === 'default' ? DEFAULT_PARTITION : `${DEFAULT_PARTITION}-${id}`);

/**
 * Keys that belong to the app rather than the page: airoom's own (Cmd+K,
 * Cmd+J) and Chrome's tab keys. Returns the name the UI acts on, or null.
 */
function shortcutOf(input) {
  if (input.type !== 'keyDown' || input.alt) return null;
  const mod = process.platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta;
  const key = String(input.key).toLowerCase();
  if (input.control && key === 'tab') return input.shift ? 'prev' : 'next';
  if (!mod) return null;
  if (input.shift) {
    if (input.code === 'BracketLeft') return 'prev';
    if (input.code === 'BracketRight') return 'next';
    return key === 'r' ? 'r' : null; // a hard reload is a reload
  }
  return ['k', 'j', 't', 'w', 'l', 'r'].includes(key) || /^[1-9]$/.test(key) ? key : null;
}

/** The list of profiles and which one is in use, kept in the app's own data folder. */
function createProfiles() {
  const file = () => path.join(app.getPath('userData'), 'browser-profiles.json');
  /** @type {{ current: string, profiles: { id: string, name: string, color: number }[] } | null} */
  let data = null;

  const clean = (name) => String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  const load = () => {
    if (data) return data;
    data = { current: 'default', profiles: [{ id: 'default', name: 'Default', color: 0 }] };
    try {
      const saved = JSON.parse(fs.readFileSync(file(), 'utf8'));
      const list = (Array.isArray(saved.profiles) ? saved.profiles : [])
        .filter((p) => p && /^[a-z0-9]{1,24}$/.test(String(p.id)) && p.id !== 'guest' && clean(p.name))
        .map((p) => ({ id: String(p.id), name: clean(p.name), color: Number.isInteger(p.color) ? Math.abs(p.color) % PROFILE_COLORS : 0 }));
      const seen = new Set();
      const unique = list.filter((p) => !seen.has(p.id) && seen.add(p.id));
      if (!unique.some((p) => p.id === 'default')) unique.unshift(data.profiles[0]);
      data.profiles = unique;
      // Guest does not survive a restart, so neither does being in it.
      if (unique.some((p) => p.id === saved.current)) data.current = saved.current;
    } catch {
      /* no file yet, or one that cannot be read: start with Default */
    }
    return data;
  };
  const save = () => {
    try {
      fs.writeFileSync(file(), JSON.stringify({ current: data.current === 'guest' ? 'default' : data.current, profiles: data.profiles }, null, 2));
    } catch (err) {
      console.error('[shell] could not save the browser profiles:', err.message);
    }
  };
  const find = (id) => (id === 'guest' ? GUEST : load().profiles.find((p) => p.id === id));

  return {
    current: () => find(load().current) || load().profiles[0],
    all: () => load().profiles.slice(),
    /** What the UI draws: the profile in use and the whole list. */
    view: () => ({ current: find(load().current) || load().profiles[0], profiles: load().profiles.slice() }),
    add(name) {
      const d = load();
      const label = clean(name);
      if (!label) throw new Error('A profile needs a name.');
      if (d.profiles.length >= 24) throw new Error('That is a lot of profiles. Remove one first.');
      const used = new Set(d.profiles.map((p) => p.color));
      let color = 0;
      while (used.has(color) && color < PROFILE_COLORS - 1) color++;
      const profile = { id: `p${crypto.randomBytes(5).toString('hex')}`, name: label, color: used.has(color) ? d.profiles.length % PROFILE_COLORS : color };
      d.profiles.push(profile);
      d.current = profile.id;
      save();
      return profile;
    },
    rename(id, name) {
      const p = load().profiles.find((x) => x.id === id);
      const label = clean(name);
      if (!p) throw new Error('No such profile.');
      if (!label) throw new Error('A profile needs a name.');
      p.name = label;
      save();
    },
    remove(id) {
      const d = load();
      if (id === 'default') throw new Error('The first profile stays.');
      if (!d.profiles.some((p) => p.id === id)) throw new Error('No such profile.');
      d.profiles = d.profiles.filter((p) => p.id !== id);
      if (d.current === id) d.current = 'default';
      save();
    },
    use(id) {
      if (!find(id)) throw new Error('No such profile.');
      load().current = id;
      save();
    },
  };
}
/** An isolated JavaScript world for our helpers: the page cannot see or change them. */
const WORLD = 4711;
const KEEP_LOGS = 200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isWeb = (url) => /^https?:\/\//i.test(String(url)) || url === 'about:blank';

function withTimeout(promise, ms, message) {
  let timer;
  const late = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms)));
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/**
 * Runs inside the page, in the isolated world. Never called in this process:
 * its source is injected as text. Everything it returns must survive JSON.
 */
function pageLib() {
  const refs = new Map(); // "e12" -> WeakRef<Element>
  const ids = new WeakMap(); // Element -> "e12"
  let next = 1;
  const refFor = (el) => {
    let id = ids.get(el);
    if (!id) {
      id = `e${next++}`;
      ids.set(el, id);
      refs.set(id, new WeakRef(el));
    }
    return id;
  };
  const byRef = (ref) => {
    const el = refs.get(String(ref).replace(/[^\w]/g, ''))?.deref();
    return el && el.isConnected ? el : null;
  };
  const gone = (ref) => ({ error: `Unknown ref ${ref}. The page has changed since that outline; take a new snapshot.` });

  const clean = (s, max = 120) => {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  };
  const q = (s) => JSON.stringify(s);

  const INPUT_ROLE = { button: 'button', submit: 'button', reset: 'button', image: 'button', checkbox: 'checkbox', radio: 'radio', range: 'slider', file: 'file chooser' };
  const TAG_ROLE = { BUTTON: 'button', SELECT: 'dropdown', TEXTAREA: 'textbox', SUMMARY: 'button', OPTION: 'option' };
  const ACTS = new Set(
    'button link checkbox radio tab menuitem menuitemcheckbox menuitemradio option switch combobox dropdown textbox searchbox slider spinbutton treeitem file'.split(' '),
  );
  const NOT_TYPED = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color', 'image', 'hidden']);
  const INLINE = new Set('SPAN B I EM STRONG CODE SMALL SUB SUP MARK U S ABBR TIME LABEL BR WBR KBD VAR Q CITE DFN FONT BDI BDO'.split(' '));
  const SKIP = new Set('SCRIPT STYLE NOSCRIPT TEMPLATE HEAD META LINK TITLE'.split(' '));
  const GROUP_TAG = {
    NAV: 'navigation', MAIN: 'main', HEADER: 'header', FOOTER: 'footer', ASIDE: 'aside', FORM: 'form', DIALOG: 'dialog',
    UL: 'list', OL: 'list', LI: 'item', TABLE: 'table', TR: 'row', FIELDSET: 'group', ARTICLE: 'article',
  };
  const GROUP_ROLE = new Set('dialog alertdialog navigation main form list listitem row table grid menu menubar tablist toolbar region alert status group radiogroup tabpanel'.split(' '));

  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.trim().split(/\s+/)[0];
    const tag = el.tagName;
    if (tag === 'INPUT') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      return t === 'hidden' ? null : INPUT_ROLE[t] || 'textbox';
    }
    if (tag === 'A') return el.hasAttribute('href') ? 'link' : null;
    return TAG_ROLE[tag] || null;
  }

  /** A label's own words, without the text of a control nested inside it. */
  function labelText(label) {
    let out = '';
    const take = (node) => {
      for (const c of node.childNodes) {
        if (c.nodeType === 3) out += c.nodeValue;
        else if (c.nodeType === 1 && !/^(SELECT|TEXTAREA|INPUT|BUTTON|OPTION)$/.test(c.tagName)) take(c);
      }
    };
    take(label);
    return out;
  }

  function actionable(el, role, cursor, parentCursor) {
    // A label only forwards the click to its control, which has its own line.
    if (el.tagName === 'LABEL' && el.control) return false;
    if (role && ACTS.has(role.split(' ')[0])) return true;
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return true;
    if (el.hasAttribute('onclick')) return true;
    const ti = el.getAttribute('tabindex');
    if (ti !== null && Number(ti) >= 0) return true;
    // A hand cursor is how a clickable <div> gives itself away. Only the
    // outermost one counts, or every word inside it would get a ref.
    return cursor === 'pointer' && parentCursor !== 'pointer';
  }

  function nameOf(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ');
      if (t.trim()) return clean(t);
    }
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      if (el.labels && el.labels.length) {
        const t = [...el.labels].map(labelText).join(' ');
        if (t.trim()) return clean(t);
      }
      if (tag === 'INPUT' && ['button', 'submit', 'reset'].includes(el.type)) return clean(el.value || el.type);
      return clean(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '');
    }
    if (tag === 'IMG') return clean(el.getAttribute('alt') || el.getAttribute('title') || '');
    return (
      clean(el.innerText || el.textContent || '') ||
      clean(el.getAttribute('title') || '') ||
      clean(el.querySelector('img[alt]')?.getAttribute('alt') || '') ||
      clean(el.querySelector('svg title')?.textContent || '')
    );
  }

  /** "button "Save"", for messages about one element. */
  function describe(el) {
    const role = roleOf(el) || (el.isContentEditable ? 'textbox' : el.tagName.toLowerCase());
    const name = nameOf(el);
    return name ? `${role} ${q(name)}` : role;
  }

  function stateOf(el, role) {
    const out = [];
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio') {
        if (el.checked) out.push('checked');
      } else if (type === 'password') {
        // What is in a password field is not this outline's to repeat.
        if (el.value) out.push(`value=(hidden, ${el.value.length} characters)`);
      } else if (!NOT_TYPED.has(type) && el.value) out.push(`value=${q(clean(el.value, 200))}`);
      if (el.placeholder && !el.value && nameOf(el) !== clean(el.placeholder)) out.push(`placeholder=${q(clean(el.placeholder, 80))}`);
      if (el.readOnly) out.push('read-only');
      if (el.required) out.push('required');
    } else if (tag === 'SELECT') {
      const chosen = [...el.selectedOptions].map((o) => clean(o.text, 60));
      out.push(`value=${q(chosen.join(', '))}`);
      const options = [...el.options].map((o) => clean(o.text, 40));
      out.push(`options: ${options.slice(0, 15).join(' | ')}${options.length > 15 ? ` | … ${options.length - 15} more` : ''}`);
    } else if (role === 'link') {
      const href = el.getAttribute('href');
      if (href && !href.startsWith('#') && !href.startsWith('javascript:')) out.push(`to ${clean(href, 100)}`);
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') out.push('disabled');
    for (const [attr, word] of [['aria-checked', 'checked'], ['aria-selected', 'selected'], ['aria-pressed', 'pressed'], ['aria-expanded', 'expanded']])
      if (el.getAttribute(attr) === 'true') out.push(word);
    if (el.getAttribute('aria-expanded') === 'false') out.push('collapsed');
    if (el.getAttribute('aria-current') && el.getAttribute('aria-current') !== 'false') out.push('current');
    return out.length ? ` ${out.join(', ')}` : '';
  }

  function snapshot(max) {
    const limit = Math.max(2000, Number(max) || 30000);
    const lines = [];
    let size = 0;
    let seen = 0;
    let truncated = false;
    const emit = (depth, text) => {
      if (truncated) return;
      const line = `${'  '.repeat(depth)}- ${text}`;
      if (size + line.length > limit) {
        truncated = true;
        return;
      }
      lines.push(line);
      size += line.length + 1;
    };

    // Each element's style is looked up once, and so is whether it is plain prose.
    const styles = new Map();
    const style = (el) => {
      let s = styles.get(el);
      if (!s) styles.set(el, (s = getComputedStyle(el)));
      return s;
    };
    const prose = new Map();
    /** Text and inline wrappers only: one line of prose rather than a line per <b>. */
    const plainInline = (el) => {
      let v = prose.get(el);
      if (v === undefined) {
        v = INLINE.has(el.tagName) && !el.shadowRoot && !actionable(el, roleOf(el), style(el).cursor, style(el.parentElement).cursor) && [...el.children].every(plainInline);
        prose.set(el, v);
      }
      return v;
    };
    /** Will this element appear in the outline, as far as CSS goes? */
    const onPage = (el) => {
      const cs = style(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden' && el.getClientRects().length > 0;
    };
    const childrenOf = (el) => (el.shadowRoot ? [...el.shadowRoot.childNodes] : [...el.childNodes]);

    function walk(el, depth, named, parentCursor) {
      if (truncated || ++seen > 6000) {
        truncated = true;
        return;
      }
      const tag = el.tagName;
      if (SKIP.has(tag) || el.hasAttribute('data-airoom-overlay') || el.getAttribute('aria-hidden') === 'true') return;
      const cs = style(el);
      if (cs.display === 'none') return;
      const shown = cs.visibility !== 'hidden' && cs.visibility !== 'collapse' && (cs.display === 'contents' || el.getClientRects().length > 0);
      const role = roleOf(el);
      const cursor = cs.cursor;
      let childNamed = named;

      if (shown) {
        if (tag === 'IFRAME' || tag === 'FRAME') {
          emit(depth, `frame${el.title ? ` ${q(clean(el.title))}` : ''} (its content is not in this outline) ${clean(el.src || '', 120)}`);
          return;
        }
        if (tag === 'LABEL' && el.control) {
          const control = el.control;
          // Its words are the control's name; saying them twice is noise.
          childNamed = true;
          if (!onPage(control)) {
            // A custom checkbox, switch or upload button: the real control is
            // hidden and the label is what a person clicks. It gets the ref.
            const kind = roleOf(control) || 'clickable';
            emit(depth, `${kind} ${q(clean(labelText(el)))} [${refFor(el)}]${stateOf(control, kind)}`);
            return;
          }
        } else if (/^H[1-6]$/.test(tag) || role === 'heading') {
          const text = clean(el.innerText || el.textContent, 200);
          if (text && !named) emit(depth, `heading ${q(text)} (${/^H[1-6]$/.test(tag) ? tag.toLowerCase() : `level ${el.getAttribute('aria-level') || '?'}`})`);
          childNamed = true;
        } else if (actionable(el, role, cursor, parentCursor)) {
          const kind = role || (el.isContentEditable ? 'textbox' : 'clickable');
          const name = el.isContentEditable && !role ? clean(el.getAttribute('aria-label') || el.getAttribute('data-placeholder') || '') : nameOf(el);
          const editable = el.isContentEditable && !role ? ` value=${q(clean(el.innerText, 200))}` : '';
          emit(depth, `${kind}${name ? ` ${q(name)}` : ''} [${refFor(el)}]${stateOf(el, kind)}${editable}`);
          childNamed = true;
          if (tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'INPUT' || el.isContentEditable) return;
        } else if (tag === 'IMG' || role === 'img') {
          const alt = clean(el.getAttribute('alt') || el.getAttribute('aria-label') || '');
          if (alt && !named) emit(depth, `image ${q(alt)}`);
          return;
        } else {
          const group = (role && GROUP_ROLE.has(role) && role) || GROUP_TAG[tag] || (tag === 'SECTION' && el.getAttribute('aria-label') ? 'region' : null);
          if (group && !named) {
            const label = clean(el.getAttribute('aria-label') || (tag === 'FIELDSET' ? el.querySelector('legend')?.textContent : '') || '', 80);
            const at = lines.length;
            const before = size;
            emit(depth, `${group}${label ? ` ${q(label)}` : ''}:`);
            for (const c of childrenOf(el)) visit(c, depth + 1, false, cursor);
            // A group that turned out to hold nothing readable is noise.
            if (lines.length === at + 1 && !truncated) {
              lines.length = at;
              size = before;
            }
            return;
          }
        }
      }
      for (const c of childrenOf(el)) visit(c, depth, childNamed, cursor);
    }

    function visit(node, depth, named, parentCursor) {
      if (truncated) return;
      if (node.nodeType === 3) {
        if (named) return;
        const text = clean(node.nodeValue, 300);
        if (text) emit(depth, `text ${q(text)}`);
        return;
      }
      if (node.nodeType !== 1) return;
      // A paragraph of inline pieces reads as one line of text.
      if (!named && node.children.length && !SKIP.has(node.tagName) && !(node.tagName === 'LABEL' && node.control) && [...node.children].every(plainInline)) {
        const cs = style(node);
        const role = roleOf(node);
        const plain = !actionable(node, role, cs.cursor, parentCursor) && !/^H[1-6]$/.test(node.tagName) && role !== 'heading' && !GROUP_TAG[node.tagName] && !(role && GROUP_ROLE.has(role));
        if (plain && cs.display !== 'none' && cs.visibility !== 'hidden' && node.getAttribute('aria-hidden') !== 'true') {
          if (node.getClientRects().length || cs.display === 'contents') {
            const text = clean(node.innerText || node.textContent, 400);
            if (text) emit(depth, `text ${q(text)}`);
          }
          return;
        }
      }
      walk(node, depth, named, parentCursor);
    }

    if (document.body) walk(document.body, 0, false, 'auto');
    const page = document.scrollingElement || document.documentElement;
    const maxY = Math.max(0, Math.round(page.scrollHeight - innerHeight));
    const head = [`Viewport ${innerWidth}×${innerHeight}${maxY > 0 ? `, scrolled ${Math.round(scrollY)} of ${maxY}` : ''}`];
    const active = document.activeElement;
    if (active && active !== document.body && active !== document.documentElement && ids.has(active)) head.push(`Focus: ${describe(active)} [${ids.get(active)}]`);
    return { outline: head.concat(lines).join('\n'), truncated };
  }

  const optionsOf = (el) => [...el.options].slice(0, 30).map((o) => o.text.trim()).join(' | ');

  /** Is `inner` inside `outer`, shadow roots included? */
  function within(outer, inner) {
    for (let n = inner; n; n = n.parentNode || n.host) if (n === outer) return true;
    return false;
  }

  /** The innermost element at a point, open shadow roots included. */
  function elementAt(x, y) {
    let hit = document.elementFromPoint(x, y);
    while (hit && hit.shadowRoot) {
      const deeper = hit.shadowRoot.elementFromPoint(x, y);
      if (!deeper || deeper === hit) break;
      hit = deeper;
    }
    return hit;
  }
  /** A node's parent, stepping out of a shadow root to its host. */
  const parentOf = (n) => (n.parentNode && n.parentNode.nodeType === 11 ? n.parentNode.host : n.parentNode);

  /** Bring an element into view and say where a click on it lands, or why it cannot be clicked. */
  function clickPoint(el) {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const rects = el.getClientRects();
    const r = rects.length ? rects[0] : el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return { error: `${describe(el)} is not visible on the page.` };
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return { error: `${describe(el)} is disabled.` };
    // Clicking a <select> opens a menu the operating system draws, outside the
    // page, where nothing can be clicked by ref. Point at the tool that works.
    if (el.tagName === 'SELECT') return { error: `${describe(el)} is a dropdown. Do not click it: use select with the option you want. It offers: ${optionsOf(el)}` };
    const x = Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1);
    const y = Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 1);
    const hit = elementAt(x, y);
    const labelled = !!el.labels && [...el.labels].some((l) => within(l, hit));
    if (hit && !within(el, hit) && !within(hit, el) && !labelled) return { error: `${describe(el)} is covered by ${describe(hit)}, so a click would not reach it.` };
    return { x, y, hit, labelled };
  }

  const CAN_FOCUS = 'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable=""], [contenteditable="true"]';

  /** What pressing the mouse does to focus: it goes to the nearest thing around the target that can hold it. */
  function focusFrom(target) {
    for (let n = target; n && n.nodeType === 1; n = parentOf(n)) {
      if (!n.disabled && n.matches(CAN_FOCUS)) {
        n.focus({ preventScroll: true });
        return;
      }
    }
    const active = document.activeElement;
    if (active && active !== document.body) active.blur();
  }

  /** Click an element as the page experiences a click: the same events, in the same order, at the same point. */
  function click(ref, double) {
    const el = byRef(ref);
    if (!el) return gone(ref);
    const at = clickPoint(el);
    if (at.error) return at;
    const what = describe(el);
    const first = at.hit && (within(el, at.hit) || at.labelled) ? at.hit : el;
    // A handler may replace what was pressed; the rest goes to what is there now.
    const target = () => (first.isConnected ? first : elementAt(at.x, at.y) || first);
    const where = { bubbles: true, cancelable: true, composed: true, view: window, clientX: at.x, clientY: at.y, screenX: at.x, screenY: at.y, button: 0 };
    const pen = { pointerId: 1, pointerType: 'mouse', isPrimary: true, width: 1, height: 1 };
    const mouse = (type, more) => target().dispatchEvent(new MouseEvent(type, { ...where, ...more }));
    const pointer = (type, more) => target().dispatchEvent(new PointerEvent(type, { ...where, ...pen, ...more }));
    pointer('pointerover');
    mouse('mouseover');
    pointer('pointermove');
    mouse('mousemove');
    for (let n = 1; n <= (double ? 2 : 1); n++) {
      pointer('pointerdown', { buttons: 1, pressure: 0.5 });
      // Pressing the mouse moves focus, unless the page said not to.
      if (mouse('mousedown', { buttons: 1, detail: n })) focusFrom(target());
      pointer('pointerup');
      mouse('mouseup', { detail: n });
      // A click event runs the element's own action (follow the link, tick the
      // box, submit the form) whoever fired it.
      pointer('click', { detail: n });
    }
    if (double) mouse('dblclick', { detail: 2 });
    mark(at.x, at.y, null);
    return { what };
  }

  const isTextField = (el) =>
    el.isContentEditable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !NOT_TYPED.has((el.getAttribute('type') || 'text').toLowerCase()));
  const textOf = (el) => (el.isContentEditable ? el.innerText.replace(/\n$/, '') : el.value);

  /**
   * Put text into a field through the browser's own editing commands, which
   * is what typing does once the keys have been read: the field's selection is
   * replaced, `beforeinput` and `input` fire, frameworks see a real change and
   * undo still works. Reports an error if the field did not take the text.
   */
  function typeInto(ref, text, append) {
    const el = byRef(ref);
    if (!el) return gone(ref);
    if (el.tagName === 'SELECT') return { error: `${describe(el)} is a dropdown. Use select with the option you want. It offers: ${optionsOf(el)}` };
    if (!isTextField(el)) return { error: `${describe(el)} is not something text can be typed into. Click it instead.` };
    if (el.disabled || el.readOnly) return { error: `${describe(el)} is ${el.disabled ? 'disabled' : 'read-only'}.` };
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    el.focus({ preventScroll: true });
    const before = textOf(el);
    if (el.isContentEditable) {
      getSelection().selectAllChildren(el);
      if (append) getSelection().collapseToEnd();
    } else {
      try {
        if (append) el.setSelectionRange(el.value.length, el.value.length);
        else el.select();
      } catch {
        /* some input types have no caret to place */
      }
    }
    const want = append ? before + text : text;
    const last = text ? [...text].pop() : 'Backspace';
    const keyed = { key: last, bubbles: true, cancelable: true, composed: true, view: window };
    el.dispatchEvent(new KeyboardEvent('keydown', keyed));
    if (text) document.execCommand('insertText', false, text);
    else if (!append && before) document.execCommand('delete');
    if (textOf(el) === before && want !== before && !el.isContentEditable) {
      // The editing command did nothing: a date or a colour field has no text
      // selection to replace. Set the value the way a framework notices.
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, want);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    el.dispatchEvent(new KeyboardEvent('keyup', keyed));
    if (textOf(el) === before && want !== before) return { error: `${describe(el)} did not take the text. It may be a custom control: click it and try press, one key at a time.` };
    mark(0, 0, ref);
    return { what: describe(el) };
  }

  /** The element that has focus, looking inside open shadow roots. */
  function focused() {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a || document.body;
  }

  /** Everything Tab stops at, in document order. */
  function tabStops() {
    const out = [];
    const walk = (root) => {
      for (const el of root.querySelectorAll('*')) {
        if (el.matches(CAN_FOCUS) && !el.disabled && el.tabIndex >= 0 && el.getClientRects().length) out.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(document);
    return out;
  }

  /** Enter in a form field submits the form, by its first submit button if it has one. */
  function submitFormOf(field) {
    const form = field.form;
    if (!form) return '';
    const button = form.querySelector('button:not([type]), button[type=submit], input[type=submit], input[type=image]');
    if (button) {
      if (!button.disabled) button.click();
      return 'Its form was submitted.';
    }
    const fields = [...form.elements].filter((e) => e.tagName === 'INPUT' && isTextField(e));
    if (fields.length > 1) return '';
    form.requestSubmit();
    return 'Its form was submitted.';
  }

  /** What the browser itself would do for this key, when no handler claimed it. */
  function keyDefault(target, k) {
    const tag = target.tagName;
    const type = (target.getAttribute && (target.getAttribute('type') || '').toLowerCase()) || '';
    const field = target.nodeType === 1 && isTextField(target) && !target.disabled && !target.readOnly;
    const plain = !k.ctrl && !k.meta && !k.alt;
    const pushes = tag === 'BUTTON' || tag === 'SUMMARY' || (tag === 'INPUT' && ['button', 'submit', 'reset', 'image'].includes(type));
    const ticks = tag === 'INPUT' && (type === 'checkbox' || type === 'radio');
    if (k.key === 'Tab' && plain) {
      const stops = tabStops();
      if (!stops.length) return '';
      const i = stops.indexOf(target);
      const next = stops[(i === -1 ? (k.shift ? stops.length - 1 : 0) : i + (k.shift ? -1 : 1) + stops.length) % stops.length];
      next.focus();
      return `Focus moved to ${describe(next)}.`;
    }
    if (k.key === 'Enter' && plain) {
      if (target.isContentEditable) return document.execCommand(k.shift ? 'insertLineBreak' : 'insertParagraph') ? 'A new line was added.' : '';
      if (tag === 'TEXTAREA') return document.execCommand('insertText', false, '\n') ? 'A new line was added.' : '';
      if (pushes || tag === 'A') {
        target.click();
        return `${describe(target)} was activated.`;
      }
      if (tag === 'INPUT') return submitFormOf(target);
      return '';
    }
    if (k.key === ' ' && plain && (pushes || ticks)) {
      target.click();
      return `${describe(target)} was activated.`;
    }
    if (field && plain) {
      if (k.key === 'Backspace') return document.execCommand('delete') ? 'One character was deleted.' : '';
      if (k.key === 'Delete') return document.execCommand('forwardDelete') ? 'One character was deleted.' : '';
      if (k.text) return document.execCommand('insertText', false, k.text) ? `"${k.text}" was typed.` : '';
    }
    if (field && (k.ctrl || k.meta) && !k.alt && k.key.toLowerCase() === 'a') {
      if (target.isContentEditable) getSelection().selectAllChildren(target);
      else target.select();
      return 'Its text was selected.';
    }
    if (tag === 'SELECT' && plain && (k.key === 'ArrowDown' || k.key === 'ArrowUp')) {
      const i = target.selectedIndex + (k.key === 'ArrowDown' ? 1 : -1);
      if (i < 0 || i >= target.options.length) return '';
      target.selectedIndex = i;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      return `"${target.options[i].text.trim()}" is chosen now.`;
    }
    if (!field && plain) {
      const way = { PageDown: 'down', PageUp: 'up', Home: 'top', End: 'bottom', ' ': 'down' }[k.key];
      if (way) return scroll(way, null).moved ? 'The page scrolled.' : '';
    }
    return '';
  }

  /**
   * Press a key where the focus is. The page's handlers get keydown, keypress
   * and keyup as they would from a keyboard; if none of them claims the key,
   * what the browser would have done itself is done here (Tab moves focus,
   * Enter submits a form or presses a button, characters go into a field).
   */
  function pressKey(k) {
    const target = focused();
    const init = {
      key: k.key, code: k.code, keyCode: k.vk, which: k.vk,
      ctrlKey: k.ctrl, altKey: k.alt, metaKey: k.meta, shiftKey: k.shift,
      bubbles: true, cancelable: true, composed: true, view: window,
    };
    const on = describe(target);
    let did = '';
    if (target.dispatchEvent(new KeyboardEvent('keydown', init))) {
      const char = k.text && !k.ctrl && !k.meta && !k.alt ? k.text.charCodeAt(0) : 0;
      if (!char || target.dispatchEvent(new KeyboardEvent('keypress', { ...init, keyCode: char, which: char, charCode: char }))) did = keyDefault(target, k);
    }
    (target.isConnected ? target : focused()).dispatchEvent(new KeyboardEvent('keyup', init));
    return { on, did };
  }

  function choose(ref, value) {
    const el = byRef(ref);
    if (!el) return gone(ref);
    if (el.tagName !== 'SELECT') return { error: `${describe(el)} is not a dropdown. Click it, then click the option you want.` };
    if (el.disabled) return { error: `${describe(el)} is disabled.` };
    const want = String(value).trim().toLowerCase();
    const opts = [...el.options];
    const opt =
      opts.find((o) => o.value === String(value)) ||
      opts.find((o) => o.text.trim().toLowerCase() === want) ||
      opts.find((o) => want && o.text.toLowerCase().includes(want));
    if (!opt) return { error: `${describe(el)} has no option ${q(String(value))}. It offers: ${optionsOf(el)}` };
    if (opt.disabled) return { error: `The option ${q(opt.text.trim())} is disabled.` };
    if (el.multiple) opt.selected = true;
    else el.value = opt.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    mark(0, 0, ref);
    return { what: describe(el), chose: opt.text.trim() };
  }

  /** The thing that actually scrolls: the page, or the app's own scrolling area. */
  function scroller() {
    const page = document.scrollingElement || document.documentElement;
    if (page.scrollHeight > innerHeight + 4) return page;
    let best = null;
    for (const el of document.querySelectorAll('*')) {
      if (el.scrollHeight <= el.clientHeight + 4 || el.clientHeight < 80) continue;
      const oy = getComputedStyle(el).overflowY;
      if (oy !== 'auto' && oy !== 'scroll') continue;
      if (!best || el.clientHeight * el.clientWidth > best.clientHeight * best.clientWidth) best = el;
    }
    return best || page;
  }

  function scroll(direction, ref) {
    if (ref) {
      const el = byRef(ref);
      if (!el) return gone(ref);
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      return { what: describe(el) };
    }
    const s = scroller();
    const view = s === document.scrollingElement || s === document.documentElement ? innerHeight : s.clientHeight;
    const step = Math.round(view * 0.85);
    const before = s.scrollTop;
    if (direction === 'top') s.scrollTo({ top: 0, behavior: 'instant' });
    else if (direction === 'bottom') s.scrollTo({ top: s.scrollHeight, behavior: 'instant' });
    else s.scrollBy({ top: direction === 'up' ? -step : step, behavior: 'instant' });
    return { moved: Math.round(s.scrollTop - before) };
  }

  const hasText = (text) => (document.body?.innerText || '').toLowerCase().includes(String(text).toLowerCase());

  /** Show the person watching where the agent just acted. Gone in under a second. */
  function mark(x, y, ref) {
    try {
      const el = ref ? byRef(ref) : null;
      const r = el ? el.getBoundingClientRect() : { left: x - 14, top: y - 14, width: 28, height: 28 };
      const d = document.createElement('div');
      d.setAttribute('data-airoom-overlay', '');
      d.style.cssText = `position:fixed;z-index:2147483647;pointer-events:none;box-sizing:border-box;left:${r.left - 3}px;top:${r.top - 3}px;width:${r.width + 6}px;height:${r.height + 6}px;border:2px solid #5eead4;border-radius:${el ? 6 : 999}px;`;
      document.documentElement.appendChild(d);
      d.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 700, easing: 'ease-out' }).onfinish = () => d.remove();
      setTimeout(() => d.remove(), 900);
    } catch {
      /* decoration only */
    }
  }

  const api = { snapshot, click, typeInto, pressKey, choose, scroll, hasText };
  /** Every call from the shell comes in here, and its answer goes back as JSON text. */
  globalThis.__airoom = { run: (fn, args) => JSON.stringify(api[fn](...args)) };
}

// Two calls can both find a fresh document without helpers; only the first puts them in.
const PAGE_LIB = `globalThis.__airoom || (${pageLib.toString()})();`;
/** What a call answers in a document that has no helpers yet. */
const MISSING = 'airoom:no-helpers';

// ---- keys ----

const NAMED_KEYS = {
  Enter: { code: 'Enter', vk: 13, text: '\r' },
  Tab: { code: 'Tab', vk: 9 },
  Escape: { code: 'Escape', vk: 27 },
  Backspace: { code: 'Backspace', vk: 8 },
  Delete: { code: 'Delete', vk: 46 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  Home: { code: 'Home', vk: 36 },
  End: { code: 'End', vk: 35 },
  PageUp: { code: 'PageUp', vk: 33 },
  PageDown: { code: 'PageDown', vk: 34 },
  ' ': { code: 'Space', vk: 32, text: ' ' },
};
for (let i = 1; i <= 12; i++) NAMED_KEYS[`F${i}`] = { code: `F${i}`, vk: 111 + i };
const KEY_ALIASES = {
  esc: 'Escape', return: 'Enter', del: 'Delete', space: ' ', spacebar: ' ',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', pgup: 'PageUp', pgdn: 'PageDown',
};
const MODIFIERS = { alt: 'alt', option: 'alt', control: 'ctrl', ctrl: 'ctrl', meta: 'meta', cmd: 'meta', command: 'meta', shift: 'shift' };

/** "Shift+Tab" → the key as the page helper presses it. Throws on a key it does not know, naming it. */
function parseKey(combo) {
  const parts = String(combo).split('+').map((p) => p.trim());
  // "Control++" and a bare "+" both mean the plus key.
  if (parts.length > 1 && parts[parts.length - 1] === '' && parts[parts.length - 2] === '') parts.splice(-2, 2, '+');
  const name = parts.pop() || '';
  const held = { alt: false, ctrl: false, meta: false, shift: false };
  for (const p of parts) {
    const low = p.toLowerCase();
    const mod = low === 'mod' ? (process.platform === 'darwin' ? 'meta' : 'ctrl') : MODIFIERS[low];
    if (!mod) throw new Error(`"${p}" is not a modifier key. Use Shift, Control, Alt or Meta.`);
    held[mod] = true;
  }
  // With Control, Alt or Meta held, a key is a shortcut, not a character.
  const typing = !held.ctrl && !held.alt && !held.meta;
  const canonical = Object.keys(NAMED_KEYS).find((k) => k.toLowerCase() === name.toLowerCase()) || KEY_ALIASES[name.toLowerCase()];
  if (canonical) {
    const k = NAMED_KEYS[canonical];
    return { key: canonical, code: k.code, vk: k.vk, text: typing ? k.text : undefined, ...held };
  }
  if ([...name].length === 1) {
    const upper = name.toUpperCase();
    const key = held.shift ? upper : name;
    const code = /[a-z]/i.test(name) ? `Key${upper}` : /\d/.test(name) ? `Digit${name}` : '';
    return { key, code, vk: upper.charCodeAt(0), text: typing ? key : undefined, ...held };
  }
  throw new Error(`"${name}" is not a key name. Use names like Enter, Escape, Tab, ArrowDown, or a single character.`);
}

/** A load failure in words an agent can act on. */
function explain(code, url) {
  let where = url;
  try {
    where = new URL(url).origin;
  } catch {
    /* keep the raw text */
  }
  if (code === 'ERR_CONNECTION_REFUSED') return `Nothing is listening at ${where}. Is the dev server running, and on that port?`;
  if (code === 'ERR_NAME_NOT_RESOLVED') return `${where} could not be found. Check the address.`;
  if (code === 'ERR_INTERNET_DISCONNECTED') return 'This machine is offline.';
  if (code === 'ERR_CONNECTION_TIMED_OUT' || code === 'ERR_TIMED_OUT') return `${where} did not answer in time.`;
  if (/^ERR_CERT_|^ERR_SSL_/.test(String(code))) return `${where} has a certificate problem (${code}). Try http:// if this is a local server.`;
  return `Could not load ${url}: ${code || 'unknown error'}.`;
}

/**
 * @param {{ getWindow: () => import('electron').BrowserWindow | null,
 *           notify: (event: object) => void,
 *           report: () => void }} deps
 *   notify sends an event to the airoom UI; report tells the server the pane changed.
 */
function createBrowserPane({ getWindow, notify, report }) {
  /**
   * Every page in the pane, by its webContents id. A page exists once its
   * <webview> has attached; it becomes a tab once the UI says which tab it is.
   * `ready`: its document can be read. `agent`, `busy`, `at`: the agent that
   * acted in it last, how many of its commands are running there, and when.
   */
  const pages = new Map();
  /** The tabs, in the order the UI shows them: { id, wcId }. */
  let tabs = [];
  let activeTab = null;
  /** Is the pane on the stage? Decides whether Cmd+W closes a tab or the window. */
  let paneShown = false;
  /** The tab each agent works in, by run. A tab is one agent's at most. */
  const drivers = new Map();
  /** Tabs an agent opened, by tab: the only ones it may close. */
  const openedBy = new Map();
  /** Tabs the UI created on request: request id → tab id. */
  const created = new Map();
  /** Pages that asked for a new window: request id → the address to load once its tab exists. */
  const opens = new Map();
  /** A click of an agent's opened a new tab: run → request id, so the agent can follow it there. */
  const following = new Map();
  /** Promises waiting for the tabs to change in some way. */
  let waiters = [];
  let reportQueued = false;
  const profiles = createProfiles();
  /** Partitions whose session is set up, and sessions whose failed requests are being recorded. */
  const prepared = new Set();
  const watched = new Set();

  const rid = () => crypto.randomBytes(6).toString('hex');
  const emptyLogs = () => ({ entries: [], failed: [] });
  const wcOfTab = (id) => {
    const t = tabs.find((x) => x.id === id);
    const p = t && pages.get(t.wcId);
    return p && !p.wc.isDestroyed() ? p.wc : null;
  };
  const tabOfWc = (wcId) => tabs.find((t) => t.wcId === wcId)?.id ?? null;
  const isBlankPage = (wc) => {
    const u = wc.getURL();
    return !u || u === 'about:blank';
  };
  const queueReport = () => {
    if (reportQueued) return;
    reportQueued = true;
    setImmediate(() => {
      reportQueued = false;
      report();
    });
  };
  const keep = (list, item) => {
    list.push(item);
    if (list.length > KEEP_LOGS) list.splice(0, list.length - KEEP_LOGS);
  };

  /** A profile's session, set up once: pages get only the permissions above. */
  function sessionOf(profileId) {
    const partition = partitionOf(profileId);
    const ses = session.fromPartition(partition);
    if (prepared.has(partition)) return ses;
    prepared.add(partition);
    ses.setPermissionRequestHandler((_wc, permission, done) => done(PERMISSIONS.has(permission)));
    ses.setPermissionCheckHandler((_wc, permission) => PERMISSIONS.has(permission));
    return ses;
  }

  /**
   * Record failed requests for the agents' console. Every request of the
   * session then makes a trip to this process, so it starts with the first
   * agent to work in a profile rather than with the pane.
   */
  function watchRequests(ses) {
    if (watched.has(ses)) return;
    watched.add(ses);
    const failed = (d, what) => {
      const p = pages.get(d.webContentsId);
      if (p) keep(p.logs.failed, { method: d.method, url: d.url, ...what });
    };
    ses.webRequest.onCompleted((d) => d.statusCode >= 400 && failed(d, { status: d.statusCode }));
    ses.webRequest.onErrorOccurred((d) => d.error !== 'net::ERR_ABORTED' && failed(d, { error: d.error }));
  }

  /** Empty a profile: cookies, storage, cache, saved logins. */
  async function wipe(profileId) {
    const ses = session.fromPartition(partitionOf(profileId));
    await ses.clearStorageData();
    await ses.clearCache();
    await ses.clearAuthCache();
  }

  /**
   * Everything the UI can do with profiles. It answers with the profile in
   * use and the list, and throws a sentence the UI can show. Whatever comes in
   * is checked here: the UI asks, this decides.
   */
  async function profileOp(req) {
    const r = req && typeof req === 'object' ? req : {};
    const op = String(r.op ?? 'list');
    const id = String(r.id ?? '');
    const was = profiles.current().id;
    if (op === 'add') profiles.add(r.name);
    else if (op === 'rename') profiles.rename(id, r.name);
    else if (op === 'use') profiles.use(id);
    else if (op === 'clear') {
      if (!profiles.all().some((p) => p.id === id) && id !== 'guest') throw new Error('No such profile.');
      await wipe(id);
      if (id === was) for (const t of tabs) wcOfTab(t.id)?.reload();
    } else if (op === 'remove') {
      profiles.remove(id); // refuses the first profile and unknown ones
      await wipe(id).catch((err) => console.error('[shell] could not empty a removed profile:', err.message));
    } else if (op !== 'list') throw new Error('Unknown profile request.');
    if (profiles.current().id !== was) {
      // Every tab is about to be replaced by one in the other profile. Which
      // agent had which tab no longer means anything.
      drivers.clear();
      openedBy.clear();
      following.clear();
      opens.clear();
      // Guest keeps nothing: leaving it empties it.
      if (was === 'guest') await wipe('guest').catch(() => {});
    }
    queueReport();
    return profiles.view();
  }

  /** Only airoom's own window may ask. A page in the pane has no bridge to ask through anyway. */
  const fromAppWindow = (event) => {
    const win = getWindow();
    return !!win && event.sender === win.webContents;
  };
  ipcMain.handle('airoom:browser-profiles', async (event, req) => {
    if (!fromAppWindow(event)) return { ok: false, error: 'Not allowed.' };
    try {
      return { ok: true, ...(await profileOp(req)) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  /**
   * The UI says which tabs exist, which webContents each one is, which is
   * showing, and which it created on request. Whatever arrives is checked: a
   * tab can only name a page this file has already adopted.
   */
  ipcMain.handle('airoom:browser-tabs', (event, req) => {
    if (!fromAppWindow(event)) return false;
    const r = req && typeof req === 'object' ? req : {};
    const seen = new Set();
    tabs = (Array.isArray(r.tabs) ? r.tabs : [])
      .filter((t) => t && /^t[a-z0-9]{1,16}$/.test(String(t.id)) && Number.isInteger(t.wcId) && pages.has(t.wcId) && !seen.has(t.id) && seen.add(t.id))
      .slice(0, MAX_TABS)
      .map((t) => ({ id: String(t.id), wcId: t.wcId }));
    activeTab = tabs.some((t) => t.id === r.active) ? String(r.active) : (tabs[0]?.id ?? null);
    paneShown = r.shown === true;
    if (r.created && typeof r.created === 'object') {
      for (const [tabId, requestId] of Object.entries(r.created)) {
        if (typeof requestId !== 'string' || created.has(requestId) || !tabs.some((t) => t.id === tabId)) continue;
        created.set(requestId, tabId);
        if (created.size > 64) created.delete(created.keys().next().value);
        // A page asked for this tab: it gets the address it wanted.
        const open = opens.get(requestId);
        if (open) open.loaded = load(wcOfTab(tabId), open.url);
      }
    }
    tabsChanged();
    return true;
  });

  /** Whatever pointed at a tab that is gone points nowhere now, and whoever waited for a change hears of it. */
  function tabsChanged() {
    const live = new Set(tabs.map((t) => t.id));
    for (const [run, t] of drivers) if (!live.has(t)) drivers.delete(run);
    for (const t of openedBy.keys()) if (!live.has(t)) openedBy.delete(t);
    for (const w of waiters.slice()) {
      const v = w.ready();
      if (v) w.resolve(v);
    }
    queueReport();
  }

  /** Resolve with what `ready` returns once it returns something; it is asked again whenever the tabs change. */
  function waitUntil(ready, ms, failText) {
    const now = ready();
    if (now) return Promise.resolve(now);
    return new Promise((resolve, reject) => {
      const w = {
        ready,
        resolve: (v) => {
          finish();
          resolve(v);
        },
      };
      const finish = () => {
        clearTimeout(timer);
        waiters = waiters.filter((x) => x !== w);
      };
      const timer = setTimeout(() => {
        finish();
        reject(new Error(failText));
      }, ms);
      waiters.push(w);
    });
  }

  /** Lock the window down before any <webview> can exist in it. */
  function secure(win) {
    // With the browser on the stage, Chrome's tab keys work anywhere in the
    // window. Cmd+W and Cmd+R would otherwise reach the app menu, which closes
    // airoom's window and reloads airoom itself.
    win.webContents.on('before-input-event', (event, input) => {
      const key = paneShown ? shortcutOf(input) : null;
      if (!key || key === 'k' || key === 'j') return; // airoom's window handles its own
      event.preventDefault();
      notify({ type: 'shortcut', key });
    });
    win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
      // One page per tab, and only so many tabs.
      if (pages.size >= MAX_TABS) return event.preventDefault();
      // Whatever the page asked for, the pane is an ordinary sandboxed web
      // page in its own profile: no preload, no Node, no access to airoom.
      delete webPreferences.preload;
      delete webPreferences.preloadURL;
      webPreferences.nodeIntegration = false;
      webPreferences.nodeIntegrationInSubFrames = false;
      webPreferences.contextIsolation = true;
      webPreferences.sandbox = true;
      webPreferences.webSecurity = true;
      webPreferences.allowRunningInsecureContent = false;
      // Agents keep testing while the window is in the background.
      webPreferences.backgroundThrottling = false;
      // A page that sets no background is white, in the pane and in its screenshots.
      webPreferences.transparent = false;
      // The profile in use decides the storage, whatever the element asked for.
      const profile = profiles.current().id;
      sessionOf(profile);
      webPreferences.partition = partitionOf(profile);
      params.partition = partitionOf(profile);
      if (!isWeb(params.src)) params.src = 'about:blank';
    });
    win.webContents.on('did-attach-webview', (_event, wc) => {
      // An exception thrown from a main-process event handler puts a blocking
      // error box on screen. The pane failing must never do that.
      try {
        adopt(wc);
      } catch (err) {
        console.error('[shell] browser pane could not be set up:', err);
      }
    });
  }

  function adopt(wc) {
    if (wc.session !== sessionOf(profiles.current().id)) {
      // will-attach-webview makes this impossible. Should it ever happen, the
      // page does not get to exist outside its profile.
      console.error('[shell] browser pane attached outside its profile; closing it');
      wc.close();
      return;
    }
    const p = { wc, logs: emptyLogs(), ready: !wc.isLoading(), onReady: [], agent: null, busy: 0, at: 0 };
    pages.set(wc.id, p);

    // A link that wants a new window gets a new tab beside its own, as in
    // Chrome. When an agent's click opened it, the agent follows it there.
    wc.setWindowOpenHandler(({ url }) => {
      if (!isWeb(url)) return { action: 'deny' };
      const requestId = rid();
      opens.set(requestId, { url, loaded: null });
      if (opens.size > 32) opens.delete(opens.keys().next().value);
      if (p.busy > 0) following.set(p.agent, requestId);
      notify({ type: 'newTab', requestId, after: tabOfWc(wc.id) });
      return { action: 'deny' };
    });
    wc.on('will-navigate', (event, url) => {
      if (!isWeb(url)) event.preventDefault();
    });
    wc.on('did-start-navigation', (event) => {
      if (!event.isMainFrame || event.isSameDocument) return;
      p.logs = emptyLogs(); // a new page starts a new log
      p.ready = false;
    });
    // The new document can be read once its DOM is there, or once the navigation ended without one.
    const readable = () => {
      p.ready = true;
      for (const wake of p.onReady.splice(0)) wake();
    };
    wc.on('dom-ready', readable);
    wc.on('did-stop-loading', readable);
    wc.on('did-fail-load', (_e, _code, _text, _url, mainFrame) => mainFrame && readable());
    wc.on('console-message', (_event, level, message, line, source) => {
      // Electron's own advice to developers, printed into every unpackaged page.
      if (String(message).startsWith('%cElectron Security Warning')) return;
      let where = String(source || '');
      try {
        const file = new URL(source).pathname;
        where = `${file.split('/').pop() || file}:${line}`;
      } catch {
        /* not an address: keep it as it is */
      }
      keep(p.logs.entries, { level: ['debug', 'log', 'warning', 'error'][level] || 'log', text: String(message ?? '').slice(0, 2000), source: where });
    });
    // airoom's own shortcuts, and Chrome's tab shortcuts, still work with the caret inside a page.
    wc.on('before-input-event', (event, input) => {
      const key = shortcutOf(input);
      if (!key) return;
      event.preventDefault();
      const win = getWindow();
      if (win && (key === 'k' || key === 'j' || key === 't' || key === 'l')) win.webContents.focus();
      notify({ type: 'shortcut', key });
    });
    wc.debugger.on('message', (_event, method, params) => {
      // A dialog raised while an agent is driving would stall the page with
      // nobody to answer it. Accept it and put it in the log instead.
      if (method !== 'Page.javascriptDialogOpening' || !p.agent || (p.busy === 0 && Date.now() - p.at > 30_000)) return;
      keep(p.logs.entries, { level: 'dialog', text: `${params.type}: ${String(params.message).slice(0, 500)} (accepted for the agent)`, source: '' });
      wc.debugger.sendCommand('Page.handleJavaScriptDialog', { accept: true, promptText: params.defaultPrompt || '' }).catch(() => {});
    });
    wc.on('did-navigate', queueReport);
    wc.on('did-navigate-in-page', queueReport);
    wc.on('destroyed', () => {
      pages.delete(wc.id);
      readable();
      tabs = tabs.filter((t) => t.wcId !== wc.id);
      tabsChanged();
    });
    queueReport();
  }

  /** What the server knows about the pane. */
  function state() {
    const who = profiles.current();
    return {
      available: !!getWindow(),
      profile: { id: who.id, name: who.name },
      tabs: tabs.map((t) => ({ id: t.id, url: wcOfTab(t.id)?.getURL() ?? '' })),
      active: activeTab,
      drivers: Object.fromEntries(drivers),
    };
  }

  // ---- tabs, as agents see them ----

  /** Ask the UI for a new tab and wait until it is there. The pane opens first if it never has. */
  async function openTab(driver, after) {
    if (!tabs.length) {
      notify({ type: 'open', driver });
      return waitUntil(() => (activeTab && wcOfTab(activeTab) ? activeTab : null), 8000, 'The browser pane did not open. The airoom window may still be starting; try again in a moment.');
    }
    if (tabs.length >= MAX_TABS) throw new Error(`The browser has ${MAX_TABS} tabs open, as many as it holds. Close one first.`);
    const requestId = rid();
    notify({ type: 'newTab', requestId, after: after ?? null });
    return waitUntil(() => created.get(requestId), 8000, 'The new tab did not open. Try again in a moment.');
  }

  /** This tab is the agent's now, and no other agent's; `opened` says it may also close it. */
  function claim(driver, tab, opened) {
    for (const [run, t] of drivers) if (t === tab) drivers.delete(run);
    if (openedBy.get(tab) !== driver.runKey) openedBy.delete(tab);
    drivers.set(driver.runKey, tab);
    if (opened) openedBy.set(tab, driver.runKey);
    queueReport();
  }

  /** The agent's own tab, while it still exists. */
  function ownTab(driver) {
    const t = drivers.get(driver.runKey);
    return t && wcOfTab(t) ? t : null;
  }

  /** Is another agent working in this tab: acting in it now, or a moment ago? */
  function heldByOther(tab, driver) {
    const wc = wcOfTab(tab);
    const p = wc && pages.get(wc.id);
    return !!p && !!p.agent && p.agent !== driver.runKey && (p.busy > 0 || Date.now() - p.at < HOLD_MS);
  }
  const HELD = 'Another agent is working in the tab that is showing. Use navigate to open your page in a tab of your own.';

  /** The tab an agent acts on: its own, or else the one showing, which becomes its own. */
  function tabFor(driver) {
    const own = ownTab(driver);
    if (own) return own;
    if (!activeTab || !wcOfTab(activeTab)) throw new Error('No page is open in the browser pane yet. Use navigate to open one.');
    if (heldByOther(activeTab, driver)) throw new Error(HELD);
    claim(driver, activeTab, false);
    return activeTab;
  }

  /**
   * Where a navigate goes: the agent's own tab; else the tab showing, for
   * back, forward and reload, or when it is blank; else a new tab beside it.
   * A page someone has open is never replaced.
   */
  async function navigateTab(args, driver) {
    const own = ownTab(driver);
    if (own) return own;
    const free = !!activeTab && !!wcOfTab(activeTab) && !heldByOther(activeTab, driver);
    if (['back', 'forward', 'reload'].includes(String(args.url))) {
      if (!activeTab || !wcOfTab(activeTab)) throw new Error('No page is open in the browser pane yet. Use navigate with an address.');
      if (!free) throw new Error(HELD);
      claim(driver, activeTab, false);
      return activeTab;
    }
    const tab = free && isBlankPage(wcOfTab(activeTab)) ? activeTab : await openTab(driver, activeTab);
    claim(driver, tab, true);
    return tab;
  }

  /** Act in a tab as this agent: the UI hears who is acting where, and the tab is held for the agent meanwhile. */
  async function working(driver, tab, fn) {
    const wc = wcOfTab(tab);
    if (!wc) throw new Error('The tab closed. Use navigate to open a page.');
    const p = pages.get(wc.id);
    notify({ type: 'driver', driver, tab });
    watchRequests(wc.session);
    p.agent = driver.runKey;
    p.busy++;
    p.at = Date.now();
    try {
      await cdp(wc).catch(() => {}); // focus emulation and dialog handling, before anything acts
      return await fn(wc);
    } finally {
      p.busy--;
      p.at = Date.now();
    }
  }

  /**
   * The page's in-process debugger session. It is not used for input. It makes
   * the page behave as focused while the window's focus is elsewhere, answers
   * dialogs an agent's action raises, and takes screenshots.
   */
  async function cdp(wc) {
    const dbg = wc.debugger;
    if (!dbg.isAttached()) {
      try {
        dbg.attach('1.3');
      } catch (err) {
        throw new Error(`The page cannot be driven right now (${err.message}). If its developer tools are open, close them and try again.`);
      }
      await dbg.sendCommand('Page.enable').catch(() => {});
      await dbg.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    }
    return dbg;
  }

  /**
   * Call one of the page helpers, in the isolated world. Arguments go in as
   * JSON, so nothing an agent sent can become code. The helpers are put into
   * a document the first time one of them is needed there.
   */
  async function call(wc, asUser, fn, args) {
    const invoke = `globalThis.__airoom ? globalThis.__airoom.run(${JSON.stringify(fn)}, ${JSON.stringify(args)}) : ${JSON.stringify(MISSING)}`;
    const run = (code, user) => withTimeout(wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code }], user), 10_000, 'The page did not respond. It may still be loading, or it is busy.');
    let json = await run(invoke, asUser);
    if (json === MISSING) {
      await run(PAGE_LIB, false);
      json = await run(invoke, asUser);
    }
    return json === undefined ? undefined : JSON.parse(json);
  }
  const inPage = (wc, fn, ...args) => call(wc, false, fn, args);

  /** Let the page react: a beat, then, when a new document is on its way, until it can be read. */
  async function settle(wc, ms) {
    await sleep(ms);
    const p = pages.get(wc.id);
    if (!p || p.ready) return;
    await withTimeout(new Promise((resolve) => p.onReady.push(resolve)), 10_000, 'still loading').catch(() => {});
  }

  async function page(wc, extra = {}, max) {
    let outline;
    let truncated = false;
    try {
      ({ outline, truncated } = await inPage(wc, 'snapshot', max ?? 30_000));
    } catch (err) {
      outline = `(This page could not be read: ${err.message})`;
    }
    // Which identity the page is being seen as, once there is more than one to be.
    const who = profiles.current();
    const profile = who.guest || profiles.all().length > 1 ? { profile: who.name } : {};
    // Which tab, once there is more than one.
    const index = tabs.findIndex((t) => t.wcId === wc.id);
    const where = tabs.length > 1 && index >= 0 ? { tab: index + 1, tabs: tabs.length } : {};
    return { url: wc.getURL(), title: wc.getTitle(), ...profile, ...where, outline, truncated, ...extra };
  }

  function load(wc, url) {
    if (!wc) return Promise.resolve('The tab is gone.');
    return new Promise((resolve) => {
      let done = false;
      const finish = (problem) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(problem);
      };
      // A page that never finishes loading still has something to show.
      const timer = setTimeout(() => finish(null), 30_000);
      wc.loadURL(url).then(
        () => finish(null),
        (err) => finish(err && err.code === 'ERR_ABORTED' ? null : explain(err && err.code, url)),
      );
    });
  }

  async function navigate(wc, args) {
    const url = String(args.url ?? '');
    const history = wc.navigationHistory;
    if (url === 'back' || url === 'forward') {
      if (!(url === 'back' ? history.canGoBack() : history.canGoForward())) throw new Error(`There is no page to go ${url} to.`);
      if (url === 'back') history.goBack();
      else history.goForward();
      await settle(wc, 400);
    } else if (url === 'reload') {
      wc.reload();
      await settle(wc, 400);
    } else {
      if (!isWeb(url)) throw new Error('Only http and https pages can be opened.');
      const problem = await load(wc, url);
      if (problem) throw new Error(problem);
      await settle(wc, 200);
    }
    return page(wc, {}, args.max);
  }

  /**
   * Run a page helper that acts on the page. If the action itself navigated
   * away, the answer never comes back; that is the action working, not failing.
   */
  async function act(wc, fn, ...args) {
    const from = wc.getURL();
    try {
      // Run as a user action. The page then treats what follows as it treats a
      // person's click: a link's new window is not a blocked popup, and the
      // page left behind stays in the history for Back to return to.
      return await call(wc, true, fn, args);
    } catch (err) {
      if (wc.isDestroyed()) throw err;
      if (wc.isLoading() || wc.getURL() !== from) return {};
      throw err;
    }
  }

  async function click(wc, args) {
    const r = await act(wc, 'click', String(args.ref), !!args.double);
    if (r.error) throw new Error(r.error);
    await settle(wc, 250);
    return page(wc, { note: `${args.double ? 'Double-clicked' : 'Clicked'}${r.what ? ` ${r.what}` : ''}.` }, args.max);
  }

  async function type(wc, args) {
    const r = await act(wc, 'typeInto', String(args.ref), String(args.text ?? ''), !!args.append);
    if (r.error) throw new Error(r.error);
    let entered = '';
    if (args.submit) entered = ` Pressed Enter. ${(await act(wc, 'pressKey', parseKey('Enter'))).did || ''}`.trimEnd();
    await settle(wc, args.submit ? 300 : 120);
    return page(wc, { note: `Typed into ${r.what}.${entered}` }, args.max);
  }

  async function press(wc, args) {
    const r = await act(wc, 'pressKey', parseKey(String(args.key ?? '')));
    await settle(wc, 250);
    return page(wc, { note: `Pressed ${args.key}${r.on ? ` on ${r.on}` : ''}.${r.did ? ` ${r.did}` : ''}` }, args.max);
  }

  async function select(wc, args) {
    const r = await act(wc, 'choose', String(args.ref), String(args.value ?? ''));
    if (r.error) throw new Error(r.error);
    await settle(wc, 200);
    return page(wc, { note: `Chose "${r.chose}" in ${r.what}.` }, args.max);
  }

  async function scroll(wc, args) {
    const r = await inPage(wc, 'scroll', args.direction || 'down', args.ref ? String(args.ref) : null);
    if (r.error) throw new Error(r.error);
    await sleep(120);
    const note = args.ref ? `Scrolled to ${r.what}.` : r.moved ? `Scrolled ${args.direction || 'down'}.` : `The page did not move: it is already at the ${args.direction === 'up' || args.direction === 'top' ? 'top' : 'bottom'}.`;
    return page(wc, { note }, args.max);
  }

  async function wait(wc, args) {
    const seconds = Math.min(30, Math.max(0, Number(args.seconds) || 10));
    const needle = args.text ? String(args.text) : args.gone ? String(args.gone) : null;
    const until = Date.now() + seconds * 1000;
    let met = false;
    if (!needle) await sleep(seconds * 1000);
    // A look at the page's text four times a second, each one a small call.
    // A watch kept inside the page would end silently with its document.
    while (needle && !met && Date.now() < until) {
      met = (await inPage(wc, 'hasText', needle).catch(() => null)) === !!args.text;
      if (!met) await sleep(250);
    }
    return page(wc, { met }, args.max);
  }

  async function screenshot(wc) {
    // A window that is out of sight draws no frames, and a capture waits for one.
    const unseen = 'The page drew nothing to take a picture of: the airoom window is out of sight. Ask the user to bring airoom to the front, then try again.';
    let data;
    try {
      const dbg = await cdp(wc);
      const m = await dbg.sendCommand('Page.getLayoutMetrics');
      const v = m.cssVisualViewport;
      const pixels = m.visualViewport.clientWidth / v.clientWidth || 1;
      const scale = Math.min(1, SHOT_WIDTH / (v.clientWidth * pixels));
      const clip = { x: v.pageX, y: v.pageY, width: v.clientWidth, height: v.clientHeight, scale };
      ({ data } = await withTimeout(dbg.sendCommand('Page.captureScreenshot', { format: 'jpeg', quality: 80, optimizeForSpeed: true, clip }), 5000, unseen));
    } catch (err) {
      if (err.message === unseen) throw err;
      let image = await withTimeout(wc.capturePage(), 5000, unseen);
      if (image.isEmpty()) throw new Error(unseen);
      if (image.getSize().width > SHOT_WIDTH) image = image.resize({ width: SHOT_WIDTH, quality: 'good' });
      data = image.toJPEG(80).toString('base64');
    }
    return { url: wc.getURL(), title: wc.getTitle(), data, mimeType: 'image/jpeg' };
  }

  async function evaluate(wc, args) {
    const expr = String(args.expression ?? '');
    const report = `if (v === undefined) return 'undefined';
      if (typeof v === 'function') return String(v).slice(0, 500);
      if (v instanceof Element) return v.outerHTML.slice(0, 2000);
      try { const j = JSON.stringify(v, null, 2); return j === undefined ? String(v) : j; } catch { return String(v); }`;
    const fail = `catch (e) { return 'Error: ' + (e && e.stack ? e.stack : String(e)); }`;
    // No eval() inside the page: a strict Content-Security-Policy forbids it.
    // First as an expression; if that will not parse, as statements with a return.
    const forms = [
      `(async () => { try { const v = await (\n${expr}\n); ${report} } ${fail} })()`,
      `(async () => { try { const v = await (async () => {\n${expr}\n})(); ${report} } ${fail} })()`,
    ];
    for (const code of forms) {
      try {
        const value = await withTimeout(wc.executeJavaScript(code), 15_000, 'The expression did not finish within 15 seconds.');
        return { url: wc.getURL(), value: String(value) };
      } catch (err) {
        if (/did not finish/.test(err.message)) throw err;
      }
    }
    throw new Error('That could not be run. Pass a JavaScript expression, or statements that end with a return.');
  }

  /** List, open, switch to or close tabs, the way an agent asks for it. */
  async function tabsAction(args, driver) {
    const what = String(args.do ?? 'list');
    const list = () => ({
      tabs: tabs.map((t, i) => {
        const w = wcOfTab(t.id);
        return { index: i + 1, url: w?.getURL() ?? '', title: w?.getTitle() ?? '', yours: drivers.get(driver.runKey) === t.id, showing: activeTab === t.id };
      }),
    });
    const byIndex = (n) => {
      const i = Number(n);
      if (!Number.isInteger(i) || i < 1 || i > tabs.length)
        throw new Error(`There is no tab ${n}. ${tabs.length === 1 ? 'There is 1 tab.' : `There are ${tabs.length} tabs.`}`);
      return tabs[i - 1].id;
    };
    if (what === 'list') return list();
    if (what === 'new') {
      const t = await openTab(driver, ownTab(driver) ?? activeTab);
      claim(driver, t, true);
      if (args.url) return execute({ action: 'navigate', args: { url: args.url, max: args.max }, driver });
      return working(driver, t, (wc) => page(wc, { note: 'Opened a new tab. It is yours now.' }, args.max));
    }
    if (what === 'select') {
      const t = byIndex(args.tab);
      if (heldByOther(t, driver)) throw new Error(`Another agent is working in tab ${args.tab}. Open a new tab of your own instead.`);
      claim(driver, t, false);
      notify({ type: 'selectTab', tab: t });
      return working(driver, t, (wc) => page(wc, { note: `Switched to tab ${args.tab}. It is the one you act on now.` }, args.max));
    }
    if (what === 'close') {
      const t = args.tab == null ? ownTab(driver) : byIndex(args.tab);
      if (!t) throw new Error('You have no tab of your own to close.');
      if (openedBy.get(t) !== driver.runKey) throw new Error('That tab was open before you used it, so it is not yours to close.');
      notify({ type: 'closeTab', tab: t });
      await waitUntil(() => !tabs.some((x) => x.id === t), 3000, 'still open').catch(() => {});
      if (drivers.get(driver.runKey) === t) drivers.delete(driver.runKey);
      openedBy.delete(t);
      return { ...list(), note: 'Closed it.' };
    }
    throw new Error(`"${what}" is not something tabs can do. Use list, new, select or close.`);
  }

  /** A link the agent clicked opened a new tab: follow it there, the way Chrome brings the new tab forward. */
  async function follow(driver, result, args) {
    const requestId = following.get(driver.runKey);
    if (!requestId) return result;
    following.delete(driver.runKey);
    let tab;
    try {
      tab = await waitUntil(() => created.get(requestId), 5000, 'no tab');
    } catch {
      return result; // no tab came after all: what the action did stands
    }
    claim(driver, tab, true);
    return working(driver, tab, async (wc) => {
      await withTimeout(opens.get(requestId)?.loaded ?? Promise.resolve(), 15_000, 'slow').catch(() => {});
      await settle(wc, 200);
      return page(wc, { note: `${result.note ? `${result.note} ` : ''}That opened a new tab, and you are in it now.` }, args.max);
    });
  }

  /** Carry out one command from the server. Resolves with its result or rejects with a sentence. */
  async function execute({ action, args = {}, driver }) {
    if (!getWindow()) throw new Error('The airoom window is closed, so the browser pane cannot be used.');
    if (action === 'tabs') return tabsAction(args, driver);
    const tab = action === 'navigate' ? await navigateTab(args, driver) : tabFor(driver);
    return working(driver, tab, async (wc) => follow(driver, action === 'navigate' ? await navigate(wc, args) : await perform(wc, action, args), args));
  }

  async function perform(wc, action, args) {
    switch (action) {
      case 'snapshot':
        return page(wc, {}, args.max);
      case 'click':
        return click(wc, args);
      case 'type':
        return type(wc, args);
      case 'press':
        return press(wc, args);
      case 'select':
        return select(wc, args);
      case 'scroll':
        return scroll(wc, args);
      case 'wait':
        return wait(wc, args);
      case 'screenshot':
        return screenshot(wc);
      case 'console': {
        const p = pages.get(wc.id);
        const out = { url: wc.getURL(), entries: p.logs.entries.slice(-100), failed: p.logs.failed.slice(-50) };
        if (args.clear) p.logs = emptyLogs();
        return out;
      }
      case 'evaluate':
        return evaluate(wc, args);
      default:
        throw new Error(`The browser pane does not know how to "${action}".`);
    }
  }

  return { secure, state, execute };
}

module.exports = { createBrowserPane, createProfiles, partitionOf, parseKey, explain, shortcutOf };
