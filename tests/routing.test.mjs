// Routing: mode, workflow, capability → skill, and optional token saving levels.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, cleanupAfter, makeHub, run, write } from './helpers.mjs';
import { scanHub } from '../scripts/lib/scan.mjs';
import { providers, route } from '../scripts/lib/route.mjs';
import { SAVING_LEVELS, savingRules } from '../scripts/lib/budget.mjs';
import { SCHEMA, readSettings } from '../scripts/lib/settings.mjs';

cleanupAfter();

const repoIndex = scanHub(REPO);
const config = JSON.parse(fs.readFileSync(path.join(REPO, 'hub.config.json'), 'utf8'));
const r = (q, size) => route(repoIndex, config, q, { size });

test('routing in repo: code changes route to code-change workflow with core skills', () => {
  for (const [q, size] of [['fix login bug in my app', 'medium'], ['add a feature to the management system', 'large'], ['refactoring the payment module', 'large'], ['fix a bug in the checkout code', undefined]]) {
    const x = r(q, size);
    assert.equal(x.mode, 'workflow', q);
    assert.equal(x.workflow.name, 'code-change', q);
    const chosen = Object.fromEntries(x.capabilities.map((c) => [c.id, c.chosen?.name ?? null]));
    assert.equal(chosen['task-intake'], 'task-intake');
    assert.equal(chosen['acceptance-criteria'], 'acceptance-criteria');
    assert.equal(chosen['quality-gate'], 'quality-gate');
    assert.equal(x.capabilities.find((c) => c.id === 'codebase-navigation').optional, true);
  }
  assert.ok(r('fix a bug in the checkout code').notes.some((n) => /intake/i.test(n)), 'without size, refers to intake');
  // skills already chosen for capabilities are not repeated among related
  const x = r('fix login bug in my app', 'medium');
  const chosen = new Set(x.capabilities.map((c) => c.chosen?.id));
  assert.deepEqual(x.related.filter((s) => chosen.has(s.id)), []);
});

test('routing in repo: small tasks are executed directly, without workflow or agents, but with verification', () => {
  const x = r('fix login bug in my app', 'small');
  assert.equal(x.mode, 'direct');
  assert.equal(x.workflow, null);
  assert.deepEqual(x.capabilities.map((c) => c.id), ['quality-gate'], 'quality before savings: always verified');
  assert.ok(x.notes.some((n) => /code-change/.test(n)), 'mentions workflow exists for larger tasks');
  assert.equal(r('rename a variable', 'small').mode, 'direct');
  assert.throws(() => r('x', 'huge'), /Invalid size/i);
});

test('routing in repo: requests without a workflow follow general method (no workflow chosen at random)', () => {
  for (const q of ['write a post for instagram', 'write a business plan', 'publish a story on facebook', 'editorial plan for instagram']) {
    const x = r(q, 'medium');
    assert.equal(x.mode, 'general', q);
    assert.equal(x.workflow, null, q);
    assert.deepEqual(x.capabilities.map((c) => c.id), ['task-intake', 'acceptance-criteria', 'quality-gate', 'self-critique'], q);
  }
  assert.ok(r('plan an important release', 'large').capabilities.some((c) => c.id === 'structured-handoff'), 'large jobs add handoff and decision record');
});

test('routing in repo: video does not route to code-change', () => {
  assert.notEqual(r('youtube video editing', 'medium').workflow?.name, 'code-change');
  assert.equal(r('fix login bug', 'medium').workflow.name, 'code-change');
});

test('capabilities: own skills preferred, then approved external; never hash-mismatched ones', () => {
  const root = makeHub();
  const sk = (dir, name, cap) => write(root, `${dir}/${name}/SKILL.md`, `---\nname: ${name}\ndescription: Test ${name}.\ncapabilities: [${cap}]\n---\n`);
  sk('skills/external', 'nav-external', 'codebase-navigation');
  sk('skills/external', 'nav-review-pending', 'codebase-navigation');
  sk('skills/own', 'nav-mine', 'codebase-navigation');
  sk('skills/external', 'nav-altered', 'codebase-navigation');
  const entry = (name, approval) => ({ kind: 'skill', name, path: `skills/external/${name}`, source: { repo: 'a/b', commit: 'c'.repeat(40) }, ...(approval ? { approval: { status: approval, hash: 'sha256:x' } } : {}) });
  write(root, 'manifest.lock.json', JSON.stringify({ version: 2, entries: [entry('nav-external', 'approved'), entry('nav-review-pending')] }));
  let idx = scanHub(root);
  assert.deepEqual(providers(idx, 'codebase-navigation').map((p) => p.name), ['nav-mine', 'nav-external', 'nav-review-pending', 'nav-altered']);
  // an element with mismatched content is not proposed
  idx = { ...idx, skills: idx.skills.map((s) => (s.name === 'nav-external' ? { ...s, approval: 'hash-mismatch' } : s)) };
  assert.ok(!providers(idx, 'codebase-navigation').some((p) => p.name === 'nav-external'));
  assert.deepEqual(providers(idx, 'nonexistent-capability'), []);
});

test('workflow: contract verified by inventory (fields, sizes, capabilities without providers)', () => {
  const root = makeHub();
  write(root, 'workflows/test-wf.md', '---\nname: test-wf\ndescription: Test workflow to launch a site.\ncapabilities: [task-intake, missing-capability]\noptional-capabilities: [extra-optional]\nsizes: [medium, huge]\ncapabilites: x\n---\n# Test\n');
  write(root, 'workflows/README.md', '# not a workflow\n');
  write(root, 'skills/own/intake/SKILL.md', '---\nname: intake\ndescription: Intake.\ncapabilities: [task-intake]\n---\n');
  const idx = scanHub(root);
  assert.equal(idx.workflows.length, 1);
  const wf = idx.workflows[0];
  assert.deepEqual([wf.capabilities, wf.optionalCapabilities, wf.sizes], [['task-intake', 'missing-capability'], ['extra-optional'], ['medium']]);
  assert.equal(idx.stats.workflows, 1);
  const msg = (type, level) => idx.warnings.filter((w) => w.type === type && (!level || w.level === level)).map((w) => w.message).join(' | ');
  assert.match(msg('capability-unprovided', 'warn'), /missing-capability/);
  assert.match(msg('capability-unprovided', 'info'), /extra-optional/);
  assert.match(msg('invalid-field'), /huge/);
  assert.match(msg('field-typo'), /capabilities/);
  // workflow is found and missing capability is noted in routing
  const x = route(idx, config, 'launch a site', { size: 'medium' });
  assert.equal(x.mode, 'workflow');
  assert.ok(x.notes.some((n) => /missing-capability/.test(n) && /no skill/i.test(n)));
});

test('token saving: optional, off by default, cumulative levels that preserve quality', () => {
  assert.equal(SCHEMA['tokens.savingLevel'].default, 'off');
  assert.equal(readSettings(REPO)['tokens.savingLevel'], 'off');
  assert.deepEqual(savingRules('off').rules, []);
  assert.deepEqual(savingRules('something').level, 'off');
  const n = SAVING_LEVELS.slice(1).map((l) => savingRules(l).rules.length);
  assert.ok(n[0] < n[1] && n[1] < n[2], 'each level adds rules');
  for (const l of SAVING_LEVELS.slice(1)) assert.match(savingRules(l).rules.at(-1), /quality gate.*mandatory/i, l);
  assert.equal(r('fix login bug', 'medium').budget.level, 'off');
  assert.equal(route(repoIndex, config, 'x', { saving: 'max' }).budget.level, 'max');

  // from CLI: level comes from Settings
  const root = makeHub();
  write(root, 'settings.json', JSON.stringify({ version: 1, security: { skillspector: 'off' }, tokens: { savingLevel: 'medium' } }));
  let out = run('route.mjs', ['fix the bug', '--size', 'medium'], { root });
  assert.equal(out.code, 0, out.err);
  assert.match(out.out, /Token savings?: Medium/i);
  assert.match(out.out, /At most one agent/i);
  write(root, 'settings.json', JSON.stringify({ version: 1, security: { skillspector: 'off' } }));
  out = run('route.mjs', ['fix the bug', '--json'], { root });
  assert.equal(JSON.parse(out.out).budget.level, 'off');
  assert.doesNotMatch(run('route.mjs', ['fix the bug'], { root }).out, /Token saving/i);
  assert.equal(run('route.mjs', [], { root }).code, 2);
});

test('self-critique: at end by default, at every phase or off per Settings; never on small tasks', () => {
  assert.equal(SCHEMA['quality.selfCritique'].default, 'final');
  assert.equal(SCHEMA['quality.improvements'].default, 'propose');
  assert.equal(readSettings(REPO)['quality.selfCritique'], 'final');
  const caps = (x) => x.capabilities.map((c) => c.id);
  let x = r('fix login bug in my app', 'medium');
  assert.deepEqual(x.selfCritique, { mode: 'final', improvements: 'propose' });
  assert.equal(caps(x).at(-1), 'self-critique');
  assert.equal(x.capabilities.at(-1).chosen.name, 'self-critique');
  assert.ok(caps(r('write a post for instagram', 'medium')).includes('self-critique'), 'also in general method');
  x = r('rename a variable', 'small');
  assert.equal(x.selfCritique.mode, 'off');
  assert.ok(!caps(x).includes('self-critique'));
  x = route(repoIndex, config, 'fix the bug', { size: 'large', critique: 'off' });
  assert.ok(!caps(x).includes('self-critique'));
  x = route(repoIndex, config, 'fix the bug', { size: 'large', critique: 'phases', improvements: 'apply-own' });
  assert.deepEqual(x.selfCritique, { mode: 'phases', improvements: 'apply-own' });
  assert.equal(route(repoIndex, config, 'x', { critique: 'unknown', improvements: 'all' }).selfCritique.improvements, 'propose', 'unknown values default safely');

  const root = makeHub();
  write(root, 'settings.json', JSON.stringify({ version: 1, security: { skillspector: 'off' }, quality: { selfCritique: 'phases', improvements: 'apply-own' } }));
  const out = run('route.mjs', ['fix the bug', '--size', 'medium'], { root });
  assert.match(out.out, /Self-critique: after the quality gate of each phase/i);
  assert.match(out.out, /apply improvements to own skills, agents, and workflows/i);
  write(root, 'settings.json', JSON.stringify({ version: 1, security: { skillspector: 'off' }, quality: { selfCritique: 'off' } }));
  assert.doesNotMatch(run('route.mjs', ['fix the bug', '--size', 'medium'], { root }).out, /Self-critique/i);
});

test('sizes: small, medium, large; the old Italian names (piccolo, medio, grande) are accepted as input', async () => {
  const { normalizeSize } = await import('../scripts/lib/schema.mjs');
  assert.deepEqual(['small', 'Medium', ' large ', 'piccolo', 'MEDIO', 'grande'].map(normalizeSize), ['small', 'medium', 'large', 'small', 'medium', 'large']);
  assert.equal(normalizeSize('huge'), null);
  assert.equal(normalizeSize(undefined), null);
  assert.equal(r('fix login bug', 'piccolo').size, 'small');
  assert.equal(r('fix login bug', 'medium').workflow.name, 'code-change');
  assert.equal(r('fix login bug', 'medio').size, 'medium');
  assert.throws(() => r('fix login bug', 'enorme'));
});
