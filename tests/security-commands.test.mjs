// Security regression: command execution (no shell, validated arguments, bounded time) and supply chain
// (pinned external components, no npm dependencies, pinned workflow actions).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cleanupAfter, makeGitFixture, makeHub, mktmp, REPO, run, write } from './helpers.mjs';
import { runCommand } from '../scripts/lib/machine.mjs';
import { commandPath, commandExists } from '../scripts/lib/util.mjs';
import { installPlan, validateDependencies, missingSkillCommands } from '../scripts/lib/deps.mjs';
import { resolveScanner, scanTarget, verdict } from '../scripts/lib/spector.mjs';
import { cloneSource, parseSource } from '../scripts/lib/source.mjs';
import { scanHub } from '../scripts/lib/scan.mjs';

cleanupAfter();

const walk = (dir, out = []) => {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'external', 'dist'].includes(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else if (/\.(mjs|js)$/.test(ent.name)) out.push(full);
  }
  return out;
};

test('policy: no exec/execSync/execFile anywhere, and `shell:` only in the validated Windows .cmd shim', () => {
  const offenders = [];
  for (const f of [...walk(path.join(REPO, 'scripts')), ...walk(path.join(REPO, 'ui')), ...walk(path.join(REPO, 'packaging'))]) {
    const text = fs.readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '');
    if (/(?<![.\w])(exec|execSync|execFile|execFileSync)\s*\(/.test(text) || /import\s*\{[^}]*\b(exec|execSync|execFile)\b[^}]*\}\s*from\s*'node:child_process'/.test(text)) offenders.push(`${path.relative(REPO, f)}: exec*`);
    if (/shell\s*:\s*true/.test(text)) offenders.push(`${path.relative(REPO, f)}: shell:true`);
    if (/shell\s*:/.test(text) && path.relative(REPO, f) !== path.join('scripts', 'lib', 'machine.mjs')) offenders.push(`${path.relative(REPO, f)}: shell option`);
  }
  assert.deepEqual(offenders, []);
});

test('runCommand: names and arguments with shell metacharacters are refused before anything runs', () => {
  const marker = path.join(mktmp(), 'pwned');
  const evil = [`x; touch ${marker}`, `x && touch ${marker}`, `x | touch ${marker}`, '$(touch x)', '`id`', 'x y', 'x\nid', '../x', '/bin/sh', 'x>out', ''];
  for (const cmd of evil) assert.throws(() => runCommand(cmd, []), /invalid|command/i, JSON.stringify(cmd));
  for (const arg of [`--x; touch ${marker}`, '$(id)', '`id`', 'a b', 'a\nb', '"q"', "'q'", 'a|b', 'a&b', 'a>b', 'a<b', 'a*b', 'a?b', 'a~b', 'a#b', '', '--x=$HOME']) assert.throws(() => runCommand('node', [arg]), /invalid|argument/i, JSON.stringify(arg));
  assert.equal(fs.existsSync(marker), false);
  assert.equal(runCommand('node', ['--version']).ok, true, 'a legitimate call still works');
});

test('skill metadata cannot turn into a command: requires-commands with shell syntax is never executed', () => {
  const root = makeHub();
  const marker = path.join(mktmp(), 'pwned');
  write(root, 'skills/own/evil/SKILL.md', `---\nname: evil\ndescription: Tries to run a command through its requirements.\nrequires-commands: "x;touch ${marker}, $(touch ${marker}), \`touch ${marker}\`"\n---\n# evil\n`);
  const index = scanHub(root);
  missingSkillCommands(index);
  for (const script of [['doctor.mjs', []], ['needs.mjs', []], ['needs.mjs', ['--json']]]) run(script[0], script[1], { root });
  assert.equal(fs.existsSync(marker), false);
  for (const c of ['x;touch /tmp/a', '$(id)', '`id`', 'a b', '../x', 'a/b']) assert.equal(commandExists(c), false, c);
});

test('install plans are built only from validated {manager, package}: injection attempts yield no plan', () => {
  for (const spec of [
    { manager: 'brew', package: 'node; touch /tmp/x' }, { manager: 'brew', package: '$(id)' }, { manager: 'brew', package: '--cask evil' },
    { manager: 'sh', package: 'node' }, { manager: 'uv', package: 'git+https://evil.example/x.git' }, { manager: 'uv', package: 'git+https://github.com/o/r.git@main' },
    { manager: 'uv', package: 'git+https://github.com/o/r.git@--upload-pack=x' }, { manager: 'uv', package: 'git+http://github.com/o/r.git' }, { manager: 'uv', package: 'x', python: '3.12; id' },
    { manager: 'winget', package: 'a b' },
  ]) {
    const plan = installPlan({ [process.platform]: spec }, null, { managers: { brew: true, uv: true, winget: true, npm: true } });
    assert.equal(plan.auto, false, JSON.stringify(spec));
  }
  const pinned = `git+https://github.com/o/r.git@${'a'.repeat(40)}`;
  assert.equal(installPlan({ [process.platform]: { manager: 'uv', package: pinned } }, null, { managers: { uv: true } }).auto, true);
});

test('executables: relative PATH entries are never trusted (a planted program in the current folder is not run)', { skip: process.platform === 'win32' }, () => {
  const planted = mktmp();
  const exe = path.join(planted, 'skillspector');
  fs.writeFileSync(exe, '#!/bin/sh\necho planted\n', { mode: 0o755 });
  const cwd = process.cwd();
  process.chdir(planted);
  try {
    for (const PATH of ['.', '', `:${planted}`.replace(planted, ''), 'bin:.', ':']) assert.equal(commandPath('skillspector', { PATH, HOME: mktmp() }), null, JSON.stringify(PATH));
    assert.equal(commandPath('skillspector', { PATH: planted, HOME: mktmp() }), exe, 'an absolute entry still works');
  } finally {
    process.chdir(cwd);
  }
  assert.equal(commandPath('../skillspector', { PATH: planted }), null);
  assert.equal(commandPath('a/b', { PATH: planted }), null);
});

test('scanner: the target is an absolute path (never an option), and a hung scanner times out and blocks', () => {
  const dir = mktmp();
  const log = path.join(dir, 'args.log');
  const script = path.join(dir, 'fake.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n'); if (process.env.HANG) setTimeout(() => {}, 20000); else { console.log('{}'); }`);
  const scanner = resolveScanner({ AI_HUB_SKILLSPECTOR_SCRIPT: script });
  const work = mktmp();
  fs.mkdirSync(path.join(work, '--help'));
  const cwd = process.cwd();
  process.chdir(work);
  try {
    scanTarget(scanner, '--help');
  } finally {
    process.chdir(cwd);
  }
  const args = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n').pop());
  assert.equal(args[0], 'scan');
  assert.ok(path.isAbsolute(args[1]), `target ${args[1]} must be absolute`);
  assert.equal(scanTarget(scanner, path.join(work, 'does-not-exist')).ok, false);

  const t0 = Date.now();
  const hung = scanTarget(scanner, work, { timeout: 400, env: { ...process.env, HANG: '1' } });
  assert.ok(Date.now() - t0 < 5000, 'returned promptly instead of waiting for the hung process');
  assert.equal(hung.ok, false);
  assert.match(hung.error, /timed out/i);
  assert.equal(verdict(hung, 'block'), 'block');
});

test('git clone: only https/file transports, no submodules, a bounded time, arguments after "--"', { skip: process.platform === 'win32' }, () => {
  const bin = mktmp();
  const log = path.join(bin, 'calls.log');
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\ncase "$*" in *rev-parse*) echo ${'a'.repeat(40)};; esac\nexit 0\n`, { mode: 0o755 });
  const old = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${old}`;
  try {
    cloneSource(parseSource('Owner/Repo'), path.join(mktmp(), 'dest'));
    cloneSource(parseSource('Owner/Repo', { ref: 'a'.repeat(40) }), path.join(mktmp(), 'dest2'));
  } finally {
    process.env.PATH = old;
  }
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
  const clone = calls.find((c) => /\bclone\b/.test(c));
  assert.match(clone, /protocol\.allow=never/);
  assert.match(clone, /protocol\.https\.allow=always/);
  assert.match(clone, /protocol\.ext\.allow=never/);
  assert.doesNotMatch(clone, /protocol\.file\.allow=always/, 'a GitHub source never enables the file transport');
  assert.match(clone, /--no-recurse-submodules/);
  assert.match(clone, / -- https:\/\/github\.com\/Owner\/Repo /);
  assert.ok(calls.some((c) => /checkout --quiet a{40} --$/.test(c)), 'checkout of a commit ends with "--"');
});

test('git clone of a local folder (CLI only) enables the file transport and nothing else', () => {
  const src = makeGitFixture({ 'skills/probe/SKILL.md': '---\nname: probe\ndescription: p.\n---\n' });
  const dest = path.join(mktmp(), 'clone');
  const sha = cloneSource(parseSource(src.dir), dest);
  assert.equal(sha, src.head());
  assert.ok(fs.existsSync(path.join(dest, 'skills', 'probe', 'SKILL.md')));
});

// ---------------------------------------------------------------- supply chain
test('supply chain: no npm dependencies are declared (nothing is downloaded at install time)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  for (const k of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies']) assert.equal(pkg[k], undefined, k);
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish']) assert.equal(pkg.scripts[hook], undefined, `no ${hook} lifecycle script runs on install`);
  assert.equal(fs.existsSync(path.join(REPO, 'package-lock.json')), false);
});

test('supply chain: every git-based package in dependencies.json is pinned to a full commit', () => {
  const deps = JSON.parse(fs.readFileSync(path.join(REPO, 'dependencies.json'), 'utf8'));
  assert.deepEqual(validateDependencies(deps), []);
  const specs = [...deps.tools, ...Object.values(deps.commandProviders ?? {})].flatMap((x) => Object.values(x.install ?? {}));
  const git = specs.filter((s) => /^git\+/.test(s.package));
  assert.ok(git.length >= 3, 'SkillSpector is installed from git on three platforms');
  for (const s of git) assert.match(s.package, /\.git@[0-9a-f]{40}$/, s.package);
});

test('supply chain: GitHub Actions are pinned to commit SHAs, tokens are read-only by default, no pull_request_target', () => {
  const dir = path.join(REPO, '.github', 'workflows');
  for (const f of fs.readdirSync(dir)) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)) {
      if (m[1].startsWith('./')) continue;
      assert.match(m[1], /@[0-9a-f]{40}$/, `${f}: ${m[1]} must be pinned to a commit SHA`);
    }
    assert.match(text, /^permissions:\s*\n\s+contents:\s*read/m, `${f}: default token permissions are read-only`);
    assert.doesNotMatch(text, /pull_request_target/, `${f}: runs untrusted PR code with secrets`);
    assert.doesNotMatch(text, /\$\{\{\s*github\.event\.(issue|pull_request|comment|head_commit)[^}]*\}\}[^\n]*\n?(?=[^\n]*run:)/, `${f}: no untrusted event text in a script`);
  }
});

test('supply chain: bootstrap scripts do not pipe downloads into a shell', () => {
  for (const f of ['bootstrap.sh', 'bootstrap.cmd', 'start.command', 'start.cmd', '.github/scripts/package.sh']) {
    const text = fs.readFileSync(path.join(REPO, f), 'utf8');
    assert.doesNotMatch(text, /(curl|wget)[^\n|]*\|\s*(ba|z)?sh/i, f);
    assert.doesNotMatch(text, /Invoke-Expression|\biex\b[^\n]*(DownloadString|irm|iwr)/i, f);
  }
});
