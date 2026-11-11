#!/usr/bin/env node
// Usage, estimated token consumption, and recommendations for each skill and agent (updates counts for this computer).
//   node scripts/usage.mjs [name] [--json] [--no-update]
// Counts come from Claude Code history (names and numbers only) and are stored in usage/<computer>.json.
import { HUB_ROOT, parseArgs } from './lib/util.mjs';
import { ensureIndex } from './lib/scan.mjs';
import { readSettings } from './lib/settings.mjs';
import { LEVEL_LABEL, readAllUsage, updateMachineUsage, usageReport } from './lib/usage.mjs';
import { tFor } from './lib/i18n.mjs';

const t = tFor(HUB_ROOT);
const { flags, positional } = parseArgs(process.argv.slice(2), { boolean: ['json', 'no-update'] });
const index = ensureIndex(HUB_ROOT);
const tracking = readSettings(HUB_ROOT)['usage.fromTranscripts'];
let update = null;
if (tracking && !flags['no-update']) {
  try {
    update = updateMachineUsage(HUB_ROOT, new Set([...index.skills, ...index.agents].map((e) => e.id)));
  } catch (e) {
    console.error(t('usage.claudeHistoryUnreadable', { message: e.message }));
  }
}
const all = readAllUsage(HUB_ROOT);
const report = usageReport(index, all.items, Date.now(), t);
const filter = positional.join(' ').trim().toLowerCase();
const rows = filter ? report.rows.filter((r) => r.name.toLowerCase().includes(filter)) : report.rows;

if (flags.json) {
  console.log(JSON.stringify({ ...report, rows, machines: all.machines, update, tracking }, null, 2));
  process.exit(0);
}

if (!tracking) console.log(t('usage.trackingOff'));
else if (update) console.log(t('usage.machineCounts', { machine: update.machine, updated: update.changed ? t('usage.updatedSuffix') : '', files: update.files }));
if (all.machines.length) console.log(t('usage.computers', { list: all.machines.join(', ') }));
if (!report.hasData) console.log(t('usage.noUsageRecorded'));
console.log(t('usage.perSessionTokens', { perSession: report.perSession }));
for (const r of rows) {
  const tk = r.tokens ?? { description: 0, body: 0, extra: 0 };
  const levelLabels = { never: t('usage.levelMai'), low: t('usage.levelBasso'), medium: t('usage.levelMedio'), high: t('usage.levelAlto') };
  const use = report.hasData ? t('usage.rowStats', { level: levelLabels[r.level] ?? LEVEL_LABEL[r.level], last90: r.last90, score: r.score }) : t('usage.rowNotMeasured');
  console.log(`${r.kind === 'agent' ? t('usage.agentLabel') : t('usage.skillLabel')} ${r.name} — ${use}`);
  const extraStr = tk.extra ? t('usage.tokenExtra', { extra: tk.extra }) : '';
  console.log(t('usage.tokenBreakdown', { desc: tk.description, body: tk.body, extra: extraStr }));
  for (const a of r.advice) console.log(`   ${a.level === 'warn' ? '⚠' : '·'} ${a.text}`);
}
