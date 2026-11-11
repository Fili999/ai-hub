// The packaged apps: the user's hub folder and safe upgrades, what ships in the app, the launcher, and the idle shutdown.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { MANIFEST_FILE, STATE_FILE, buildManifest, dataDir, syncManaged } from '../scripts/lib/appdata.mjs';
import { BLANK_FILES, shippedFiles, stageHub } from '../packaging/build.mjs';
import { startServer } from '../ui/server.mjs';
import { REPO, cleanupAfter, makeHub, mktmp, write } from './helpers.mjs';

cleanupAfter();

/** A fake "app bundle" with the given files, and its manifest. */
function makeShipped(files, version = '1.0.0') {
  const dir = mktmp();
  for (const [rel, text] of Object.entries(files)) write(dir, rel, text);
  fs.writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify(buildManifest(dir, Object.keys(files), version)));
  return dir;
}
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');

test('dataDir: "AI Hub" in the home folder, or AI_HUB_HOME', () => {
  assert.equal(dataDir({ env: {}, home: '/home/ana' }), path.join('/home/ana', 'AI Hub'));
  assert.equal(dataDir({ env: { AI_HUB_HOME: '/x/y' }, home: '/home/ana' }), path.resolve('/x/y'));
});

test('syncManaged: first run copies everything and records it', () => {
  const src = makeShipped({ 'a.txt': 'A', 'skills/own/s/SKILL.md': 'S' });
  const dest = path.join(mktmp(), 'hub');
  const r = syncManaged(src, dest);
  assert.deepEqual(r.copied.sort(), ['a.txt', 'skills/own/s/SKILL.md']);
  assert.equal(read(dest, 'skills/own/s/SKILL.md'), 'S');
  assert.ok(JSON.parse(read(dest, STATE_FILE)).files['a.txt']);
  assert.equal(syncManaged(src, dest).skipped, true, 'same version again: nothing to do');
});

test('syncManaged: an update replaces untouched files, keeps user changes, does not resurrect deleted files, drops obsolete ones', () => {
  const dest = path.join(mktmp(), 'hub');
  syncManaged(makeShipped({ 'same.txt': '1', 'plain.txt': 'old', 'edited.txt': 'old', 'deleted.txt': 'old', 'gone.txt': 'old', 'gone-edited.txt': 'old' }, '1.0.0'), dest);

  fs.writeFileSync(path.join(dest, 'edited.txt'), 'MINE');
  fs.writeFileSync(path.join(dest, 'gone-edited.txt'), 'MINE TOO');
  fs.rmSync(path.join(dest, 'deleted.txt'));
  write(dest, 'my-own-skill/SKILL.md', 'user content'); // not shipped: never touched

  const r = syncManaged(makeShipped({ 'same.txt': '1', 'plain.txt': 'new', 'edited.txt': 'new', 'deleted.txt': 'new', 'fresh.txt': 'new' }, '1.1.0'), dest);
  assert.equal(read(dest, 'plain.txt'), 'new');
  assert.equal(read(dest, 'edited.txt'), 'MINE');
  assert.ok(!fs.existsSync(path.join(dest, 'deleted.txt')));
  assert.equal(read(dest, 'fresh.txt'), 'new');
  assert.ok(!fs.existsSync(path.join(dest, 'gone.txt')), 'obsolete and untouched: removed');
  assert.equal(read(dest, 'gone-edited.txt'), 'MINE TOO', 'obsolete but edited: kept');
  assert.equal(read(dest, 'my-own-skill/SKILL.md'), 'user content');
  assert.deepEqual(r.kept, ['edited.txt']);
  assert.equal(JSON.parse(read(dest, STATE_FILE)).version, '1.1.0');
});

test('syncManaged: without a manifest (source checkout) it does nothing', () => {
  const src = mktmp();
  write(src, 'a.txt', 'A');
  const dest = path.join(mktmp(), 'hub');
  assert.equal(syncManaged(src, dest).skipped, true);
  assert.ok(!fs.existsSync(dest));
});

test('stageHub: ships the program and built-in skills, nothing personal, and a correct manifest', () => {
  const dest = path.join(mktmp(), 'stage');
  const manifest = stageHub(dest);
  const files = Object.keys(manifest.files);
  for (const must of ['ui/server.mjs', 'scripts/app-launcher.mjs', 'scripts/lib/appdata.mjs', 'i18n/en.json', 'hub.config.json', 'memory/README.md', ...Object.keys(BLANK_FILES)]) {
    assert.ok(files.includes(must), `${must} should ship`);
  }
  assert.ok(files.some((f) => f.startsWith('skills/own/orchestrator/')));
  for (const f of files) assert.ok(!/^(tests|packaging|site|dist|\.cache|\.git\/|archify|graphify|\.agents)/.test(f) && !f.endsWith('.zip') && !f.endsWith('.DS_Store'), `${f} must not ship`);
  assert.ok(files.filter((f) => f.startsWith('memory/')).every((f) => f === 'memory/README.md'), 'personal notes never ship');
  assert.deepEqual(JSON.parse(read(dest, 'teams.json')), BLANK_FILES['teams.json']);
  assert.equal(JSON.parse(read(dest, MANIFEST_FILE)).id, manifest.id);
  assert.equal(JSON.parse(read(dest, MANIFEST_FILE)).version, JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version);
  assert.ok(shippedFiles().length > 20);
});

test('stageHub: refuses to empty a folder that is not a previous staging, or that holds the repository', () => {
  const busy = mktmp();
  write(busy, 'precious.txt', 'keep me');
  assert.throws(() => stageHub(busy), /Refusing/);
  assert.equal(read(busy, 'precious.txt'), 'keep me');
  assert.throws(() => stageHub(path.dirname(REPO)), /Refusing/);
});

test('server: idle shutdown fires only when no page is connected', async () => {
  const root = makeHub();
  let idle = 0;
  const app = await startServer({ root, port: 0, quiet: true, idleExitMs: 300, onIdle: () => idle++ });
  try {
    // a connected page (the interface keeps /api/events open) keeps the hub alive
    const ctl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${app.port}/api/events?t=${app.token}`, { signal: ctl.signal });
    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 900));
    assert.equal(idle, 0, 'a page is connected');
    ctl.abort();
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(idle, 1, 'page closed: shuts down after the delay');
  } finally {
    await app.close();
  }
});

test('server: without idleExitMs it never shuts itself down', async () => {
  const app = await startServer({ root: makeHub(), port: 0, quiet: true, onIdle: () => assert.fail('must not fire') });
  await new Promise((r) => setTimeout(r, 400));
  await app.close();
});

test('launcher: seeds the hub folder, serves, reopens instead of duplicating, and stops by itself', async () => {
  const stage = path.join(mktmp(), 'app-hub');
  stageHub(stage);
  const home = path.join(mktmp(), 'AI Hub');
  const env = { ...process.env, AI_HUB_HOME: home, AI_HUB_LANG: 'en' };
  const launcher = path.join(stage, 'scripts', 'app-launcher.mjs');
  const first = spawn(process.execPath, [launcher, '--no-open', '--idle-minutes', '0.1'], { env, stdio: 'ignore' });
  const exited = new Promise((resolve) => first.on('exit', resolve));
  try {
    const runtimeFile = path.join(home, '.tmp', 'app.json');
    for (let i = 0; i < 100 && !fs.existsSync(runtimeFile); i++) await new Promise((r) => setTimeout(r, 100));
    const rt = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
    assert.equal(rt.pid, first.pid);
    const health = await (await fetch(new URL('api/health', rt.url))).json();
    assert.equal(health.name, 'ai-hub-ui');
    assert.ok(fs.existsSync(path.join(home, 'ui', 'server.mjs')), 'the hub was copied to the user folder');
    assert.ok(fs.existsSync(path.join(home, STATE_FILE)));

    // second launch while running: opens/ends at once, no second server
    const second = spawn(process.execPath, [launcher, '--no-open'], { env, stdio: 'ignore' });
    assert.equal(await new Promise((resolve) => second.on('exit', resolve)), 0);
    assert.equal(JSON.parse(fs.readFileSync(runtimeFile, 'utf8')).pid, first.pid);

    // nobody opened a page: it stops by itself (6 s) and cleans up
    assert.equal(await exited, 0);
    assert.ok(!fs.existsSync(runtimeFile));
  } finally {
    first.kill();
  }
});
