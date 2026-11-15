// Minimal, explicit bridge between the airoom web UI and the desktop shell.
// Only what the UI genuinely needs from the OS — nothing generic.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('airoomNative', {
  /** 'darwin' | 'win32' | 'linux' — the UI reserves title-bar room per OS. */
  platform: process.platform,

  /** Open the native folder picker; resolves to an absolute path or null. */
  pickFolder: () => ipcRenderer.invoke('airoom:pick-folder'),

  /**
   * Hand a session off to Claude Code: opens a terminal in the room's folder
   * and resumes that session. Resolves {ok, cmd?, error?}.
   */
  openInClaudeCode: (cwd, sessionId) =>
    ipcRenderer.invoke('airoom:open-claude', { cwd, sessionId }),

  /**
   * The browser pane. Its presence tells the UI it runs where a pane can
   * exist. `onEvent` hears what the shell asks of the UI (BrowserShellEvent in
   * web/src/ui/BrowserPane.tsx) and returns a function that stops listening.
   */
  browser: {
    onEvent: (listener) => {
      const handler = (_event, payload) => listener(payload);
      ipcRenderer.on('airoom:browser-event', handler);
      return () => ipcRenderer.removeListener('airoom:browser-event', handler);
    },
    /**
     * Profiles, as in Chrome. `{op:'list'}` reads them; 'use', 'add',
     * 'rename', 'remove' and 'clear' change them. Resolves to
     * `{ok:true, current, profiles}`, or `{ok:false, error}` with a sentence.
     */
    profiles: (request) => ipcRenderer.invoke('airoom:browser-profiles', request),
    /**
     * Which tabs exist, which page (webContents id) each one is, which is
     * showing, whether the pane is on the stage, and which tabs were created on
     * request. The shell checks every entry against the pages it knows.
     */
    tabs: (report) => ipcRenderer.invoke('airoom:browser-tabs', report),
  },
});
