#!/usr/bin/env node
// Agent → skill links and categories. Saved to registry.json (versioned).
//   node scripts/link.mjs add agent:<agent> skill:<skill>
//   node scripts/link.mjs remove agent:<agent> skill:<skill>
//   node scripts/link.mjs list [--agent <name>] [--skill <name>]
//   node scripts/link.mjs categorize skill:<name> cat1,cat2     (--clear to empty)
//   node scripts/link.mjs capabilities skill:<name> cap1,cap2   (capabilities for route.mjs; --clear to remove)
//   node scripts/link.mjs category add <id> "Name" [word1,word2] | category rename <id> "Name" | category keywords <id> a,b | category remove <id>
// The skill:/agent: prefixes are optional: otherwise first is agent and second is skill.
import { HUB_ROOT, csv, fail, parseArgs } from './lib/util.mjs';
import { ensureIndex } from './lib/scan.mjs';
import { addCategory, categorize, linkAdd, linkRemove, removeCategory, setItemCapabilities, updateCategory } from './lib/ops.mjs';
import { tFor } from './lib/i18n.mjs';

const t = tFor(HUB_ROOT);
const { flags, positional } = parseArgs(process.argv.slice(2), { boolean: ['clear'] });
const [cmd, ...rest] = positional;
const withKind = (ref, kind) => (/^(skill|agent):/.test(ref) ? ref : `${kind}:${ref}`);

try {
  switch (cmd) {
    case 'add':
    case 'remove': {
      if (rest.length !== 2) fail(t('link.usageAddRemove', { cmd }), 2);
      const r = (cmd === 'add' ? linkAdd : linkRemove)(HUB_ROOT, rest[0], rest[1]);
      console.log(`${r.changed ? '✔ ' : ''}${r.message}`);
      break;
    }
    case 'list': {
      const index = ensureIndex(HUB_ROOT);
      const fAgent = flags.agent && flags.agent !== true ? withKind(String(flags.agent), 'agent') : null;
      const fSkill = flags.skill && flags.skill !== true ? withKind(String(flags.skill), 'skill') : null;
      const rows = index.edges.filter((e) => e.type !== 'depends' && (!fAgent || e.from === fAgent) && (!fSkill || e.to === fSkill));
      if (!rows.length) console.log(t('link.noLinks'));
      for (const e of rows) console.log(`${e.from} → ${e.to}  (${e.type === 'declared' ? t('link.declaredInAgent') : 'registry.json'})`);
      break;
    }
    case 'categorize': {
      if (!rest[0]) fail(t('link.usageCategorize'), 2);
      const r = categorize(HUB_ROOT, rest[0], flags.clear ? [] : csv(rest[1]));
      console.log(`✔ ${r.message}`);
      break;
    }
    case 'capabilities': {
      if (!rest[0]) fail(t('link.usageCapabilities'), 2);
      const r = setItemCapabilities(HUB_ROOT, rest[0], flags.clear ? [] : csv(rest[1]));
      console.log(`✔ ${r.message}`);
      break;
    }
    case 'category': {
      const [action, id, value, keywords] = rest;
      let r;
      if (action === 'add') r = addCategory(HUB_ROOT, { id, label: value, keywords: keywords ?? '' });
      else if (action === 'rename') r = updateCategory(HUB_ROOT, id, { label: value });
      else if (action === 'keywords') r = updateCategory(HUB_ROOT, id, { keywords: value ?? '' });
      else if (action === 'remove') r = removeCategory(HUB_ROOT, id);
      else fail(t('link.usageCategory'), 2);
      console.log(`✔ ${r.message}`);
      break;
    }
    default:
      fail(t('link.unknownCommand'), 2);
  }
} catch (e) {
  fail(e.message, e.status === 404 || e.status === 400 ? 1 : 1);
}
