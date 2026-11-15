import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { BROWSER_MCP, BROWSER_TOOL_PREFIX } from '../../../shared/describeTool';
import type { BrowserAction, BrowserDriver } from '../../../shared/types';
import type { RunExtras, RunExtrasContext } from '../agent/AgentController';
import type { BrowserBridge } from './BrowserBridge';
import { approvalKey, HISTORY_WORDS, judgedSite, needsApproval, normalizeUrl, siteOf } from './policy';

/**
 * The tools an agent drives the browser pane with, built per run so every
 * handler knows which agent is calling (and so which tab is its own).
 */

/** How much of a page outline rides along with an action's result. */
const OUTLINE_AFTER_ACTION = 8_000;
const OUTLINE_ON_REQUEST = 30_000;

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
type ToolResult = { content: Content[]; isError?: boolean };

const say = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

interface PageResult {
  url?: string;
  title?: string;
  /** The browser profile the page was seen in, when there is more than one. */
  profile?: string;
  /** Which tab, counted from 1, when more than one is open. */
  tab?: number;
  tabs?: number;
  outline?: string;
  truncated?: boolean;
  note?: string;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** One tool, before it is handed to the SDK. Kept plain so tests can call the handler. */
export interface BrowserToolDef {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
  /** Reads the page without changing it. */
  readOnly?: boolean;
}

const READ_ONLY = new Set(['snapshot', 'screenshot', 'console', 'wait']);

/** The tools and their policy for one run, or null when no shell is connected. */
export function browserToolDefs(
  bridge: BrowserBridge,
  ctx: RunExtrasContext,
): { defs: BrowserToolDef[]; autoAllowTool: NonNullable<RunExtras['autoAllowTool']> } | null {
  // No shell, no pane: the tools would only ever answer "not available".
  if (!bridge.connected) return null;
  const def = (name: string, description: string, schema: z.ZodRawShape, handler: BrowserToolDef['handler']): BrowserToolDef => ({
    name,
    description,
    schema,
    handler,
    readOnly: READ_ONLY.has(name),
  });

  /** Sites this run has been cleared for, per browser profile: by an approval card, or by a mode that does not ask. */
  const approved = new Set<string>();
  const profile = () => bridge.state.profile?.id;
  const driver = (): BrowserDriver => ({ runKey: ctx.runKey, sessionId: ctx.sessionId(), roomId: ctx.roomId });
  /** The site of a page nobody cleared for this run yet, or null. */
  const uncleared = (url: string) => {
    const site = siteOf(url);
    return site !== null && !approved.has(approvalKey(site, profile())) ? site : null;
  };

  /** Address and title, then the outline, unless the page is on a site nobody cleared yet. */
  const describe = (r: PageResult, cap: number): string => {
    const site = uncleared(str(r.url));
    const withheld = site !== null;
    // A title is content too: a mail tab's title carries an address.
    const lines = [`Page: ${withheld ? '(not shown)' : r.title || '(no title)'}`, `Address: ${r.url || 'about:blank'}`];
    if (r.profile) lines.push(`Browser profile: ${r.profile}`);
    if (r.tab && r.tabs) lines.push(`Tab ${r.tab} of ${r.tabs}`);
    if (r.note) lines.push(r.note);
    if (withheld) {
      lines.push(
        '',
        `This page is on ${site}, which the user has not cleared for you yet, so its content is not shown. Call snapshot to ask.`,
      );
      return lines.join('\n');
    }
    if (r.outline != null) {
      const outline = r.outline.length > cap ? `${r.outline.slice(0, cap)}\n… (cut here; call snapshot for the whole page)` : r.outline;
      lines.push('', outline || '(the page is empty)');
      if (r.truncated && r.outline.length <= cap) lines.push('… (the page is longer than this outline)');
    }
    return lines.join('\n');
  };

  /**
   * Run one command. Reaching a handler at all means the call was allowed, by
   * the policy, a card or the run's mode, so the site it was judged by is
   * cleared from here on.
   */
  const run = async (action: BrowserAction, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown> => {
    const site = judgedSite(action, args, bridge.urlFor(ctx.runKey));
    if (site) approved.add(approvalKey(site, profile()));
    return bridge.run(action, args, driver(), timeoutMs);
  };

  const guard = (fn: (args: Record<string, unknown>) => Promise<ToolResult>) => async (args: Record<string, unknown>) => {
    try {
      return await fn(args);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  };

  /** The common shape: act, then say what the page looks like now. */
  const act = (action: BrowserAction, timeoutMs?: number) =>
    guard(async (args) => say(describe((await run(action, { ...args, max: OUTLINE_AFTER_ACTION }, timeoutMs)) as PageResult, OUTLINE_AFTER_ACTION)));

  const ref = z.string().min(1).describe('The ref of the element from the latest outline, for example e12.');
  const element = z.string().optional().describe('What the element is, in a few words. The user sees this.');

  const defs = [
    def(
      'navigate',
      'Open a page in airoom\'s browser pane: a real browser inside the app, which the user can watch. Use it to try the web app you are working on. Pass an address such as http://localhost:5173, or "back", "forward" or "reload". Returns the address, the title and an outline of the page. Every element you can act on carries a ref like [e12]; pass that ref to click, type, select or scroll. You work in a tab of your own; a page someone else has open is never replaced. Pages on this machine open freely; other sites ask the user first.',
      { url: z.string().min(1).describe('An address, or "back", "forward" or "reload".') },
      guard(async (args) => {
        const raw = str(args.url).trim();
        let url = raw;
        if (!HISTORY_WORDS.has(raw)) {
          const n = normalizeUrl(raw);
          if (!n.ok) return fail(n.error);
          url = n.url;
        }
        return say(describe((await run('navigate', { url, max: OUTLINE_AFTER_ACTION }, 45_000)) as PageResult, OUTLINE_AFTER_ACTION));
      }),
    ),
    def(
      'snapshot',
      'Read the page that is open in the browser pane: its address, title and an outline of the visible content, with a ref like [e12] on every element you can act on. Refs stay valid until the page changes. Take a new snapshot whenever an action answers that a ref is unknown.',
      {},
      guard(async () => say(describe((await run('snapshot', { max: OUTLINE_ON_REQUEST })) as PageResult, OUTLINE_ON_REQUEST))),
    ),
    def(
      'click',
      'Click an element in the browser pane, by its ref. Returns the page outline after the click.',
      { ref, element, double: z.boolean().optional().describe('Double-click instead.') },
      act('click'),
    ),
    def(
      'type',
      'Type text into a field in the browser pane (an input, a textarea or an editable element), replacing what was there. Returns the page outline afterwards.',
      {
        ref,
        text: z.string(),
        element,
        submit: z.boolean().optional().describe('Press Enter afterwards.'),
        append: z.boolean().optional().describe('Keep what the field already holds and add to it.'),
      },
      act('type'),
    ),
    def(
      'select',
      'Choose an option in a dropdown (a select element) in the browser pane, by its label or its value.',
      { ref, value: z.string().describe('The option to choose: its visible label, or its value.'), element },
      act('select'),
    ),
    def(
      'press',
      'Press a key in the browser pane, for example Enter, Escape, Tab, ArrowDown or Control+A. The key goes to whatever has focus on the page.',
      { key: z.string().min(1).describe('A key name, optionally with modifiers joined by +, such as Shift+Tab.') },
      act('press'),
    ),
    def(
      'scroll',
      'Scroll the page in the browser pane, or bring one element into view by its ref.',
      { direction: z.enum(['down', 'up', 'top', 'bottom']).optional(), ref: ref.optional(), element },
      act('scroll'),
    ),
    def(
      'wait',
      'Wait in the browser pane until some text appears on the page, until some text is gone, or for a number of seconds. Use it after an action that loads something.',
      {
        text: z.string().optional().describe('Wait until this text is on the page.'),
        gone: z.string().optional().describe('Wait until this text is no longer on the page.'),
        seconds: z.number().min(0).max(30).optional().describe('How long to wait at most. Default 10.'),
      },
      guard(async (args) => {
        const seconds = typeof args.seconds === 'number' ? args.seconds : 10;
        const r = (await run('wait', { ...args, seconds, max: OUTLINE_AFTER_ACTION }, seconds * 1000 + 10_000)) as PageResult & { met?: boolean };
        const what = args.text ? `"${str(args.text)}" to appear` : args.gone ? `"${str(args.gone)}" to go away` : null;
        const note = what ? (r.met ? `Done waiting for ${what}.` : `Gave up after ${seconds} seconds waiting for ${what}.`) : `Waited ${seconds} seconds.`;
        return say(describe({ ...r, note }, OUTLINE_AFTER_ACTION));
      }),
    ),
    def(
      'screenshot',
      'Take a picture of the browser pane, to check layout and appearance. For reading text or finding elements use snapshot instead: it is far cheaper and gives you refs.',
      {},
      guard(async () => {
        const r = (await run('screenshot', {})) as PageResult & { data?: string; mimeType?: string };
        if (!r.data) return fail('The browser pane returned no picture.');
        return {
          content: [
            { type: 'image', data: r.data, mimeType: r.mimeType || 'image/jpeg' },
            { type: 'text', text: `Screenshot of ${r.url || 'the page'}.` },
          ],
        };
      }),
    ),
    def(
      'console',
      'Read what the page in the browser pane wrote to its console, uncaught errors included, and the network requests that failed. Look here when something on the page does not work.',
      { clear: z.boolean().optional().describe('Empty the log after reading it.') },
      guard(async (args) => {
        const r = (await run('console', args)) as {
          url?: string;
          entries?: { level?: string; text?: string; source?: string }[];
          failed?: { method?: string; url?: string; status?: number; error?: string }[];
        };
        const out = [`Address: ${r.url || 'about:blank'}`];
        const entries = r.entries ?? [];
        out.push('', entries.length ? `Console (${entries.length}):` : 'Console: nothing was logged.');
        for (const e of entries) out.push(`[${e.level || 'log'}] ${str(e.text).slice(0, 1200)}${e.source ? `  (${e.source})` : ''}`);
        const failed = r.failed ?? [];
        out.push('', failed.length ? `Failed requests (${failed.length}):` : 'Failed requests: none.');
        for (const f of failed) out.push(`${f.method || 'GET'} ${f.url} → ${f.status ?? f.error ?? 'failed'}`);
        return say(out.join('\n'));
      }),
    ),
    def(
      'tabs',
      'Work with the browser pane\'s tabs, as in Chrome. "list" shows them all; "new" opens a tab (at an address, if you give one) and makes it yours; "select" switches to a tab by its number and makes it yours; "close" closes a tab you opened. You always act on your own tab: the one you opened, or the one that was showing when you first used the pane. A tab another agent is working in stays theirs. A link that opens a new window opens a new tab, and you follow it there.',
      {
        do: z.enum(['list', 'new', 'select', 'close']),
        tab: z.number().int().min(1).optional().describe('For select and close: the tab\'s number, counted from 1 as "list" shows them. close without it closes your own tab.'),
        url: z.string().optional().describe('For new: the address to open in it.'),
      },
      guard(async (args) => {
        if (args.do === 'new' && str(args.url)) {
          const n = normalizeUrl(str(args.url));
          if (!n.ok) return fail(n.error);
          args = { ...args, url: n.url };
        }
        const r = (await run('tabs', { ...args, max: OUTLINE_AFTER_ACTION }, 45_000)) as PageResult & { tabs?: unknown };
        if (!Array.isArray(r.tabs)) return say(describe(r, OUTLINE_AFTER_ACTION));
        // The list. A tab on a site nobody cleared yet shows its address, not its title.
        const lines = (r.tabs as { index: number; url: string; title: string; yours: boolean; showing: boolean }[]).map((t) => {
          const title = uncleared(t.url) ? '(not shown)' : t.title || '(no title)';
          const marks = [t.yours ? 'yours' : '', t.showing ? 'showing' : ''].filter(Boolean).join(', ');
          return `${t.index}. ${title} | ${t.url || 'about:blank'}${marks ? ` (${marks})` : ''}`;
        });
        return say([r.note, `Tabs (${lines.length}):`, ...lines].filter(Boolean).join('\n'));
      }),
    ),
    def(
      'evaluate',
      'Run a JavaScript expression in the page that is open in the browser pane and get its result back as JSON. For state the outline does not show, such as localStorage or a computed style.',
      { expression: z.string().min(1).describe('An expression, or an async arrow function body wrapped as (async () => { … })().') },
      guard(async (args) => {
        const r = (await run('evaluate', args, 20_000)) as { value?: string };
        const value = str(r.value);
        return say(value.length > 12_000 ? `${value.slice(0, 12_000)}\n… (cut: the result was ${value.length} characters)` : value || 'undefined');
      }),
    ),
  ];

  return {
    defs,
    autoAllowTool: (toolName, input) =>
      toolName.startsWith(BROWSER_TOOL_PREFIX) &&
      !needsApproval(toolName.slice(BROWSER_TOOL_PREFIX.length), input, { currentUrl: bridge.urlFor(ctx.runKey), approved, profile: profile() }),
  };
}

/** What a run carries: the tools as an in-process MCP server, and their policy. */
export function browserExtras(bridge: BrowserBridge, ctx: RunExtrasContext): RunExtras | null {
  const built = browserToolDefs(bridge, ctx);
  if (!built) return null;
  const tools = built.defs.map((d) =>
    tool(d.name, d.description, d.schema, d.handler, d.readOnly ? { annotations: { readOnlyHint: true } } : undefined),
  );
  return {
    // Always loaded: a model that has to search for a tool spends more turns than the tools cost.
    mcpServers: { [BROWSER_MCP]: createSdkMcpServer({ name: BROWSER_MCP, version: '1.0.0', tools, alwaysLoad: true }) },
    autoAllowTool: built.autoAllowTool,
  };
}
