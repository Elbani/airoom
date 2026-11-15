/**
 * The browser pane's server half, proven without a browser.
 *
 *   npx tsx scripts/browser-test.ts
 *
 * What an address is, which sites ask first, the relay to the desktop shell
 * (answers, failures, a shell that goes away), two agents sharing one pane,
 * what the tools tell the model, and the switch to the user's own Chrome.
 */
import assert from 'node:assert/strict';
import { BrowserBridge, BrowserUnavailable } from '../src/browser/BrowserBridge';
import { needsApproval, normalizeUrl, siteOf } from '../src/browser/policy';
import { browserExtras, browserToolDefs } from '../src/browser/tools';
import { chromeCheck, chromeExtras } from '../src/browser/chrome';
import { loadBrowserAgents, saveBrowserAgents } from '../src/browser/settings';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeTool } from '../../shared/describeTool';
import type { ServerMessage } from '../../shared/types';

let passed = 0;
const failures: Array<[string, Error]> = [];
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
  } catch (e) {
    failures.push([name, e as Error]);
  }
}

type Cmd = Extract<ServerMessage, { type: 'browserCmd' }>;
/** What the shell reports: one tab, showing `url`. */
const pane = (url = 'http://localhost:5173/', more: Record<string, unknown> = {}) => ({
  available: true,
  profile: { id: 'default', name: 'Default' },
  tabs: [{ id: 't1', url }],
  active: 't1',
  drivers: {},
  ...more,
});

/** A bridge with a pretend shell on the other end. `answer` decides what the pane says. */
function rig(answer: (cmd: Cmd) => { ok: boolean; result?: unknown; error?: string } | null = () => ({ ok: true, result: {} })) {
  const host = { name: 'shell' };
  const sent: Cmd[] = [];
  const bridge = new BrowserBridge((to, msg) => {
    assert.equal(to, host, 'commands only ever go to the host');
    const cmd = msg as Cmd;
    sent.push(cmd);
    const a = answer(cmd);
    if (a) queueMicrotask(() => bridge.onResult(host, { id: cmd.id, ...a }));
  });
  return { bridge, host, sent };
}
const driver = (key: string, sessionId: string | null = key) => ({ runKey: key, sessionId, roomId: '/proj' });
const ctx = (key: string, sessionId: string | null = key) => ({ roomId: '/proj', runKey: key, sessionId: () => sessionId });
const textOf = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? `<${c.type}>`).join('\n');
/** One run's tools, called by name the way the model calls them, and their policy. */
function toolsOf(bridge: BrowserBridge, key: string, sessionId: string | null = key) {
  const { defs, autoAllowTool } = browserToolDefs(bridge, ctx(key, sessionId))!;
  return {
    call: (name: string, args: Record<string, unknown> = {}) => defs.find((d) => d.name === name)!.handler(args),
    free: (name: string, args: Record<string, unknown> = {}) => autoAllowTool(`mcp__airoom-browser__${name}`, args),
  };
}

await test('an address is http or https, and bare hosts are completed sensibly', () => {
  const ok = (raw: string, url: string) => assert.deepEqual(normalizeUrl(raw), { ok: true, url }, raw);
  const bad = (raw: string) => assert.equal(normalizeUrl(raw).ok, false, raw);
  ok('http://localhost:5173/app?x=1', 'http://localhost:5173/app?x=1');
  ok('localhost:5173', 'http://localhost:5173/');
  ok('127.0.0.1:3000/admin', 'http://127.0.0.1:3000/admin');
  ok('[::1]:8080', 'http://[::1]:8080/');
  ok('myapp.localhost:4000', 'http://myapp.localhost:4000/');
  ok('192.168.1.20:8000', 'http://192.168.1.20:8000/');
  ok('devbox:3000', 'http://devbox:3000/');
  ok('example.com', 'https://example.com/');
  ok('example.com/docs#top', 'https://example.com/docs#top');
  ok('http://0.0.0.0:3000/', 'http://localhost:3000/');
  ok('  about:blank ', 'about:blank');
  for (const raw of ['', 'two words', 'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,<b>x</b>', 'mailto:a@b.c', 'chrome://settings', 'ftp://x.y/z'])
    bad(raw);
});

await test('this machine is free; any other site is a question for the human, once', () => {
  assert.equal(siteOf('http://localhost:5173/a'), null);
  assert.equal(siteOf('http://127.0.0.5:80/'), null);
  assert.equal(siteOf('http://app.localhost/'), null);
  assert.equal(siteOf('about:blank'), null);
  assert.equal(siteOf(''), null);
  assert.equal(siteOf('chrome-error://chromewebdata/'), null, 'an error page has nothing to protect');
  assert.equal(siteOf('https://example.com/x?y'), 'https://example.com');
  assert.equal(siteOf('http://192.168.1.20:8000/'), 'http://192.168.1.20:8000', 'another machine on the network is not this machine');

  const none = new Set<string>();
  const here = { currentUrl: 'http://localhost:5173/', approved: none };
  assert.equal(needsApproval('navigate', { url: 'http://localhost:3000' }, here), false);
  assert.equal(needsApproval('navigate', { url: 'localhost:3000' }, here), false);
  assert.equal(needsApproval('navigate', { url: 'https://example.com' }, here), true);
  assert.equal(needsApproval('navigate', { url: 'example.com' }, here), true, 'a bare host is judged as the address it becomes');
  assert.equal(needsApproval('navigate', { url: 'javascript:alert(1)' }, here), false, 'a bad address is refused by the tool, not by a card');
  assert.equal(needsApproval('click', { ref: 'e1' }, here), false);
  assert.equal(needsApproval('snapshot', {}, here), false);

  // Reading counts too: the user may be signed in to that site inside the pane.
  const there = { currentUrl: 'https://mail.example.com/inbox', approved: none };
  for (const action of ['snapshot', 'screenshot', 'console', 'click', 'type', 'evaluate', 'wait']) assert.equal(needsApproval(action, {}, there), true, action);
  assert.equal(needsApproval('navigate', { url: 'back' }, there), true, 'history moves are judged by the page they act on');
  assert.equal(needsApproval('navigate', { url: 'http://localhost:5173' }, there), false, 'leaving for a local page is always fine');

  const cleared = { currentUrl: 'https://mail.example.com/inbox', approved: new Set(['https://mail.example.com']) };
  assert.equal(needsApproval('click', {}, cleared), false);
  assert.equal(needsApproval('navigate', { url: 'https://mail.example.com/sent' }, cleared), false);
  assert.equal(needsApproval('navigate', { url: 'https://other.example.com/' }, cleared), true, 'one yes covers one site');
});

await test('no shell, or a closed window, is said plainly', async () => {
  const { bridge, host } = rig();
  await assert.rejects(bridge.run('snapshot', {}, driver('a')), (e) => e instanceof BrowserUnavailable && /desktop app/.test((e as Error).message));
  bridge.attachHost(host, { available: false });
  assert.equal(bridge.connected, true);
  await assert.rejects(bridge.run('snapshot', {}, driver('a')), (e) => e instanceof BrowserUnavailable && /window is closed/.test((e as Error).message));
});

await test('a command goes to the shell and its answer comes back', async () => {
  const { bridge, host, sent } = rig((cmd) => ({ ok: true, result: { echoed: cmd.action, args: cmd.args } }));
  bridge.attachHost(host, pane());
  const r = await bridge.run('click', { ref: 'e3' }, driver('run1', 'sess1'));
  assert.deepEqual(r, { echoed: 'click', args: { ref: 'e3' } });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].driver, { runKey: 'run1', sessionId: 'sess1', roomId: '/proj' });
  assert.equal(bridge.status().waiting, 0);
});

await test('a failure in the pane arrives as the pane worded it', async () => {
  const { bridge, host } = rig(() => ({ ok: false, error: 'Unknown ref e99. Take a new snapshot.' }));
  bridge.attachHost(host, pane());
  await assert.rejects(bridge.run('click', { ref: 'e99' }, driver('a')), /Unknown ref e99/);
});

await test('an answer from anyone but the host is ignored, and silence times out', async () => {
  const { bridge, host, sent } = rig(() => null);
  bridge.attachHost(host, pane());
  const p = bridge.run('snapshot', {}, driver('a'), 60);
  bridge.onResult({ name: 'impostor' }, { id: sent[0].id, ok: true, result: 'fake page' });
  bridge.onResult(host, { id: 'not-an-id', ok: true });
  await assert.rejects(p, /did not answer/);
  assert.equal(bridge.status().waiting, 0);
});

await test('when the shell goes away, whatever was waiting on it fails at once', async () => {
  const { bridge, host } = rig(() => null);
  bridge.attachHost(host, pane());
  const p = bridge.run('navigate', { url: 'http://localhost:5173/' }, driver('a'));
  bridge.detachHost({ name: 'some other client' }); // an ordinary tab closing changes nothing
  assert.equal(bridge.connected, true);
  bridge.detachHost(host);
  await assert.rejects(p, (e) => e instanceof BrowserUnavailable);
  assert.equal(bridge.connected, false);
  assert.deepEqual(bridge.state, { available: false, profile: null, tabs: [], active: null, drivers: {} });
});

await test('what the shell reports is taken as untrusted input', () => {
  const { bridge, host } = rig();
  bridge.attachHost(host, { available: 'yes', profile: { id: 7, name: 'x' }, tabs: 'many', active: 3, drivers: ['t1'] });
  assert.deepEqual(bridge.state, { available: false, profile: null, tabs: [], active: null, drivers: {} });
  bridge.attachHost(host, { available: true, profile: { id: 'p1', name: 'n'.repeat(200) } });
  assert.deepEqual(bridge.state.profile, { id: 'p1', name: 'n'.repeat(60) });
  bridge.attachHost(host, null);
  assert.equal(bridge.state.available, false);
});

await test('runs only carry the tools while a shell is connected', () => {
  const { bridge, host } = rig();
  assert.equal(browserExtras(bridge, ctx('a')), null);
  bridge.attachHost(host, pane());
  const extras = browserExtras(bridge, ctx('a'));
  assert.deepEqual(Object.keys(extras?.mcpServers ?? {}), ['airoom-browser'], 'named so the connections panel hides it as plumbing');
  const names = browserToolDefs(bridge, ctx('a'))!.defs.map((d) => d.name);
  assert.deepEqual(names, ['navigate', 'snapshot', 'click', 'type', 'select', 'press', 'scroll', 'wait', 'screenshot', 'console', 'tabs', 'evaluate']);
  const defs = browserToolDefs(bridge, ctx('a'))!.defs;
  assert.deepEqual(defs.filter((d) => d.readOnly).map((d) => d.name), ['snapshot', 'wait', 'screenshot', 'console']);
  for (const d of defs) assert.ok(d.description.length > 40 && d.description.length < 700, `${d.name} says what it is for, briefly`);
});

await test('opening the local app needs no card and comes back as an outline', async () => {
  const { bridge, host, sent } = rig((cmd) => ({
    ok: true,
    result: { url: String(cmd.args.url), title: 'Counter', outline: '- heading "Counter" (h1)\n- button "Add" [e1]' },
  }));
  bridge.attachHost(host, pane('about:blank'));
  const { call, free } = toolsOf(bridge, 'run1');
  assert.equal(free('navigate', { url: 'localhost:5173' }), true);
  assert.equal(browserToolDefs(bridge, ctx('run1'))!.autoAllowTool('Bash', { command: 'ls' }), false, 'only its own tools');
  const r = await call('navigate', { url: 'localhost:5173' });
  assert.equal(r.isError, undefined);
  assert.equal(sent[0].args.url, 'http://localhost:5173/', 'the pane gets the completed address');
  assert.equal(textOf(r), 'Page: Counter\nAddress: http://localhost:5173/\n\n- heading "Counter" (h1)\n- button "Add" [e1]');
});

await test('a bad address is answered by the tool and never reaches the pane', async () => {
  const { bridge, host, sent } = rig();
  bridge.attachHost(host, pane());
  const r = await toolsOf(bridge, 'run1').call('navigate', { url: 'file:///etc/passwd' });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /Only http and https/);
  assert.equal(sent.length, 0);
});

await test('another site asks first, and one yes covers that site for the run', async () => {
  let current = 'http://localhost:5173/';
  const { bridge, host } = rig((cmd) => {
    if (cmd.action === 'navigate') current = String(cmd.args.url);
    bridge.attachHost(host, pane(current));
    return { ok: true, result: { url: current, title: 'T', outline: `- text "content of ${current}"` } };
  });
  bridge.attachHost(host, pane());
  const { call, free } = toolsOf(bridge, 'run1');

  assert.equal(free('navigate', { url: 'https://example.com/' }), false, 'a card is raised');
  // The human says yes: the runtime then calls the handler.
  assert.match(textOf(await call('navigate', { url: 'https://example.com/' })), /content of https:\/\/example\.com\//);
  assert.equal(free('snapshot'), true, 'the same site does not ask again');
  assert.equal(free('click', { ref: 'e1' }), true);
  assert.equal(free('navigate', { url: 'https://example.com/pricing' }), true);
  assert.equal(free('navigate', { url: 'https://elsewhere.example/' }), false, 'a different site does');
});

await test('one yes covers a site in one browser profile, not in the others', async () => {
  // The user clears a site for the agent while the pane is in Guest, then
  // switches to the profile that is signed in there. Same address, another page.
  let who = { id: 'guest', name: 'Guest' };
  const { bridge, host } = rig((cmd) => {
    const url = cmd.action === 'navigate' ? String(cmd.args.url) : 'https://shop.example.com/';
    bridge.attachHost(host, pane(url, { profile: who }));
    return { ok: true, result: { url, title: 'Orders', profile: who.name, outline: `- text "orders of ${who.name}"` } };
  });
  bridge.attachHost(host, pane(undefined, { profile: who }));
  const { call, free } = toolsOf(bridge, 'run1');

  assert.equal(free('navigate', { url: 'https://shop.example.com/' }), false);
  const first = textOf(await call('navigate', { url: 'https://shop.example.com/' })); // the human said yes
  assert.match(first, /Browser profile: Guest/, 'the agent is told which identity it is looking through');
  assert.match(first, /orders of Guest/);
  assert.equal(free('snapshot'), true);

  who = { id: 'pa1b2c3d4e5', name: 'Petrit' };
  bridge.attachHost(host, pane('https://shop.example.com/', { profile: who }));
  assert.equal(free('snapshot'), false, 'the signed-in profile was never cleared');
  assert.equal(free('click', { ref: 'e1' }), false);
  assert.equal(free('navigate', { url: 'http://localhost:5173/' }), true, 'this machine is free in every profile');

  who = { id: 'guest', name: 'Guest' };
  bridge.attachHost(host, pane('https://shop.example.com/', { profile: who }));
  assert.equal(free('snapshot'), true, 'and back in Guest the yes still holds');
});

await test('with tabs, an agent is judged by its own tab, not the one showing', async () => {
  // The user is reading their mail in tab 1; the agent works on localhost in tab 2.
  const state = pane('https://mail.example.com/inbox', {
    tabs: [
      { id: 't1', url: 'https://mail.example.com/inbox' },
      { id: 't2', url: 'http://localhost:5173/' },
    ],
    drivers: { run1: 't2' },
  });
  const { bridge, host } = rig((cmd) => ({ ok: true, result: cmd.action === 'tabs' ? { tabs: [
    { index: 1, url: 'https://mail.example.com/inbox', title: 'Inbox (3) - me@example.com', yours: false, showing: true },
    { index: 2, url: 'http://localhost:5173/', title: 'My app', yours: true, showing: false },
  ] } : { url: 'http://localhost:5173/', title: 'My app', tab: 2, tabs: 2, outline: '- button "Go" [e1]' } }));
  bridge.attachHost(host, state);
  assert.equal(bridge.urlFor('run1'), 'http://localhost:5173/');
  assert.equal(bridge.urlFor('another-run'), 'https://mail.example.com/inbox', 'a run with no tab of its own would take the one showing');
  const mine = toolsOf(bridge, 'run1');
  const theirs = toolsOf(bridge, 'another-run');
  assert.equal(mine.free('snapshot'), true, 'its own local tab needs no card');
  assert.equal(theirs.free('snapshot'), false, 'reading the mail tab does');
  const page = textOf(await mine.call('snapshot'));
  assert.match(page, /Tab 2 of 2/);

  // Listing tabs needs no card and shows no title from a site nobody cleared.
  assert.equal(theirs.free('tabs', { do: 'list' }), true);
  const list = textOf(await theirs.call('tabs', { do: 'list' }));
  assert.match(list, /1\. \(not shown\) \| https:\/\/mail\.example\.com\/inbox \(showing\)/);
  assert.match(list, /2\. My app \| http:\/\/localhost:5173\/ \(yours\)/);
  assert.doesNotMatch(list, /me@example\.com/);
  // …and listing cleared nothing: the mail tab still asks.
  assert.equal(theirs.free('snapshot'), false);

  // A new tab is judged by the address it opens.
  assert.equal(mine.free('tabs', { do: 'new', url: 'localhost:3000' }), true);
  assert.equal(mine.free('tabs', { do: 'new', url: 'https://example.com/' }), false);
  assert.equal(mine.free('tabs', { do: 'new' }), true);
  assert.equal(mine.free('tabs', { do: 'select', tab: 1 }), true, 'switching reads nothing by itself');
});

await test('what the shell says about tabs is checked', () => {
  const { bridge, host } = rig();
  bridge.attachHost(host, {
    available: true,
    tabs: [{ id: 't1', url: 'http://localhost:1/' }, { id: 7 }, null, { id: 't2', url: 99 }, { id: 'x'.repeat(50), url: 'u'.repeat(5000) }],
    active: 'nope',
    drivers: { run1: 't2', run2: 'gone', run3: 5 },
  });
  assert.deepEqual(bridge.state.tabs, [{ id: 't1', url: 'http://localhost:1/' }, { id: 't2', url: '' }, { id: 'x'.repeat(24), url: 'u'.repeat(4000) }]);
  assert.equal(bridge.state.active, null, 'a tab that is not in the list is not showing');
  assert.deepEqual(bridge.state.drivers, { run1: 't2' }, 'only runs on tabs that exist');
});

await test('a page that lands on an uncleared site keeps its content to itself', async () => {
  const { bridge, host } = rig((cmd) => {
    // A click on the local app that redirects to a sign-in page elsewhere.
    const url = cmd.action === 'click' ? 'https://login.example.com/' : 'http://localhost:5173/';
    bridge.attachHost(host, pane(url));
    return { ok: true, result: { url, title: 'Sign in as petrit@example.com', outline: '- textbox "Password" [e1] value="hunter2"' } };
  });
  bridge.attachHost(host, pane());
  const { call, free } = toolsOf(bridge, 'run1');
  const out = textOf(await call('click', { ref: 'e4' }));
  assert.match(out, /Address: https:\/\/login\.example\.com\//);
  assert.match(out, /not cleared for you yet/);
  assert.doesNotMatch(out, /hunter2|Password|petrit@example\.com|Sign in/, 'nothing of the page leaks into the result, its title included');
  assert.equal(free('snapshot'), false, 'reading it is the next card');
});

await test('two agents both reach the pane, each as itself: the shell keeps their tabs apart', async () => {
  const { bridge, host, sent } = rig((cmd) =>
    cmd.driver.runKey === 'run-b'
      ? { ok: false, error: 'Another agent is working in the tab that is showing. Use navigate to open your page in a tab of your own.' }
      : { ok: true, result: { url: 'http://localhost:5173/', title: 'App', outline: '- button "Go" [e1]' } },
  );
  bridge.attachHost(host, pane());
  const [a, b] = await Promise.all([toolsOf(bridge, 'run-a').call('click', { ref: 'e1' }), toolsOf(bridge, 'run-b').call('click', { ref: 'e1' })]);
  assert.deepEqual(sent.map((c) => c.driver.runKey).sort(), ['run-a', 'run-b'], 'the server holds nobody back');
  assert.equal(a.isError, undefined);
  assert.equal(b.isError, true);
  assert.match(textOf(b), /^Another agent is working in the tab/, "and the shell's refusal reaches the model as it said it");
});

await test('a screenshot comes back as a picture, the console as lines', async () => {
  const { bridge, host } = rig((cmd) =>
    cmd.action === 'screenshot'
      ? { ok: true, result: { url: 'http://localhost:5173/', data: 'QUJD', mimeType: 'image/jpeg' } }
      : {
          ok: true,
          result: {
            url: 'http://localhost:5173/',
            entries: [{ level: 'error', text: 'Uncaught TypeError: x is not a function', source: 'app.js:12' }],
            failed: [{ method: 'POST', url: 'http://localhost:5173/api/save', status: 500 }],
          },
        },
  );
  bridge.attachHost(host, pane());
  const { call } = toolsOf(bridge, 'run1');
  const shot = await call('screenshot');
  assert.deepEqual(shot.content[0], { type: 'image', data: 'QUJD', mimeType: 'image/jpeg' });
  assert.equal(shot.content[1].text, 'Screenshot of http://localhost:5173/.');
  const log = textOf(await call('console'));
  assert.match(log, /\[error\] Uncaught TypeError: x is not a function {2}\(app\.js:12\)/);
  assert.match(log, /POST http:\/\/localhost:5173\/api\/save → 500/);
});

await test('the feed and the approval card describe browser calls in words', () => {
  const d = (action: string, input: Record<string, unknown>) => describeTool(`mcp__airoom-browser__${action}`, input);
  assert.deepEqual(d('navigate', { url: 'https://example.com/' }), { name: 'Browser', target: 'open https://example.com/', label: 'Browser: open https://example.com/' });
  assert.equal(d('click', { ref: 'e12', element: 'Save button' }).label, 'Browser: click Save button');
  assert.equal(d('click', { ref: 'e12' }).label, 'Browser: click e12');
  assert.equal(d('type', { ref: 'e3', text: 'secret', element: 'Password field' }).label, 'Browser: type into Password field', 'what is typed stays out of the label');
  assert.equal(d('snapshot', {}).label, 'Browser: read the page');
  assert.equal(d('tabs', { do: 'new', url: 'localhost:5173' }).label, 'Browser: open a new tab at localhost:5173');
  assert.equal(d('tabs', { do: 'select', tab: 2 }).label, 'Browser: switch to tab 2');
  assert.equal(d('tabs', { do: 'list' }).label, 'Browser: list the tabs');
  assert.equal(describeTool('Bash', { command: 'ls' }).label, 'Bash: ls', 'other tools are untouched');
});

await test('using my Chrome: the flag, the sign-in, and the same policy as the pane', () => {
  const x = chromeExtras();
  assert.deepEqual(x.extraArgs, { chrome: null }, 'that is --chrome');
  assert.equal(x.ownLogin, true, 'Claude in Chrome refuses tokens');
  assert.equal(x.mcpServers, undefined, "airoom's own tabs are not offered at the same time");
  assert.match(x.systemPromptAppend ?? '', /ask the user in a short plain message which one/);
  const site = (host: string) => [{ type: 'addRules', rules: [{ toolName: 'ClaudeInChromeDomain', ruleContent: host }], behavior: 'allow', destination: 'session' }];
  const allow = (name: string, input: Record<string, unknown> = {}, suggestions?: unknown[]) => x.autoAllowTool!(`mcp__claude-in-chrome__${name}`, input, suggestions);
  // What the runtime sent on Petrit's Mac on 15 November: navigate and read_page carry the site until it is cleared.
  assert.deepEqual(allow('navigate', { url: 'http://localhost:5391', tabId: 1 }, site('localhost:5391')), { rules: site('localhost:5391') }, 'a page on this machine opens, and its site rule comes back for the session');
  assert.deepEqual(allow('read_page', { tabId: 1 }, site('localhost:5391')), { rules: site('localhost:5391') });
  assert.equal(allow('navigate', { url: 'https://example.com/', tabId: 1 }, site('example.com')), false, 'any other site is a card');
  assert.equal(allow('read_page', { tabId: 1 }, site('example.com')), false, 'and so is reading a page the agent landed on there');
  assert.equal(allow('computer', { action: 'left_click', tabId: 1 }, site('mail.example.com')), false);
  // Once a site is cleared the runtime asks about no site, and the steps there go through.
  for (const step of ['read_page', 'get_page_text', 'find', 'form_input', 'read_console_messages', 'browser_batch'])
    assert.equal(allow(step, { tabId: 1 }, undefined), true, `${step} on a cleared site`);
  assert.equal(allow('computer', { action: 'left_click', tabId: 1 }, []), true);
  for (const code of ['javascript_tool', 'upload_image', 'file_upload']) assert.equal(allow(code, { tabId: 1 }), false, `${code} always asks`);
  assert.equal(allow('read_page', { tabId: 1 }, [{ type: 'addRules', rules: [{ toolName: 'mcp__claude-in-chrome__read_page' }] }, null, 'x']), true, 'a tool rule is not a site');
  for (const free of ['tabs_context_mcp', 'tabs_create_mcp', 'list_connected_browsers', 'switch_browser']) assert.equal(allow(free), true, free);
  assert.equal(x.autoAllowTool!('Bash', { command: 'ls' }), false, 'only the Chrome tools');
  assert.equal(allow('select_browser', { deviceId: '3c59d1bb-effc-47f2-9f73-df836bd059c1' }), true, 'Claude Code remembers the choice itself');
});

await test('whether agents can use Chrome is said in a sentence', () => {
  const out = chromeCheck({ servers: [], account: null, signedIn: false });
  assert.equal(out.state, 'problem');
  assert.match(out.text, /\/login/, 'not signed in: the way to sign in');
  const failed = chromeCheck({ servers: [{ name: 'claude-in-chrome', status: 'failed', error: 'no extension' }], account: null, signedIn: true });
  assert.match(failed.text, /did not start \(no extension\)/);
  const ready = chromeCheck({ servers: [{ name: 'claude-in-chrome', status: 'connected' }], account: { email: 'me@example.com' }, signedIn: true });
  assert.equal(ready.state, 'ready');
  assert.match(ready.text, /me@example\.com/);
});

await test('the browser setting survives a restart and a damaged file', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'airoom-bs-'));
  process.env.AIROOM_BROWSER_FILE = path.join(dir, 'browser.json');
  assert.equal(loadBrowserAgents(), 'pane', "nothing saved yet: airoom's own tabs");
  assert.equal(saveBrowserAgents('chrome'), null);
  assert.equal(loadBrowserAgents(), 'chrome');
  writeFileSync(process.env.AIROOM_BROWSER_FILE, '{"agents":"firefox"}');
  assert.equal(loadBrowserAgents(), 'pane', 'anything else is the pane');
  writeFileSync(process.env.AIROOM_BROWSER_FILE, 'not json');
  assert.equal(loadBrowserAgents(), 'pane');
  delete process.env.AIROOM_BROWSER_FILE;
  rmSync(dir, { recursive: true, force: true });
});

await test('Chrome steps are described in words, and what is typed stays out', () => {
  const d = (action: string, input: Record<string, unknown>) => describeTool(`mcp__claude-in-chrome__${action}`, input).label;
  assert.equal(d('navigate', { url: 'http://localhost:5173', tabId: 4 }), 'Chrome: open http://localhost:5173');
  assert.equal(d('computer', { action: 'left_click', coordinate: [10, 20] }), 'Chrome: left click');
  assert.equal(d('computer', { action: 'type', text: 'my password' }), 'Chrome: type text');
  assert.equal(d('computer', { action: 'key', text: 'Enter' }), 'Chrome: press Enter');
  assert.equal(d('find', { query: 'the Save button' }), 'Chrome: find the Save button');
  assert.equal(d('select_browser', { deviceId: 'x' }), 'Chrome: choose a browser');
  assert.equal(describeTool('mcp__claude-in-chrome__read_page', {}).name, 'Chrome');
});

console.log(`browser-test: ${passed} passed, ${failures.length} failed`);
for (const [name, err] of failures) console.error(`  ✗ ${name}\n    ${err.message}`);
if (failures.length) process.exit(1);
