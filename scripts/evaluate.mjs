#!/usr/bin/env node
// Continuous evaluation: records metrics for a task (self-critique scores, gate, retries) and shows report.
//   node scripts/evaluate.mjs record '{"request":"…","size":"medium","workflow":"code-change","skills":["…"],"gate":"pass","retries":0,"routing":"ok","scores":{…}}'
//   node scripts/evaluate.mjs report [--days 90] [--json]
// Measurements are stored in evaluations/<computer>.jsonl. Exits with 3 if disabled in Settings.
import path from 'node:path';
import { HUB_ROOT, parseArgs } from './lib/util.mjs';
import { readSettings } from './lib/settings.mjs';
import { ensureIndex } from './lib/scan.mjs';
import { DIMENSIONS, EvalError, evaluationReport, readEvaluations, recordEvaluation } from './lib/evaluation.mjs';
import { tFor } from './lib/i18n.mjs';

const t = tFor(HUB_ROOT);
const { flags, positional } = parseArgs(process.argv.slice(2), { boolean: ['json'] });
const [cmd, ...rest] = positional;

if (!readSettings(HUB_ROOT)['quality.recordEvaluations']) {
  console.error(t('eval.disabledInSettings'));
  process.exit(3);
}

if (cmd === 'record') {
  let raw;
  try {
    raw = JSON.parse(rest.join(' '));
  } catch {
    console.error(t('eval.badJson'));
    process.exit(2);
  }
  try {
    const file = recordEvaluation(HUB_ROOT, raw);
    console.log(flags.json ? JSON.stringify({ ok: true, file }) : t('eval.recorded', { file }));
  } catch (e) {
    if (!(e instanceof EvalError)) throw e;
    console.error(`✖ ${e.message}`);
    process.exit(2);
  }
} else if (cmd === 'report') {
  const { list, invalid } = readEvaluations(HUB_ROOT);
  const days = Number(flags.days) > 0 ? Number(flags.days) : 0;
  const since = days ? new Date(Date.now() - days * 86400000).toISOString().slice(0, 10) : '';
  const r = evaluationReport(list.filter((e) => e.date >= since), { index: ensureIndex(HUB_ROOT) });
  if (flags.json) {
    console.log(JSON.stringify({ ...r, invalid }, null, 2));
    process.exit(0);
  }
  if (invalid) console.log(t('eval.invalidLinesIgnored', { invalid, path: path.join('evaluations', '*.jsonl') }));
  console.log(t('eval.jobsEvaluated', { runs: r.runs, days: days ? t('eval.lastDays', { days }) : '' }));
  if (r.runs) {
    console.log(`${t('eval.averages')}: ${Object.entries(r.overall.averages).map(([k, v]) => `${t(`eval.dim.${k}`)} ${v}`).join(' · ')}`);
    console.log(t('eval.gateStats', { pass: r.overall.gate.pass, fail: r.overall.gate.fail, blocked: r.overall.gate.blocked, retries: r.overall.retries }));
    if (r.routing.judged) console.log(t('eval.routingStats', { ok: r.routing.judged - r.routing.wrong.length, total: r.routing.judged }));
    for (const [n, s] of Object.entries(r.workflows)) {
      const weakest = s.weakest ? t('eval.weakestPart', { dim: t(`eval.dim.${s.weakest.dimension}`), avg: s.weakest.average }) : '';
      console.log(t('eval.workflowRow', { name: n, runs: s.runs, weakest }));
    }
  }
  for (const a of r.advice) console.log(`${a.level === 'warn' ? '⚠' : '·'} ${a.text}`);
  if (!r.advice.length && r.runs) console.log(t('eval.noWeakPoints'));
} else {
  console.error(t('eval.usage'));
  process.exit(2);
}
