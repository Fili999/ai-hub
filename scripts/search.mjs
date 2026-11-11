#!/usr/bin/env node
// Searchable catalog: find skills and agents by capability.
//   node scripts/search.mjs "video editing" [--kind skill|agent] [--category video] [--limit 8] [--json]
//   node scripts/search.mjs --list [--category video]      (compact listing by category)
//   node scripts/search.mjs --collisions                   (different words with the same root: potential collisions)
import path from 'node:path';
import { HUB_ROOT, parseArgs, readJson } from './lib/util.mjs';
import { ensureIndex } from './lib/scan.mjs';
import { catsOf, filterPool, searchIndex } from './lib/search.mjs';
import { stemCollisions } from './lib/text.mjs';
import { tFor } from './lib/i18n.mjs';

const t = tFor(HUB_ROOT);
const { flags, positional } = parseArgs(process.argv.slice(2), { boolean: ['json', 'list', 'collisions'] });
const index = ensureIndex(HUB_ROOT);
const config = readJson(path.join(HUB_ROOT, 'hub.config.json'), { categories: {}, synonymGroups: [] });
const str = (v) => (v && v !== true ? String(v) : undefined);
const kind = str(flags.kind);
const category = str(flags.category);
const limit = Number(flags.limit) > 0 ? Number(flags.limit) : 8;

if (flags.collisions) {
  const list = stemCollisions([...index.skills, ...index.agents, ...(index.workflows ?? [])].map((e) => e.description));
  if (flags.json) console.log(JSON.stringify(list, null, 2));
  else {
    console.log(t('search.collisionsHeader'));
    for (const c of list) console.log(`  ${c.stem}: ${c.words.join(', ')}`);
  }
  process.exit(0);
}

if (flags.list) {
  const groups = {};
  for (const e of filterPool(index, { kind, category })) {
    for (const c of catsOf(e).length ? catsOf(e) : [t('search.otherCategory')]) (groups[c] ??= []).push(e);
  }
  if (flags.json) {
    console.log(JSON.stringify(Object.fromEntries(Object.entries(groups).map(([c, l]) => [c, l.map((e) => e.id)])), null, 2));
  } else {
    for (const [c, list] of Object.entries(groups).sort()) {
      console.log(`\n# ${c}${config.categories?.[c] ? ` — ${config.categories[c].label}` : ''}`);
      for (const e of list) console.log(`  ${e.kind === 'agent' ? '◆' : '•'} ${e.name} (${e.origin}) — ${e.description.slice(0, 90)}`);
    }
  }
  process.exit(0);
}

const query = positional.join(' ').trim();
if (!query) {
  console.error(t('search.usage'));
  process.exit(2);
}

const top = searchIndex(index, config, query, { kind, category, limit });

if (flags.json) {
  console.log(JSON.stringify(top.map(({ e, score, matched }) => ({ ...e, score, matched })), null, 2));
} else if (!top.length) {
  console.log(t('search.noResults', { query }));
} else {
  top.forEach(({ e, score }, i) => {
    const cats = catsOf(e).join(', ') || '—';
    const who = e.assignedTo.length ? t('search.assignedTo', { who: e.assignedTo.join(', ') }) : '';
    console.log(t('search.resultHeader', { num: i + 1, kind: e.kind, name: e.name, origin: e.origin, risk: e.risk, cats, score }));
    console.log(`   ${e.description.slice(0, 160)}`);
    console.log(`   ${e.file}${who}`);
  });
}
