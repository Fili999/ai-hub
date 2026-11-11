#!/usr/bin/env node
// Guided setup of this computer: language, AI tools, security, programs (dependencies.json), git hooks, sync to your AI tools.
//
//   node scripts/setup.mjs [--configure] [--lang en] [--tools claude,codex,antigravity,opencode]
//                          [--yes] [--check] [--dry-run] [--json] [--with-optional] [--no-install] [--no-hooks] [--no-sync] [--instructions]
//
//   --configure      asks the configuration questions again (they are asked anyway the first time, when settings.json is missing)
//   --lang, --tools  answer those questions from the command line (also without a terminal)
//   --check          changes nothing: shows what is missing, exits with 1 if a required tool is missing
//   --yes            answers yes to the install, hooks and sync questions
//   --dry-run        shows the commands that would run, without running them
//   --with-optional  includes the optional programs
//   --instructions   writes the ai-hub block in CLAUDE.md / AGENTS.md / GEMINI.md (use the orchestrator first)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HUB_ROOT, ask, commandExists, confirm, fail, isInteractive, parseArgs } from './lib/util.mjs';
import { availableManagers, machineInfo, runCommand } from './lib/machine.mjs';
import { checkAll, installPlan, loadDependencies, missingSkillCommands, runPlan, validateDependencies } from './lib/deps.mjs';
import { ensureIndex } from './lib/scan.mjs';
import { SETTINGS_FILE, readSettings, writeSettings } from './lib/settings.mjs';
import { loadProviders, providerPaths } from './lib/providers.mjs';
import { LANGUAGES, translator, tFor } from './lib/i18n.mjs';

const { flags } = parseArgs(process.argv.slice(2), {
  boolean: ['yes', 'check', 'dry-run', 'json', 'with-optional', 'no-install', 'no-hooks', 'no-sync', 'claude-md', 'instructions', 'configure'],
});
const json = Boolean(flags.json);
const dry = Boolean(flags['dry-run']);
const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const say = (...a) => {
  if (!json) console.log(...a);
};
let t = tFor(HUB_ROOT);
const report = { machine: null, config: null, tools: [], skillCommands: [], installed: [], skipped: [], hooks: null, sync: null, doctor: null };
const interactive = isInteractive() && !json;

const deps = loadDependencies(HUB_ROOT);
const depErrors = validateDependencies(deps);
if (depErrors.length) fail(`${t('setup.badDeps')}\n  - ${depErrors.join('\n  - ')}`);

const managers = availableManagers();
const machine = machineInfo(HUB_ROOT);
report.machine = machine;

// ---- 0. configuration: language, AI tools, security, sync between computers
const firstRun = !fs.existsSync(path.join(HUB_ROOT, SETTINGS_FILE));
const providers = loadProviders(HUB_ROOT);
const flagList = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : null);

async function choose(question, options, def) {
  if (!interactive) return def;
  const keys = options.map((o) => o.id);
  say(`\n${question}`);
  options.forEach((o, i) => say(`  ${i + 1}) ${o.label}${o.id === def ? ` (${t('setup.default')})` : ''}`));
  const a = (await ask('  > ', String(keys.indexOf(def) + 1))).trim().toLowerCase();
  const n = Number(a);
  if (Number.isInteger(n) && n >= 1 && n <= keys.length) return keys[n - 1];
  return keys.includes(a) ? a : def;
}

if (!flags.check && (flags.lang || flags.tools || ((firstRun || flags.configure) && interactive))) {
  const cur = readSettings(HUB_ROOT);
  const patch = {};
  // language
  let lang = typeof flags.lang === 'string' ? flags.lang : null;
  if (lang && !LANGUAGES[lang]) fail(t('setup.badLang', { lang, list: Object.keys(LANGUAGES).join(', ') }), 2);
  if (!lang && interactive) lang = await choose('Language', Object.entries(LANGUAGES).map(([id, label]) => ({ id, label })), cur['interface.language']);
  if (lang) {
    patch['interface.language'] = lang;
    t = translator(lang);
  }
  // AI tools: those installed on this computer are proposed
  const wanted = flagList(flags.tools);
  const unknown = (wanted ?? []).filter((id) => !providers[id]);
  if (unknown.length) fail(t('setup.badTools', { ids: unknown.join(', '), list: Object.keys(providers).join(', ') }), 2);
  if (wanted || interactive) {
    say(`\n${t('setup.toolsTitle')}`);
    for (const p of Object.values(providers)) {
      const found = commandExists(p.command);
      let on = wanted ? wanted.includes(p.id) : null;
      if (on === null) on = await confirm(`  ${t('setup.toolAsk', { tool: p.name, state: t(found ? 'setup.toolFound' : 'setup.toolMissing') })}`, firstRun ? found || (p.id === 'claude' && !Object.values(providers).some((x) => commandExists(x.command))) : cur[`providers.${p.id}`]);
      patch[`providers.${p.id}`] = Boolean(on);
      if (on) say(`    ${t('setup.toolFolders', { skills: providerPaths(p).skillsDir, agents: providerPaths(p).agentsDir })}`);
    }
    say(`  ${t('setup.toolsHint')}`);
  }
  if (interactive && !flags.lang && !flags.tools) {
    patch['security.skillspector'] = await choose(t('setup.securityAsk'), [
      { id: 'block', label: t('setup.security.block') },
      { id: 'warn', label: t('setup.security.warn') },
      { id: 'off', label: t('setup.security.off') },
    ], cur['security.skillspector']);
    patch['dependencies.claudeMayInstall'] = await confirm(`\n${t('setup.mayInstallAsk')}`, cur['dependencies.claudeMayInstall']);
    patch['sync.github'] = await confirm(`\n${t('setup.githubAsk')}`, cur['sync.github']);
  }
  if (Object.keys(patch).length && !dry) {
    writeSettings(HUB_ROOT, patch);
    say(`\n✔ ${t('setup.saved', { file: SETTINGS_FILE })}`);
  }
  report.config = patch;
}

say(`\n${t('setup.title')}`);
say(`  ${t('setup.system', { os: machine.platformLabel, arch: machine.arch, node: machine.node, root: HUB_ROOT })}`);
say(`  ${t('setup.managers')}: ${Object.entries(managers).map(([m, ok]) => `${m} ${ok ? '✔' : '✖'}`).join('  ')}\n`);

// ---- 1. programs
let tools = checkAll(deps);
const ICON = { required: '●', recommended: '◐', optional: '○' };
const printTools = () => {
  for (const x of tools) {
    const state = x.ok ? `✔ ${x.version ?? 'ok'}` : `✖ ${x.reason}`;
    say(`  ${ICON[x.level]} ${x.name.padEnd(12)} ${t(`setup.level.${x.level}`).padEnd(12)} ${state}`);
  }
};
say(t('setup.programs'));
printTools();

const index = ensureIndex(HUB_ROOT);
const skillCmds = missingSkillCommands(index).map((m) => ({ ...m, provider: deps.commandProviders[m.command] ?? null }));
report.skillCommands = skillCmds;
if (skillCmds.length) {
  say(`\n${t('setup.skillPrograms')}`);
  for (const m of skillCmds) say(`  ✖ ${m.command.padEnd(12)} ${t('setup.usedBy', { list: m.requiredBy.join(', ') })}${m.provider ? '' : `  (${t('setup.installByHand')})`}`);
}

const requiredMissing = tools.filter((x) => x.level === 'required' && !x.ok);
report.tools = tools;

if (flags.check) {
  if (json) console.log(JSON.stringify(report, null, 2));
  else say(requiredMissing.length ? `\n✖ ${t('setup.requiredMissing', { list: requiredMissing.map((x) => x.name).join(', ') })}` : `\n✔ ${t('setup.requiredOk')}`);
  process.exit(requiredMissing.length ? 1 : 0);
}

// ---- consent: --yes, or a question in the terminal; without a terminal nothing invasive happens
async function decide(question) {
  if (flags.yes) return true;
  if (!interactive) return false;
  return confirm(question);
}

// ---- 2. install
if (!flags['no-install']) {
  const wanted = tools.filter((x) => !x.ok && (x.level !== 'optional' || flags['with-optional']));
  const jobs = [
    ...wanted.map((x) => {
      const def = deps.tools.find((d) => d.id === x.id);
      return { label: x.name, why: x.why, spec: def.install, manual: def.manual, plan: installPlan(def.install, def.manual, { managers }), check: def.check.command };
    }),
    ...skillCmds.filter((m) => m.provider).map((m) => ({ label: m.provider.name ?? m.command, why: t('setup.requiredBy', { list: m.requiredBy.join(', ') }), plan: installPlan(m.provider.install, null, { managers }), check: m.command })),
  ];
  if (jobs.length) say(`\n${t('setup.install')}`);
  for (const job of jobs) {
    // a package manager installed earlier in this same run (e.g. uv, then SkillSpector) can already be used
    if (!job.plan.auto && job.spec) job.plan = installPlan(job.spec, job.manual, { managers: availableManagers() });
    if (!job.plan.auto) {
      say(`  ⚠ ${t('setup.cannotInstall', { what: job.label, reason: job.plan.reason })}${job.plan.manual ? ` ${t('setup.guide', { url: job.plan.manual })}` : ''}`);
      report.skipped.push({ what: job.label, reason: job.plan.reason });
      continue;
    }
    say(`  ${job.label} — ${job.why}\n    ${t('setup.command')}: ${job.plan.display}`);
    if (dry) {
      say(`    ${t('setup.dryNotRun')}`);
      report.skipped.push({ what: job.label, reason: 'dry-run' });
      continue;
    }
    if (!(await decide(`    ${t('setup.installAsk', { what: job.label })}`))) {
      say(`    ${t(interactive ? 'setup.skipped' : 'setup.skippedNoTerminal')}`);
      report.skipped.push({ what: job.label, reason: 'not confirmed' });
      continue;
    }
    const res = runPlan(job.plan);
    if (res.ok && res.already) {
      say(`    ✔ ${t('setup.already', { what: job.label })}`);
      report.installed.push(job.label);
    } else if (res.ok) {
      say(`    ✔ ${t(commandExists(job.check) ? 'setup.installed' : 'setup.installedReopen', { what: job.label })}`);
      report.installed.push(job.label);
    } else {
      say(`    ✖ ${job.label}: ${res.error}`);
      report.skipped.push({ what: job.label, reason: res.error });
    }
  }
  tools = checkAll(deps);
  report.tools = tools;
}

const stillMissing = tools.filter((x) => x.level === 'required' && !x.ok);
if (stillMissing.length) say(`\n✖ ${t('setup.stillMissing', { list: stillMissing.map((x) => x.name).join(', ') })}`);

// ---- 3. git hooks (sync to your AI tools after every pull)
if (!flags['no-hooks'] && machine.isGitRepo && commandExists('git')) {
  const cur = runCommand('git', ['config', '--get', 'core.hooksPath'], { cwd: HUB_ROOT }).stdout;
  if (cur === '.githooks') report.hooks = 'already on';
  else if (dry) say(`\n${t('setup.hooksDry')}`);
  else if (await decide(`\n${t('setup.hooksAsk')}`)) {
    const r = runCommand('git', ['config', 'core.hooksPath', '.githooks'], { cwd: HUB_ROOT });
    report.hooks = r.ok ? 'on' : `error: ${r.error ?? r.stderr}`;
    say(r.ok ? `  ✔ ${t('setup.hooksOn')}` : `  ✖ ${report.hooks}`);
  }
}

// ---- 4. install skills and agents into the chosen AI tools
const enabled = Object.values(providers).filter((p) => readSettings(HUB_ROOT)[`providers.${p.id}`]);
const instructions = Boolean(flags.instructions || flags['claude-md']);
if (!flags['no-sync'] && enabled.length) {
  const names = enabled.map((p) => p.name).join(', ');
  const syncArgs = [path.join(SCRIPTS, 'sync.mjs'), ...(instructions ? ['--instructions'] : [])];
  if (dry) say(`\n${t('setup.syncDry', { tools: names })}`);
  else if (await decide(`\n${t('setup.syncAsk', { tools: names })}`)) {
    say('');
    const r = spawnSync(process.execPath, syncArgs, { stdio: json ? 'ignore' : 'inherit', env: process.env });
    report.sync = r.status === 0 ? 'ok' : `error (code ${r.status})`;
    if (r.status !== 0) say(`  ✖ ${t('setup.syncFailed', { code: r.status })}`);
    else if (!instructions && interactive && (await confirm(t('setup.instructionsAsk')))) {
      const r2 = spawnSync(process.execPath, [path.join(SCRIPTS, 'sync.mjs'), '--instructions', '--quiet'], { stdio: 'inherit', env: process.env });
      say(r2.status === 0 ? `  ✔ ${t('setup.instructionsDone')}` : `  ✖ ${t('setup.failed')}`);
    }
  } else say(`  ${t('setup.syncSkipped')}`);
} else if (!flags['no-sync']) say(`\n${t('setup.noTools')}`);

// ---- 5. final check
const doctor = spawnSync(process.execPath, [path.join(SCRIPTS, 'doctor.mjs'), '--json'], { encoding: 'utf8', env: process.env });
try {
  const d = JSON.parse(doctor.stdout);
  const errors = d.problems.filter((p) => p.level === 'error');
  const warns = d.problems.filter((p) => p.level === 'warn');
  report.doctor = { errors: errors.length, warnings: warns.length };
  say(`\n${t('setup.final', { items: d.checked.length, errors: errors.length, warnings: warns.length })}${errors.length ? ` — ${t('setup.seeDoctor')}` : ''}`);
} catch {
  report.doctor = { errors: 0, warnings: 0 };
}

if (json) console.log(JSON.stringify(report, null, 2));
else {
  say(`\n${stillMissing.length ? t('setup.almost') : `✔ ${t('setup.ready')}`} ${t('setup.start')}`);
  say(t('setup.guideHint'));
}
process.exit(stillMissing.length ? 1 : 0);
