// GitHub synchronization: status, safe pull, push with commit, and all cases where it must stop.
// Uses a mock GitHub (local bare repo) and two "machines" (a and b): no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { classifyError, cleanUrl, defaultCommitMessage, describeStatus, findSecrets, git as runGit, looksSecret, pullUpdates, pushChanges, repoStatus, secretInText } from '../scripts/lib/repo.mjs';
import { hashPath } from '../scripts/lib/util.mjs';
import { cleanupAfter, makeHub, makeSyncPair, mktmp, run, write } from './helpers.mjs';

cleanupAfter();

test('pure: sanitized URLs, secret files, git errors, default commit message', () => {
  assert.equal(cleanUrl('https://user:ghp_TOKEN@github.com/a/b.git'), 'https://github.com/a/b.git');
  assert.equal(cleanUrl('https://ghp_TOKEN@github.com/a/b'), 'https://github.com/a/b');
  assert.equal(cleanUrl('git@github.com:a/b.git'), 'git@github.com:a/b.git');
  assert.equal(cleanUrl('fatal: unable to access \'https://u:p@github.com/x\': 403'), "fatal: unable to access 'https://github.com/x': 403");
  for (const f of ['.env', 'config/.env.local', 'id_rsa', 'key.pem', 'a/b/server.key', 'credentials.json', '.npmrc', 'my-secret.txt']) assert.ok(looksSecret(f), f);
  for (const f of ['.env.example', 'README.md', 'skills/own/x/SKILL.md', 'id_rsa.pub', 'docs/keyboard.md']) assert.ok(!looksSecret(f), f);

  const c = (stderr, extra = {}) => classifyError({ stderr, stdout: '', ...extra });
  assert.equal(c("fatal: Authentication failed for 'https://github.com/a/b/'"), 'auth');
  assert.equal(c('fatal: could not read Username for \'https://github.com\': terminal prompts disabled'), 'auth');
  assert.equal(c("remote: Repository not found.\nfatal: repository 'https://github.com/a/b/' not found"), 'auth');
  assert.equal(c("fatal: unable to access 'https://github.com/a/b/': Could not resolve host: github.com"), 'offline');
  assert.equal(c('! [rejected]        main -> main (non-fast-forward)'), 'rejected');
  assert.equal(c('error: Your local changes to the following files would be overwritten by merge:'), 'local-changes');
  assert.equal(c('fatal: unable to auto-detect email address'), 'identity');
  assert.equal(c('', { timedOut: true }), 'timeout');
  assert.equal(c('', { notFound: true }), 'no-git');
  assert.equal(c('something unexpected'), 'other');

  assert.match(defaultCommitMessage(new Date(2026, 9, 3, 7, 5)), /^Updates from .+ on 2026-10-03 07:05$/);
});

test('status: synced, uncommitted changes, and new files listed', async () => {
  const { a } = makeSyncPair();
  let st = await repoStatus(a);
  assert.equal(st.state, 'synced');
  assert.equal(st.branch, 'main');
  assert.equal(st.upstream, 'origin/main');
  assert.equal(st.changesTotal, 0);
  assert.equal(describeStatus(st), 'Everything is in sync with GitHub.');

  write(a, 'skills/own/new-skill/SKILL.md', '---\nname: new-skill\ndescription: Test.\n---\n# New\n');
  fs.appendFileSync(path.join(a, 'skills/own/seo-audit/SKILL.md'), '\nAn extra line.\n');
  st = await repoStatus(a);
  assert.equal(st.state, 'synced', 'local changes do not change remote tracking state');
  assert.equal(st.changesTotal, 2);
  const byPath = Object.fromEntries(st.changes.map((c) => [c.path, c.status]));
  assert.equal(byPath['skills/own/new-skill/SKILL.md'], 'new');
  assert.equal(byPath['skills/own/seo-audit/SKILL.md'], 'modified');
  assert.match(describeStatus(st), /2 modified files/);
});

test('updates: visible only after fetch, with change list; downloaded without touching remainder', async () => {
  const { a, b, git } = makeSyncPair();
  write(b, 'skills/own/from-b/SKILL.md', '---\nname: from-b\ndescription: Arrived from the other machine.\n---\n# From B\n');
  write(b, 'dependencies.json', fs.readFileSync(path.join(a, 'dependencies.json'), 'utf8').replace(/\s*$/, '\n') + '\n');
  git(b, 'add', '-A');
  git(b, 'commit', '-q', '-m', 'Added from B');
  git(b, 'push', '-q');

  assert.equal((await repoStatus(a)).state, 'synced', 'without fetch it does not know yet');
  const st = await repoStatus(a, { fetch: true });
  assert.equal(st.fetched, true);
  assert.equal(st.state, 'behind');
  assert.equal(st.behind, 1);
  assert.equal(st.incoming[0].subject, 'Added from B');
  assert.ok(st.incomingFiles.includes('skills/own/from-b/SKILL.md'));
  assert.equal(st.needsSetup, true, 'dependencies.json changed: setup should be re-run');
  assert.ok(st.lastFetch);

  // local change on another file remains untouched
  write(a, 'my-notes.txt', 'do not touch');
  const r = await pullUpdates(a);
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.equal(r.count, 1);
  assert.ok(fs.existsSync(path.join(a, 'skills/own/from-b/SKILL.md')));
  assert.equal(fs.readFileSync(path.join(a, 'my-notes.txt'), 'utf8'), 'do not touch');
  assert.equal((await repoStatus(a)).state, 'synced');

  const again = await pullUpdates(a);
  assert.equal(again.ok, true);
  assert.equal(again.changed, false);
  assert.match(again.message, /already up to date/i);
});

test('pull: stops and preserves everything if incoming updates touch same lines as local changes', async () => {
  const { a, b, git } = makeSyncPair();
  fs.appendFileSync(path.join(b, 'skills/own/seo-audit/SKILL.md'), '\nChange from B.\n');
  git(b, 'commit', '-q', '-am', 'B touches seo-audit');
  git(b, 'push', '-q');
  const mine = path.join(a, 'skills/own/seo-audit/SKILL.md');
  fs.appendFileSync(mine, '\nMy change, not saved.\n');
  const before = fs.readFileSync(mine, 'utf8');
  const head = git(a, 'rev-parse', 'HEAD');

  const r = await pullUpdates(a);
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, 'same-lines');
  assert.match(r.message, /same lines/i);
  // same content; Git on Windows (core.autocrlf=true) may rewrite the line endings of a stashed file, so ignore \r
  const eol = (s) => s.replace(/\r\n/g, '\n');
  assert.equal(eol(fs.readFileSync(mine, 'utf8')), eol(before), 'my change is still there');
  assert.equal(git(a, 'rev-parse', 'HEAD'), head);
  assert.equal(git(a, 'stash', 'list'), '', 'no dangling stashes');

  // with setAside, pulls and leaves my changes safely stashed
  const s = await pullUpdates(a, { setAside: true });
  assert.equal(s.ok, true, JSON.stringify(s));
  assert.deepEqual(s.setAside, ['skills/own/seo-audit/SKILL.md']);
  assert.match(fs.readFileSync(mine, 'utf8'), /Change from B/);
  assert.doesNotMatch(fs.readFileSync(mine, 'utf8'), /My change/);
  assert.match(git(a, 'stash', 'list'), /stash-repo-pull|set aside/i);
  assert.match(git(a, 'stash', 'show', '-p'), /My change, not saved/, 'my change is saved in stash');
});

test('pull: local changes on different lines of the same file are reapplied on top and can be pushed', async () => {
  const { a, b, remote, git } = makeSyncPair();
  const rel = 'teams.json';
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
  write(a, rel, lines.join('\n') + '\n');
  git(a, 'add', '-A');
  git(a, 'commit', '-q', '-m', 'long file');
  git(a, 'push', '-q');
  git(b, 'pull', '-q');
  write(b, rel, [...lines.slice(0, 19), 'line 20 changed by B'].join('\n') + '\n');
  git(b, 'commit', '-q', '-am', 'B changes end');
  git(b, 'push', '-q');
  write(a, rel, ['line 1 changed by me', ...lines.slice(1)].join('\n') + '\n');

  const r = await pullUpdates(a);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.reapplied, [rel]);
  assert.match(r.message, /reapplied/i);
  const text = fs.readFileSync(path.join(a, rel), 'utf8');
  assert.match(text, /line 20 changed by B/);
  assert.match(text, /line 1 changed by me/);
  assert.equal(git(a, 'stash', 'list'), '');
  const p = await pushChanges(a);
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.match(git(remote, 'show', `main:${rel}`), /line 1 changed by me/);
});

test('push: saves changes, sends to mock GitHub, and cleans commit message', async () => {
  const { a, remote, git } = makeSyncPair();
  write(a, 'skills/own/new-skill/SKILL.md', '---\nname: new-skill\ndescription: Test.\n---\n# New\n');

  const r = await pushChanges(a, { message: 'Adding\na new\tskill' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.committed, true);
  assert.equal(r.pushed, 1);
  assert.equal(git(a, 'log', '-1', '--format=%s'), 'Adding a new skill');
  assert.equal(git(remote, 'rev-parse', 'main'), git(a, 'rev-parse', 'HEAD'), 'GitHub has identical commit');
  assert.equal((await repoStatus(a)).state, 'synced');

  const nothing = await pushChanges(a);
  assert.equal(nothing.ok, true);
  assert.match(nothing.message, /nothing to send/i);
  assert.equal(git(remote, 'rev-list', '--count', 'main'), '2');
});

test('push: uses default message when none provided; pushes all when unpushed commits exist', async () => {
  const { a, remote, git } = makeSyncPair();
  write(a, 'one.txt', '1');
  git(a, 'add', '-A');
  git(a, 'commit', '-q', '-m', 'Already committed locally');
  write(a, 'two.txt', '2');
  let st = await repoStatus(a);
  assert.equal(st.state, 'ahead');
  assert.equal(st.ahead, 1);
  assert.equal(st.outgoing[0].subject, 'Already committed locally');

  const r = await pushChanges(a);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.pushed, 2);
  assert.match(git(a, 'log', '-1', '--format=%s'), /^Updates from .+ on \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(git(remote, 'rev-parse', 'main'), git(a, 'rev-parse', 'HEAD'));
});

test('push: rejects files that look like secrets and creates no commit', async () => {
  const { a, remote, git } = makeSyncPair();
  write(a, '.env', 'TOKEN=abc');
  write(a, 'ok.txt', 'all good');
  const head = git(a, 'rev-parse', 'HEAD');
  const st = await repoStatus(a);
  assert.deepEqual(st.blocked, ['.env']);
  const r = await pushChanges(a);
  assert.equal(r.ok, false);
  assert.match(r.message, /\.env/);
  assert.equal(git(a, 'rev-parse', 'HEAD'), head);
  assert.equal(git(remote, 'rev-parse', 'main'), head);
  assert.equal(git(a, 'status', '--porcelain').includes('ok.txt'), true, 'ok.txt remains uncommitted');
});

test('secrets: detected by content; unmodified copies from GitHub are not blocked by file name', async () => {
  // content (keys constructed here to avoid leaving fake secrets in repo)
  const fakeGh = 'ghp' + '_' + 'A1b2C3d4'.repeat(5);
  assert.match(secretInText(`token = "${fakeGh}"`), /GitHub/);
  assert.match(secretInText('-----BEGIN OPENSSH ' + 'PRIVATE KEY-----\nabc'), /private key/i);
  assert.match(secretInText('AKIA' + 'ABCDEFGHIJKLMNOP'), /AWS/);
  assert.match(secretInText('sk-ant-' + 'api03-' + 'x'.repeat(50)), /Anthropic/);
  for (const t of ['use the ANTHROPIC_API_KEY variable', 'sk-ant-xxxx', 'ghp_xxx', 'BEGIN PUBLIC KEY', '# secret management']) assert.equal(secretInText(t), null, t);

  const { a, remote, git } = makeSyncPair();
  // external skill installed from GitHub with a "suspicious" but harmless filename, registered in lock
  write(a, 'skills/external/scanner/SKILL.md', '---\nname: scanner\ndescription: Searches secrets in code.\n---\n');
  write(a, 'skills/external/scanner/scripts/find_secrets.py', 'print("searching secrets")\n');
  write(a, 'skills/external/scanner/test.key', 'not a key\n');
  const lock = { version: 1, entries: [{ kind: 'skill', name: 'scanner', path: 'skills/external/scanner', source: { repo: 'x/y', commit: 'a'.repeat(40) }, contentHash: hashPath(path.join(a, 'skills/external/scanner')) }] };
  write(a, 'manifest.lock.json', JSON.stringify(lock));
  // own file with a real token inside, and a .env
  write(a, 'notes.md', `my token: ${fakeGh}\n`);
  write(a, '.env', 'X=1');
  let st = await repoStatus(a);
  assert.deepEqual([...st.blocked].sort(), ['.env', 'notes.md']);
  assert.match(st.blockedReasons['notes.md'], /GitHub/);
  assert.match(st.blockedReasons['.env'], /name/i);
  const r = await pushChanges(a);
  assert.equal(r.ok, false);
  assert.match(r.message, /notes\.md \(contains a GitHub token\)/i);
  assert.doesNotMatch(r.message, /find_secrets/);

  // once own files are removed, external skill can be pushed
  fs.rmSync(path.join(a, 'notes.md'));
  fs.rmSync(path.join(a, '.env'));
  st = await repoStatus(a);
  assert.deepEqual(st.blocked, []);
  const ok = await pushChanges(a);
  assert.equal(ok.ok, true, ok.message);
  assert.equal(git(remote, 'rev-parse', 'main'), git(a, 'rev-parse', 'HEAD'));

  // if external copy is modified locally, filename checks apply again; and a secret inside external skill always blocks
  write(a, 'skills/external/scanner/test.key', 'changed\n');
  assert.deepEqual(findSecrets(a, ['skills/external/scanner/test.key']).map((x) => x.path), ['skills/external/scanner/test.key']);
  write(a, 'skills/external/scanner/test.key', 'not a key\n');
  write(a, 'skills/external/scanner/scripts/find_secrets.py', `K = "${fakeGh}"\n`);
  assert.match(findSecrets(a, ['skills/external/scanner/scripts/find_secrets.py'])[0].reason, /GitHub/);
});

test('pull: skips git hooks (slow sync does not block) and notifies if interface restart is required', async () => {
  const { a, b, git } = makeSyncPair();
  // slow post-merge hook on "a"
  write(a, '.githooks-test/post-merge', '#!/bin/sh\necho done > hook-done.txt\nsleep 30\n');
  fs.chmodSync(path.join(a, '.githooks-test/post-merge'), 0o755);
  git(a, 'config', 'core.hooksPath', '.githooks-test');
  write(b, 'scripts/new-script.mjs', 'export {};\n');
  git(b, 'add', '-A');
  git(b, 'commit', '-q', '-m', 'new script');
  git(b, 'push', '-q');
  const t0 = Date.now();
  const r = await pullUpdates(a, { interactive: false });
  assert.equal(r.ok, true, r.message);
  assert.ok(Date.now() - t0 < 15000, 'pull does not wait for hook');
  assert.ok(fs.existsSync(path.join(a, 'scripts/new-script.mjs')));
  assert.ok(!fs.existsSync(path.join(a, 'hook-done.txt')), 'hook was not executed');
  assert.equal(r.needsRestart, true);
});

test('pull: generated and locally modified GUIDE.md does not block; user settings preserved', async () => {
  const { a, b, git } = makeSyncPair();
  for (const d of [a]) {
    write(d, 'GUIDE.md', 'guide v1\n');
    git(d, 'add', '-A');
    git(d, 'commit', '-q', '-m', 'guide');
    git(d, 'push', '-q');
  }
  git(b, 'pull', '-q');
  // on "a": hub regenerated guide and recorded an install in lock, without committing
  write(a, 'GUIDE.md', 'locally regenerated guide\n');
  write(a, 'manifest.lock.json', '{"version":1,"entries":[{"kind":"skill","name":"mine"}]}\n');
  // incoming new guide on GitHub
  write(b, 'GUIDE.md', 'guide v2\n');
  git(b, 'commit', '-qam', 'guide 2');
  git(b, 'push', '-q');
  const r = await pullUpdates(a, { interactive: false });
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(r.regenerate, ['GUIDE.md']);
  assert.equal(fs.readFileSync(path.join(a, 'GUIDE.md'), 'utf8').replace(/\r\n/g, '\n'), 'guide v2\n', 'caller regenerates afterward');
  assert.match(fs.readFileSync(path.join(a, 'manifest.lock.json'), 'utf8'), /"mine"/, 'local installations are not touched');

  // a file with conflicting user settings continues to stop pull safely
  write(a, 'registry.json', '{"version":1,"overrides":{},"links":[{"from":"agent:x","to":"skill:y"}]}\n');
  write(b, 'registry.json', '{"version":1,"overrides":{},"links":[]}\n ');
  git(b, 'commit', '-qam', 'registry');
  git(b, 'push', '-q');
  const r2 = await pullUpdates(a, { interactive: false });
  assert.equal(r2.ok, false);
  assert.match(fs.readFileSync(path.join(a, 'registry.json'), 'utf8'), /agent:x/);
});

test('git: responds on timeout even if spawned process keeps output pipe open', { skip: process.platform === 'win32' }, async () => {
  const dir = mktmp();
  spawnSync('git', ['init', '-q', dir]);
  const t0 = Date.now();
  const r = await runGit(dir, ['-c', 'alias.slow=!sleep 30 & sleep 30', 'slow'], { timeout: 800 });
  assert.equal(r.timedOut, true);
  assert.equal(r.ok, false);
  assert.ok(Date.now() - t0 < 5000, `response after ${Date.now() - t0} ms`);
});

test('push and pull: stops without changing anything if remote has updates or histories diverged', async () => {
  const { a, b, remote, git } = makeSyncPair();
  write(b, 'from-b.txt', 'b');
  git(b, 'add', '-A');
  git(b, 'commit', '-q', '-m', 'B');
  git(b, 'push', '-q');

  // a is behind and has uncommitted file: push must not create commit
  write(a, 'mine.txt', 'a');
  const head = git(a, 'rev-parse', 'HEAD');
  const remoteHead = git(remote, 'rev-parse', 'main');
  let r = await pushChanges(a);
  assert.equal(r.ok, false);
  assert.match(r.message, /download updates/i);
  assert.equal(git(a, 'rev-parse', 'HEAD'), head, 'no commit created');
  assert.equal(git(remote, 'rev-parse', 'main'), remoteHead);

  // now a also has a commit: histories diverge
  git(a, 'add', '-A');
  git(a, 'commit', '-q', '-m', 'A');
  const st = await repoStatus(a, { fetch: true });
  assert.equal(st.state, 'diverged');
  assert.equal(st.ahead, 1);
  assert.equal(st.behind, 1);
  const localHead = git(a, 'rev-parse', 'HEAD');

  r = await pullUpdates(a);
  assert.equal(r.ok, false);
  assert.match(r.message, /merged manually/i);
  r = await pushChanges(a);
  assert.equal(r.ok, false);
  assert.equal(git(a, 'rev-parse', 'HEAD'), localHead, 'no automatic merge');
  assert.equal(git(remote, 'rev-parse', 'main'), remoteHead, 'no force push to mock GitHub');
});

test('push: reports identity error and creates no commit if git user identity is missing', async () => {
  const { a, git } = makeSyncPair();
  git(a, 'config', 'user.name', '');
  git(a, 'config', 'user.email', '');
  write(a, 'x.txt', 'x');
  const head = git(a, 'rev-parse', 'HEAD');
  const r = await pushChanges(a);
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, 'identity');
  assert.match(r.message, /git config --global user\.name/);
  assert.equal(git(a, 'rev-parse', 'HEAD'), head);
});

test('edge cases: no repo, repo inside another repo, no remote, no upstream, detached HEAD, merge in progress', async () => {
  const plain = makeHub();
  assert.equal((await repoStatus(plain)).state, 'no-repo');
  assert.match(describeStatus(await repoStatus(plain)), /git clone/);

  // hub inside another repo: must never operate on outer repo
  const { a: outer, git } = makeSyncPair();
  const inner = path.join(outer, 'sub-hub');
  fs.mkdirSync(inner);
  write(inner, 'x.txt', 'x');
  assert.equal((await repoStatus(inner)).state, 'no-repo');
  const r = await pushChanges(inner);
  assert.equal(r.ok, false);
  assert.equal(git(outer, 'log', '--oneline').split('\n').length, 1, 'outer repo received no commits');
  assert.ok(git(outer, 'status', '--porcelain').includes('sub-hub'), 'file remains untracked');

  const solo = mktmp();
  git(solo, 'init', '-q');
  assert.equal((await repoStatus(solo)).state, 'no-remote');
  git(solo, 'remote', 'add', 'origin', path.join(solo, 'nonexistent.git'));
  const st = await repoStatus(solo);
  assert.equal(st.state, 'no-upstream');
  assert.match(describeStatus(st), /git push -u origin/);

  const { a, git: g2 } = makeSyncPair();
  g2(a, 'checkout', '-q', '--detach');
  assert.equal((await repoStatus(a)).state, 'detached');
  g2(a, 'checkout', '-q', 'main');
  fs.writeFileSync(path.join(a, '.git', 'MERGE_HEAD'), g2(a, 'rev-parse', 'HEAD') + '\n');
  assert.equal((await repoStatus(a)).state, 'in-progress');
});

test('failed fetch: local status remains valid and error is explained without credentials', async () => {
  const { a, git } = makeSyncPair();
  git(a, 'remote', 'set-url', 'origin', path.join(a, 'nonexistent.git'));
  const st = await repoStatus(a, { fetch: true });
  assert.equal(st.fetched, false);
  assert.ok(st.fetchError);
  assert.equal(st.state, 'synced', 'local copy state is still visible');
  const p = await pullUpdates(a);
  assert.equal(p.ok, false);
  const s = await pushChanges(a);
  assert.equal(s.ok, false);
});

test('GitHub URL displayed without user and password', async () => {
  const { a, git } = makeSyncPair();
  git(a, 'remote', 'set-url', 'origin', 'https://user:ghp_SECRET@github.com/example-owner/ai-hub.git');
  const st = await repoStatus(a);
  assert.equal(st.remoteUrl, 'https://github.com/example-owner/ai-hub');
  assert.ok(!JSON.stringify(st).includes('SECRET'));
});

test('terminal: npm run update checks, pulls, and pushes only with confirmation', async () => {
  const { a, b, remote, git } = makeSyncPair();
  write(b, 'from-b.txt', 'b');
  git(b, 'add', '-A');
  git(b, 'commit', '-q', '-m', 'B');
  git(b, 'push', '-q');

  let r = run('update.mjs', ['--check', '--json'], { root: a });
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).state, 'behind');
  r = run('update.mjs', [], { root: a });
  assert.match(r.out, /update to download/i);
  assert.match(r.out, /npm run update -- --pull/);

  assert.equal(run('update.mjs', ['--pull', '--push'], { root: a }).code, 2, 'only one action at a time');
  r = run('update.mjs', ['--pull'], { root: a });
  assert.equal(r.code, 0, r.err);
  assert.ok(fs.existsSync(path.join(a, 'from-b.txt')));
  assert.match(r.out, /npm run sync/);
  // test hub has a skill requiring a missing tool: after pull recommends running setup
  assert.match(r.out, /missing programs used by skills: comando-che-non-esiste-xyz/i);
  assert.match(r.out, /npm run setup/);

  write(a, 'mine.txt', 'a');
  const remoteHead = git(remote, 'rev-parse', 'main');
  r = run('update.mjs', ['--push'], { root: a });
  assert.equal(r.code, 2, 'refuses push without terminal and without --yes');
  assert.equal(git(remote, 'rev-parse', 'main'), remoteHead);
  r = run('update.mjs', ['--push', '--yes', '--message=From terminal'], { root: a });
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(git(remote, 'log', '-1', '--format=%s', 'main'), 'From terminal');
});

test('git commands executed without shell: message with quotes and symbols remains plain text', async () => {
  const { a, git } = makeSyncPair();
  write(a, 'x.txt', 'x');
  const msg = 'Test "with quotes" and $(echo hacked) ; rm -rf / `x` & plus';
  const r = await pushChanges(a, { message: msg });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(git(a, 'log', '-1', '--format=%s'), msg);
  assert.equal(spawnSync('git', ['--version']).status, 0);
});
