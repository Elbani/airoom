import { CHROME_MCP, CHROME_TOOL_PREFIX } from '../../../shared/describeTool';
import type { ChromeCheck } from '../../../shared/types';
import type { RawMcpStatus, RunExtras } from '../agent/AgentController';
import { normalizeUrl, siteOf } from './policy';

/**
 * "Use my Chrome": agents browse in the user's own Chrome, with its profiles
 * and sign-ins, through Claude Code's Claude in Chrome integration. airoom
 * switches it on (`--chrome`), runs those agents on Claude Code's own sign-in
 * (the integration refuses tokens), and keeps its approval policy: pages on
 * this machine go through, any other site asks first.
 */

/** The CLI flag, the way the SDK passes it. */
export const CHROME_ARGS = { chrome: null };

/** Calls that read or change no page: choosing a browser, looking at its own tabs. */
const FREE = new Set(['tabs_context_mcp', 'tabs_create_mcp', 'list_connected_browsers', 'select_browser', 'switch_browser', 'shortcuts_list']);
/** Running code in a page or handing it files: always the user's call. */
const ALWAYS_ASK = new Set(['javascript_tool', 'upload_image', 'file_upload']);

/**
 * The runtime's suggested rules for a site not yet cleared this session.
 * Claude in Chrome knows which site a tab is on: a call there carries a
 * `ClaudeInChromeDomain` suggestion until the site is allowed, and none after.
 */
function siteRules(suggestions: unknown): { sites: string[]; rules: unknown[] } {
  const sites: string[] = [];
  const rules: unknown[] = [];
  for (const s of Array.isArray(suggestions) ? suggestions : []) {
    const sug = s as { type?: string; destination?: string; rules?: { toolName?: string; ruleContent?: string }[] } | null;
    if (sug?.type !== 'addRules' || !Array.isArray(sug.rules)) continue;
    const domains = sug.rules.filter((r) => r?.toolName === 'ClaudeInChromeDomain' && typeof r.ruleContent === 'string');
    if (!domains.length) continue;
    sites.push(...domains.map((r) => r.ruleContent as string));
    if (sug.destination === 'session') rules.push(sug);
  }
  return { sites, rules };
}

/** "localhost:5391" is this machine; "example.com" is not. */
function isLocalSite(hostPort: string): boolean {
  const n = normalizeUrl(hostPort);
  return n.ok && siteOf(n.url) === null;
}

const PROMPT =
  `The user's own Chrome is available through the Claude in Chrome tools (${CHROME_TOOL_PREFIX}*). It has their profiles and the sites they are signed in to. Use it whenever a task needs a browser; airoom's own browser tabs are not available in this session. ` +
  'If the Chrome tools say several browsers are connected, ask the user in a short plain message which one to use, listing them by name, then select the one they name.';

/** What a run carries while agents use the user's Chrome. */
export function chromeExtras(): RunExtras {
  return {
    extraArgs: CHROME_ARGS,
    ownLogin: true,
    systemPromptAppend: PROMPT,
    autoAllowTool: (toolName, _input, suggestions) => {
      if (!toolName.startsWith(CHROME_TOOL_PREFIX)) return false;
      const name = toolName.slice(CHROME_TOOL_PREFIX.length);
      if (FREE.has(name)) return true;
      if (ALWAYS_ASK.has(name)) return false;
      const { sites, rules } = siteRules(suggestions);
      // Asked about no site: the one this tab is on is cleared already.
      if (!sites.length) return true;
      // A site on this machine goes through, and its rule comes back for the
      // session. Any other site is the approval card, whose "always allow"
      // clears it for the session.
      return sites.every(isLocalSite) ? { rules } : false;
    },
  };
}

/** Whether agents can use the user's Chrome now, from a probe that spends no tokens. */
export function chromeCheck(probe: { servers: RawMcpStatus[]; account: { email?: string } | null; signedIn: boolean }): ChromeCheck {
  if (!probe.signedIn)
    return {
      state: 'problem',
      text: 'Claude Code is not signed in on this machine, and your Chrome needs its own sign-in. Run claude in a terminal, type /login, then choose My Chrome again.',
    };
  const chrome = probe.servers.find((s) => s.name === CHROME_MCP);
  if (chrome?.status !== 'connected')
    return {
      state: 'problem',
      text: `Claude in Chrome did not start${chrome?.error ? ` (${chrome.error.slice(0, 160)})` : ''}. Install the Claude in Chrome extension in Chrome and sign it in to the same Claude account.`,
    };
  return {
    state: 'ready',
    text: `Ready. Agents use your Chrome, on your Claude Code sign-in${probe.account?.email ? ` (${probe.account.email})` : ''}. Chrome must be open with Claude in Chrome signed in.`,
  };
}
