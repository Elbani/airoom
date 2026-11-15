/**
 * A stand-in server for trying the browser pane against a real desktop shell,
 * with no agent in the loop and no tokens spent.
 *
 *   # 1. build the UI once:            npm run build --prefix web
 *   # 2. this, in one terminal:        PORT=8797 npx tsx scripts/browser-harness.ts
 *   # 3. the shell, in another:        AIROOM_PORT=8797 npm start --prefix ../desktop -- --user-data-dir=/tmp/airoom-dev
 *   # 4. call the same handlers an agent would:
 *   curl -s -X POST 'http://127.0.0.1:8797/tool?name=navigate' -d '{"url":"localhost:5391"}'
 *   curl -s -X POST 'http://127.0.0.1:8797/tool?name=click&as=other-run' -d '{"ref":"e1"}'
 *
 * The shell finds an "airoom server" on its port, loads the real UI from it
 * and announces its pane, exactly as it does against the real server. What
 * comes back from /tool is what the model would have been given.
 */
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { BrowserBridge } from '../src/browser/BrowserBridge';
import { browserToolDefs } from '../src/browser/tools';
import { BROWSER_TOOL_PREFIX } from '../../shared/describeTool';

const PORT = Number(process.env.PORT ?? 8797);
const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
const ROOM = process.env.HARNESS_ROOM ?? '/tmp/airoom-harness';
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

const bridge = new BrowserBridge((host, msg) => (host as WebSocket).send(JSON.stringify(msg)));

/** One set of tools per pretend run, kept so its cleared sites persist across calls. */
const runs = new Map<string, NonNullable<ReturnType<typeof browserToolDefs>>>();
function toolsFor(run: string) {
  let t = runs.get(run);
  if (!t) {
    const built = browserToolDefs(bridge, { roomId: ROOM, runKey: run, sessionId: () => `session-${run}` });
    if (!built) return null;
    runs.set(run, (t = built));
  }
  return t;
}

const body = (req: http.IncomingMessage) =>
  new Promise<string>((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const json = (code: number, value: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value, null, 2));
  };
  if (url.pathname === '/health') return json(200, { ok: true, engine: { harness: true, authToken: 'harness', claudeBin: '/harness/claude' }, busy: { runs: 0, teams: 0 }, browser: bridge.status(), pane: bridge.state });
  if (url.pathname === '/tool' && req.method === 'POST') {
    const tools = toolsFor(url.searchParams.get('as') ?? 'run1');
    if (!tools) return json(503, { error: 'no shell is connected' });
    const name = url.searchParams.get('name') ?? '';
    const def = tools.defs.find((d) => d.name === name);
    if (!def) return json(404, { error: `no tool ${name}`, tools: tools.defs.map((d) => d.name) });
    const args = JSON.parse((await body(req)) || '{}');
    const free = tools.autoAllowTool(`${BROWSER_TOOL_PREFIX}${name}`, args);
    const started = Date.now();
    const r = await def.handler(args);
    return json(200, {
      wouldAsk: !free,
      ms: Date.now() - started,
      isError: !!r.isError,
      text: r.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('\n'),
      images: r.content.filter((c) => c.type === 'image').map((c) => ({ mimeType: (c as { mimeType: string }).mimeType, data: (c as { data: string }).data })),
    });
  }
  // the built UI
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.normalize(path.join(WEB, rel));
  if (file.startsWith(WEB)) {
    try {
      const data = await fs.readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
      return res.end(data);
    } catch {
      /* fall through */
    }
  }
  json(404, { error: 'not found' });
});

const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  // Enough of an office for the UI to come up: one room, one idle agent.
  ws.send(
    JSON.stringify({
      v: 1,
      type: 'snapshot',
      snapshot: {
        rooms: [{ id: ROOM, name: 'harness', path: ROOM, robotCount: 1, needsAttention: false }],
        robots: [
          { sessionId: 'session-run1', roomId: ROOM, title: 'Try the counter shop', status: 'idle', currentAction: '', lastActivity: new Date().toISOString(), messageCount: 1, recentSteps: [], name: 'Mira' },
        ],
        teams: [],
        away: [],
        generatedAt: new Date().toISOString(),
        curated: true,
      },
    }),
  );
  ws.on('message', (data) => {
    let msg: { type?: string; state?: unknown };
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === 'browserHost') {
      bridge.attachHost(ws, msg.state);
      console.log('[harness] pane:', JSON.stringify(bridge.state));
    } else if (msg.type === 'browserResult') bridge.onResult(ws, msg as never);
  });
  ws.on('close', () => bridge.detachHost(ws));
});

server.listen(PORT, '127.0.0.1', () => console.log(`[harness] http://127.0.0.1:${PORT}  (UI from ${WEB})`));
