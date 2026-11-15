/**
 * The browser pane's shell half, the parts that need no window.
 *
 *   npx tsx scripts/browser-shell-test.ts
 *
 * desktop/browser.js is written for Electron's main process. What is proven
 * here needs only a folder to keep a file in: the profiles (which exist, which
 * is in use, where each keeps its storage, what survives a restart, what a
 * damaged file turns into) and the reading of key names.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(os.tmpdir(), 'airoom-shell-'));
const file = path.join(dir, 'browser-profiles.json');
// Stand in for Electron: the code under test asks it for one path and nothing else.
const realLoad = (Module as unknown as { _load: (...a: unknown[]) => unknown })._load;
(Module as unknown as { _load: (...a: unknown[]) => unknown })._load = function (this: unknown, request: unknown, ...rest: unknown[]) {
  if (request === 'electron') return { app: { getPath: () => dir }, ipcMain: { handle() {} }, session: {} };
  return realLoad.call(this, request, ...rest);
};
const shell = createRequire(import.meta.url)('../../desktop/browser.js') as {
  createProfiles(): {
    current(): { id: string; name: string; color: number; guest?: boolean };
    all(): { id: string; name: string; color: number }[];
    view(): { current: { id: string; name: string }; profiles: { id: string; name: string }[] };
    add(name: unknown): { id: string; name: string; color: number };
    rename(id: string, name: unknown): void;
    remove(id: string): void;
    use(id: string): void;
  };
  partitionOf(id: string): string;
  shortcutOf(input: Record<string, unknown>): string | null;
  parseKey(combo: string): { key: string; code: string; vk: number; text?: string; alt: boolean; ctrl: boolean; meta: boolean; shift: boolean };
  explain(code: string, url: string): string;
};
const saved = () => JSON.parse(readFileSync(file, 'utf8'));

let passed = 0;
const failures: Array<[string, Error]> = [];
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
  } catch (e) {
    failures.push([name, e as Error]);
  }
}

test('the first profile is there from the start, each profile on storage of its own', () => {
  const p = shell.createProfiles();
  assert.deepEqual(p.view(), { current: { id: 'default', name: 'Default', color: 0 }, profiles: [{ id: 'default', name: 'Default', color: 0 }] });
  assert.equal(shell.partitionOf('default'), 'persist:airoom-browser');
  assert.equal(shell.partitionOf('pabc123'), 'persist:airoom-browser-pabc123');
  assert.equal(shell.partitionOf('guest').startsWith('persist:'), false, 'Guest is never written to disk');
});

test('a new profile is in use at once, wears its own colour, and survives a restart', () => {
  const p = shell.createProfiles();
  const admin = p.add('  Admin  ');
  const customer = p.add('Customer');
  assert.match(admin.id, /^p[0-9a-f]{10}$/);
  assert.notEqual(admin.id, customer.id);
  assert.deepEqual([admin.name, customer.name], ['Admin', 'Customer']);
  assert.equal(new Set([0, admin.color, customer.color]).size, 3, 'three profiles, three colours');
  assert.equal(p.current().id, customer.id);
  const after = shell.createProfiles(); // the app started again
  assert.deepEqual(after.all().map((x) => x.name), ['Default', 'Admin', 'Customer']);
  assert.equal(after.current().id, customer.id, 'the profile in use is remembered');
  after.use(admin.id);
  assert.equal(saved().current, admin.id);
});

test('names are tidied, and a profile without one is refused', () => {
  const p = shell.createProfiles();
  const long = p.add(`  Night   shift\n ${'x'.repeat(80)} `);
  assert.equal(long.name.startsWith('Night shift x'), true);
  assert.equal(long.name.length, 40);
  for (const bad of ['', '   ', null, undefined]) assert.throws(() => p.add(bad), /needs a name/);
  assert.throws(() => p.rename(long.id, '  '), /needs a name/);
  p.rename(long.id, 'Night shift');
  assert.equal(p.all().find((x) => x.id === long.id)?.name, 'Night shift');
  assert.throws(() => p.rename('nope', 'x'), /No such profile/);
  p.remove(long.id);
});

test('the first profile stays; removing the one in use falls back to it', () => {
  const p = shell.createProfiles();
  const temp = p.add('Temporary');
  assert.equal(p.current().id, temp.id);
  p.remove(temp.id);
  assert.equal(p.current().id, 'default');
  assert.equal(p.all().some((x) => x.id === temp.id), false);
  assert.throws(() => p.remove('default'), /first profile stays/);
  assert.throws(() => p.remove(temp.id), /No such profile/);
  assert.throws(() => p.use('../../etc'), /No such profile/);
});

test('Guest can be used but is never remembered', () => {
  const p = shell.createProfiles();
  p.use('guest');
  assert.deepEqual(p.current(), { id: 'guest', name: 'Guest', color: -1, guest: true });
  assert.equal(p.all().some((x) => x.id === 'guest'), false, 'Guest is not one of the kept profiles');
  assert.equal(saved().current, 'default', 'the file never says Guest');
  assert.equal(shell.createProfiles().current().id, 'default', 'after a restart Guest is over');
});

test('a damaged or doctored file turns into something safe', () => {
  writeFileSync(file, '{ not json');
  assert.deepEqual(shell.createProfiles().all(), [{ id: 'default', name: 'Default', color: 0 }]);
  writeFileSync(
    file,
    JSON.stringify({
      current: 'ghost',
      profiles: [
        { id: '../../outside', name: 'Path' },
        { id: 'guest', name: 'Fake guest' },
        { id: 'pgood', name: '  Kept  ', color: 99 },
        { id: 'pgood', name: 'Twice' },
        { id: 'pnoname', name: '   ' },
        'nonsense',
        null,
      ],
    }),
  );
  const p = shell.createProfiles();
  assert.deepEqual(p.all(), [{ id: 'default', name: 'Default', color: 0 }, { id: 'pgood', name: 'Kept', color: 3 }], 'only well-formed profiles are kept, and the first profile is put back');
  assert.equal(p.current().id, 'default', 'a profile in use that does not exist is not in use');
  for (const x of p.all()) assert.match(shell.partitionOf(x.id), /^persist:airoom-browser(-[a-z0-9]+)?$/, 'an id can never name storage outside the pane');
});

test('there is a limit to how many profiles there can be', () => {
  writeFileSync(file, JSON.stringify({ current: 'default', profiles: [] }));
  const p = shell.createProfiles();
  for (let i = 1; i < 24; i++) p.add(`Profile ${i}`);
  assert.equal(p.all().length, 24);
  assert.throws(() => p.add('One too many'), /Remove one first/);
});

test('key names are read the way people write them', () => {
  const k = shell.parseKey;
  const none = { alt: false, ctrl: false, meta: false, shift: false };
  assert.deepEqual(k('Enter'), { key: 'Enter', code: 'Enter', vk: 13, text: '\r', ...none });
  assert.deepEqual(k('enter'), k('Return'));
  assert.deepEqual(k('Shift+Tab'), { key: 'Tab', code: 'Tab', vk: 9, text: undefined, ...none, shift: true });
  assert.deepEqual(k('esc'), k('Escape'));
  assert.deepEqual(k('a'), { key: 'a', code: 'KeyA', vk: 65, text: 'a', ...none });
  assert.deepEqual(k('Shift+a'), { key: 'A', code: 'KeyA', vk: 65, text: 'A', ...none, shift: true });
  assert.equal(k('Control+A').text, undefined, 'with Control held, a key is a shortcut and types nothing');
  assert.deepEqual(k('Control+Alt+Delete'), { ...k('Delete'), ctrl: true, alt: true });
  const mod = k('Mod+k');
  assert.equal(process.platform === 'darwin' ? mod.meta : mod.ctrl, true, 'Mod is Command on a Mac and Control elsewhere');
  assert.equal(k('Control++').key, '+');
  assert.equal(k('Space').key, ' ');
  assert.equal(k('F5').vk, 116);
  assert.throws(() => k('Hyper+x'), /not a modifier key/);
  assert.throws(() => k('Banana'), /not a key name/);
});

test("Chrome's tab keys, pressed inside a page, are read as the app's", () => {
  const mac = process.platform === 'darwin';
  const press = (key: string, more: Record<string, unknown> = {}) =>
    shell.shortcutOf({ type: 'keyDown', key, code: '', alt: false, shift: false, meta: mac, control: !mac, ...more });
  for (const k of ['t', 'w', 'l', 'r', 'k', 'j']) assert.equal(press(k), k, k);
  assert.equal(press('T'), 't', 'the case of the letter does not matter');
  assert.equal(press('3'), '3');
  assert.equal(press('0'), null, 'only 1 to 9 pick a tab');
  assert.equal(press('a'), null, 'select-all stays the page\'s');
  assert.equal(press('c'), null, 'and so does copy');
  assert.equal(press('[', { shift: true, code: 'BracketLeft' }), 'prev');
  assert.equal(press(']', { shift: true, code: 'BracketRight' }), 'next');
  assert.equal(press('R', { shift: true, code: 'KeyR' }), 'r', 'a hard reload reloads the tab, not airoom');
  assert.equal(press('T', { shift: true, code: 'KeyT' }), null);
  assert.equal(shell.shortcutOf({ type: 'keyDown', key: 'Tab', control: true, shift: false, meta: false, alt: false }), 'next');
  assert.equal(shell.shortcutOf({ type: 'keyDown', key: 'Tab', control: true, shift: true, meta: false, alt: false }), 'prev');
  assert.equal(shell.shortcutOf({ type: 'keyDown', key: 't', control: false, shift: false, meta: false, alt: false }), null, 'a plain t is typing');
  assert.equal(press('t', { alt: true }), null);
  assert.equal(press('t', { type: 'keyUp' }), null, 'only on the way down');
});

test('a page that will not load is explained in words an agent can act on', () => {
  assert.match(shell.explain('ERR_CONNECTION_REFUSED', 'http://localhost:5173/app'), /Nothing is listening at http:\/\/localhost:5173\. Is the dev server running/);
  assert.match(shell.explain('ERR_NAME_NOT_RESOLVED', 'https://nope.example/'), /could not be found/);
  assert.match(shell.explain('ERR_CERT_AUTHORITY_INVALID', 'https://localhost:8443/'), /certificate problem/);
  assert.match(shell.explain('ERR_SOMETHING_ELSE', 'https://x.example/'), /ERR_SOMETHING_ELSE/);
});

rmSync(dir, { recursive: true, force: true });
console.log(`browser-shell-test: ${passed} passed, ${failures.length} failed`);
for (const [name, err] of failures) console.error(`  ✗ ${name}\n    ${err.message}`);
if (failures.length) process.exit(1);
