import os from 'node:os';
import path from 'node:path';
import type { BrowserAgents } from '../../../shared/types';
import { readJson, writeJsonAtomic } from '../jsonFile';

/** Where agents browse: airoom's own tabs ('pane') or the user's own Chrome. */
const file = () => process.env.AIROOM_BROWSER_FILE || path.join(os.homedir(), '.airoom', 'browser.json');

export function loadBrowserAgents(): BrowserAgents {
  return readJson<{ agents?: unknown }>(file())?.agents === 'chrome' ? 'chrome' : 'pane';
}

/** Returns why saving failed, or null. */
export function saveBrowserAgents(agents: BrowserAgents): string | null {
  try {
    writeJsonAtomic(file(), { agents });
    return null;
  } catch (err) {
    return `Could not save the browser setting: ${(err as Error).message}`;
  }
}
