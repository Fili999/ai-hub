// Security regression: what is approved is exactly what is installed. Content changed during the scan, concurrent
// runs, replaced versions, case-insensitive name clashes and untrusted paths in manifest.lock.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cleanupAfter, linkDir, makeGitFixture, makeHub, mktmp, run, snapshotTree, write } from './helpers.mjs';
import { packageHash } from '../scripts/lib/approval.mjs';
import { IntegrityError, Transaction, assertHash, snapshotItem } from '../scripts/lib/integrity.mjs';
import { HubLockError, acquireHubLock } from '../scripts/lib/hublock.mjs';

cleanupAfter();

// Scanner that behaves, but can tamper with files while "scanning" (the dangerous window).
const FAKE = `
import fs from 'node:fs'; import path from 'node:path';
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('SkillSpector v9.9.9'); process.exit(0); }
const target = a[1];
const append = (f, text) => { try { fs.appendFileSync(f, text); } catch {} };
// 1) modify the very copy that is being scanned
if (process.env.FAKE_TAMPER_SNAPSHOT) append(path.join(target, 'SKILL.md'), '\\nTAMPERED-DURING-SCAN\\n');
// 2) modify the ORIGINAL downloaded files (sibling "repo" folder of the "stage" folder)
if (process.env.FAKE_TAMPER_CLONE) {
  const repo = path.resolve(target, '..', '..', '..', 'repo');
  for (const f of ['skills/probe/SKILL.md']) append(path.join(repo, f), '\\nTAMPERED-ORIGINAL-AFTER-SCAN-START\\n');
}
// 3) modify an arbitrary file (e.g. the installed skill while it is being approved)
if (process.env.FAKE_TAMPER_FILE) append(process.env.FAKE_TAMPER_FILE, '\\nTAMPERED-INSTALLED\\n');
console.log(JSON.stringify({ risk_assessment: { score: 0, severity: 'LOW', recommendation: 'SAFE' }, issues: [], analysis_completeness: { is_complete: true }, execution_successful: true }));
`;
const script = path.join(mktmp(), 'fake.mjs');
fs.writeFileSync(script, FAKE);
const env = (extra = {}) => ({ AI_HUB_SKILLSPECTOR_SCRIPT: script, ...extra });

const skillText = (body = '') => `---\nname: probe\ndescription: Probe skill.\n---\n# probe\n${body}\n`;
const blockHub = () => {
  const root = makeHub();
  write(root, 'settings.json', JSON.stringify({ version: 1, security: { skillspector: 'block' } }));
  return root;
};
const lockOf = (root) => JSON.parse(fs.readFileSync(path.join(root, 'manifest.lock.json'), 'utf8'));
const installed = (root) => path.join(root, 'skills', 'external', 'probe', 'SKILL.md');
const stagingLeftovers = (root) => (fs.existsSync(path.join(root, '.tmp')) ? fs.readdirSync(path.join(root, '.tmp')).filter((n) => n.startsWith('staging-')) : []);

// ---------------------------------------------------------------- content changed during the scan
test('install: the scanner changes the scanned copy → abort, nothing installed, nothing approved', () => {
  const root = blockHub();
  const src = makeGitFixture({ 'skills/probe/SKILL.md': skillText() });
  const r = run('install.mjs', [src.dir, '--all', '--to', 'global'], { root, env: env({ FAKE_TAMPER_SNAPSHOT: '1' }) });
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.err, /changed during the operation/i);
  assert.equal(fs.existsSync(path.join(root, 'skills', 'external', 'probe')), false);
  assert.deepEqual(lockOf(root).entries, []);
  assert.deepEqual(stagingLeftovers(root), [], 'staging area cleaned up');
});

test('install: the ORIGINAL download is altered after the scan starts → the installed bytes are the scanned ones, hash matches', () => {
  const root = blockHub();
  const src = makeGitFixture({ 'skills/probe/SKILL.md': skillText() });
  const r = run('install.mjs', [src.dir, '--all', '--to', 'global'], { root, env: env({ FAKE_TAMPER_CLONE: '1' }) });
  assert.equal(r.code, 0, r.out + r.err);
  const text = fs.readFileSync(installed(root), 'utf8');
  assert.doesNotMatch(text, /TAMPERED/, 'only the snapshot that was scanned reached the hub');
  const e = lockOf(root).entries[0];
  assert.equal(e.approval.hash, packageHash(path.join(root, 'skills/external/probe')), 'approval is for the installed content');
  assert.equal(e.approval.hash, e.package.hash);
});

test('install --force: a tampered replacement leaves the previous version and its approval untouched', () => {
  const root = blockHub();
  const src = makeGitFixture({ 'skills/probe/SKILL.md': skillText('v1') });
  assert.equal(run('install.mjs', [src.dir, '--all', '--to', 'global'], { root, env: env() }).code, 0);
  const before = { text: fs.readFileSync(installed(root), 'utf8'), lock: lockOf(root) };
  write(src.dir, 'skills/probe/SKILL.md', skillText('v2'));
  src.git('commit', '-qam', 'v2');
  const r = run('install.mjs', [src.dir, '--all', '--to', 'global', '--force'], { root, env: env({ FAKE_TAMPER_SNAPSHOT: '1' }) });
  assert.equal(r.code, 1, r.out + r.err);
  assert.equal(fs.readFileSync(installed(root), 'utf8'), before.text, 'old version still in place');
  assert.deepEqual(lockOf(root), before.lock, 'lock unchanged');
});

test('update: a tampered new version never replaces the installed one', () => {
  const root = blockHub();
  const src = makeGitFixture({ 'skills/probe/SKILL.md': skillText('v1') });
  assert.equal(run('install.mjs', [src.dir, '--all', '--to', 'global'], { root, env: env() }).code, 0);
  const before = { text: fs.readFileSync(installed(root), 'utf8'), lock: lockOf(root) };
  write(src.dir, 'skills/probe/SKILL.md', skillText('v2'));
  src.git('commit', '-qam', 'v2');
  const r = run('install.mjs', ['--update', 'probe'], { root, env: env({ FAKE_TAMPER_SNAPSHOT: '1' }) });
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.out, /changed during the operation/i);
  assert.equal(fs.readFileSync(installed(root), 'utf8'), before.text);
  assert.deepEqual(lockOf(root), before.lock);
  // and a clean update works and records the hash of what is on disk
  const ok = run('install.mjs', ['--update', 'probe'], { root, env: env() });
  assert.equal(ok.code, 0, ok.out + ok.err);
  const e = lockOf(root).entries[0];
  assert.equal(e.approval.hash, packageHash(path.join(root, 'skills/external/probe')));
  assert.match(fs.readFileSync(installed(root), 'utf8'), /v2/);
});

test('approve: the installed skill changes while it is scanned → no approval is recorded', () => {
  const root = blockHub();
  const src = makeGitFixture({ 'skills/probe/SKILL.md': skillText() });
  assert.equal(run('install.mjs', [src.dir, '--all', '--to', 'global'], { root, env: env() }).code, 0);
  const lock = lockOf(root);
  delete lock.entries[0].approval; // as if installed before approvals existed
  write(root, 'manifest.lock.json', JSON.stringify(lock));
  const r = run('install.mjs', ['--approve', 'probe'], { root, env: env({ FAKE_TAMPER_FILE: installed(root) }) });
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.out, /changed during the operation/i);
  assert.equal(lockOf(root).entries[0].approval, undefined, 'nothing was approved');
});

// ---------------------------------------------------------------- Transaction building block
test('Transaction: verifies before and after the move, restores the old version on failure', () => {
  const root = mktmp();
  write(root, 'skills/external/x/SKILL.md', 'OLD');
  const dest = path.join(root, 'skills', 'external', 'x');
  const staging = mktmp();
  write(staging, 'new/SKILL.md', 'NEW');
  const snap = snapshotItem(path.join(staging, 'new'), path.join(staging, 'snap'));

  // snapshot modified after hashing → refused before anything moves
  write(staging, 'snap/new/SKILL.md', 'NEW-TAMPERED');
  let tx = new Transaction(root);
  assert.throws(() => tx.place(snap.path, dest, snap.hash), IntegrityError);
  tx.rollback();
  tx.dispose();
  assert.equal(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), 'OLD');

  // hash that does not match what ends up installed → rolled back to OLD
  write(staging, 'snap/new/SKILL.md', 'NEW');
  tx = new Transaction(root);
  assert.throws(() => tx.place(snap.path, dest, `sha256:${'0'.repeat(64)}`), IntegrityError);
  tx.rollback();
  tx.dispose();
  assert.equal(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), 'OLD');

  // success path: replaced atomically, old version gone after commit, staging removed
  tx = new Transaction(root);
  tx.place(snap.path, dest, snap.hash);
  assert.equal(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), 'NEW');
  tx.commit();
  tx.dispose();
  assert.deepEqual(fs.readdirSync(path.join(root, '.tmp')), []);
  assert.throws(() => assertHash(dest, `sha256:${'1'.repeat(64)}`), IntegrityError);
});

test('Transaction: destination parent that is a symlink/junction is refused', () => {
  const root = mktmp();
  const outside = mktmp();
  fs.mkdirSync(path.join(root, 'skills'));
  linkDir(outside, path.join(root, 'skills', 'external'));
  const src = mktmp();
  write(src, 'x/SKILL.md', 'X');
  const snap = snapshotItem(path.join(src, 'x'), path.join(src, 'snap'));
  const tx = new Transaction(root);
  assert.throws(() => tx.place(snap.path, path.join(root, 'skills', 'external', 'x'), snap.hash), /symbolic link|junction/i);
  tx.rollback();
  tx.dispose();
  assert.deepEqual(fs.readdirSync(outside), []);
});

// ---------------------------------------------------------------- concurrent runs
test('lock: a second run while another is active is refused without writing anything', () => {
  const root = blockHub();
  const src = makeGitFixture({ 'skills/probe/SKILL.md': skillText() });
  const release = acquireHubLock(root, 'update'); // held by THIS (alive) process
  try {
    const r = run('install.mjs', [src.dir, '--all', '--to', 'global'], { root, env: env() });
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.err, /Another operation/i);
    assert.equal(fs.existsSync(path.join(root, 'skills', 'external', 'probe')), false);
    assert.deepEqual(lockOf(root).entries, []);
    assert.throws(() => acquireHubLock(root, 'approve'), HubLockError);
  } finally {
    release();
  }
  const ok = run('install.mjs', [src.dir, '--all', '--to', 'global'], { root, env: env() });
  assert.equal(ok.code, 0, ok.out + ok.err);
  assert.equal(fs.existsSync(path.join(root, '.tmp', 'locks', 'hub.lock')), false, 'lock released when the run ends');
});

test('lock: a lock left by a crashed run (dead pid) or an ancient one is taken over', () => {
  const root = mktmp();
  const dead = spawnSync(process.execPath, ['-e', '0']).pid; // exited: pid no longer alive
  const lockDir = path.join(root, '.tmp', 'locks', 'hub.lock');
  fs.mkdirSync(lockDir, { recursive: true });
  write(lockDir, 'owner.json', JSON.stringify({ pid: dead, label: 'install', at: new Date().toISOString() }));
  const r1 = acquireHubLock(root, 'install');
  r1();
  // alive pid but older than the staleness limit
  fs.mkdirSync(lockDir, { recursive: true });
  write(lockDir, 'owner.json', JSON.stringify({ pid: process.pid, label: 'install', at: '2000-01-01T00:00:00.000Z' }));
  const r2 = acquireHubLock(root, 'install');
  r2();
  assert.equal(fs.existsSync(lockDir), false);
  // release is idempotent and never removes somebody else's lock
  fs.mkdirSync(lockDir, { recursive: true });
  write(lockDir, 'owner.json', JSON.stringify({ pid: process.pid + 1, label: 'x', at: new Date().toISOString() }));
  r2();
  assert.equal(fs.existsSync(lockDir), true);
});

test('lock: reads (list, dry-run, help) do not need the lock', () => {
  const root = blockHub();
  const release = acquireHubLock(root, 'update');
  try {
    assert.equal(run('install.mjs', ['--list'], { root }).code, 0);
    assert.equal(run('install.mjs', ['--help'], { root }).code, 0);
  } finally {
    release();
  }
});

// ---------------------------------------------------------------- names and untrusted lock paths
test('names that differ only by case are the same installation (macOS/Windows folders are case-insensitive)', () => {
  const root = makeHub();
  const a = makeGitFixture({ 'skills/Probe/SKILL.md': skillText().replace('name: probe', 'name: Probe') });
  const b = makeGitFixture({ 'skills/probe/SKILL.md': skillText('different') });
  assert.equal(run('install.mjs', [a.dir, '--all', '--to', 'global'], { root }).code, 0);
  const before = snapshotTree(path.join(root, 'skills', 'external'));
  const r = run('install.mjs', [b.dir, '--all', '--to', 'global'], { root });
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.err, /already installed/i);
  assert.deepEqual(snapshotTree(path.join(root, 'skills', 'external')), before);
});

test('remove: a lock entry pointing outside skills/external or through a symlinked folder deletes nothing', () => {
  const root = makeHub();
  const victim = mktmp();
  write(victim, 'precious/SKILL.md', 'keep me');
  write(root, 'precious-in-hub/SKILL.md', 'keep me too');
  const entry = (p) => ({ kind: 'skill', name: 'evil', path: p, source: { type: 'github', url: 'https://github.com/a/b', repo: 'a/b', ref: null, subpath: 'x', commit: 'c'.repeat(40) }, installedAt: '2026-01-01T00:00:00Z', package: { path: p, hash: 'sha256:x' } });

  for (const p of ['skills/external/../../precious-in-hub', '../precious', path.join(victim, 'precious'), 'skills/external']) {
    write(root, 'manifest.lock.json', JSON.stringify({ version: 2, entries: [entry(p)] }));
    const r = run('install.mjs', ['--remove', 'evil', '--yes'], { root });
    assert.equal(r.code, 1, `${p}: ${r.out}${r.err}`);
    assert.equal(fs.readFileSync(path.join(root, 'precious-in-hub', 'SKILL.md'), 'utf8'), 'keep me too', p);
    assert.equal(fs.readFileSync(path.join(victim, 'precious', 'SKILL.md'), 'utf8'), 'keep me', p);
  }

  // skills/external is itself a link to an outside folder: textually "inside", really outside
  fs.mkdirSync(path.join(root, 'skills'), { recursive: true });
  fs.rmSync(path.join(root, 'skills', 'external'), { recursive: true, force: true });
  linkDir(victim, path.join(root, 'skills', 'external'));
  write(root, 'manifest.lock.json', JSON.stringify({ version: 2, entries: [entry('skills/external/precious')] }));
  const r = run('install.mjs', ['--remove', 'evil', '--yes'], { root });
  assert.equal(r.code, 1, r.out + r.err);
  assert.equal(fs.readFileSync(path.join(victim, 'precious', 'SKILL.md'), 'utf8'), 'keep me', 'the folder behind the link survived');
});

test('install into a hub whose skills/external is a symlink to an outside folder writes nothing outside', () => {
  const root = makeHub();
  const outside = mktmp();
  fs.mkdirSync(path.join(root, 'skills'), { recursive: true });
  linkDir(outside, path.join(root, 'skills', 'external'));
  const src = makeGitFixture({ 'skills/probe/SKILL.md': skillText() });
  const r = run('install.mjs', [src.dir, '--all', '--to', 'global'], { root });
  assert.equal(r.code, 1, r.out + r.err);
  assert.deepEqual(fs.readdirSync(outside), []);
});
