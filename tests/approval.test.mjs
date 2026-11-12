// Phase C: full packages, SHA-256 hash on exact bytes, approvals in lock v2, verification on second computer.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, cleanupAfter, makeGitFixture, makeHub, makeSyncPair, mktmp, run, write } from './helpers.mjs';
import { packageHash, verifyEntry } from '../scripts/lib/approval.mjs';
import { scanHub } from '../scripts/lib/scan.mjs';

cleanupAfter();

const lockOf = (root) => JSON.parse(fs.readFileSync(path.join(root, 'manifest.lock.json'), 'utf8'));
const skill = (name, body = '') => `---\nname: ${name}\ndescription: Test skill ${name}.\n---\n# ${name}\n${body}\n`;

/** Test repo: two skills using a shared script outside their directories. */
const packageRepo = () =>
  makeGitFixture({
    'README.md': '# Test package\n',
    'shared/lib.sh': 'echo shared\n',
    'skills/alfa/SKILL.md': skill('alfa', 'Run ../../shared/lib.sh'),
    'skills/beta/SKILL.md': skill('beta'),
  });

test('package hash: SHA-256 on exact bytes, stable, excluding .git, node_modules and symlinks', () => {
  const d = mktmp();
  write(d, 'a/SKILL.md', 'line\n');
  write(d, 'a/sub/x.txt', 'x');
  const h1 = packageHash(path.join(d, 'a'));
  assert.match(h1, /^sha256:[0-9a-f]{64}$/);
  assert.equal(packageHash(path.join(d, 'a')), h1, 'stable');
  write(d, 'a/.git/HEAD', 'ref');
  write(d, 'a/node_modules/m/index.js', 'x');
  if (process.platform !== 'win32') fs.symlinkSync(path.join(d, 'a', 'sub'), path.join(d, 'a', 'link'));
  assert.equal(packageHash(path.join(d, 'a')), h1, 'what the installer does not copy does not count');
  write(d, 'a/SKILL.md', 'line\r\n');
  assert.notEqual(packageHash(path.join(d, 'a')), h1, 'line endings count: exact bytes, no normalization');
  write(d, 'a/SKILL.md', 'line\n');
  fs.renameSync(path.join(d, 'a', 'sub', 'x.txt'), path.join(d, 'a', 'sub', 'y.txt'));
  assert.notEqual(packageHash(path.join(d, 'a')), h1, 'file names also count');
  assert.match(packageHash(path.join(d, 'a', 'SKILL.md')), /^sha256:/, 'also works on a single file (agents)');
});

test('entry status: lock v1 review pending, approved, content mismatch, missing', () => {
  const root = mktmp();
  write(root, 'skills/external/x/SKILL.md', skill('x'));
  const hash = packageHash(path.join(root, 'skills/external/x'));
  const v1 = { kind: 'skill', name: 'x', path: 'skills/external/x', source: { repo: 'a/b', commit: 'c'.repeat(40) } };
  assert.equal(verifyEntry(root, v1).status, 'review-pending');
  const ok = { ...v1, package: { path: v1.path, hash }, approval: { status: 'approved', hash, at: '2026-10-26T10:00:00Z', platform: 'macOS' } };
  assert.equal(verifyEntry(root, ok).status, 'approved');
  write(root, 'skills/external/x/SKILL.md', skill('x', 'changed'));
  assert.equal(verifyEntry(root, ok).status, 'hash-mismatch');
  assert.equal(verifyEntry(root, { ...ok, path: 'skills/external/missing', package: { path: 'skills/external/missing', hash } }).status, 'missing');
});

test('full package: shared files copied, all skills registered and approved on the same hash', () => {
  const root = makeHub();
  const src = packageRepo();
  // preview: warns when items use files outside their directory
  let r = run('install.mjs', [src.dir, '--dry-run', '--json'], { root });
  assert.equal(r.code, 0, r.err);
  const prev = JSON.parse(r.out);
  assert.equal(prev.items.find((i) => i.name === 'alfa').sharedFiles, true);
  assert.equal(prev.items.find((i) => i.name === 'beta').sharedFiles, false);
  // with --package part selection is not allowed
  r = run('install.mjs', [src.dir, '--package', '--only', 'alfa'], { root });
  assert.equal(r.code, 1);
  assert.match(r.err, /--path/);

  r = run('install.mjs', [src.dir, '--package', '--to', 'global'], { root });
  assert.equal(r.code, 0, r.out + r.err);
  const lock = lockOf(root);
  assert.equal(lock.version, 2);
  const [alfa, beta] = ['alfa', 'beta'].map((n) => lock.entries.find((e) => e.name === n));
  const pkg = alfa.package.path;
  assert.match(pkg, /^skills\/external\/[A-Za-z0-9._-]+$/);
  assert.equal(beta.package.path, pkg);
  assert.equal(alfa.path, `${pkg}/skills/alfa`);
  assert.ok(fs.existsSync(path.join(root, pkg, 'shared', 'lib.sh')), 'shared script comes with the package');
  assert.ok(!fs.existsSync(path.join(root, pkg, '.git')), 'no .git');
  const hash = packageHash(path.join(root, pkg));
  assert.equal(alfa.approval.hash, hash);
  assert.equal(beta.approval.hash, hash);
  assert.equal(alfa.approval.status, 'approved');
  assert.equal(alfa.approval.via, 'cli');
  assert.equal(verifyEntry(root, alfa).status, 'approved');
  // inventory finds skills inside package and links them to the package
  const idx = scanHub(root);
  assert.equal(idx.skills.find((s) => s.name === 'alfa').package, pkg);
  assert.equal(idx.skills.find((s) => s.name === 'alfa').approval, 'approved');
  assert.ok(!idx.warnings.some((w) => w.type === 'duplicate-name'));

  // removing a skill of the package removes the whole package (otherwise approved content would change)
  r = run('install.mjs', ['--remove', 'beta', '--yes'], { root });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /same package/i);
  assert.ok(!fs.existsSync(path.join(root, pkg)));
  assert.deepEqual(lockOf(root).entries, []);
});

test('second computer: valid approval with identical hash (even with CRLF line endings), not activated if changed', () => {
  const { a, b, git } = makeSyncPair();
  fs.copyFileSync(path.join(REPO, '.gitattributes'), path.join(a, '.gitattributes'));
  // author repo with CRLF actually saved in files (without Git conversions on this system)
  const src = { dir: mktmp() };
  write(src.dir, 'skills/crlf/SKILL.md', '---\r\nname: crlf\r\ndescription: Written on Windows.\r\n---\r\nText\r\n');
  write(src.dir, 'skills/crlf/run.cmd', '@echo off\r\necho hello\r\n');
  write(src.dir, 'skills/crlf/note.txt', 'LF only\n');
  for (const args of [['init', '-q'], ['-c', 'core.autocrlf=false', 'add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init']]) spawnSync('git', ['-C', src.dir, ...args]);
  let r = run('install.mjs', [src.dir, '--all', '--to', 'global'], { root: a });
  assert.equal(r.code, 0, r.out + r.err);
  const approved = lockOf(a).entries[0].approval.hash;
  git(a, 'add', '-A');
  git(a, 'commit', '-q', '-m', 'approved skill');
  git(a, 'push', '-q');
  // the other computer converts line endings (like Git on Windows with autocrlf): external content must not change
  git(b, 'config', 'core.autocrlf', 'true');
  git(b, 'pull', '-q');
  assert.equal(fs.readFileSync(path.join(b, 'skills/external/crlf/SKILL.md'), 'utf8').includes('\r\n'), true);
  const entry = lockOf(b).entries[0];
  assert.equal(packageHash(path.join(b, entry.package.path)), approved);
  assert.equal(verifyEntry(b, entry).status, 'approved', 'no new review needed');

  // sync on other computer: activates approved skill
  const target = mktmp();
  r = run('sync.mjs', ['--target', target, '--mode', 'copy'], { root: b });
  assert.equal(r.code, 0, r.out + r.err);
  assert.ok(fs.existsSync(path.join(target, 'skills', 'crlf', 'SKILL.md')));
  // one different byte: not activated and doctor reports it as an error
  write(b, 'skills/external/crlf/note.txt', 'LF only!\n');
  r = run('sync.mjs', ['--target', target, '--mode', 'copy'], { root: b });
  assert.match(r.out, /differs from the approved one/i);
  assert.ok(!fs.existsSync(path.join(target, 'skills', 'crlf')), 'not linked (and old copy removed)');
  r = run('doctor.mjs', ['--json'], { root: b });
  assert.ok(JSON.parse(r.out).problems.some((p) => p.level === 'error' && /differs from (the )?approved/i.test(p.message)));
});

test('items installed before approvals: review pending, approvable with --approve (and SkillSpector decides)', () => {
  const root = makeHub();
  write(root, 'skills/external/old/SKILL.md', skill('old'));
  write(root, 'skills/external/suspicious/SKILL.md', skill('suspicious', 'MALICIOUS'));
  const legacy = (name) => ({ kind: 'skill', name, path: `skills/external/${name}`, source: { type: 'github', url: 'https://github.com/a/b', repo: 'a/b', ref: null, subpath: name, commit: 'c'.repeat(40) }, installedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' });
  write(root, 'manifest.lock.json', JSON.stringify({ version: 1, entries: [legacy('old'), legacy('suspicious')] }));
  let r = run('doctor.mjs', ['--json'], { root });
  assert.ok(JSON.parse(r.out).problems.some((p) => p.level === 'warn' && /old: review pending/i.test(p.message)));
  assert.equal(scanHub(root).skills.find((s) => s.name === 'old').approval, 'review-pending');
  // remains active (with warning): sync links it
  const target = mktmp();
  r = run('sync.mjs', ['--target', target, '--mode', 'copy'], { root });
  assert.ok(fs.existsSync(path.join(target, 'skills', 'old')));

  // approval with SkillSpector set to "block" (mock scanner: MALICIOUS → DO_NOT_INSTALL)
  const fake = path.join(mktmp(), 'fake.mjs');
  fs.writeFileSync(fake, `import fs from 'node:fs'; import path from 'node:path';
const a = process.argv.slice(2); if (a[0] === '--version') { console.log('SkillSpector v1.0.0'); process.exit(0); }
const t = fs.readFileSync(path.join(a[1], 'SKILL.md'), 'utf8'); const bad = t.includes('MALICIOUS');
console.log(JSON.stringify({ risk_assessment: { score: bad ? 90 : 0, severity: bad ? 'CRITICAL' : 'LOW', recommendation: bad ? 'DO_NOT_INSTALL' : 'SAFE' }, issues: [], analysis_completeness: { is_complete: true }, execution_successful: true })); process.exit(bad ? 1 : 0);`);
  write(root, 'settings.json', '{"version":1,"security":{"skillspector":"block"}}');
  const env = { AI_HUB_SKILLSPECTOR_SCRIPT: fake };
  r = run('install.mjs', ['--approve', 'old', '--via=ui'], { root, env });
  assert.equal(r.code, 0, r.out + r.err);
  let lock = lockOf(root);
  const v = lock.entries.find((e) => e.name === 'old');
  assert.equal(lock.version, 2);
  assert.equal(v.approval.status, 'approved');
  assert.equal(v.approval.via, 'ui');
  assert.equal(v.approval.hash, packageHash(path.join(root, 'skills/external/old')));
  assert.equal(v.security.recommendation, 'SAFE');
  r = run('install.mjs', ['--approve', 'suspicious'], { root, env });
  assert.equal(r.code, 1);
  assert.match(r.out, /SkillSpector blocks it/i);
  assert.equal(lockOf(root).entries.find((e) => e.name === 'suspicious').approval, undefined);
  r = run('install.mjs', ['--approve', 'nonexistent'], { root, env });
  assert.equal(r.code, 1);
});

test('package update: recopied entirely and approval moves to the new version', () => {
  const root = makeHub();
  const src = packageRepo();
  let r = run('install.mjs', [src.dir, '--package', '--to', 'global'], { root });
  assert.equal(r.code, 0, r.out + r.err);
  const before = lockOf(root).entries.find((e) => e.name === 'alfa');
  write(src.dir, 'shared/lib.sh', 'echo shared v2\n');
  src.git('commit', '-qam', 'v2');
  r = run('install.mjs', ['--update', 'alfa'], { root });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /package .*alfa.*beta/i);
  const after = lockOf(root).entries;
  const pkg = before.package.path;
  assert.equal(fs.readFileSync(path.join(root, pkg, 'shared/lib.sh'), 'utf8'), 'echo shared v2\n');
  for (const e of after) {
    assert.equal(e.package.hash, packageHash(path.join(root, pkg)));
    assert.equal(e.approval.hash, e.package.hash);
    assert.notEqual(e.approval.hash, before.approval.hash);
  }
  // locally modified: will not overwrite without --force
  write(root, `${pkg}/shared/lib.sh`, 'locally modified\n');
  write(src.dir, 'shared/lib.sh', 'echo shared v3\n');
  src.git('commit', '-qam', 'v3');
  r = run('install.mjs', ['--update'], { root });
  assert.match(r.out, /locally modified/i);
  assert.equal(fs.readFileSync(path.join(root, pkg, 'shared/lib.sh'), 'utf8'), 'locally modified\n');
});

test('package too large or with files exceeding GitHub limits: stops before writing', { skip: process.platform === 'win32' }, () => {
  const root = makeHub();
  const src = makeGitFixture({ 'skills/large/SKILL.md': skill('large') });
  // sparse file: takes little disk space but has the size of a giant file
  const big = path.join(src.dir, 'skills/large/data.bin');
  const fd = fs.openSync(big, 'w');
  fs.ftruncateSync(fd, 96 * 1024 * 1024);
  fs.closeSync(fd);
  spawnSync('git', ['-C', src.dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A']);
  spawnSync('git', ['-C', src.dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'large']);
  const r = run('install.mjs', [src.dir, '--package'], { root });
  assert.equal(r.code, 1);
  assert.match(r.err, /too large for GitHub/i);
  assert.ok(!fs.existsSync(path.join(root, 'skills', 'external')) || fs.readdirSync(path.join(root, 'skills', 'external')).length === 0);
});
