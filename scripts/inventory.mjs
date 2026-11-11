#!/usr/bin/env node
// Automated inventory: scans skills/ and agents/ and generates index/skillindex.json.
//   node scripts/inventory.mjs [--quiet] [--json] [--check]
import { parseArgs, HUB_ROOT } from './lib/util.mjs';
import { scanHub, writeIndex, INDEX_FILE } from './lib/scan.mjs';
import { refreshGuideSafe } from './lib/guide.mjs';
import { tFor } from './lib/i18n.mjs';

const t = tFor(HUB_ROOT);
const { flags } = parseArgs(process.argv.slice(2), { boolean: ['quiet', 'json', 'check'] });
const index = writeIndex(HUB_ROOT, scanHub(HUB_ROOT));
const guide = refreshGuideSafe(HUB_ROOT);

if (flags.json) {
  console.log(JSON.stringify(index.stats));
} else if (!flags.quiet) {
  const s = index.stats;
  const guideText = guide.changed ? t('inventory.guideUpdated') : '';
  console.log(t('inventory.updated', { file: INDEX_FILE, guide: guideText }));
  console.log(t('inventory.counts', { skills: s.skills, agents: s.agents, own: s.own, external: s.external }));

  const perCat = {};
  for (const e of [...index.skills, ...index.agents]) {
    const cats = e.categories.length ? e.categories : e.inferredCategories.length ? e.inferredCategories : [t('inventory.uncategorized')];
    for (const c of cats) perCat[c] = (perCat[c] ?? 0) + 1;
  }
  const line = Object.entries(perCat).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}: ${n}`).join(' · ');
  if (line) console.log(t('inventory.categories', { line }));

  const interesting = index.warnings.filter((w) => w.level !== 'info');
  if (interesting.length) {
    console.log(t('inventory.warningsHeader', { count: interesting.length }));
    for (const w of interesting.slice(0, 8)) console.log(`  - [${w.level}] ${w.message}`);
    if (interesting.length > 8) console.log(t('inventory.moreWarnings', { count: interesting.length - 8 }));
  }
}

if (flags.check && index.stats.errors > 0) process.exit(1);
