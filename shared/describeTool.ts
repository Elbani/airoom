/**
 * ONE description of a tool call, shared by every producer.
 *
 * There used to be three of these (the transcript parser, the SDK controller
 * and the CLI controller), each truncating to a different length and only one
 * of them appending an ellipsis. Because the live/transcript reconciler in
 * useFleet matches on the label text, a Bash command longer than the shortest
 * cap could never reconcile — the same tool call rendered twice for the whole
 * run. Producers now emit identical, UNtruncated text; shortening is a
 * rendering decision made in the client.
 */

export interface ToolDescription {
  /** Tool name as the SDK reports it, e.g. "Bash", "Edit". */
  name: string;
  /** What the tool is acting on, untruncated: a command, path, pattern, url. */
  target: string;
  /** One-line label for places that need a flat string (status lines, tooltips). */
  label: string;
}

const FILE_TOOLS = new Set(['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/** airoom's own browser tabs, as an in-process MCP server. */
export const BROWSER_MCP = 'airoom-browser';
export const BROWSER_TOOL_PREFIX = `mcp__${BROWSER_MCP}__`;
/** Claude Code's Claude in Chrome: the user's own Chrome. */
export const CHROME_MCP = 'claude-in-chrome';
export const CHROME_TOOL_PREFIX = `mcp__${CHROME_MCP}__`;

/** "mcp__claude-in-chrome__navigate" + {url} → "open https://…". What is typed stays out. */
function describeChrome(action: string, inp: Record<string, unknown>): string {
  if (action === 'navigate') return `open ${str(inp.url)}`;
  if (action === 'computer') {
    const a = str(inp.action);
    if (a === 'type') return 'type text';
    if (a === 'key') return `press ${str(inp.text)}`;
    if (a === 'screenshot') return 'take a screenshot';
    if (a === 'scroll' || a === 'scroll_to') return 'scroll';
    if (/click/.test(a)) return a.replace(/_/g, ' ');
    return a ? a.replace(/_/g, ' ') : 'act on the page';
  }
  if (action === 'find') return `find ${str(inp.query)}`;
  if (action === 'form_input') return 'fill in a form field';
  if (action === 'read_page') return 'read the page';
  if (action === 'get_page_text') return 'read the page text';
  if (action === 'javascript_tool') return 'run JavaScript in the page';
  if (action === 'tabs_context_mcp') return 'look at its tabs';
  if (action === 'tabs_create_mcp') return 'open a tab';
  if (action === 'tabs_close_mcp') return 'close a tab';
  if (action === 'read_console_messages') return 'read the console';
  if (action === 'read_network_requests') return 'read the network requests';
  if (action === 'list_connected_browsers') return 'list the connected browsers';
  if (action === 'select_browser' || action === 'switch_browser') return 'choose a browser';
  if (action === 'browser_batch') return 'take several steps';
  if (action === 'gif_creator') return 'record a GIF';
  if (action === 'resize_window') return 'resize the window';
  if (action === 'upload_image' || action === 'file_upload') return 'upload a file';
  return action.replace(/_/g, ' ');
}

/** "mcp__airoom-browser__click" + {element: 'Save'} → "click Save". */
function describeBrowser(action: string, inp: Record<string, unknown>): string {
  const what = str(inp.element) || str(inp.ref);
  if (action === 'navigate') return `open ${str(inp.url)}`;
  if (action === 'click') return `${inp.double ? 'double-click' : 'click'} ${what}`.trim();
  if (action === 'type') return `type into ${what}`.trim();
  if (action === 'select') return `choose ${str(inp.value)} in ${what}`.trim();
  if (action === 'press') return `press ${str(inp.key)}`;
  if (action === 'scroll') return what ? `scroll to ${what}` : `scroll ${str(inp.direction) || 'down'}`;
  if (action === 'wait') return inp.text ? `wait for "${str(inp.text)}"` : inp.gone ? `wait for "${str(inp.gone)}" to go` : 'wait';
  if (action === 'evaluate') return `run ${str(inp.expression).replace(/\s+/g, ' ')}`;
  if (action === 'snapshot') return 'read the page';
  if (action === 'screenshot') return 'take a screenshot';
  if (action === 'console') return 'read the console';
  if (action === 'tabs') {
    const t = inp.tab != null ? ` ${str(inp.tab)}` : '';
    if (inp.do === 'new') return inp.url ? `open a new tab at ${str(inp.url)}` : 'open a new tab';
    if (inp.do === 'select') return `switch to tab${t}`;
    if (inp.do === 'close') return `close tab${t}`.trim();
    return 'list the tabs';
  }
  return action;
}

export function describeTool(name: string, input: unknown): ToolDescription {
  const inp = (input ?? {}) as Record<string, unknown>;
  let shown = name;
  let target = '';

  if (name.startsWith(CHROME_TOOL_PREFIX)) {
    shown = 'Chrome';
    target = describeChrome(name.slice(CHROME_TOOL_PREFIX.length), inp);
  } else if (name.startsWith(BROWSER_TOOL_PREFIX)) {
    shown = 'Browser';
    target = describeBrowser(name.slice(BROWSER_TOOL_PREFIX.length), inp);
  } else if (name === 'Bash') target = str(inp.command).replace(/\s*\n\s*/g, ' ').trim();
  else if (FILE_TOOLS.has(name)) target = str(inp.file_path || inp.notebook_path);
  else if (name === 'Grep') target = str(inp.pattern);
  else if (name === 'Glob') target = str(inp.pattern);
  else if (name === 'Task' || name === 'Agent') target = str(inp.description || inp.subagent_type);
  else if (name === 'WebFetch') target = str(inp.url);
  else if (name === 'WebSearch') target = str(inp.query);
  else if (name === 'AskUserQuestion')
    // the real shape is { questions: [{ question, ... }] }
    target = str((Array.isArray(inp.questions) ? (inp.questions[0] as any)?.question : '') || inp.question);
  else if (name === 'ExitPlanMode') target = str(inp.plan).split('\n')[0];
  else if (name === 'TodoWrite') {
    const todos = Array.isArray(inp.todos) ? inp.todos : [];
    const active = todos.find((t: any) => t?.status === 'in_progress') ?? todos[0];
    target = active ? str(active.content ?? active.activeForm) : `${todos.length} items`;
  }

  // Cap for the wire: this text rides in every snapshot broadcast, and a
  // pasted heredoc command can be tens of kilobytes. 400 is far more than any
  // row renders, so the client still truncates purely visually.
  if (target.length > 400) target = `${target.slice(0, 399)}…`;
  return { name: shown, target, label: target ? `${shown}: ${target}` : shown };
}
