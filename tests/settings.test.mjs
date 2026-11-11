// Settings, NVIDIA SkillSpector analysis before install/update, missing programs (needs.mjs).
// SkillSpector is mocked via AI_HUB_SKILLSPECTOR_SCRIPT for deterministic results.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, cleanupAfter, makeGitFixture, makeHub, mktmp, run, write } from './helpers.mjs';
import { SCHEMA, checkPatch, readSettings, settingsProblems, writeSettings } from '../scripts/lib/settings.mjs';
import { describeScan, resolveScanner, scanTarget, verdict } from '../scripts/lib/spector.mjs';
import { commandPath } from '../scripts/lib/util.mjs';
import { installPlan, validateDependencies } from '../scripts/lib/deps.mjs';
import { startServer } from '../ui/server.mjs';

cleanupAfter();

// Mock scanner matching "skillspector scan <path> --format json [--no-llm]" (exit 0/1/2 + JSON).
const FAKE = `import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (process.env.FAKE_SPECTOR_LOG) fs.appendFileSync(process.env.FAKE_SPECTOR_LOG, JSON.stringify(args) + '\\n');
if (args[0] === '--version') { console.log('SkillSpector v9.9.9'); process.exit(0); }
const target = args[1];
const read = (p) => fs.statSync(p).isDirectory() ? fs.readdirSync(p).map((f) => read(path.join(p, f))).join('\\n') : fs.readFileSync(p, 'utf8');
const text = read(target);
if (text.includes('ROTTO')) { console.error('Error: analysis impossible'); process.exit(2); }
const bad = text.includes('MALEVOLO');
const caution = text.includes('ATTENZIONE');
const rec = bad ? 'DO_NOT_INSTALL' : caution ? 'CAUTION' : 'SAFE';
const issues = bad ? [{ id: 'E2', severity: 'HIGH', pattern: 'Env Variable Harvesting', finding: 'os.environ', location: { file: 'SKILL.md', start_line: 3 } }, { id: 'P5', severity: 'CRITICAL', pattern: 'Harmful Content', location: { file: 'SKILL.md', start_line: 4 } }] : [];
console.log(JSON.stringify({ skill: { name: path.basename(target) }, risk_assessment: { score: bad ? 90 : caution ? 30 : 0, severity: bad ? 'CRITICAL' : caution ? 'MEDIUM' : 'LOW', recommendation: rec }, issues, metadata: { llm_available: !args.includes('--no-llm') }, analysis_completeness: { is_complete: true } }));
process.exit(bad ? 1 : 0);
`;

function fakeScanner() {
  const dir = mktmp();
  const script = path.join(dir, 'fake-skillspector.mjs');
  fs.writeFileSync(script, FAKE);
  const log = path.join(dir, 'calls.log');
  return { script, log, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []) };
}

const skill = (name, body = '') => `---\nname: ${name}\ndescription: Test skill ${name}.\n---\n# ${name}\n${body}\n`;
const setMode = (root, mode, llm = false) => write(root, 'settings.json', JSON.stringify({ version: 1, security: { skillspector: mode, skillspectorLlm: llm } }));
const lockOf = (root) => JSON.parse(fs.readFileSync(path.join(root, 'manifest.lock.json'), 'utf8'));

// ------------------------------------------------------------------ settings
test('settings: defaults, invalid values ignored, updates known keys only, rest of file preserved', () => {
  const root = mktmp();
  const d = readSettings(root);
  assert.equal(d['dependencies.claudeMayInstall'], false);
  assert.equal(d['security.skillspector'], 'block');
  assert.equal(d['interface.graphMode'], '3d');
  for (const [k, spec] of Object.entries(SCHEMA)) assert.equal(d[k], spec.default, k);

  write(root, 'settings.json', JSON.stringify({ version: 1, _note: 'mine', security: { skillspector: 'unknown' }, extra: { x: 1 } }));
  assert.equal(readSettings(root)['security.skillspector'], 'block', 'disallowed value falls back to default');
  const probs = settingsProblems(root);
  assert.ok(probs.some((p) => p.includes('security.skillspector')));
  assert.ok(probs.some((p) => p.includes('extra.x')));

  assert.throws(() => checkPatch({ 'security.nonExistent': true }), /unknown/i);
  assert.throws(() => checkPatch({ 'security.skillspector': 'always' }), /disallowed|invalid/i);
  assert.throws(() => checkPatch({ 'dependencies.claudeMayInstall': 'true' }), /disallowed|invalid/i);
  assert.throws(() => checkPatch({ __proto__: { x: 1 } }), /no settings|unknown/i);
  assert.throws(() => checkPatch([]), /invalid/i);
  assert.throws(() => checkPatch({ constructor: 1 }), /unknown/i);

  const v = writeSettings(root, { 'dependencies.claudeMayInstall': true, 'security.skillspector': 'warn' });
  assert.equal(v['dependencies.claudeMayInstall'], true);
  const file = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'));
  assert.equal(file._note, 'mine');
  assert.deepEqual(file.extra, { x: 1 });
  assert.equal(file.security.skillspector, 'warn');
  assert.equal(file.dependencies.claudeMayInstall, true);
});

test('settings: legacy option "providers.gemini" maps to Antigravity CLI without reporting as error', () => {
  const root = makeHub();
  write(root, 'settings.json', JSON.stringify({ providers: { gemini: true } }));
  assert.equal(readSettings(root)['providers.antigravity'], true, 'anyone who had Gemini CLI active finds Antigravity CLI active');
  assert.deepEqual(settingsProblems(root), []);
  write(root, 'settings.json', JSON.stringify({ providers: { gemini: true, antigravity: false } }));
  assert.equal(readSettings(root)['providers.antigravity'], false, 'new option takes precedence over legacy');
  assert.ok(!('providers.gemini' in SCHEMA), 'legacy key is no longer written');
});

test('repo settings.json is valid and analysis is active in block mode', () => {
  assert.deepEqual(settingsProblems(REPO), []);
  assert.equal(readSettings(REPO)['security.skillspector'], 'block');
});

// ------------------------------------------------------------------ SkillSpector
test('skillspector: policy verdict, mock scanner, errors treated as unsafe', () => {
  assert.equal(verdict({ ok: true, recommendation: 'SAFE' }, 'block'), 'pass');
  assert.equal(verdict({ ok: true, recommendation: 'CAUTION' }, 'block'), 'warn');
  assert.equal(verdict({ ok: true, recommendation: 'DO_NOT_INSTALL' }, 'block'), 'block');
  assert.equal(verdict({ ok: true, recommendation: 'DO_NOT_INSTALL' }, 'warn'), 'warn');
  assert.equal(verdict({ ok: false, error: 'x' }, 'block'), 'block', 'fail-closed');
  assert.equal(verdict({ ok: false, error: 'x' }, 'warn'), 'warn');
  assert.equal(verdict({ ok: true, recommendation: 'DO_NOT_INSTALL' }, 'off'), 'pass');

  const f = fakeScanner();
  assert.equal(resolveScanner({ AI_HUB_SKILLSPECTOR_SCRIPT: path.join(f.script, 'missing.mjs') }), null);
  const scanner = resolveScanner({ AI_HUB_SKILLSPECTOR_SCRIPT: f.script });
  const dir = mktmp();
  write(dir, 'ok/SKILL.md', skill('ok'));
  write(dir, 'bad/SKILL.md', skill('bad', 'MALEVOLO'));
  write(dir, 'broken/SKILL.md', skill('broken', 'ROTTO'));
  const ok = scanTarget(scanner, path.join(dir, 'ok'));
  assert.equal(ok.ok, true);
  assert.equal(ok.recommendation, 'SAFE');
  const bad = scanTarget(scanner, path.join(dir, 'bad'));
  assert.equal(bad.recommendation, 'DO_NOT_INSTALL');
  assert.equal(bad.issueCount, 2);
  assert.equal(bad.issues[0].severity, 'CRITICAL', 'most severe issues first');
  assert.match(describeScan(bad), /DO NOT INSTALL/i);
  const broken = scanTarget(scanner, path.join(dir, 'broken'));
  assert.equal(broken.ok, false);
  assert.match(broken.error, /exit code 2|code 2/i);
  assert.equal(scanTarget(scanner, path.join(dir, 'nonexistent')).ok, false);
  assert.equal(scanTarget(null, dir).ok, false);
});

test('tools installed with uv but not yet in PATH: hub still resolves them', { skip: process.platform === 'win32' }, () => {
  const bin = mktmp();
  const exe = path.join(bin, 'skillspector');
  fs.writeFileSync(exe, '#!/bin/sh\necho "SkillSpector v1.2.3"\n');
  fs.chmodSync(exe, 0o755);
  const env = { PATH: mktmp(), UV_TOOL_BIN_DIR: bin, HOME: mktmp() };
  assert.equal(commandPath('skillspector', env), exe);
  assert.equal(commandPath('skillspector', { PATH: mktmp(), HOME: mktmp() }), null);
  assert.equal(commandPath('../skillspector', env), null, 'simple names only');
  assert.deepEqual(resolveScanner(env), { cmd: exe, pre: [] });
});

test('installer + skillspector block: installs safe items, stops remainder without writing, fail-closed', () => {
  const root = makeHub();
  setMode(root, 'block');
  const f = fakeScanner();
  const env = { AI_HUB_SKILLSPECTOR_SCRIPT: f.script, FAKE_SPECTOR_LOG: f.log };
  const src = makeGitFixture({
    'skills/good/SKILL.md': skill('good'),
    'skills/bad/SKILL.md': skill('bad', 'MALEVOLO'),
    'skills/broken/SKILL.md': skill('broken', 'ROTTO'),
    'skills/dubious/SKILL.md': skill('dubious', 'ATTENZIONE'),
  });

  // preview reports security configuration; --scan analyzes only specified items
  let r = run('install.mjs', [src.dir, '--dry-run', '--json'], { root, env });
  assert.equal(r.code, 0, r.err);
  const prev = JSON.parse(r.out);
  assert.deepEqual(prev.security, { mode: 'block', available: true, llm: false });
  assert.equal(f.calls().length, 0, 'simple preview does not scan');
  r = run('install.mjs', [src.dir, '--dry-run', '--json', '--scan', '--only=good,bad'], { root, env });
  assert.equal(r.code, 0, r.err);
  const scanned = JSON.parse(r.out);
  assert.equal(scanned.security.version, '9.9.9');
  assert.equal(scanned.items.find((i) => i.name === 'good').spector.verdict, 'pass');
  assert.equal(scanned.items.find((i) => i.name === 'bad').spector.verdict, 'block');
  assert.equal(scanned.items.find((i) => i.name === 'broken').spector, undefined);
  assert.ok(f.calls().filter((a) => a[0] === 'scan').every((a) => a.includes('--no-llm') && path.isAbsolute(a[1])));

  // safe: installed, verdict recorded in lock
  r = run('install.mjs', [src.dir, '--only', 'good'], { root, env });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /SkillSpector 9\.9\.9/);
  const entry = lockOf(root).entries.find((e) => e.name === 'good');
  assert.equal(entry.security.recommendation, 'SAFE');
  assert.equal(entry.security.scanner, 'skillspector');

  // DO_NOT_INSTALL: blocked, and accompanied item is also skipped
  r = run('install.mjs', [src.dir, '--only', 'bad,dubious'], { root, env });
  assert.equal(r.code, 1);
  assert.match(r.err, /blocked by SkillSpector for: skill:bad/i);
  assert.ok(!fs.existsSync(path.join(root, 'skills/external/bad')));
  assert.ok(!fs.existsSync(path.join(root, 'skills/external/dubious')));

  // CAUTION: installed with warning
  r = run('install.mjs', [src.dir, '--only', 'dubious'], { root, env });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /⚠ skill:dubious: caution/i);

  // failed analysis: block mode refuses install
  r = run('install.mjs', [src.dir, '--only', 'broken'], { root, env });
  assert.equal(r.code, 1);
  assert.match(r.out, /analysis failed/i);
  assert.ok(!fs.existsSync(path.join(root, 'skills/external/broken')));

  // SkillSpector missing: block mode refuses and explains resolution
  r = run('install.mjs', [src.dir, '--only', 'broken'], { root, env: { AI_HUB_SKILLSPECTOR_SCRIPT: path.join(root, 'missing.mjs') } });
  assert.equal(r.code, 1);
  assert.match(r.err, /SkillSpector is not installed.*npm run setup/i);
});

test('installer + skillspector warn and off; update stopped if new version is dangerous', () => {
  const root = makeHub();
  const f = fakeScanner();
  const env = { AI_HUB_SKILLSPECTOR_SCRIPT: f.script, FAKE_SPECTOR_LOG: f.log };
  const src = makeGitFixture({ 'skills/alpha/SKILL.md': skill('alpha'), 'skills/beta/SKILL.md': skill('beta', 'MALEVOLO') });

  setMode(root, 'warn', true);
  let r = run('install.mjs', [src.dir, '--only', 'beta'], { root, env });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /⚠ skill:beta: DO NOT INSTALL/i);
  assert.ok(fs.existsSync(path.join(root, 'skills/external/beta/SKILL.md')));
  assert.ok(!f.calls().find((a) => a[0] === 'scan').includes('--no-llm'), 'with LLM analysis active --no-llm is omitted');

  setMode(root, 'off');
  const before = f.calls().length;
  r = run('install.mjs', [src.dir, '--only', 'alpha'], { root, env });
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(f.calls().length, before, 'off: no scan');

  // warn without SkillSpector: installs with notice
  setMode(root, 'warn');
  r = run('install.mjs', [src.dir, '--only', 'alpha', '--force'], { root, env: { AI_HUB_SKILLSPECTOR_SCRIPT: path.join(root, 'missing.mjs') } });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /SkillSpector is not installed/i);

  // update: new version of alpha becomes malicious → old version kept
  setMode(root, 'block');
  write(src.dir, 'skills/alpha/SKILL.md', skill('alpha', 'MALEVOLO'));
  src.git('commit', '-qam', 'change');
  r = run('install.mjs', ['--update', 'alpha'], { root, env });
  assert.equal(r.code, 1);
  assert.match(r.out, /update blocked by SkillSpector/i);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'skills/external/alpha/SKILL.md'), 'utf8'), /MALEVOLO/);

  // safe new version → updated
  write(src.dir, 'skills/alpha/SKILL.md', skill('alpha', 'version 3'));
  src.git('commit', '-qam', 'change 2');
  r = run('install.mjs', ['--update', 'alpha'], { root, env });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(fs.readFileSync(path.join(root, 'skills/external/alpha/SKILL.md'), 'utf8'), /version 3/);
  assert.equal(lockOf(root).entries.find((e) => e.name === 'alpha').security.recommendation, 'SAFE');
});

// ------------------------------------------------------------------ missing programs
test('needs: lists missing tools; --install without permission exits with 3 and executes nothing', () => {
  const root = makeHub();
  write(root, 'skills/own/serve-xyz/SKILL.md', '---\nname: serve-xyz\ndescription: Test.\nrequires-commands: comando-che-non-esiste-xyz\n---\n');
  let r = run('needs.mjs', ['--json'], { root });
  assert.equal(r.code, 1);
  let rep = JSON.parse(r.out);
  assert.equal(rep.allowed, false);
  const m = rep.missing.find((x) => x.command === 'comando-che-non-esiste-xyz');
  assert.ok(m.requiredBy.includes('skill:serve-xyz'));
  assert.equal(m.known, false);
  assert.equal(m.installCommand, null);

  r = run('needs.mjs', ['serve-xyz', 'none', '--install', '--json'], { root });
  assert.equal(r.code, 3);
  rep = JSON.parse(r.out);
  assert.equal(rep.refused, true);
  assert.deepEqual(rep.unknownItems, ['none']);
  assert.deepEqual(rep.installed, []);

  // permission active: items not in dependencies.json are still not installed
  write(root, 'settings.json', JSON.stringify({ version: 1, dependencies: { claudeMayInstall: true } }));
  r = run('needs.mjs', ['serve-xyz', '--install', '--json'], { root });
  assert.equal(r.code, 1);
  rep = JSON.parse(r.out);
  assert.equal(rep.allowed, true);
  assert.equal(rep.refused, undefined);
  assert.deepEqual(rep.installed, []);

  // targeted skill: seo-audit has no missing commands
  r = run('needs.mjs', ['seo-audit'], { root });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /No missing programs/i);
});

test('dependencies: uv installs only packages or GitHub repositories, via constructed command', () => {
  const deps = (manager, pkg) => ({ tools: [{ id: 'x', level: 'optional', check: { command: 'x' }, install: { darwin: { manager, package: pkg } } }], commandProviders: {} });
  assert.deepEqual(validateDependencies(deps('uv', 'git+https://github.com/NVIDIA/skillspector.git')), []);
  assert.deepEqual(validateDependencies(deps('uv', 'ruff')), []);
  assert.equal(validateDependencies(deps('uv', 'git+https://evil.example.com/a/b.git')).length, 1);
  assert.equal(validateDependencies(deps('uv', 'git+https://github.com/a/b.git; rm -rf /')).length, 1);
  assert.equal(validateDependencies(deps('npm', 'git+https://github.com/a/b.git')).length, 1, 'only uv accepts a repository');
  const plan = installPlan({ darwin: { manager: 'uv', package: 'git+https://github.com/NVIDIA/skillspector.git' } }, null, { platform: 'darwin', managers: { uv: true } });
  assert.deepEqual(plan.args, ['tool', 'install', 'git+https://github.com/NVIDIA/skillspector.git']);
  assert.equal(installPlan({ darwin: { manager: 'uv', package: 'ruff' } }, null, { platform: 'darwin', managers: { uv: true } }).args.join(' '), 'tool install ruff');
  assert.equal(installPlan({ darwin: { manager: 'uv', package: 'ruff' } }, null, { platform: 'darwin', managers: { uv: false } }).auto, false);
  // fixed Python version
  const py = installPlan({ darwin: { manager: 'uv', package: 'ruff', python: '3.12' } }, null, { platform: 'darwin', managers: { uv: true } });
  assert.deepEqual(py.args, ['tool', 'install', '--python', '3.12', 'ruff']);
  const withPy = (manager, python) => ({ tools: [{ id: 'x', level: 'optional', check: { command: 'x' }, install: { darwin: { manager, package: 'ruff', python } } }], commandProviders: {} });
  assert.deepEqual(validateDependencies(withPy('uv', '3.12')), []);
  assert.equal(validateDependencies(withPy('uv', '3.12; rm -rf /')).length, 1);
  assert.equal(validateDependencies(withPy('brew', '3.12')).length, 1, 'only uv accepts python');
});

// ------------------------------------------------------------------ server
const origin = (app) => `http://127.0.0.1:${app.port}`;
const post = async (app, p, body, headers = {}) => {
  const r = await fetch(origin(app) + p, { method: 'POST', headers: { 'X-Hub-Token': app.token, Origin: origin(app), 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const get = async (app, p) => {
  const r = await fetch(origin(app) + p, { headers: { 'X-Hub-Token': app.token } });
  return { status: r.status, body: await r.json().catch(() => null) };
};

test('server: settings (read, validated patch, Origin and token), large preview, selective scan', async () => {
  const root = makeHub();
  const f = fakeScanner();
  process.env.AI_HUB_SKILLSPECTOR_SCRIPT = f.script;
  const app = await startServer({ root, port: 0, quiet: true, allowLocal: true });
  try {
    let r = await get(app, '/api/settings');
    assert.equal(r.status, 200);
    assert.equal(r.body.values['security.skillspector'], 'off');
    assert.ok(r.body.schema['dependencies.claudeMayInstall'].label);
    assert.ok(r.body.sections.length >= 3);
    assert.deepEqual(r.body.skillspector, { installed: true, version: '9.9.9' });
    assert.equal((await get(app, '/api/state')).body.settings['interface.graphMode'], '3d');

    r = await post(app, '/api/settings', { values: { 'dependencies.claudeMayInstall': true, 'security.skillspector': 'block', 'interface.graphMode': '2d' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.values['dependencies.claudeMayInstall'], true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8')).interface.graphMode, '2d');
    for (const bad of [{ values: { 'security.skillspector': 'maybe' } }, { values: { 'other.x': true } }, { values: {} }, { values: 'x' }, {}]) {
      r = await post(app, '/api/settings', bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    assert.equal((await post(app, '/api/settings', { values: { 'security.skillspector': 'off' } }, { Origin: 'http://evil.example' })).status, 403);
    const noToken = await fetch(origin(app) + '/api/settings');
    assert.equal(noToken.status, 401);
    assert.equal(readSettings(root)['security.skillspector'], 'block', 'rejected requests changed nothing');

    // repo with hundreds of skills: preview is not truncated
    const files = {};
    const long = 'Very long description of a skill. '.repeat(30);
    for (let i = 0; i < 400; i++) files[`skills/s${i}/SKILL.md`] = `---\nname: s${i}\ndescription: ${long}\n---\n# s${i}\n`;
    files['skills/bad/SKILL.md'] = skill('bad', 'MALEVOLO');
    const big = makeGitFixture(files);
    r = await post(app, '/api/install/preview', { source: big.dir });
    assert.equal(r.status, 200, JSON.stringify(r.body)?.slice(0, 300));
    assert.equal(r.body.items.length, 401);
    assert.equal(r.body.security.mode, 'block');

    // scan of selected items only, on preview commit
    r = await post(app, '/api/install/scan', { source: big.dir, only: ['s1', 'bad'], expectCommit: r.body.source.commit });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const byName = Object.fromEntries(r.body.items.filter((i) => i.spector).map((i) => [i.name, i.spector]));
    assert.deepEqual(Object.keys(byName).sort(), ['bad', 's1']);
    assert.equal(byName.bad.verdict, 'block');
    assert.equal(byName.s1.recommendation, 'SAFE');
    assert.equal((await post(app, '/api/install/scan', { source: big.dir, only: [] })).status, 400);
    assert.equal((await post(app, '/api/install/scan', { source: big.dir, only: Array.from({ length: 21 }, (_, i) => `s${i}`) })).status, 400);
    assert.equal((await post(app, '/api/install/scan', { source: big.dir, only: ['../x'] })).status, 400);

    // UI install respects block
    r = await post(app, '/api/install', { source: big.dir, only: ['bad'] });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, false);
    assert.match(r.body.output, /blocked by SkillSpector/i);
    assert.ok(!fs.existsSync(path.join(root, 'skills/external/bad')));
  } finally {
    delete process.env.AI_HUB_SKILLSPECTOR_SCRIPT;
    await app.close();
  }
});
