/**
 * Long transcripts, against a real transcript tree.
 *
 *   npx tsx scripts/transcript-scale-test.ts
 *
 * A session that reads screenshots writes them into its transcript as base64,
 * and a long one reaches hundreds of megabytes while it is still being
 * appended to every few seconds. The office is built from those files. This
 * proves the promises that keep it standing: a transcript is never held whole
 * in memory, a session that only grew is only read where it grew, a file that
 * was rewritten is noticed, and a line still being written is neither lost nor
 * counted twice.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, truncateSync, writeFileSync, openSync, writeSync, closeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tmp = process.env.SCALE_TMP ?? mkdtempSync(path.join(os.tmpdir(), 'airoom-scale-'));
const root = path.join(tmp, 'projects');
const home = path.join(tmp, 'home');
mkdirSync(root, { recursive: true });
mkdirSync(home, { recursive: true });
// Same reason as agent-removal-test: the datasource keeps its config under the
// home directory, and a test must never read or write the real one.
process.env.HOME = home;
process.env.USERPROFILE = home;

const { LocalClaudeDataSource } = await import('../src/datasource/LocalClaudeDataSource');
const { createSessionParse, parseSession } = await import('../src/parse/sessionParser');

const CWD = '/work/shop';
const DIR = path.join(root, CWD.replace(/[/._]/g, '-'));
mkdirSync(DIR, { recursive: true });
let n = 0;
const stamp = () => new Date(Date.now() - 60_000 + n * 10).toISOString();
const user = (text: string) => JSON.stringify({ type: 'user', uuid: `u${++n}`, timestamp: stamp(), cwd: CWD, message: { role: 'user', content: text } });
const reply = (text: string) => JSON.stringify({ type: 'assistant', uuid: `a${++n}`, timestamp: stamp(), cwd: CWD, message: { role: 'assistant', model: 'm', content: [{ type: 'text', text }] } });
/** A turn that carries a screenshot: the reason transcripts get big. */
const shot = (uuid: string, bytes: number, fill = 'A') =>
  JSON.stringify({ type: 'user', uuid, timestamp: stamp(), cwd: CWD, message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: fill.repeat(bytes) } }] } });
const file = (id: string) => path.join(DIR, `${id}.jsonl`);
const robotOf = async (source: InstanceType<typeof LocalClaudeDataSource>, id: string) => (await source.getSnapshot()).robots.find((r) => r.sessionId === id);
const lastLabel = async (source: InstanceType<typeof LocalClaudeDataSource>, id: string) => (await source.getTranscript(id, 5)).steps.at(-1)?.label;

// ---- the child half of the memory test: build a snapshot under a small heap ----
if (process.argv[2] === 'child') {
  const source = new LocalClaudeDataSource(root);
  const snap = await source.getSnapshot();
  const big = snap.robots.find((r) => r.sessionId === 'big');
  const t = await source.getTranscript('big', 3);
  const img = await source.getSessionImage('big', 'beef0001:0');
  console.log(JSON.stringify({ messages: big?.messageCount, last: t.steps.at(-1)?.label, image: img?.data.length, read: source.stats() }));
  await source.close();
  process.exit(0);
}

let passed = 0;
const failures: Array<[string, Error]> = [];
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push([name, err as Error]);
    console.log(`  FAIL ${name}\n       ${(err as Error).message}`);
  }
}

await test('fed a record at a time, a session reads exactly as it does whole', () => {
  const lines = [user('build the shop'), reply('on it'), user('add a cart'), reply('done')];
  const whole = parseSession(lines.join('\n'), 's1', path.basename(DIR));
  const parse = createSessionParse('s1', path.basename(DIR));
  for (const l of lines.slice(0, 2)) parse.add(JSON.parse(l));
  assert.equal(parse.robot()?.messageCount, 2, 'the robot can be asked for part way');
  for (const l of lines.slice(2)) parse.add(JSON.parse(l));
  assert.deepEqual(parse.robot(), whole);
  assert.equal(parse.steps().length, 4);
  for (const junk of [null, 42, 'text', [], undefined]) parse.add(junk);
  assert.deepEqual(parse.robot(), whole, 'anything that is not a record is ignored');
});

await test('a session that only grew is only read where it grew', async () => {
  const source = new LocalClaudeDataSource(root);
  writeFileSync(file('grow'), [user('first'), reply('one')].join('\n') + '\n');
  assert.equal((await robotOf(source, 'grow'))?.messageCount, 2);
  const before = source.stats();
  assert.equal(before.fullReads >= 1, true);

  const added = [user('second'), reply('two')].join('\n') + '\n';
  appendFileSync(file('grow'), added);
  assert.equal((await robotOf(source, 'grow'))?.messageCount, 4);
  const after = source.stats();
  assert.equal(after.fullReads, before.fullReads, 'not read from the top again');
  assert.equal(after.appends, before.appends + 1);
  assert.equal(after.bytes - before.bytes, Buffer.byteLength(added), 'exactly the appended bytes were read');

  // Nothing changed: nothing is read.
  assert.equal((await robotOf(source, 'grow'))?.messageCount, 4);
  assert.deepEqual(source.stats(), after);
  // A desk keeps only its last few steps. The chat panel keeps them all, so
  // it reads the file once for itself, and after that only what is new.
  assert.equal(await lastLabel(source, 'grow'), 'two');
  const chat = source.stats();
  assert.equal(chat.fullReads, after.fullReads + 1);
  assert.equal(await lastLabel(source, 'grow'), 'two');
  assert.deepEqual(source.stats(), chat, 'asking again costs nothing');
  await source.close();
});

await test('a line still being written is neither lost nor counted twice', async () => {
  const source = new LocalClaudeDataSource(root);
  const next = reply('the answer');
  writeFileSync(file('torn'), user('question') + '\n' + next.slice(0, 40));
  assert.equal((await robotOf(source, 'torn'))?.messageCount, 1, 'half a line is not a record yet');
  appendFileSync(file('torn'), next.slice(40) + '\n');
  assert.equal((await robotOf(source, 'torn'))?.messageCount, 2);
  assert.equal(await lastLabel(source, 'torn'), 'the answer');
  assert.equal((await source.getTranscript('torn', 50)).steps.length, 2, 'once, not twice');

  // A last line with no newline at all is still a record, and still only one
  // when the newline and more arrive later.
  appendFileSync(file('torn'), user('and then?'));
  assert.equal((await robotOf(source, 'torn'))?.messageCount, 3);
  appendFileSync(file('torn'), '\n' + reply('then this') + '\n');
  assert.equal((await robotOf(source, 'torn'))?.messageCount, 4);
  assert.deepEqual((await source.getTranscript('torn', 50)).steps.map((s) => s.label), ['question', 'the answer', 'and then?', 'then this']);
  await source.close();
});

await test('multi-byte text split across read chunks comes out intact', async () => {
  const source = new LocalClaudeDataSource(root);
  // The file is read a megabyte at a time. Place a reply so that the chunk
  // boundary falls in the middle of one of its four-byte characters.
  const word = 'ok 🙂🙂 ç 好 fine';
  const answer = reply(word);
  const cut = Buffer.byteLength(answer.slice(0, answer.indexOf('🙂'))) + 2; // two bytes into the first 🙂
  const empty = user('');
  const fill = (1 << 20) - cut - (Buffer.byteLength(empty) + 1);
  const filler = empty.replace('"content":""', `"content":"${'x'.repeat(fill)}"`);
  assert.equal(Buffer.byteLength(filler) + 1 + cut, 1 << 20, 'the boundary is where the test says it is');
  writeFileSync(file('utf8'), filler + '\n' + answer + '\n');
  assert.equal((await robotOf(source, 'utf8'))?.messageCount, 2);
  const last = (await source.getTranscript('utf8', 5)).steps.at(-1)?.label;
  assert.equal(last, word, 'no character was cut in half');
  await source.close();
});

await test('a file rewritten in place is noticed, even though it also grew', async () => {
  const source = new LocalClaudeDataSource(root);
  writeFileSync(file('rewrite'), [user('old question'), reply('old answer')].join('\n') + '\n');
  assert.equal((await robotOf(source, 'rewrite'))?.title, 'old question');
  const full = source.stats().fullReads;
  // Same file, longer, different from the first byte on: what a compaction does.
  writeFileSync(file('rewrite'), [user('a summary of everything so far'), reply('carrying on'), user('next'), reply('ok')].join('\n') + '\n');
  const robot = await robotOf(source, 'rewrite');
  assert.equal(robot?.title, 'a summary of everything so far');
  assert.equal(robot?.messageCount, 4);
  assert.equal(source.stats().fullReads, full + 1, 'read from the top, not appended to the old parse');
  assert.deepEqual((await source.getTranscript('rewrite', 50)).steps.map((s) => s.label), ['a summary of everything so far', 'carrying on', 'next', 'ok']);

  // The tail rewritten while the head stays: caught by the bytes before where reading stopped.
  const head = user('same head, long enough to fill the comparison window '.repeat(8));
  writeFileSync(file('tail'), [head, reply('first ending')].join('\n') + '\n');
  assert.equal(await lastLabel(source, 'tail'), 'first ending');
  writeFileSync(file('tail'), [head, reply('other ending'), reply('and more')].join('\n') + '\n');
  assert.deepEqual((await source.getTranscript('tail', 50)).steps.slice(1).map((s) => s.label), ['other ending', 'and more']);

  // A file that shrank cannot be an append.
  truncateSync(file('tail'), Buffer.byteLength(head) + 1);
  assert.equal((await robotOf(source, 'tail'))?.messageCount, 1);
  await source.close();
});

await test('snapshots asked for at once share one read of each file', async () => {
  // Every client that connects asks for a snapshot, and so does every change
  // on disk. Three at once used to mean three copies of the same transcript.
  const alone = path.join(tmp, 'projects-alone');
  const dir = path.join(alone, CWD.replace(/[/._]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const only = path.join(dir, 'twice.jsonl');
  writeFileSync(only, [user('hello'), reply('hi')].join('\n') + '\n');
  const source = new LocalClaudeDataSource(alone);
  const snaps = await Promise.all([source.getSnapshot(), source.getSnapshot(), source.getSnapshot()]);
  for (const snap of snaps) assert.equal(snap.robots.find((r) => r.sessionId === 'twice')?.messageCount, 2);
  assert.deepEqual(source.stats(), { bytes: statSync(only).size, fullReads: 1, appends: 0 });
  await source.close();
});

await test('an image is found without reading past its record', async () => {
  const source = new LocalClaudeDataSource(root);
  const lines = [user('look'), shot('ea110001', 2000, 'B'), reply('seen'), shot('1a7e0002', 300_000, 'C'), reply('done')];
  writeFileSync(file('img'), lines.join('\n') + '\n');
  const before = source.stats().bytes;
  const img = await source.getSessionImage('img', 'ea110001:0');
  assert.equal(img?.media, 'image/png');
  assert.equal(img?.data.length, Buffer.from('B'.repeat(2000), 'base64').length);
  assert.equal(source.stats().bytes, before, 'looking up an image is not a parse');
  assert.equal(await source.getSessionImage('img', 'ea110001:1'), null, 'no such block');
  assert.equal(await source.getSessionImage('img', '00000000:0'), null, 'no such record');
  assert.equal((await source.getSessionImage('img', '1a7e0002:0'))?.data.length, Buffer.from('C'.repeat(300_000), 'base64').length);
  await source.close();
});

await test('a 96 MB transcript is read inside a 96 MB heap', async () => {
  // 48 screenshots of 2 MB each between ordinary turns. Read whole, this file
  // alone is the entire heap before a single line of it is parsed.
  const fd = openSync(file('big'), 'w');
  writeSync(fd, user('take screenshots') + '\n');
  for (let i = 0; i < 48; i++) {
    writeSync(fd, shot(i === 30 ? 'beef0001' : `5407${String(i).padStart(4, '0')}`, 2 * 1024 * 1024) + '\n');
    writeSync(fd, reply(`looked at ${i}`) + '\n');
  }
  closeSync(fd);
  assert.equal(statSync(file('big')).size > 96 * 1024 * 1024, true);
  const child = spawnSync(process.execPath, [...process.execArgv, '--max-old-space-size=96', fileURLToPath(import.meta.url), 'child'], {
    env: { ...process.env, SCALE_TMP: tmp },
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert.equal(child.status, 0, `the reader ran out of memory or failed:\n${(child.stderr || '').split('\n').slice(0, 6).join('\n')}`);
  const out = JSON.parse(child.stdout.trim().split('\n').at(-1) ?? '{}');
  assert.equal(out.messages, 49, 'every turn was counted');
  assert.equal(out.last, 'looked at 47');
  assert.equal(out.image, Buffer.from('A'.repeat(2 * 1024 * 1024), 'base64').length, 'and a screenshot can still be fetched');
});

rmSync(tmp, { recursive: true, force: true });
console.log(`transcript-scale-test: ${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
