// Continuous evaluation: recording scores, report (weak points, regressions, routing, duplicates)
// and metrics usage by route.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, cleanupAfter, makeHub, run, write } from './helpers.mjs';
import { DIMENSIONS, EvalError, checkEvaluation, evaluationReport, readEvaluations, recordEvaluation, workflowHint } from '../scripts/lib/evaluation.mjs';
import { route } from '../scripts/lib/route.mjs';
import { scanHub } from '../scripts/lib/scan.mjs';

cleanupAfter();

const scores = (o = {}) => ({ correctness: 4, completeness: 4, robustness: 4, simplicity: 4, verification: 4, process: 4, tools: 4, ...o });
const ev = (o = {}) => ({ request: 'fix login bug', size: 'medium', workflow: 'code-change', skills: ['quality-gate'], gate: 'pass', retries: 0, routing: 'ok', scores: scores(), ...o });
const day = (n) => new Date(Date.UTC(2026, 9, n, 12));

test('evaluation: controlled fields, no small tasks, no secrets, no missing or extra points', () => {
  const e = checkEvaluation(ev(), day(20));
  assert.equal(e.date, '2026-10-20');
  assert.deepEqual(Object.keys(e.scores), Object.keys(DIMENSIONS));
  const bad = [
    [ev({ size: 'small' }), /size/i],
    [ev({ gate: 'ok' }), /gate/i],
    [ev({ scores: scores({ tools: 6 }) }), /scores.tools/i],
    [ev({ scores: { ...scores(), beauty: 3 } }), /unknown/i],
    [ev({ scores: { correctness: 4 } }), /scores.completeness/i],
    [ev({ request: '' }), /request/i],
    [ev({ request: 'x'.repeat(201) }), /too long/i],
    [ev({ skills: ['../x'] }), /invalid/i],
    [ev({ retries: -1 }), /retries/i],
    [ev({ routing: 'maybe' }), /routing/i],
    [ev({ notes: 'token ghp_' + 'a'.repeat(36) }), /GitHub token/i],
    [null, /object/i],
  ];
  for (const [raw, re] of bad) assert.throws(() => checkEvaluation(raw), (x) => x instanceof EvalError && re.test(x.message), JSON.stringify(raw)?.slice(0, 50));
});

test('evaluation: one file per computer, read together in date order; damaged lines counted and skipped', () => {
  const root = makeHub();
  assert.equal(recordEvaluation(root, ev(), { now: day(21), machine: 'mac' }), 'evaluations/mac.jsonl');
  recordEvaluation(root, ev({ request: 'other' }), { now: day(20), machine: 'windows' });
  fs.appendFileSync(path.join(root, 'evaluations', 'mac.jsonl'), '{broken\n{"request":"x"}\n');
  const { list, invalid } = readEvaluations(root);
  assert.deepEqual(list.map((e) => e.date), ['2026-10-20', '2026-10-21']);
  assert.equal(invalid, 2);
});

test('report: recurring weak point, regression, retries, incorrect routing, duplicates', () => {
  // 6 jobs on workflow: first 3 good, last 3 with verification dropping and more retries
  const list = [
    ...[1, 2, 3].map((d) => ({ ...checkEvaluation(ev(), day(d)) })),
    ...[4, 5, 6].map((d) => ({ ...checkEvaluation(ev({ retries: 4, scores: scores({ verification: 2 }) }), day(d)) })),
    checkEvaluation(ev({ workflow: 'video-production', routing: 'wrong', request: 'editorial plan' }), day(7)),
  ];
  const index = { warnings: [{ type: 'similar', message: 'skill:a and skill:b have almost identical descriptions' }] };
  const r = evaluationReport(list, { index });
  assert.equal(r.runs, 7);
  assert.equal(r.workflows['code-change'].runs, 6);
  assert.deepEqual(r.workflows['code-change'].regressions, [{ dimension: 'verification', before: 4, recent: 2 }]);
  assert.equal(r.overall.weakest.dimension, 'verification');
  const text = r.advice.map((a) => a.text).join('\n');
  assert.match(text, /workflow code-change: Verification dropping \(from 4 to 2/i);
  assert.match(text, /workflow code-change: average 2 retries/i);
  assert.match(text, /skill quality-gate: Verification average 3.1 across 7 jobs/i);
  assert.match(text, /Incorrect routing 1 times out of 7/i);
  assert.match(text, /Possible duplicate: skill:a/i);
  // few jobs: no conclusions
  assert.deepEqual(evaluationReport(list.slice(0, 2)).advice, []);
});

test('route uses metrics: warns of workflow weak point only with enough jobs', () => {
  const weak = [1, 2, 3].map((d) => checkEvaluation(ev({ scores: scores({ robustness: 2 }) }), day(d)));
  assert.match(workflowHint(weak, 'code-change'), /weakest point was Robustness \(average 2\)/i);
  assert.equal(workflowHint(weak.slice(0, 2), 'code-change'), null);
  assert.equal(workflowHint(weak, 'video-production'), null);
  const index = scanHub(REPO);
  const config = JSON.parse(fs.readFileSync(path.join(REPO, 'hub.config.json'), 'utf8'));
  assert.ok(route(index, config, 'fix login bug', { size: 'medium', history: weak }).notes.some((n) => /Robustness/i.test(n)));
  assert.ok(!route(index, config, 'fix login bug', { size: 'medium' }).notes.some((n) => /Robustness/i.test(n)));
});

test('npm run evaluate: record, report, disabled setting', () => {
  const root = makeHub();
  const rec = run('evaluate.mjs', ['record', JSON.stringify(ev())], { root });
  assert.equal(rec.code, 0, rec.err);
  assert.equal(run('evaluate.mjs', ['record', '{not json'], { root }).code, 2);
  assert.equal(run('evaluate.mjs', ['record', JSON.stringify(ev({ size: 'small' }))], { root }).code, 2);
  const rep = JSON.parse(run('evaluate.mjs', ['report', '--json'], { root }).out);
  assert.equal(rep.runs, 1);
  write(root, 'settings.json', '{"version":1,"quality":{"recordEvaluations":false}}\n');
  assert.equal(run('evaluate.mjs', ['report'], { root }).code, 3);
  const skill = fs.readFileSync(path.join(REPO, 'skills', 'own', 'self-critique', 'SKILL.md'), 'utf8');
  for (const k of Object.keys(DIMENSIONS)) assert.ok(skill.toLowerCase().includes(k.toLowerCase()), `self-critique mentions ${k}`);
});
