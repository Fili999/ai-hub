// Security regression: a SkillSpector result that is incomplete, malformed or unverifiable must never count as safe.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cleanupAfter, makeGitFixture, makeHub, mktmp, run, write } from './helpers.mjs';
import { describeScan, resolveScanner, scanTarget, verdict } from '../scripts/lib/spector.mjs';

cleanupAfter();

// Scanner that prints whatever the test asks for (raw stdout) and exits with the requested code.
const FAKE = `
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('SkillSpector v9.9.9'); process.exit(0); }
if (process.env.FAKE_SPECTOR_STDERR) console.error(process.env.FAKE_SPECTOR_STDERR);
process.stdout.write(process.env.FAKE_SPECTOR_STDOUT ?? '');
process.exit(Number(process.env.FAKE_SPECTOR_EXIT ?? 0));
`;
const script = path.join(mktmp(), 'fake.mjs');
fs.writeFileSync(script, FAKE);
const scanner = resolveScanner({ AI_HUB_SKILLSPECTOR_SCRIPT: script });
const target = mktmp();
write(target, 'SKILL.md', '---\nname: t\ndescription: t\n---\n# t\n');

const good = (over = {}) => ({
  risk_assessment: { score: 0, severity: 'LOW', recommendation: 'SAFE' },
  issues: [],
  analysis_completeness: { is_complete: true },
  execution_successful: true,
  metadata: {},
  ...over,
});
/** Runs scanTarget with a canned scanner response. */
const scan = (out, exit = 0, stderr = '') =>
  scanTarget(scanner, target, { env: { ...process.env, FAKE_SPECTOR_STDOUT: typeof out === 'string' ? out : JSON.stringify(out), FAKE_SPECTOR_EXIT: String(exit), FAKE_SPECTOR_STDERR: stderr } });

test('1. SAFE + complete → pass in every mode', () => {
  const s = scan(good());
  assert.equal(s.ok, true);
  assert.equal(s.complete, true);
  for (const mode of ['block', 'warn', 'off']) assert.equal(verdict(s, mode), 'pass', mode);
});

test('2. SAFE + incomplete → block in block mode, warn in warn mode, never "safe-looking"', () => {
  const s = scan(good({ analysis_completeness: { is_complete: false } }));
  assert.equal(s.ok, true);
  assert.equal(s.recommendation, 'SAFE');
  assert.equal(s.complete, false);
  assert.equal(verdict(s, 'block'), 'block');
  assert.equal(verdict(s, 'warn'), 'warn');
  assert.equal(verdict(s, 'off'), 'pass', 'off keeps the configured behaviour (no scan at all)');
  assert.match(describeScan(s), /INCOMPLETE/i, 'the warning is explicit');
  assert.doesNotMatch(describeScan(s), /^safe/i);
});

test('2b. completeness missing, null, malformed or execution failed → treated as incomplete', () => {
  const variants = [
    { analysis_completeness: undefined },
    { analysis_completeness: null },
    { analysis_completeness: {} },
    { analysis_completeness: { is_complete: 'true' } },
    { analysis_completeness: { is_complete: 1 } },
    { execution_successful: false },
    { analysis_completeness: { is_complete: true, execution_successful: false } },
  ];
  for (const v of variants) {
    const s = scan(good(v));
    assert.equal(s.complete, false, JSON.stringify(v));
    assert.equal(verdict(s, 'block'), 'block', JSON.stringify(v));
  }
});

test('3. DO_NOT_INSTALL → block (block mode), warn (warn mode)', () => {
  const s = scan(good({ risk_assessment: { score: 90, severity: 'CRITICAL', recommendation: 'DO_NOT_INSTALL' } }), 1);
  assert.equal(s.ok, true);
  assert.equal(verdict(s, 'block'), 'block');
  assert.equal(verdict(s, 'warn'), 'warn');
});

test('4. CAUTION never passes (even when complete)', () => {
  const s = scan(good({ risk_assessment: { score: 30, severity: 'MEDIUM', recommendation: 'CAUTION' } }));
  assert.equal(s.ok, true);
  assert.notEqual(verdict(s, 'block'), 'pass');
  assert.notEqual(verdict(s, 'warn'), 'pass');
});

test('5. truncated / malformed / empty / wrong-shaped JSON and scanner crashes never pass in block mode', () => {
  const full = JSON.stringify(good());
  const broken = [
    full.slice(0, full.length - 15), // truncated
    '',
    'null',
    '[]',
    '"SAFE"',
    '42',
    '{"risk_assessment": null}',
    '{"risk_assessment": {"recommendation": 7}}',
    'Traceback (most recent call last): ...',
    `${full}\ngarbage after the document`,
  ];
  for (const raw of broken) {
    const s = scan(raw);
    assert.equal(s.ok, false, raw.slice(0, 40));
    assert.equal(verdict(s, 'block'), 'block', raw.slice(0, 40));
    assert.equal(verdict(s, 'warn'), 'warn', raw.slice(0, 40));
  }
  // scanner error exit codes, including 0-looking output with exit 2
  for (const code of [2, 3, 127, 255]) {
    const s = scan(good(), code, 'boom');
    assert.equal(s.ok, false, `exit ${code}`);
    assert.equal(verdict(s, 'block'), 'block');
  }
  assert.equal(scanTarget(null, target).ok, false);
  assert.equal(verdict(scanTarget(scanner, path.join(target, 'missing')), 'block'), 'block');
  assert.equal(verdict(undefined, 'block'), 'block');
  assert.equal(verdict({}, 'block'), 'block');
});

test('6. a hand-built result without a `complete: true` flag can never pass', () => {
  for (const mode of ['block', 'warn']) {
    assert.notEqual(verdict({ ok: true, recommendation: 'SAFE' }, mode), 'pass', mode);
    assert.notEqual(verdict({ ok: true, recommendation: 'SAFE', complete: 'yes' }, mode), 'pass', mode);
  }
});

test('7. score missing, NaN, null, string, negative or above 100 → unreliable result, not "0 = no risk"', () => {
  const scores = [undefined, null, 'NaN', '', '0', 'high', -1, 101, 1e9, {}, [], true];
  for (const score of scores) {
    const ra = { severity: 'LOW', recommendation: 'SAFE' };
    if (score !== undefined) ra.score = score;
    const s = scan(good({ risk_assessment: ra }));
    assert.equal(s.ok, false, `score ${JSON.stringify(score)}`);
    assert.match(s.error, /score/i);
    assert.equal(verdict(s, 'block'), 'block', `score ${JSON.stringify(score)}`);
  }
  // NaN cannot be written in JSON, but a non-finite number from a broken scanner arrives as null or a string
  assert.equal(scan('{"risk_assessment":{"score":NaN,"recommendation":"SAFE"}}').ok, false);
  assert.equal(scan(good({ risk_assessment: { score: 50.5, severity: 'MEDIUM', recommendation: 'CAUTION' } })).score, 50.5, 'valid fractions are kept');
});

test('8. unknown recommendation or contradictory exit code → unreliable', () => {
  assert.equal(scan(good({ risk_assessment: { score: 0, recommendation: 'PROBABLY_FINE' } })).ok, false);
  assert.equal(scan(good({ risk_assessment: { score: 0, recommendation: 'safe' } })).ok, false, 'case matters');
  // exit code 1 means "risk > 50": a SAFE document with it is contradictory
  const s = scan(good(), 1);
  assert.equal(s.ok, false);
  assert.match(s.error, /contradict/i);
  assert.equal(verdict(s, 'block'), 'block');
});

// ---------------------------------------------------------------- end to end through the installer
const skill = `---\nname: probe\ndescription: Probe skill.\n---\n# probe\n`;
const lockEntries = (root) => JSON.parse(fs.readFileSync(path.join(root, 'manifest.lock.json'), 'utf8')).entries;
const setMode = (root, mode) => write(root, 'settings.json', JSON.stringify({ version: 1, security: { skillspector: mode } }));

test('installer: SAFE but INCOMPLETE scan blocks the install in block mode and writes nothing', () => {
  const root = makeHub();
  setMode(root, 'block');
  const src = makeGitFixture({ 'skills/probe/SKILL.md': skill });
  const env = { AI_HUB_SKILLSPECTOR_SCRIPT: script, FAKE_SPECTOR_STDOUT: JSON.stringify(good({ analysis_completeness: { is_complete: false } })), FAKE_SPECTOR_EXIT: '0' };
  const r = run('install.mjs', [src.dir, '--all', '--to', 'global'], { root, env });
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.out + r.err, /INCOMPLETE|blocked|not installed/i);
  assert.equal(fs.existsSync(path.join(root, 'skills', 'external', 'probe')), false, 'nothing was written');
  assert.deepEqual(lockEntries(root), []);
});

test('installer: SAFE + complete installs; in warn mode an incomplete scan installs but is flagged, never reported as safe', () => {
  const src = makeGitFixture({ 'skills/probe/SKILL.md': skill });
  const okRoot = makeHub();
  setMode(okRoot, 'block');
  const ok = run('install.mjs', [src.dir, '--all', '--to', 'global'], { root: okRoot, env: { AI_HUB_SKILLSPECTOR_SCRIPT: script, FAKE_SPECTOR_STDOUT: JSON.stringify(good()), FAKE_SPECTOR_EXIT: '0' } });
  assert.equal(ok.code, 0, ok.out + ok.err);
  assert.equal(lockEntries(okRoot).length, 1);

  const warnRoot = makeHub();
  setMode(warnRoot, 'warn');
  const w = run('install.mjs', [src.dir, '--all', '--to', 'global'], { root: warnRoot, env: { AI_HUB_SKILLSPECTOR_SCRIPT: script, FAKE_SPECTOR_STDOUT: JSON.stringify(good({ analysis_completeness: { is_complete: false } })), FAKE_SPECTOR_EXIT: '0' } });
  assert.equal(w.code, 0, w.out + w.err);
  assert.match(w.out, /⚠[^\n]*INCOMPLETE/i, 'the warning line is shown, not a ✔ safe line');
  assert.doesNotMatch(w.out, /✔ skill:probe/);
});

test('installer: malformed scanner output blocks in block mode', () => {
  const root = makeHub();
  setMode(root, 'block');
  const src = makeGitFixture({ 'skills/probe/SKILL.md': skill });
  const r = run('install.mjs', [src.dir, '--all', '--to', 'global'], { root, env: { AI_HUB_SKILLSPECTOR_SCRIPT: script, FAKE_SPECTOR_STDOUT: '{"risk_assessment":', FAKE_SPECTOR_EXIT: '0' } });
  assert.equal(r.code, 1, r.out + r.err);
  assert.equal(fs.existsSync(path.join(root, 'skills', 'external', 'probe')), false);
});
