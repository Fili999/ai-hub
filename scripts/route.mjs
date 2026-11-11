#!/usr/bin/env node
// Task routing: mode of operation, workflow, capabilities and skills to use (used by orchestrator).
//   node scripts/route.mjs "fix the login bug" [--size small|medium|large] [--team <id>] [--json]
// Proposes, does not decide: size is determined by intake (skill task-intake). Executes nothing.
import path from 'node:path';
import { HUB_ROOT, parseArgs, readJson } from './lib/util.mjs';
import { ensureIndex } from './lib/scan.mjs';
import { route } from './lib/route.mjs';
import { readSettings } from './lib/settings.mjs';
import { readEvaluations } from './lib/evaluation.mjs';
import { loadTeams } from './lib/teams.mjs';
import { tFor } from './lib/i18n.mjs';

const t = tFor(HUB_ROOT);
const { flags, positional } = parseArgs(process.argv.slice(2), { boolean: ['json'] });
const request = positional.join(' ').trim();
if (!request) {
  console.error(t('route.cliUsage'));
  process.exit(2);
}
const size = flags.size && flags.size !== true ? String(flags.size) : undefined;

let r;
try {
  const s = readSettings(HUB_ROOT);
  r = route(ensureIndex(HUB_ROOT), readJson(path.join(HUB_ROOT, 'hub.config.json'), { categories: {}, synonymGroups: [] }), request, {
    size,
    saving: s['tokens.savingLevel'],
    critique: s['quality.selfCritique'],
    improvements: s['quality.improvements'],
    memory: s['memory.mode'],
    history: s['quality.recordEvaluations'] ? readEvaluations(HUB_ROOT).list : [],
    teams: loadTeams(HUB_ROOT).teams,
    team: flags.team && flags.team !== true ? String(flags.team) : null,
  });
} catch (e) {
  console.error(`✖ ${e.message}`);
  process.exit(2);
}

if (flags.json) {
  console.log(JSON.stringify(r, null, 2));
  process.exit(0);
}

const MODE = { direct: t('route.modeDirect'), workflow: t('route.modeWorkflow'), general: t('route.modeGeneral') };
console.log(t('route.cliRequest', { request: r.request }));
console.log(t('route.cliSizeAndMode', { size: r.size ?? t('route.cliSizeNotSpecified'), mode: MODE[r.mode] }));
if (r.workflow) {
  const alt = r.alternatives.length ? t('route.cliAlternatives', { list: r.alternatives.map((a) => a.name).join(', ') }) : '';
  console.log(t('route.cliWorkflow', { name: r.workflow.name, file: r.workflow.file, alt }));
}
if (r.team) {
  const alt = r.team.alternatives?.length ? t('route.cliTeamAlternatives', { list: r.team.alternatives.join(', ') }) : '';
  console.log(t('route.cliTeam', { name: r.team.name, alt }));
  for (const ro of r.team.roles) {
    if (ro.agents.length || ro.skills.length) {
      console.log(`  · ${ro.name}: ${[...ro.agents.map((a) => `${a}${t('route.cliAgentSuffix')}`), ...ro.skills].join(', ')}`);
    }
  }
}
if (r.capabilities.length) {
  console.log(t('route.cliCapabilities'));
  for (const c of r.capabilities) {
    const tokens = c.chosen?.tokens ? t('route.cliTokens', { tokens: c.chosen.tokens.body }) : '';
    const who = c.chosen ? `${c.chosen.kind} ${c.chosen.name} (${c.chosen.file})${tokens}` : t('route.cliNoSkillOffers');
    const alt = c.alternatives.length ? t('route.cliAlternatives', { list: c.alternatives.map((a) => a.name).join(', ') }) : '';
    console.log(`  - ${c.id}${c.optional ? t('route.cliOptional') : ''} → ${who}${alt}`);
  }
}
if (r.related.length) console.log(t('route.cliRelated', { list: r.related.map((x) => x.name).join(', ') }));
for (const n of r.notes) console.log(`ℹ ${n}`);
if (r.selfCritique.mode !== 'off') {
  const when = r.selfCritique.mode === 'phases' ? t('route.critiqueWhenPhases') : t('route.critiqueWhenFinal');
  const what = r.selfCritique.improvements === 'apply-own' ? t('route.critiqueWhatApply') : t('route.critiqueWhatPropose');
  console.log(t('route.cliSelfCritique', { when, what }));
}
if (r.memory !== 'off') {
  const action = r.memory === 'auto' ? t('route.memorySaveAuto') : t('route.memorySavePropose');
  console.log(t('route.cliMemory', { action }));
}
if (r.budget.level !== 'off') {
  console.log(t('route.cliTokensSaving', { label: r.budget.label }));
  for (const rule of r.budget.rules) console.log(`  · ${rule}`);
}
