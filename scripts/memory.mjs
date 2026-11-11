#!/usr/bin/env node
// Hub memory: search, save and update notes (decisions, lessons, metrics) in memory/, openable with Obsidian.
//   node scripts/memory.mjs search "parole" [--type decision|lesson|metric] [--tag x] [--project x] [--limit 5] [--json]
//   node scripts/memory.mjs add --type lesson --title "…" --body "…" [--tags a,b] [--project x]
//   node scripts/memory.mjs append memory/lessons/<file>.md --body "…"
//   node scripts/memory.mjs list [--type …] [--json]
// Rejects text with secrets; never overwrites. With memory turned off in Settings exits with 3.
import { HUB_ROOT, parseArgs } from './lib/util.mjs';
import { readSettings } from './lib/settings.mjs';
import { MemoryError, TYPES, addNote, appendNote, readNotes, searchMemory } from './lib/memory.mjs';
import { tFor } from './lib/i18n.mjs';

const t = tFor(HUB_ROOT);
const { flags, positional } = parseArgs(process.argv.slice(2), { boolean: ['json'] });
const [cmd, ...rest] = positional;
const str = (v) => (v !== undefined && v !== true ? String(v) : undefined);
const out = (data, text) => console.log(flags.json ? JSON.stringify(data, null, 2) : text);

if (readSettings(HUB_ROOT)['memory.mode'] === 'off') {
  console.error(t('memory.disabledInSettings'));
  process.exit(3);
}

try {
  if (cmd === 'search' || cmd === 'list') {
    const { notes } = readNotes(HUB_ROOT);
    const opts = { type: str(flags.type), tag: str(flags.tag), project: str(flags.project), limit: Number(flags.limit) > 0 ? Number(flags.limit) : cmd === 'list' ? 1000 : 5 };
    const hits = searchMemory(notes, cmd === 'search' ? rest.join(' ') : '', opts);
    out(hits, hits.length ? hits.map((h) => `${TYPES[h.type].label} · ${h.date ?? ''} · ${h.title}${h.tags.length ? ` [${h.tags.join(', ')}]` : ''}\n  ${h.file}\n  ${h.excerpt}`).join('\n') : t('memory.noNotesFound'));
  } else if (cmd === 'add') {
    const file = addNote(HUB_ROOT, { type: str(flags.type), title: str(flags.title), body: str(flags.body), tags: str(flags.tags) ?? [], project: str(flags.project) });
    out({ ok: true, file }, t('memory.noteSaved', { file }));
  } else if (cmd === 'append') {
    const file = appendNote(HUB_ROOT, rest.join(' '), str(flags.body));
    out({ ok: true, file }, t('memory.noteUpdated', { file }));
  } else {
    console.error(t('memory.usage'));
    process.exit(2);
  }
} catch (e) {
  if (!(e instanceof MemoryError)) throw e;
  console.error(`✖ ${e.message}`);
  process.exit(2);
}
