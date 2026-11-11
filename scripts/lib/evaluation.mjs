// Continuous evaluation (Phase J): every non-trivial task records a measurement (self-critique scores, gate outcome,
// retries, correct routing or not). Measurements live in evaluations/<computer>.jsonl (one line per run,
// versioned; each machine writes only its file) and help find: recurring weak points, regressions,
// skills needing review, and routing errors; route.mjs uses them to provide warnings before similar tasks.
import fs from 'node:fs';
import path from 'node:path';
import { memorySecret } from './memory.mjs';
import { machineName } from './usage.mjs';
import { tFor } from './i18n.mjs';
import { normalizeSize } from './schema.mjs';

export const EVAL_DIR = 'evaluations';

/** The seven self-critique dimensions (skill self-critique): id → label. */
export const DIMENSIONS = {
  correctness: 'Correctness',
  completeness: 'Completeness',
  robustness: 'Robustness',
  simplicity: 'Simplicity',
  verification: 'Verification',
  process: 'Process',
  tools: 'Tools',
};
const GATES = ['pass', 'fail', 'blocked'];
const SIZES = ['medium', 'large'];
const NAME_RE = /^[a-z0-9][a-z0-9:._-]{0,79}$/;

export class EvalError extends Error {}

/** Validates and normalizes an evaluation. Throws EvalError with a clear message. */
export function checkEvaluation(raw, now = new Date(), t = tFor()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new EvalError(t('eval.needJsonObject'));
  const request = String(raw.request ?? '').replace(/\s+/g, ' ').trim();
  if (!request) throw new EvalError(t('eval.needRequest'));
  if (request.length > 200) throw new EvalError(t('eval.requestTooLong'));
  const size = normalizeSize(raw.size); // accepts the old Italian names
  if (!SIZES.includes(size)) throw new EvalError(t('eval.badSize', { sizes: SIZES.join(' | ') }));
  if (!GATES.includes(raw.gate)) throw new EvalError(t('eval.badGate', { gates: GATES.join(', ') }));
  const scores = {};
  for (const k of Object.keys(DIMENSIONS)) {
    const v = raw.scores?.[k];
    if (!Number.isInteger(v) || v < 1 || v > 5) throw new EvalError(t('eval.badScore', { k }));
    scores[k] = v;
  }
  const extra = Object.keys(raw.scores ?? {}).find((k) => !DIMENSIONS[k]);
  if (extra) throw new EvalError(t('eval.unknownScoreDim', { extra: extra.slice(0, 40), allowed: Object.keys(DIMENSIONS).join(', ') }));
  const names = (key) => {
    const list = Array.isArray(raw[key]) ? raw[key].map(String) : [];
    const bad = list.find((n) => !NAME_RE.test(n));
    if (bad !== undefined) throw new EvalError(t('eval.invalidNameInKey', { key, bad: bad.slice(0, 40) }));
    return [...new Set(list)];
  };
  const retries = raw.retries ?? 0;
  if (!Number.isInteger(retries) || retries < 0 || retries > 50) throw new EvalError(t('eval.badRetries'));
  if (raw.routing != null && !['ok', 'wrong'].includes(raw.routing)) throw new EvalError(t('eval.badRouting'));
  const workflow = raw.workflow == null ? null : String(raw.workflow);
  if (workflow !== null && !NAME_RE.test(workflow)) throw new EvalError(t('eval.badWorkflow'));
  const notes = String(raw.notes ?? '').replace(/\s+/g, ' ').trim();
  if (notes.length > 300) throw new EvalError(t('eval.notesTooLong'));
  const why = memorySecret(`${request}\n${notes}`);
  if (why) throw new EvalError(t('eval.secretInEvaluation', { why }));
  return {
    date: now.toISOString().slice(0, 10),
    request,
    size,
    workflow,
    skills: names('skills'),
    agents: names('agents'),
    gate: raw.gate,
    retries,
    routing: raw.routing ?? null,
    scores,
    ...(notes ? { notes } : {}),
  };
}

/** Appends an evaluation to this machine's file. Returns relative path. */
export function recordEvaluation(root, raw, { now = new Date(), machine = machineName() } = {}) {
  const t = tFor(root);
  const e = checkEvaluation(raw, now, t);
  const dir = path.join(root, EVAL_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `${machine}.jsonl`), `${JSON.stringify(e)}\n`);
  return `${EVAL_DIR}/${machine}.jsonl`;
}

/** All evaluations across all machines, from oldest to newest. Invalid lines are counted and skipped. */
export function readEvaluations(root) {
  const t = tFor(root);
  const dir = path.join(root, EVAL_DIR);
  const list = [];
  let invalid = 0;
  if (!fs.existsSync(dir)) return { list, invalid };
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl')).sort()) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const raw = JSON.parse(line);
        list.push({ ...checkEvaluation(raw, new Date(`${raw.date}T12:00:00Z`), t), date: raw.date });
      } catch {
        invalid++;
      }
    }
  }
  list.sort((a, b) => a.date.localeCompare(b.date));
  return { list, invalid };
}

const avg = (xs) => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10 : null);
const dimAvg = (list) => Object.fromEntries(Object.keys(DIMENSIONS).map((k) => [k, avg(list.map((e) => e.scores[k]))]));

// guidance thresholds
export const MIN_RUNS = 3; // below this number of runs no conclusions are drawn
export const WEAK = 3.5; // score average below which it is considered a weak point
export const DROP = 0.75; // average drop between recent and prior runs indicating a regression

/**
 * Summary by group (workflow, skill, agent): runs, dimension averages, gate outcomes, retries, regressions.
 * A regression: average of last MIN_RUNS runs lower by DROP compared to previous ones (requires 2×MIN_RUNS runs).
 */
function summarize(list) {
  const recent = list.slice(-MIN_RUNS);
  const before = list.slice(0, -MIN_RUNS);
  const avgs = dimAvg(list);
  const regressions = [];
  if (before.length >= MIN_RUNS) {
    const a = dimAvg(before);
    const b = dimAvg(recent);
    for (const k of Object.keys(DIMENSIONS)) if (a[k] - b[k] >= DROP) regressions.push({ dimension: k, before: a[k], recent: b[k] });
  }
  const weakest = Object.entries(avgs).sort((x, y) => x[1] - y[1])[0];
  return {
    runs: list.length,
    averages: avgs,
    weakest: weakest ? { dimension: weakest[0], average: weakest[1] } : null,
    gate: Object.fromEntries(GATES.map((g) => [g, list.filter((e) => e.gate === g).length])),
    retries: avg(list.map((e) => e.retries)),
    regressions,
  };
}

/** Full report with advice. */
export function evaluationReport(list, { index = null, t = tFor() } = {}) {
  const group = (key) => {
    const m = new Map();
    for (const e of list) for (const n of key(e)) (m.get(n) ?? m.set(n, []).get(n)).push(e);
    return Object.fromEntries([...m].sort().map(([n, l]) => [n, summarize(l)]));
  };
  const workflows = group((e) => [e.workflow ?? t('eval.generalMethod')]);
  const skills = group((e) => e.skills);
  const agents = group((e) => e.agents);
  const routed = list.filter((e) => e.routing);
  const routing = { judged: routed.length, wrong: routed.filter((e) => e.routing === 'wrong').map((e) => ({ date: e.date, request: e.request, workflow: e.workflow })) };
  const advice = [];
  const overall = summarize(list);
  const label = (k) => t(`eval.dim.${k}`);
  if (list.length >= MIN_RUNS && overall.weakest && overall.weakest.average < WEAK) {
    advice.push({ level: 'warn', text: t('eval.adviceRecurringWeakPoint', { dim: label(overall.weakest.dimension), avg: overall.weakest.average, runs: list.length }) });
  }
  for (const [name, s] of Object.entries({ ...prefix(workflows, t('eval.workflowPrefix')), ...prefix(skills, t('eval.skillPrefix')), ...prefix(agents, t('eval.agentPrefix')) })) {
    for (const r of s.regressions) advice.push({ level: 'warn', text: t('eval.adviceRegression', { name, dim: label(r.dimension), before: r.before, recent: r.recent, min: MIN_RUNS }) });
    if (s.runs >= MIN_RUNS && s.weakest && s.weakest.average < WEAK && !name.startsWith(t('eval.workflowPrefix'))) {
      advice.push({ level: 'tip', text: t('eval.adviceRevisionCandidate', { name, dim: label(s.weakest.dimension), avg: s.weakest.average, runs: s.runs }) });
    }
    if (s.runs >= MIN_RUNS && s.retries >= 2) advice.push({ level: 'tip', text: t('eval.adviceAvgRetries', { name, retries: s.retries }) });
  }
  if (routing.wrong.length) advice.push({ level: 'warn', text: t('eval.adviceWrongRouting', { wrong: routing.wrong.length, judged: routing.judged }) });
  // duplicates and near-duplicates already found by inventory
  const dup = (index?.warnings ?? []).filter((w) => w.type === 'duplicate-name' || w.type === 'similar');
  for (const w of dup) advice.push({ level: 'tip', text: t('eval.adviceDuplicate', { message: w.message }) });
  return { runs: list.length, overall, workflows, skills, agents, routing, advice };
}

const prefix = (obj, p) => Object.fromEntries(Object.entries(obj).map(([n, s]) => [`${p} ${n}`, s]));

/** Warning for route.mjs: the weakest point of a workflow in past runs, if enough data exists. */
export function workflowHint(list, workflow, t = tFor()) {
  const l = list.filter((e) => (e.workflow ?? null) === (workflow ?? null));
  if (l.length < MIN_RUNS) return null;
  const s = summarize(l);
  if (!s.weakest || s.weakest.average >= WEAK) return null;
  const target = workflow ? t('eval.withWorkflow', { workflow }) : t('eval.withGeneralMethod');
  return t('eval.workflowHint', { runs: s.runs, target, dim: t(`eval.dim.${s.weakest.dimension}`), avg: s.weakest.average });
}
