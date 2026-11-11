#!/usr/bin/env node
// Syncs the hub with GitHub: checks for updates, pulls them (without reinstalling), and pushes your changes.
//   node scripts/update.mjs [--check] [--pull] [--push] [--message "text"] [--yes] [--json]
//
// Without options only checks (--check) and reports status. --pull downloads only fast-forward updates;
// --push commits local changes and pushes (asks for confirmation unless --yes). Never force pushes.
import { HUB_ROOT, confirm, isInteractive, parseArgs } from './lib/util.mjs';
import { describeStatus, pullUpdates, pushChanges, repoStatus } from './lib/repo.mjs';
import { ensureIndex } from './lib/scan.mjs';
import { loadDependencies, missingSkillCommands } from './lib/deps.mjs';
import { tFor } from './lib/i18n.mjs';

const t = tFor(HUB_ROOT);

const { flags } = parseArgs(process.argv.slice(2), { boolean: ['check', 'pull', 'push', 'yes', 'json'] });
const json = Boolean(flags.json);
const out = (data) => console.log(JSON.stringify(data, null, 2));
const say = (...a) => {
  if (!json) console.log(...a);
};

if ([flags.check, flags.pull, flags.push].filter(Boolean).length > 1) {
  console.error(`✖ ${t('update.oneActionOnly')}`);
  process.exit(2);
}

function showStatus(st) {
  say(`${st.state === 'synced' ? '✔' : st.state === 'diverged' || st.fetchError ? '✖' : '•'} ${describeStatus(st)}`);
  if (st.fetchError) say(`  ⚠ ${st.fetchError.message}`);
  if (st.remoteUrl) say(`  GitHub: ${st.remoteUrl} (${st.upstream})`);
  for (const c of st.incoming) say(`  ↓ ${c.hash}  ${c.subject}  (${c.author})`);
  for (const c of st.outgoing) say(`  ↑ ${c.hash}  ${c.subject}`);
  for (const f of st.changes) say(`  ● ${f.status.padEnd(12)} ${f.path}`);
  if (st.changesTotal > st.changes.length) say(`  ${t('update.moreFiles', { count: st.changesTotal - st.changes.length })}`);
}

let result;
if (flags.pull) {
  result = await pullUpdates(HUB_ROOT, { interactive: isInteractive() });
  if (result.changed) {
    const index = ensureIndex(HUB_ROOT); // realigns catalog with freshly pulled updates
    // programs required by pulled skills that are missing on THIS computer: install only once
    let providers = {};
    try {
      providers = loadDependencies(HUB_ROOT).commandProviders ?? {};
    } catch {
      /* dependencies.json unreadable: doctor reports it */
    }
    result.missingPrograms = [...new Set(missingSkillCommands(index).map((m) => providers[m.command]?.name ?? m.command))];
  }
  if (json) out(result);
  else {
    console.log(`${result.ok ? '✔' : '✖'} ${result.message}`);
    if (result.error?.detail) console.log(`  ${result.error.detail}`);
    if (result.changed) {
      for (const f of result.files ?? []) console.log(`  ↓ ${f}`);
      if (result.missingPrograms.length) console.log(`  ℹ ${t('update.missingProgramsNotice', { programs: result.missingPrograms.join(', ') })}`);
      else if (result.needsSetup) console.log(`  ℹ ${t('update.needsSetupNotice')}`);
      console.log(`  ${t('update.syncHint')}`);
    }
  }
} else if (flags.push) {
  const before = await repoStatus(HUB_ROOT, { fetch: true, interactive: isInteractive() });
  if (!json) showStatus(before);
  const something = before.changesTotal || before.ahead;
  if (something && !flags.yes) {
    if (!isInteractive()) {
      console.error(`✖ ${t('update.confirmRequiredNoTty')}`);
      process.exit(2);
    }
    if (!(await confirm(t('update.confirmPush', { target: before.upstream ?? 'GitHub' })))) {
      console.log(t('update.cancelledNothingSent'));
      process.exit(0);
    }
  }
  result = await pushChanges(HUB_ROOT, { message: typeof flags.message === 'string' ? flags.message : undefined, interactive: isInteractive() });
  if (json) out(result);
  else {
    console.log(`${result.ok ? '✔' : '✖'} ${result.message}`);
    if (result.error?.detail) console.log(`  ${result.error.detail}`);
  }
} else {
  result = await repoStatus(HUB_ROOT, { fetch: true, interactive: false });
  if (json) out(result);
  else {
    showStatus(result);
    if (result.state === 'behind') console.log(t('update.pullHint'));
    if (result.state === 'ahead' || result.changesTotal) console.log(t('update.pushHint'));
  }
}
process.exit(result?.ok === false || result?.fetchError ? 1 : 0);
