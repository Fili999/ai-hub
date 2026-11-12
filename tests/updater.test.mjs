// In-app updates: discovery, verification (checksum, manifest, archive entries, hosts, Node version), applying without
// overwriting the user's files, rollback, lock, modes, and the server routes. GitHub is simulated: nothing touches the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, cleanupAfter, mktmp, snapshotTree, write } from './helpers.mjs';
import { MANIFEST_FILE, STATE_FILE, buildManifest, cmpVersion, syncManaged } from '../scripts/lib/appdata.mjs';
import { ARCHIVE_NAME, SUMS_NAME, UpdateError, applyUpdate, checkForUpdate, createUpdater, sumFor } from '../scripts/lib/updater.mjs';
import { acquireHubLock, HubLockError } from '../scripts/lib/hublock.mjs';
import { commandPath } from '../scripts/lib/util.mjs';
import { startServer } from '../ui/server.mjs';

cleanupAfter();
const hasTar = Boolean(commandPath('tar'));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

const pkg = (version, extra = {}) => JSON.stringify({ name: 'ai-hub', version, repository: { type: 'git', url: 'git+https://github.com/o/r.git' }, engines: { node: '>=22' }, ...extra });

/** A folder shaped like what the app ships: files + app-manifest.json. */
function shipped(version, files, { manifestExtra = {} } = {}) {
  const dir = mktmp();
  const all = { 'package.json': pkg(version), ...files };
  for (const [rel, text] of Object.entries(all)) write(dir, rel, text);
  const manifest = buildManifest(dir, Object.keys(all), version);
  Object.assign(manifest.files, manifestExtra);
  fs.writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify(manifest));
  return dir;
}
/** The user's hub after the app copied version `v1` into it. */
const installed = (v1files, version = '0.1.0') => {
  const src = shipped(version, v1files);
  const root = mktmp();
  syncManaged(src, root);
  return root;
};
const tarOf = (dir) => {
  const out = path.join(mktmp(), ARCHIVE_NAME);
  const r = spawnSync(commandPath('tar'), ['-czf', out, '-C', dir, '.'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return fs.readFileSync(out);
};

const json = (o) => new Response(JSON.stringify(o), { status: 200 });
/** A fake GitHub: the API, the release assets (behind a redirect, like the real one) and a call log. */
function github({ version, archive, sums, assetsOverride, release = {}, redirectTo = 'https://objects.githubusercontent.com/blob', onAsset, renamedTo = null } = {}) {
  const calls = [];
  const base = `https://github.com/o/${renamedTo ?? 'r'}/releases/download/v${version}/`;
  const assets = assetsOverride ?? [{ name: ARCHIVE_NAME, browser_download_url: base + ARCHIVE_NAME }, { name: SUMS_NAME, browser_download_url: base + SUMS_NAME }];
  const fetchImpl = async (url) => {
    const u = String(url);
    calls.push(u);
    // a renamed repository: the old name answers with a redirect, like GitHub does
    if (renamedTo && u === 'https://api.github.com/repos/o/r/releases/latest') return new Response(null, { status: 301, headers: { location: 'https://api.github.com/repositories/42/releases/latest' } });
    if (u === 'https://api.github.com/repos/o/r/releases/latest' || u === 'https://api.github.com/repositories/42/releases/latest') return json({ tag_name: `v${version}`, draft: false, prerelease: false, body: 'Notes', assets, ...release });
    if (u.startsWith(base)) return new Response(null, { status: 302, headers: { location: `${redirectTo}/${u.slice(base.length)}` } });
    if (u.startsWith(`${redirectTo}/`)) {
      const name = u.slice(redirectTo.length + 1);
      onAsset?.(name);
      return new Response(name === SUMS_NAME ? sums : archive, { status: 200 });
    }
    return new Response('not found', { status: 404 });
  };
  return { fetchImpl, calls };
}
/** Archive + checksum for a new version, and the fake GitHub serving them. */
function release(version, files, opts = {}) {
  const dir = shipped(version, files, opts);
  const archive = tarOf(dir);
  const sums = `${sha256(archive)}  ${ARCHIVE_NAME}\n${'0'.repeat(64)}  ai-hub-macos.zip\n`;
  return { dir, archive, sums, ...github({ version, archive, sums, ...opts.github }) };
}
const noTmp = (root) => Object.fromEntries(Object.entries(snapshotTree(root)).filter(([k]) => !k.startsWith('.tmp')));
const V1 = { 'scripts/run.mjs': 'v1', 'docs/a.md': 'a1', 'ui/page.html': 'p1', 'GUIDE.md': 'g1' };

test('cmpVersion: numeric, not textual', () => {
  assert.equal(cmpVersion('0.1.10', '0.1.9'), 1);
  assert.equal(cmpVersion('v1.0.0', '1'), 0);
  assert.equal(cmpVersion('0.1.2', '0.2.0'), -1);
  assert.equal(cmpVersion('garbage', '0.0.0'), 0);
});

test('sumFor: reads the checksum of one file, ignores look-alikes and malformed lines', () => {
  const h = 'a'.repeat(64);
  assert.equal(sumFor(`${h}  ${ARCHIVE_NAME}\n`, ARCHIVE_NAME), h);
  assert.equal(sumFor(`${h} *${ARCHIVE_NAME}\r\n`, ARCHIVE_NAME), h);
  assert.equal(sumFor(`${h}  x-${ARCHIVE_NAME}\n${h}  ${ARCHIVE_NAME}.sig\nzz  ${ARCHIVE_NAME}\n`, ARCHIVE_NAME), null);
});

// ---------------------------------------------------------------- check
test('check: newer release is available and applicable; same or older is not; results are cached 12 hours', { skip: !hasTar }, async () => {
  const root = installed(V1);
  const r2 = release('0.1.5', { ...V1, 'scripts/run.mjs': 'v2' });
  const a = await checkForUpdate(root, { fetchImpl: r2.fetchImpl });
  assert.deepEqual([a.current, a.latest, a.available, a.canApply, a.error], ['0.1.0', '0.1.5', true, true, null]);
  assert.equal(a.url, 'https://github.com/o/r/releases/tag/v0.1.5');
  assert.equal(r2.calls.length, 1);
  await checkForUpdate(root, { fetchImpl: r2.fetchImpl });
  assert.equal(r2.calls.length, 1, 'cached: no second request');
  await checkForUpdate(root, { fetchImpl: r2.fetchImpl, force: true });
  assert.equal(r2.calls.length, 2, 'force asks again');
  await checkForUpdate(root, { fetchImpl: r2.fetchImpl, now: Date.now() + 13 * 3600 * 1000 });
  assert.equal(r2.calls.length, 3, 'cache expires');
  for (const v of ['0.1.0', '0.0.9']) {
    const same = await checkForUpdate(root, { fetchImpl: github({ version: v }).fetchImpl, force: true });
    assert.equal(same.available, false, v);
  }
});

test('check and apply: a repository renamed after the app was built still updates (owner is what counts)', { skip: !hasTar }, async () => {
  const root = installed(V1); // its package.json says github.com/o/r
  const dir = shipped('0.1.5', { ...V1, 'scripts/run.mjs': 'v2' });
  const archive = tarOf(dir);
  const g = github({ version: '0.1.5', archive, sums: `${sha256(archive)}  ${ARCHIVE_NAME}`, renamedTo: 'r-renamed' });
  const c = await checkForUpdate(root, { fetchImpl: g.fetchImpl });
  assert.equal(c.canApply, true, c.error);
  assert.equal(c.url, 'https://github.com/o/r-renamed/releases/tag/v0.1.5');
  await applyUpdate(root, { fetchImpl: g.fetchImpl });
  assert.equal(fs.readFileSync(path.join(root, 'scripts/run.mjs'), 'utf8'), 'v2');
  // a different OWNER is not the same project: notice only
  const other = github({ version: '0.1.5', archive, sums: 'x', assetsOverride: [{ name: ARCHIVE_NAME, browser_download_url: `https://github.com/someone-else/r/releases/download/v0.1.5/${ARCHIVE_NAME}` }, { name: SUMS_NAME, browser_download_url: `https://github.com/someone-else/r/releases/download/v0.1.5/${SUMS_NAME}` }] });
  assert.equal((await checkForUpdate(installed(V1), { fetchImpl: other.fetchImpl })).canApply, false);
});

test('check: a copy that is not an installed app (git clone, classic bundle) is told, never changed', { skip: !hasTar }, async () => {
  const root = mktmp();
  write(root, 'package.json', pkg('0.1.0'));
  const r2 = release('0.2.0', V1);
  const c = await checkForUpdate(root, { fetchImpl: r2.fetchImpl });
  assert.equal(c.available, true);
  assert.equal(c.canApply, false);
  await assert.rejects(() => applyUpdate(root, { fetchImpl: r2.fetchImpl }), (e) => e instanceof UpdateError && /cannot update itself/i.test(e.message));
});

test('check: offline, bad answers, drafts, odd tags and foreign asset URLs never throw and never offer an update to apply', async () => {
  const root = installed(V1);
  const offline = await checkForUpdate(root, { fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); }, force: true });
  assert.equal(offline.available, false);
  assert.match(offline.error, /ENOTFOUND/);
  const bad = [
    github({ version: '9.9.9', release: { draft: true } }),
    github({ version: '9.9.9', release: { prerelease: true } }),
    github({ version: '9.9.9', release: { tag_name: 'latest' } }),
    github({ version: '9.9.9', release: { tag_name: 'v9.9.9; rm -rf /' } }),
    github({ version: '9.9.9', release: { tag_name: '../v9.9.9' } }),
    { fetchImpl: async () => new Response('<html>', { status: 200 }) },
    { fetchImpl: async () => new Response('{}', { status: 500 }) },
  ];
  for (const g of bad) {
    const c = await checkForUpdate(root, { fetchImpl: g.fetchImpl, force: true });
    assert.equal(c.available, false);
    assert.ok(c.error);
  }
  // assets that point anywhere but this repository's release download path are not used
  const evil = github({ version: '9.9.9', assetsOverride: [{ name: ARCHIVE_NAME, browser_download_url: 'https://evil.example/x.tar.gz' }, { name: SUMS_NAME, browser_download_url: 'https://github.com/other/repo/releases/download/v9.9.9/SHA256SUMS.txt' }] });
  const c = await checkForUpdate(root, { fetchImpl: evil.fetchImpl, force: true });
  assert.equal(c.available, true);
  assert.equal(c.canApply, false, 'no usable archive: notice only');
  // a hub that does not say where it comes from asks nobody
  const anon = mktmp();
  write(anon, 'package.json', '{"version":"0.0.1"}');
  assert.match((await checkForUpdate(anon, { fetchImpl: evil.fetchImpl })).error, /repository/i);
});

// ---------------------------------------------------------------- apply
test('apply: updates what the app copied, keeps what you changed, never brings back what you deleted, never touches your data', { skip: !hasTar }, async () => {
  const root = installed({ ...V1, 'docs/deleted.md': 'd', 'docs/mine.md': 'orig' });
  write(root, 'docs/mine.md', 'MY EDIT'); // you changed it
  fs.rmSync(path.join(root, 'docs', 'deleted.md')); // you deleted it
  write(root, 'registry.json', '{"mine":true}');
  write(root, 'settings.json', '{"mine":true}');
  write(root, 'skills/external/x/SKILL.md', 'external');
  write(root, 'memory/lessons/n.md', 'note');
  const r2 = release('0.1.5', {
    ...V1, 'scripts/run.mjs': 'v2', 'ui/page.html': 'p2', 'docs/new.md': 'new', 'docs/deleted.md': 'd2', 'docs/mine.md': 'THEIR EDIT',
    // things an update must never touch even if the archive lists them
    'registry.json': '{"hostile":true}', 'settings.json': '{"hostile":true}', 'skills/external/x/SKILL.md': 'hostile', 'agents/own/a.md': 'hostile', 'memory/lessons/n.md': 'hostile', 'manifest.lock.json': '{"hostile":true}',
  });
  const before = noTmp(root);
  const res = await applyUpdate(root, { fetchImpl: r2.fetchImpl });
  assert.deepEqual([res.from, res.to], ['0.1.0', '0.1.5']);
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  assert.equal(read('scripts/run.mjs'), 'v2');
  assert.equal(read('ui/page.html'), 'p2');
  assert.equal(read('docs/new.md'), 'new');
  assert.equal(JSON.parse(read('package.json')).version, '0.1.5');
  assert.equal(read('docs/mine.md'), 'MY EDIT', 'your edit survives');
  assert.equal(fs.existsSync(path.join(root, 'docs', 'deleted.md')), false, 'a file you deleted stays deleted');
  assert.equal(read('registry.json'), '{"mine":true}');
  assert.equal(read('settings.json'), '{"mine":true}');
  assert.equal(read('skills/external/x/SKILL.md'), 'external');
  assert.equal(read('memory/lessons/n.md'), 'note');
  assert.equal(fs.existsSync(path.join(root, 'agents')), false);
  assert.equal(fs.existsSync(path.join(root, 'manifest.lock.json')), false);
  assert.equal(JSON.parse(read(STATE_FILE)).version, '0.1.5');
  // cleanup: no staging left, lock released, and the next check says "up to date"
  assert.deepEqual(fs.readdirSync(path.join(root, '.tmp')).filter((n) => /^update-(?!check)/.test(n)), []);
  assert.equal(fs.existsSync(path.join(root, '.tmp', 'locks', 'hub.lock')), false);
  assert.equal((await checkForUpdate(root, { fetchImpl: r2.fetchImpl })).available, false);
  assert.ok(Object.keys(before).length > 0);
});

test('apply: the old downloaded app cannot undo an in-app update at its next start (no downgrade)', { skip: !hasTar }, async () => {
  const oldApp = shipped('0.1.0', V1);
  const root = mktmp();
  syncManaged(oldApp, root);
  await applyUpdate(root, { fetchImpl: release('0.1.5', { ...V1, 'scripts/run.mjs': 'v2' }).fetchImpl });
  const after = noTmp(root);
  const again = syncManaged(oldApp, root); // what app-launcher does at every start, with the OLD files inside the app
  assert.equal(again.skipped, true);
  assert.deepEqual(noTmp(root), after);
  assert.equal(fs.readFileSync(path.join(root, 'scripts/run.mjs'), 'utf8'), 'v2');
  // a NEWER app still updates normally
  const newerApp = shipped('0.2.0', { ...V1, 'scripts/run.mjs': 'v3' });
  assert.equal(syncManaged(newerApp, root).skipped, false);
  assert.equal(fs.readFileSync(path.join(root, 'scripts/run.mjs'), 'utf8'), 'v3');
});

test('syncManaged dry run: reports the plan and writes nothing', () => {
  const root = installed(V1);
  const next = shipped('0.2.0', { ...V1, 'scripts/run.mjs': 'v2', 'docs/new.md': 'n' });
  const before = snapshotTree(root);
  const plan = syncManaged(next, root, { dry: true });
  assert.deepEqual([plan.updated.includes('scripts/run.mjs'), plan.copied.includes('docs/new.md')], [true, true]);
  assert.deepEqual(snapshotTree(root), before);
  const empty = path.join(mktmp(), 'new-hub');
  syncManaged(next, empty, { dry: true });
  assert.equal(fs.existsSync(empty), false, 'a dry run does not even create the folder');
});

test('apply: a checksum that does not match stops everything before any file is written', { skip: !hasTar }, async () => {
  const root = installed(V1);
  const r2 = release('0.1.5', { ...V1, 'scripts/run.mjs': 'v2' });
  const swapped = github({ version: '0.1.5', archive: tarOf(shipped('0.1.5', { ...V1, 'scripts/run.mjs': 'EVIL' })), sums: r2.sums });
  const before = noTmp(root);
  await assert.rejects(() => applyUpdate(root, { fetchImpl: swapped.fetchImpl }), (e) => e instanceof UpdateError && /checksum/i.test(e.message));
  assert.deepEqual(noTmp(root), before);
  const noLine = github({ version: '0.1.5', archive: r2.archive, sums: `${'0'.repeat(64)}  other.zip\n` });
  await assert.rejects(() => applyUpdate(root, { fetchImpl: noLine.fetchImpl }), /no checksum/i);
  assert.deepEqual(noTmp(root), before);
});

test('apply: a file that differs from its own manifest, or a manifest path that escapes, is refused', { skip: !hasTar }, async () => {
  const root = installed(V1);
  const before = noTmp(root);
  // manifest hash does not match the file
  const bad = shipped('0.1.5', { ...V1, 'scripts/run.mjs': 'v2' });
  fs.writeFileSync(path.join(bad, 'scripts/run.mjs'), 'TAMPERED AFTER HASHING');
  const archive = tarOf(bad);
  await assert.rejects(() => applyUpdate(root, { fetchImpl: github({ version: '0.1.5', archive, sums: `${sha256(archive)}  ${ARCHIVE_NAME}` }).fetchImpl }), /own file list/i);
  // manifest key leaves the hub
  for (const key of ['../escape.txt', '/etc/passwd', 'a/../../b', 'C:\\x']) {
    const dir = shipped('0.1.5', V1, { manifestExtra: { [key]: 'a'.repeat(40) } });
    const arc = tarOf(dir);
    await assert.rejects(() => applyUpdate(root, { fetchImpl: github({ version: '0.1.5', archive: arc, sums: `${sha256(arc)}  ${ARCHIVE_NAME}` }).fetchImpl }), (e) => e instanceof UpdateError, key);
  }
  // manifest of another version
  const other = shipped('0.9.9', V1);
  const arc2 = tarOf(other);
  await assert.rejects(() => applyUpdate(root, { fetchImpl: github({ version: '0.1.5', archive: arc2, sums: `${sha256(arc2)}  ${ARCHIVE_NAME}` }).fetchImpl }), /own file list/i);
  assert.deepEqual(noTmp(root), before);
  assert.equal(fs.existsSync(path.join(path.dirname(root), 'escape.txt')), false);
});

test('apply: symlinks and absolute entries in the archive are refused (POSIX)', { skip: !hasTar || process.platform === 'win32' }, async () => {
  const root = installed(V1);
  const before = noTmp(root);
  const withLink = shipped('0.1.5', { ...V1, 'scripts/run.mjs': 'v2' });
  fs.symlinkSync('/etc/hosts', path.join(withLink, 'docs', 'link.md'));
  const arc = tarOf(withLink);
  await assert.rejects(() => applyUpdate(root, { fetchImpl: github({ version: '0.1.5', archive: arc, sums: `${sha256(arc)}  ${ARCHIVE_NAME}` }).fetchImpl }), /unsafe file/i);
  // an archive with an absolute path inside it: rejected from the listing, before anything is extracted
  const victimDir = mktmp();
  write(victimDir, 'abs.txt', 'x');
  const out = path.join(mktmp(), 'abs.tar.gz');
  assert.equal(spawnSync(commandPath('tar'), ['-czPf', out, path.join(victimDir, 'abs.txt')]).status, 0);
  const abs = fs.readFileSync(out);
  await assert.rejects(() => applyUpdate(root, { fetchImpl: github({ version: '0.1.5', archive: abs, sums: `${sha256(abs)}  ${ARCHIVE_NAME}` }).fetchImpl }), /unsafe file|archive/i);
  assert.deepEqual(noTmp(root), before);
});

test('apply: downloads only over https from GitHub hosts, with redirects checked and a size cap', { skip: !hasTar }, async () => {
  const root = installed(V1);
  const r2 = release('0.1.5', { ...V1, 'scripts/run.mjs': 'v2' });
  const before = noTmp(root);
  for (const redirectTo of ['https://evil.example/blob', 'http://objects.githubusercontent.com/blob', 'https://githubusercontent.com.evil.example/blob', 'https://notgithub.com/blob']) {
    const g = github({ version: '0.1.5', archive: r2.archive, sums: r2.sums, redirectTo });
    await assert.rejects(() => applyUpdate(root, { fetchImpl: g.fetchImpl }), /Refused to download|https/i, redirectTo);
  }
  // too many redirects
  let n = 0;
  const loop = async (url) => {
    if (String(url).startsWith('https://api.github.com')) return github({ version: '0.1.5' }).fetchImpl(url);
    return new Response(null, { status: 302, headers: { location: `https://github.com/o/r/releases/download/v0.1.5/loop${n++}` } });
  };
  await assert.rejects(() => applyUpdate(root, { fetchImpl: loop }), /redirects/i);
  // declared size over the cap, and an endless body
  const huge = async (url) => {
    if (String(url).startsWith('https://api.github.com')) return github({ version: '0.1.5' }).fetchImpl(url);
    return new Response('x', { status: 200, headers: { 'content-length': String(500 * 1024 * 1024) } });
  };
  await assert.rejects(() => applyUpdate(root, { fetchImpl: huge }), /larger than allowed/i);
  assert.deepEqual(noTmp(root), before);
});

test('apply: a release that needs a newer Node.js than the app has is not installed', { skip: !hasTar }, async () => {
  const root = installed(V1);
  const r2 = release('0.1.5', { 'scripts/run.mjs': 'v2', 'package.json': pkg('0.1.5', { engines: { node: '>=99' } }) });
  const before = noTmp(root);
  await assert.rejects(() => applyUpdate(root, { fetchImpl: r2.fetchImpl }), /Node\.js 99/);
  assert.deepEqual(noTmp(root), before);
});

test('apply: if copying fails half way, every changed file is put back and new ones are removed', { skip: !hasTar }, async () => {
  const root = installed(V1);
  write(root, 'zz/sub', 'a plain FILE where the update wants a folder'); // the last new file cannot be created
  const before = noTmp(root);
  const r2 = release('0.1.5', { ...V1, 'GUIDE.md': 'g2', 'docs/new.md': 'n', 'zz/sub/new.md': 'x' });
  await assert.rejects(() => applyUpdate(root, { fetchImpl: r2.fetchImpl }), /previous files were restored/i);
  assert.deepEqual(noTmp(root), before, 'GUIDE.md, package.json and the state file are back, docs/new.md is gone');
  assert.equal((await checkForUpdate(root, { fetchImpl: r2.fetchImpl })).available, true, 'and a later attempt is still possible');
});

test('apply: refused while an install or another update holds the hub lock', { skip: !hasTar }, async () => {
  const root = installed(V1);
  const release2 = release('0.1.5', V1);
  const unlock = acquireHubLock(root, 'install');
  try {
    await assert.rejects(() => applyUpdate(root, { fetchImpl: release2.fetchImpl }), HubLockError);
  } finally {
    unlock();
  }
});

// ---------------------------------------------------------------- the updater the app runs
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('updater modes: "off" never asks GitHub, "notify" only checks, "auto" installs by itself', { skip: !hasTar }, async () => {
  for (const [mode, expectApplied, expectCalls] of [['off', false, 0], ['notify', false, 1], ['auto', true, 3]]) {
    const root = installed(V1);
    write(root, 'settings.json', JSON.stringify({ version: 1, updates: { mode } }));
    const r2 = release('0.1.5', { ...V1, 'scripts/run.mjs': 'v2' });
    const u = createUpdater(root, { fetchImpl: r2.fetchImpl, firstCheckMs: 10, everyMs: 3600_000 });
    u.start();
    await wait(600);
    u.stop();
    assert.equal(r2.calls.length >= expectCalls && (mode !== 'off' || r2.calls.length === 0), true, `${mode}: ${r2.calls.length} requests`);
    assert.equal(fs.readFileSync(path.join(root, 'scripts/run.mjs'), 'utf8') === 'v2', expectApplied, mode);
    assert.equal(u.status().phase, expectApplied ? 'restart' : 'idle', mode);
  }
});

test('updater: manual check and apply, one at a time, state without internals', { skip: !hasTar }, async () => {
  const root = installed(V1);
  const r2 = release('0.1.5', { ...V1, 'scripts/run.mjs': 'v2' });
  const seen = [];
  const u = createUpdater(root, { fetchImpl: r2.fetchImpl, onChange: (s) => seen.push(s.phase) });
  assert.equal(u.status().info, null);
  const s1 = await u.check(true);
  assert.equal(s1.info.available, true);
  assert.equal('release' in s1.info, false, 'download URLs and internals stay on the server');
  const [a, b] = await Promise.all([u.apply(), u.apply()]);
  assert.equal(fs.readFileSync(path.join(root, 'scripts/run.mjs'), 'utf8'), 'v2');
  assert.equal(a.phase, 'restart');
  assert.ok(['restart', 'applying'].includes(b.phase), 'the second call did not start a second update');
  assert.equal(r2.calls.filter((c) => c.endsWith(ARCHIVE_NAME) || c.includes('/blob/ai-hub-update')).length <= 2, true);
  assert.ok(seen.includes('checking') && seen.includes('applying') && seen.includes('restart'));
});

test('updater: a failed update is reported and leaves the app usable', { skip: !hasTar }, async () => {
  const root = installed(V1);
  const bad = release('0.1.5', V1);
  const g = github({ version: '0.1.5', archive: bad.archive, sums: `${'1'.repeat(64)}  ${ARCHIVE_NAME}` });
  const u = createUpdater(root, { fetchImpl: g.fetchImpl });
  await u.check(true);
  const s = await u.apply();
  assert.match(s.error, /checksum/i);
  assert.equal(s.phase, 'idle');
});

// ---------------------------------------------------------------- server routes
test('server: update routes — status without network, check and apply protected, apply needs confirm', async () => {
  const root = installed(V1);
  const calls = [];
  const fake = {
    status: () => ({ enabled: true, phase: 'idle', info: null }),
    check: async () => (calls.push('check'), { enabled: true, phase: 'idle', info: { available: true, latest: '9.9.9', current: '0.1.0', canApply: true } }),
    apply: async () => (calls.push('apply'), { enabled: true, phase: 'restart', result: { to: '9.9.9' } }),
    start() {
      calls.push('start');
    },
    stop() {
      calls.push('stop');
    },
  };
  const app = await startServer({ root, port: 0, quiet: true, updater: fake });
  const origin = `http://127.0.0.1:${app.port}`;
  const H = { 'X-Hub-Token': app.token };
  const P = { ...H, Origin: origin, 'Content-Type': 'application/json' };
  try {
    assert.equal((await fetch(`${origin}/api/update`)).status, 401);
    assert.equal((await fetch(`${origin}/api/update`, { headers: H })).status, 200);
    assert.equal((await fetch(`${origin}/api/update/apply`, { method: 'POST', headers: { ...P, Origin: 'http://evil.example' }, body: '{"confirm":true}' })).status, 403);
    assert.equal((await fetch(`${origin}/api/update/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: '{"confirm":true}' })).status, 401);
    assert.equal((await fetch(`${origin}/api/update/apply`, { method: 'POST', headers: P, body: '{}' })).status, 400, 'no confirm, no update');
    assert.ok(!calls.includes('apply'));
    assert.equal((await (await fetch(`${origin}/api/update/check`, { method: 'POST', headers: P, body: '{}' })).json()).info.latest, '9.9.9');
    const done = await (await fetch(`${origin}/api/update/apply`, { method: 'POST', headers: P, body: '{"confirm":true}' })).json();
    assert.equal(done.phase, 'restart');
    assert.deepEqual(calls, ['start', 'check', 'apply']);
  } finally {
    await app.close();
  }
  assert.ok(calls.includes('stop'));
  // a server without an updater (tests, dev): status says so, actions do not exist
  const bare = await startServer({ root, port: 0, quiet: true });
  try {
    const o = `http://127.0.0.1:${bare.port}`;
    assert.deepEqual(await (await fetch(`${o}/api/update`, { headers: { 'X-Hub-Token': bare.token } })).json(), { enabled: false });
    const r = await fetch(`${o}/api/update/apply`, { method: 'POST', headers: { 'X-Hub-Token': bare.token, Origin: o, 'Content-Type': 'application/json' }, body: '{"confirm":true}' });
    assert.equal(r.status, 404);
  } finally {
    await bare.close();
  }
});

// ---------------------------------------------------------------- release side
test('release: the update archive is built and its checksum published next to it', () => {
  const sh = fs.readFileSync(path.join(REPO, '.github', 'scripts', 'package.sh'), 'utf8');
  assert.match(sh, /ai-hub-update\.tar\.gz/);
  assert.match(sh, /packaging\/build\.mjs stage/);
  assert.match(sh, /\*\.tar\.gz/, 'the archive is listed in SHA256SUMS.txt');
  assert.equal(ARCHIVE_NAME, 'ai-hub-update.tar.gz');
  const wf = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'release.yml'), 'utf8');
  assert.match(wf, /path:\s*dist\/\*/, 'every file in dist/ is attached to the draft release');
});
