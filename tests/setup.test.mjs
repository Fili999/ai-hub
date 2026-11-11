// Dependencies and setup: file validation, install plans, checks, safe execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { compareVersions, parseVersion, runCommand } from '../scripts/lib/machine.mjs';
import { checkTool, installPlan, loadDependencies, missingSkillCommands, runPlan, validateDependencies } from '../scripts/lib/deps.mjs';
import { cleanupAfter, makeHub, mktmp, REPO, run, write } from './helpers.mjs';

cleanupAfter();

const NO_MANAGERS = { winget: false, brew: false, npm: false };
const ALL_MANAGERS = { winget: true, brew: true, npm: true };

test('repo dependencies.json is valid and covers Windows and Mac for each tool', () => {
  const deps = loadDependencies(REPO);
  assert.deepEqual(validateDependencies(deps), []);
  assert.ok(deps.tools.length >= 3);
  for (const t of deps.tools.filter((x) => x.level !== 'optional')) {
    assert.ok(t.install.win32 && t.install.darwin, `${t.id}: requires both win32 and darwin`);
    assert.ok(t.manual, `${t.id}: requires a manual installation link`);
  }
  assert.ok(deps.tools.some((t) => t.id === 'node' && t.level === 'required'));
  assert.ok(!('_note' in deps.commandProviders) && !('_nota' in deps.commandProviders));
});

test('validation: managers and packages with invalid characters or off-list are rejected', () => {
  const base = { id: 'x', level: 'optional', check: { command: 'x' } };
  const errs = (install, extra = {}) => validateDependencies({ tools: [{ ...base, ...extra, install }], commandProviders: {} });
  assert.deepEqual(errs({ linux: { manager: 'npm', package: '@scope/package-1.2' } }), []);
  assert.equal(errs({ linux: { manager: 'sh', package: 'x' } }).length, 1);
  assert.equal(errs({ linux: { manager: 'curl', package: 'https://x.sh' } }).length, 1);
  assert.equal(errs({ linux: { manager: 'npm', package: 'x; rm -rf /' } }).length, 1);
  assert.equal(errs({ linux: { manager: 'npm', package: 'x y' } }).length, 1);
  assert.equal(errs({ linux: { manager: 'npm', package: '$(id)' } }).length, 1);
  assert.equal(errs({ linux: { manager: 'npm', package: '-g' } }).length, 1, 'package cannot resemble a flag');
  assert.equal(errs({ plan9: { manager: 'npm', package: 'x' } }).length, 1);
  assert.equal(errs({}, { level: 'maybe' }).length, 1);
  assert.equal(errs({}, { check: { command: 'a b' } }).length, 1);
  assert.equal(errs({}, { id: '' }).length >= 1, true);
  assert.equal(validateDependencies({ tools: [base, base], commandProviders: {} }).filter((e) => /duplicate/i.test(e)).length, 1);
  assert.equal(validateDependencies({ tools: [], commandProviders: { 'ff mpeg': { install: {} } } }).length, 1);
  assert.equal(validateDependencies({ tools: [], commandProviders: { ffmpeg: { install: { win32: { manager: 'bash', package: 'x' } } } } }).length, 1);
});

test('installation plan: commands constructed per platform and manager', () => {
  const spec = {
    win32: { manager: 'winget', package: 'Git.Git' },
    darwin: { manager: 'brew', package: 'claude-code', cask: true },
    linux: { manager: 'npm', package: '@anthropic-ai/claude-code' },
  };
  const w = installPlan(spec, 'https://m', { platform: 'win32', managers: ALL_MANAGERS });
  assert.equal(w.auto, true);
  assert.equal(w.manager, 'winget');
  assert.deepEqual(w.args, ['install', '--id', 'Git.Git', '-e', '--accept-package-agreements', '--accept-source-agreements']);
  assert.equal(w.display, 'winget install --id Git.Git -e --accept-package-agreements --accept-source-agreements');

  const m = installPlan(spec, null, { platform: 'darwin', managers: ALL_MANAGERS });
  assert.deepEqual(m.args, ['install', '--cask', 'claude-code']);
  assert.deepEqual(installPlan({ darwin: { manager: 'brew', package: 'git' } }, null, { platform: 'darwin', managers: ALL_MANAGERS }).args, ['install', 'git']);
  assert.deepEqual(installPlan(spec, null, { platform: 'linux', managers: ALL_MANAGERS }).args, ['install', '-g', '@anthropic-ai/claude-code']);

  const noBrew = installPlan(spec, 'https://m', { platform: 'darwin', managers: NO_MANAGERS });
  assert.equal(noBrew.auto, false);
  assert.match(noBrew.reason, /Homebrew/i);
  assert.equal(noBrew.manual, 'https://m');
  assert.match(installPlan(spec, null, { platform: 'win32', managers: NO_MANAGERS }).reason, /winget/i);

  const none = installPlan({ win32: spec.win32 }, 'https://m', { platform: 'linux', managers: ALL_MANAGERS });
  assert.equal(none.auto, false);
  assert.match(none.reason, /linux/i);
  assert.equal(installPlan(undefined, null, { platform: 'linux', managers: ALL_MANAGERS }).auto, false);
  // even if file validation is bypassed, plan is not created
  assert.equal(installPlan({ linux: { manager: 'npm', package: 'x; id' } }, null, { platform: 'linux', managers: ALL_MANAGERS }).auto, false);
  assert.equal(installPlan({ linux: { manager: 'sh', package: 'x' } }, null, { platform: 'linux', managers: ALL_MANAGERS }).auto, false);
});

test('winget: already installed is not an error; programs placed by winget found outside PATH', async () => {
  const plan = { auto: true, manager: 'winget', args: ['install', '--id', 'astral-sh.uv', '-e'] };
  assert.deepEqual(runPlan(plan, () => ({ ok: false, status: 2316632107 })), { ok: true, error: null, already: true });
  assert.deepEqual(runPlan(plan, () => ({ ok: false, status: -1978335135 })), { ok: true, error: null, already: true }, 'also as signed integer');
  assert.equal(runPlan(plan, () => ({ ok: false, status: 1 })).ok, false);
  assert.equal(runPlan({ ...plan, manager: 'brew' }, () => ({ ok: false, status: 2316632107 })).ok, false, 'winget only');
  const { toolBinDirs } = await import('../scripts/lib/util.mjs');
  const win = toolBinDirs({ USERPROFILE: 'C:\\Users\\f', LOCALAPPDATA: 'C:\\Users\\f\\AppData\\Local' }, 'win32');
  assert.ok(win.includes('C:\\Users\\f\\AppData\\Local\\Microsoft\\WinGet\\Links'));
  assert.ok(!toolBinDirs({ HOME: '/Users/f', LOCALAPPDATA: 'x' }, 'darwin').some((d) => d.includes('WinGet')));
});

test('runPlan: does not execute manual plans, passes manager and args to runner', () => {
  assert.deepEqual(runPlan({ auto: false, reason: 'no' }, () => assert.fail('should not execute')), { ok: false, error: 'no' });
  const calls = [];
  const ok = runPlan({ auto: true, manager: 'npm', args: ['install', '-g', 'x'] }, (...a) => (calls.push(a), { ok: true }));
  assert.deepEqual(ok, { ok: true, error: null });
  assert.deepEqual(calls[0].slice(0, 2), ['npm', ['install', '-g', 'x']]);
  assert.equal(calls[0][2].inherit, true);
  assert.deepEqual(runPlan({ auto: true, manager: 'npm', args: [] }, () => ({ ok: false, status: 3, error: null })), { ok: false, error: 'exited with code 3' });
});

test('tool checking: missing, too old, ok, unresponsive', () => {
  const node = { id: 'node', name: 'Node', level: 'required', check: { command: 'node', args: ['--version'], minVersion: '18' } };
  const probe = (stdout, ok = true) => () => ({ ok, stdout, stderr: '' });

  assert.match(checkTool({ ...node, check: { command: 'comando-che-non-esiste-xyz' } }).reason, /not found in PATH/i);
  const old = checkTool(node, probe('v16.20.2'));
  assert.equal(old.ok, false);
  assert.equal(old.found, true);
  assert.match(old.reason, /too old.*18/i);
  const good = checkTool(node, probe('v22.1.0'));
  assert.equal(good.ok, true);
  assert.equal(good.version, '22.1.0');
  assert.match(checkTool(node, probe('', false)).reason, /not responding/i);
  assert.equal(checkTool({ ...node, check: { command: 'node' } }, () => assert.fail('without args do not execute')).ok, true);
});

test('commands required by skills: missing ones only, with demanding entities', () => {
  const index = {
    skills: [{ id: 'skill:a', requires: { commands: ['ffmpeg', 'git'] } }, { id: 'skill:b', requires: { commands: ['ffmpeg'] } }, { id: 'skill:c' }],
    agents: [{ id: 'agent:x', requires: { commands: ['yt-dlp'] } }],
  };
  const out = missingSkillCommands(index, (c) => c === 'git');
  assert.deepEqual(out, [
    { command: 'ffmpeg', requiredBy: ['skill:a', 'skill:b'] },
    { command: 'yt-dlp', requiredBy: ['agent:x'] },
  ]);
  assert.deepEqual(missingSkillCommands(index, () => true), []);
});

test('programs: on Windows app execution aliases count as present even if stat fails', async () => {
  const { isRunnable } = await import('../scripts/lib/util.mjs');
  const alias = { statSync: () => { throw Object.assign(new Error('UNKNOWN'), { code: 'UNKNOWN' }); }, accessSync: () => {}, readdirSync: () => ['winget.exe', 'python.exe'] };
  assert.equal(isRunnable('C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe', { platform: 'win32', fsx: alias }), true);
  assert.equal(isRunnable('C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps\\WinGet.EXE', { platform: 'win32', fsx: alias }), true);
  assert.equal(isRunnable('C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps\\brew.exe', { platform: 'win32', fsx: alias }), false);
  assert.equal(isRunnable('/usr/local/bin/winget', { platform: 'darwin', fsx: alias }), false, 'Windows only');
  const dir = { statSync: () => ({ isFile: () => false }), accessSync: () => {}, readdirSync: () => [] };
  assert.equal(isRunnable('C:\\x\\folder', { platform: 'win32', fsx: dir }), false);
});

test('runCommand: rejects shell injection names and args', () => {
  for (const cmd of ['node;ls', 'node && id', '$(id)', 'a b', '', '../node', 'x|y']) assert.throws(() => runCommand(cmd, []), /invalid/i, cmd);
  for (const arg of ['a b', '$(id)', '`id`', 'x;y', 'x|y', 'x>y', '"x"', '', 'a\nb']) assert.throws(() => runCommand('node', [arg]), /invalid/i, JSON.stringify(arg));
  const r = runCommand('node', ['--version']);
  assert.equal(r.ok, true);
  assert.match(r.stdout, /^v\d+\./);
  assert.equal(runCommand('comando-che-non-esiste-xyz', []).ok, false);
});

test('versions: comparison and parsing across formats', () => {
  assert.deepEqual(parseVersion('git version 2.43.0'), [2, 43, 0]);
  assert.deepEqual(parseVersion('v22.22.0'), [22, 22, 0]);
  assert.deepEqual(parseVersion('1.2'), [1, 2, 0]);
  assert.equal(parseVersion('no version'), null);
  assert.equal(compareVersions('18', '18.0.0'), 0);
  assert.equal(compareVersions('v16.20.2', '18'), -1);
  assert.equal(compareVersions('2.43.0', '2.25'), 1);
  assert.equal(compareVersions('2.9', '2.25'), -1, 'numerical comparison');
  assert.equal(compareVersions('unknown', '1'), 0);
});

// ---- CLI execution tests ----

const deps = (tools, commandProviders = {}) => JSON.stringify({ version: 1, tools, commandProviders });
const fake = (over = {}) => ({
  id: 'fake-tool-xyz',
  name: 'Fake',
  level: 'required',
  why: 'test',
  check: { command: 'fake-tool-xyz', args: ['--version'] },
  install: { win32: { manager: 'npm', package: 'fake-package-xyz' }, darwin: { manager: 'npm', package: 'fake-package-xyz' }, linux: { manager: 'npm', package: 'fake-package-xyz' } },
  ...over,
});

test('setup --check: exits 1 if required tool missing, 0 if only optional missing, changes nothing', () => {
  const root = makeHub();
  const before = fs.readdirSync(root).sort();
  write(root, 'dependencies.json', deps([fake()]));
  let r = run('setup.mjs', ['--check', '--json'], { root });
  assert.equal(r.code, 1, r.err);
  let rep = JSON.parse(r.out);
  assert.equal(rep.tools[0].ok, false);
  assert.match(rep.tools[0].reason, /not found in PATH/i);
  assert.deepEqual(rep.installed, []);
  assert.equal(rep.skillCommands[0].command, 'comando-che-non-esiste-xyz');
  assert.equal(rep.skillCommands[0].provider, null);

  write(root, 'dependencies.json', deps([fake({ level: 'optional' }), { id: 'node', name: 'Node', level: 'required', why: 'x', check: { command: 'node', args: ['--version'], minVersion: '18' } }]));
  r = run('setup.mjs', ['--check', '--json'], { root });
  assert.equal(r.code, 0, r.err);
  rep = JSON.parse(r.out);
  assert.equal(rep.tools.find((t) => t.id === 'node').ok, true);

  r = run('setup.mjs', ['--check'], { root });
  assert.equal(r.code, 0);
  assert.match(r.out, /required are present|required programs are installed/i);
  assert.deepEqual(fs.readdirSync(root).sort().filter((f) => f !== 'dependencies.json' && f !== 'index' && f !== 'GUIDE.md'), before.filter((f) => f !== 'dependencies.json'));
});

test('setup --dry-run --yes: shows command to execute and runs nothing', () => {
  const root = makeHub();
  write(root, 'dependencies.json', deps([fake()], { 'comando-che-non-esiste-xyz': { name: 'Fake command', install: { win32: { manager: 'npm', package: 'other-fake-xyz' }, darwin: { manager: 'npm', package: 'other-fake-xyz' }, linux: { manager: 'npm', package: 'other-fake-xyz' } } } }));
  const r = run('setup.mjs', ['--dry-run', '--yes', '--no-sync', '--no-hooks'], { root });
  if (/npm ✔/.test(r.out)) {
    assert.match(r.out, /command: npm install -g fake-package-xyz/);
    assert.match(r.out, /command: npm install -g other-fake-xyz/);
    assert.match(r.out, /\[dry[- ]run\] not (run|executed)/i);
    assert.match(r.out, /(needed|required) by skill:montaggio-video/i);
  } else {
    assert.match(r.out, /cannot install automatically/i);
  }
  assert.doesNotMatch(r.out, /✔ Fake installed/i);
  assert.equal(r.code, 1, 'required tool is still missing');
});

test('setup without terminal and without --yes: installs nothing', () => {
  const root = makeHub();
  write(root, 'dependencies.json', deps([fake()]));
  const r = run('setup.mjs', ['--no-sync', '--no-hooks'], { root });
  assert.doesNotMatch(r.out, /✔ .*installed/i);
  if (/npm ✔/.test(r.out)) assert.match(r.out, /skipped \(no interactive terminal/i);
  assert.equal(r.code, 1);
  assert.match(r.out, /Required programs still missing/i);
});

test('setup: dependencies.json with disallowed managers or packages blocks before running', () => {
  for (const install of [{ linux: { manager: 'sh', package: 'x' } }, { linux: { manager: 'npm', package: 'x; touch /tmp/pwned-ai-hub' } }]) {
    const root = makeHub();
    write(root, 'dependencies.json', deps([fake({ install })]));
    const r = run('setup.mjs', ['--yes', '--no-sync', '--no-hooks'], { root });
    assert.equal(r.code, 1);
    assert.match(r.err, /dependencies\.json is not valid/i);
    assert.ok(!fs.existsSync('/tmp/pwned-ai-hub'));
  }
});

test('bootstrap: startup scripts exist and point to setup.mjs', () => {
  const sh = fs.readFileSync(path.join(REPO, 'bootstrap.sh'), 'utf8');
  const cmd = fs.readFileSync(path.join(REPO, 'bootstrap.cmd'), 'utf8');
  assert.match(sh, /^#!\/usr\/bin\/env (ba)?sh/);
  assert.match(sh, /scripts\/setup\.mjs/);
  assert.match(cmd, /scripts\\setup\.mjs/);
  const mode = spawnSync('git', ['-C', REPO, 'ls-files', '-s', 'bootstrap.sh'], { encoding: 'utf8' }).stdout.split(' ')[0];
  assert.equal(mode, '100755', 'bootstrap.sh must be executable');
  assert.ok(!/curl[^\n|]*\|\s*(ba)?sh/i.test(sh + cmd), 'no pipe-to-shell');
});

// ---- double-click start: start.cmd / start.command and desktop shortcut ----
test('launch: launch files exist, correct line endings and target scripts', async () => {
  const { REPO } = await import('./helpers.mjs');
  const cmd = fs.readFileSync(path.join(REPO, 'start.cmd'), 'utf8');
  assert.ok(cmd.includes('\r\n') && !/[^\r]\n/.test(cmd), 'start.cmd uses CRLF');
  assert.match(cmd, /node ui\\server\.mjs/);
  assert.match(cmd, /bootstrap\.cmd/);
  const sh = fs.readFileSync(path.join(REPO, 'start.command'), 'utf8');
  assert.ok(sh.startsWith('#!/bin/zsh -l\n'), 'zsh login mode');
  assert.ok(!sh.includes('\r'));
  assert.match(sh, /exec node ui\/server\.mjs/);
  assert.match(sh, /bootstrap\.sh/);
  if (process.platform !== 'win32') assert.ok(fs.statSync(path.join(REPO, 'start.command')).mode & 0o100, 'start.command is executable');
  const attrs = fs.readFileSync(path.join(REPO, '.gitattributes'), 'utf8');
  assert.match(attrs, /\*\.cmd text eol=crlf/);
  const ico = fs.readFileSync(path.join(REPO, 'ui', 'public', 'brand', 'ai-hub.ico'));
  assert.deepEqual([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)], [0, 1, 4]);
});

test('desktop shortcut: Mac writes executable .command, Windows uses PowerShell and falls back to .cmd', async () => {
  const { createShortcut, cmdPath, shellQuote, windowsLauncher, macLauncher, WINDOWS_SHORTCUT_SCRIPT } = await import('../scripts/lib/shortcut.mjs');
  assert.equal(shellQuote("a b'c"), `'a b'\\''c'`);
  assert.equal(cmdPath('C:\\Users\\Me\\100%\\ai-hub\\start.cmd'), '"C:\\Users\\Me\\100%%\\ai-hub\\start.cmd"');
  assert.throws(() => cmdPath('C:\\a"b'));
  assert.throws(() => macLauncher('/a\nb'));

  // Mac
  const desk = mktmp();
  const root = "/Users/Me/Projects/test-hub";
  let r = createShortcut({ platform: 'darwin', dir: desk, root, fs });
  assert.equal(r.ok, true);
  const file = path.join(desk, 'ai-hub.command');
  assert.equal(r.file, file);
  const body = fs.readFileSync(file, 'utf8');
  assert.match(body, /^#!\/bin\/zsh -l\n/);
  assert.ok(body.includes(`exec '/Users/Me/Projects/test-hub/start.command'`), body);
  if (process.platform !== 'win32') assert.ok(fs.statSync(file).mode & 0o100);
  assert.equal(createShortcut({ platform: 'darwin', dir: desk, root, fs }).ok, true);
  assert.match(createShortcut({ platform: 'darwin', dir: desk, root, fs, dry: true }).message, /^\[dry-run\]/i);
  fs.writeFileSync(file, '#!/bin/sh\necho my file\n');
  r = createShortcut({ platform: 'darwin', dir: desk, root, fs });
  assert.equal(r.ok, false);
  assert.equal(fs.readFileSync(file, 'utf8'), '#!/bin/sh\necho my file\n');

  // Windows with successful mock PowerShell
  const winDesk = mktmp();
  const calls = [];
  const okPs = (script, env) => {
    calls.push({ script, env });
    fs.writeFileSync(env.AIHUB_LNK, 'LNK');
    return { status: 0 };
  };
  const winRoot = 'C:\\Users\\Me\\Projects\\ai-hub';
  r = createShortcut({ platform: 'win32', dir: winDesk, root: winRoot, fs, powershell: okPs });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'lnk');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].script, WINDOWS_SHORTCUT_SCRIPT);
  assert.ok(!calls[0].script.includes(winRoot));
  assert.ok(calls[0].env.AIHUB_TARGET.endsWith('start.cmd'));
  assert.ok(calls[0].env.AIHUB_ICON.endsWith('ai-hub.ico,0'));
  assert.equal(calls[0].env.AIHUB_DIR, winRoot);

  // PowerShell fails: fallback to .cmd with CRLF
  const winDesk2 = mktmp();
  r = createShortcut({ platform: 'win32', dir: winDesk2, root: winRoot, fs, powershell: () => ({ status: 1 }) });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'cmd');
  const cmdBody = fs.readFileSync(path.join(winDesk2, 'ai-hub.cmd'), 'utf8');
  assert.equal(cmdBody, windowsLauncher(winRoot));
  assert.ok(cmdBody.includes('\r\n') && !/[^\r]\n/.test(cmdBody));
  assert.match(cmdBody, /call "C:\\Users\\Me\\Projects\\ai-hub\\start\.cmd"/);

  assert.equal(createShortcut({ platform: 'linux', dir: desk, root, fs }).kind, 'none');
});

test('setup: language and AI tools from CLI flags, saved in Settings; unknown rejected', () => {
  const root = makeHub();
  let r = run('setup.mjs', ['--lang', 'en', '--tools', 'codex,opencode', '--no-install', '--no-hooks', '--no-sync'], { root, env: { AI_HUB_LANG: '' } });
  assert.equal(r.code, 0, r.err + r.out);
  const s = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'));
  assert.equal(s.interface.language, 'en');
  assert.deepEqual(s.providers, { claude: false, codex: true, antigravity: false, opencode: true });
  assert.match(r.out, /Which AI tools do you use/);
  assert.match(r.out, /skills → .*\.agents.skills/);
  r = run('setup.mjs', ['--lang', 'fr', '--no-install', '--no-hooks', '--no-sync'], { root });
  assert.equal(r.code, 2);
  r = run('setup.mjs', ['--tools', 'cursor', '--no-install', '--no-hooks', '--no-sync'], { root });
  assert.equal(r.code, 2);
  assert.match(r.err, /cursor/);
});
