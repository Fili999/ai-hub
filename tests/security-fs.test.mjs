// Security regression: filesystem operations stay inside the folders they are allowed to touch
// (symlinks / junctions, "..", absolute and mixed-separator paths, tampered metadata, untrusted lock/source paths).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanupAfter, linkDir, makeGitFixture, makeHub, mktmp, run, snapshotTree, write } from './helpers.mjs';
import { createItem } from '../scripts/lib/create.mjs';
import { verifyEntry } from '../scripts/lib/approval.mjs';
import { assertContained, isInside, UnsafePathError } from '../scripts/lib/safefs.mjs';
import { discoverItems, parseSource } from '../scripts/lib/source.mjs';
import { readJson, writeJson } from '../scripts/lib/util.mjs';

cleanupAfter();

const skillDraft = (over = {}) => ({
  kind: 'skill', name: 'safe-skill', title: 'Safe Skill', goal: 'Does a harmless thing for the tests.',
  description: 'Does a harmless thing for the tests, only when asked to.', descriptionEn: 'Harmless test skill.',
  model: 'sonnet', effort: 'high', categories: [], tools: ['Read'], requiresCommands: [], requiresMcp: [], agents: [], skills: [],
  ...over,
});

test('create: skills/ or skills/own being a link to an outside folder is refused (not only the last folders)', () => {
  for (const where of ['skills', 'skills/own']) {
    const root = makeHub();
    const outside = mktmp();
    write(outside, 'keep.txt', 'x');
    const before = snapshotTree(outside);
    fs.rmSync(path.join(root, where), { recursive: true, force: true });
    fs.mkdirSync(path.dirname(path.join(root, where)), { recursive: true });
    linkDir(outside, path.join(root, where));
    assert.throws(() => createItem(root, skillDraft()), /link|symbolic|junction/i, where);
    assert.deepEqual(snapshotTree(outside), before, `${where}: nothing created behind the link`);
  }
});

test('create: ".." and absolute folder names cannot leave skills/own', () => {
  const root = makeHub();
  for (const folder of ['../escaped', '..\\escaped', '/tmp/escaped', 'C:\\escaped', 'a/../../escaped']) {
    try {
      createItem(root, skillDraft({ folder }));
    } catch {
      /* refused: expected */
    }
  }
  assert.equal(fs.existsSync(path.join(root, 'skills', 'escaped')), false);
  assert.equal(fs.existsSync(path.join(path.dirname(root), 'escaped')), false);
});

test('sync: a tampered ai-hub.json can never make the hub delete paths outside the tool folders', () => {
  const root = makeHub();
  const target = mktmp();
  const victim = mktmp();
  write(victim, 'precious.txt', 'keep');
  assert.equal(run('sync.mjs', ['--target', target, '--mode', 'copy'], { root }).code, 0);
  const info = JSON.parse(fs.readFileSync(path.join(target, 'ai-hub.json'), 'utf8'));
  // entries that claim the hub placed things at arbitrary places
  info.entries.push({ kind: 'skill', name: 'x', dest: victim, mode: 'copy', hash: 'x' });
  info.entries.push({ kind: 'skill', name: 'y', dest: path.join(target, 'skills', '..', '..', path.basename(victim)), mode: 'copy' });
  fs.writeFileSync(path.join(target, 'ai-hub.json'), JSON.stringify(info));
  const r = run('sync.mjs', ['--target', target, '--mode', 'copy'], { root });
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(fs.readFileSync(path.join(victim, 'precious.txt'), 'utf8'), 'keep', 'outside folder survived the prune');
  assert.match(r.out, /outside the tool/i);
});

test('sync: still prunes what the hub itself placed and no longer wants', () => {
  const root = makeHub();
  const target = mktmp();
  assert.equal(run('sync.mjs', ['--target', target, '--mode', 'copy'], { root }).code, 0);
  assert.ok(fs.existsSync(path.join(target, 'skills', 'seo-audit')));
  fs.rmSync(path.join(root, 'skills', 'own', 'seo-audit'), { recursive: true });
  assert.equal(run('sync.mjs', ['--target', target, '--mode', 'copy'], { root }).code, 0);
  assert.equal(fs.existsSync(path.join(target, 'skills', 'seo-audit')), false);
});

test('approval: a lock path that leaves the hub is "missing", never hashed or approved', () => {
  const root = mktmp();
  const outside = mktmp();
  write(outside, 'SKILL.md', 'outside');
  const rel = path.relative(root, outside);
  const e = { kind: 'skill', name: 'x', path: rel, package: { path: rel, hash: 'sha256:abc' }, approval: { status: 'approved', hash: 'sha256:abc', at: '2026-01-01T00:00:00Z' } };
  assert.equal(verifyEntry(root, e).status, 'missing');
  assert.equal(verifyEntry(root, { ...e, path: '..', package: { path: '..' } }).status, 'missing');
});

test('safefs.assertContained: inside only, no link on the way, mixed separators and traversal refused', () => {
  const root = mktmp();
  const outside = mktmp();
  fs.mkdirSync(path.join(root, 'skills', 'external', 'a'), { recursive: true });
  linkDir(outside, path.join(root, 'skills', 'linked'));
  assert.ok(assertContained(root, 'skills/external', 'skills/external/a'));
  for (const bad of ['skills/external', 'skills/external/../x', 'skills', '../x', path.join(outside, 'x'), 'skills/linked/x']) {
    assert.throws(() => assertContained(root, 'skills/external', bad), UnsafePathError, bad);
  }
  assert.throws(() => assertContained(root, 'skills/linked', 'skills/linked/x'), UnsafePathError, 'a base reached through a link is refused');
  assert.equal(isInside('/a/b', '/a/b/c'), true);
  assert.equal(isInside('/a/b', '/a/b'), false);
  assert.equal(isInside('/a/b', '/a/bc'), false, 'prefix match is not containment');
  assert.equal(isInside('/a/b', '/a/b/../c'), false);
});

test('writeJson: atomic, and a symlink planted at the target is replaced, never written through', (t) => {
  const dir = mktmp();
  const outside = mktmp();
  write(outside, 'target.json', '{"original":true}');
  const file = path.join(dir, 'manifest.lock.json');
  try {
    fs.symlinkSync(path.join(outside, 'target.json'), file, 'file');
  } catch {
    return t.skip('file symlinks are not allowed here');
  }
  writeJson(file, { version: 2, entries: [] });
  assert.equal(fs.lstatSync(file).isSymbolicLink(), false, 'the link itself was replaced');
  assert.deepEqual(readJson(file), { version: 2, entries: [] });
  assert.equal(fs.readFileSync(path.join(outside, 'target.json'), 'utf8'), '{"original":true}', 'file behind the link untouched');
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], 'no temporary files left');
});

test('install sources: symlinks inside a downloaded repository are never followed or copied', (t) => {
  const outside = mktmp();
  write(outside, 'SKILL.md', '---\nname: stolen\ndescription: from outside the repo.\n---\n');
  const repo = mktmp();
  write(repo, 'skills/real/SKILL.md', '---\nname: real\ndescription: a real skill.\n---\n# real\n');
  try {
    linkDir(outside, path.join(repo, 'skills', 'linked'));
  } catch {
    return t.skip('links not allowed here');
  }
  const names = discoverItems(repo, '', 'repo').map((i) => i.name);
  assert.deepEqual(names, ['real']);

  // end to end: a symlink INSIDE a skill is dropped from the installed copy
  const root = makeHub();
  const secret = path.join(outside, 'secret.txt');
  write(outside, 'secret.txt', 'TOP SECRET');
  const src = makeGitFixture({ 'skills/probe/SKILL.md': '---\nname: probe\ndescription: probe.\n---\n# p\n' });
  try {
    fs.symlinkSync(secret, path.join(src.dir, 'skills', 'probe', 'leak.txt'), 'file');
    src.git('add', '-A');
    src.git('commit', '-qm', 'link');
  } catch {
    return;
  }
  assert.equal(run('install.mjs', [src.dir, '--all', '--to', 'global'], { root }).code, 0);
  assert.equal(fs.existsSync(path.join(root, 'skills', 'external', 'probe', 'leak.txt')), false);
});

test('install sources: traversal in --path and --ref, option-looking sources and exotic transports are rejected', () => {
  for (const sub of ['../x', 'a/../../x', 'a\\..\\..\\x']) assert.throws(() => parseSource('owner/repo', { path: sub }), /path|\.\./i, sub);
  for (const ref of ['--upload-pack=touch /tmp/x', '-x', 'a b', 'a;b', 'a$(id)']) assert.throws(() => parseSource('owner/repo', { ref }), /ref/i, ref);
  for (const src of ['--upload-pack=x', '-oProxyCommand=x', 'ext::sh -c "id"', 'ssh://evil/x', 'git://evil/x', 'http://evil.example/x/y', 'https://evil.example/x/y', 'ftp://x/y/z', 'owner/repo/../../x']) {
    let ok = true;
    try {
      const s = parseSource(src);
      ok = s.type === 'github' && s.url === `https://github.com/${s.repo}`; // anything accepted must resolve to github.com over https
    } catch {
      ok = true; // rejected
    }
    assert.ok(ok, src);
  }
  // an existing local folder is a "local" source (CLI only: the web interface refuses it, see security-server tests)
  assert.equal(parseSource(os.tmpdir()).type, 'local');
  // a valid one still resolves to https://github.com
  assert.equal(parseSource('Owner/Repo.js').url, 'https://github.com/Owner/Repo.js');
  assert.equal(parseSource('git@github.com:o/r.git').url, 'https://github.com/o/r');
});
