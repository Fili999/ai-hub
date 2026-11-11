#!/usr/bin/env node
// Pre-flight check: tools, dependencies, duplicates, conflicts, integrity of installed files.
//   node scripts/doctor.mjs [name ...] [--json] [--strict]
// Without arguments checks the entire hub; with names checks those skills/agents (and their dependencies).
import fs from 'node:fs';
import path from 'node:path';
import { HUB_ROOT, commandExists, hashPath, parseArgs, readJson } from './lib/util.mjs';
import { ensureIndex } from './lib/scan.mjs';
import { settingsProblems } from './lib/settings.mjs';
import { PROVIDERS_FILE, providerProblems } from './lib/providers.mjs';
import { readNotes } from './lib/memory.mjs';
import { teamProblems } from './lib/teams.mjs';
import { verifyEntry } from './lib/approval.mjs';
import { tFor } from './lib/i18n.mjs';

const t = tFor(HUB_ROOT);
const { flags, positional } = parseArgs(process.argv.slice(2), { boolean: ['json', 'strict'] });
const index = ensureIndex(HUB_ROOT);
const lock = readJson(path.join(HUB_ROOT, 'manifest.lock.json'), { entries: [] });
const all = [...index.skills, ...index.agents];
const byId = new Map(all.map((e) => [e.id, e]));

const problems = []; // {level, message}
const add = (level, message) => problems.push({ level, message });

// ---- target selection (with dependency closure) ----
let targets = all;
if (positional.length) {
  const picked = new Set();
  const visit = (id) => {
    if (picked.has(id) || !byId.has(id)) return;
    picked.add(id);
    byId.get(id).dependsOn.forEach(visit);
  };
  for (const n of positional) {
    const id = /^(skill|agent):/.test(n) ? n : byId.has(`skill:${n}`) ? `skill:${n}` : `agent:${n}`;
    if (!byId.has(id)) add('error', t('doctor.notInCatalog', { name: n }));
    else visit(id);
  }
  targets = [...picked].map((id) => byId.get(id));
}
const targetIds = new Set(targets.map((t) => t.id));

// ---- inventory warnings relevant to targets ----
for (const w of index.warnings) {
  if (w.level === 'info') continue;
  if (positional.length && w.id && !targetIds.has(w.id)) continue;
  add(w.level, w.message);
}

// ---- required tools ----
// missing program reported once with skills needing it (not repeated per skill)
const missing = new Map();
for (const tItem of targets) for (const cmd of tItem.requires.commands) if (!commandExists(cmd)) missing.set(cmd, [...(missing.get(cmd) ?? []), tItem.id]);
for (const [cmd, ids] of missing) add('error', t('doctor.missingCommand', { cmd, ids: ids.join(', ') }));
for (const tItem of targets) {
  if (tItem.requires.mcp.length) add('info', t('doctor.mcpRequired', { id: tItem.id, mcp: tItem.requires.mcp.join(', ') }));
  if (tItem.risk !== 'low') add(tItem.risk === 'high' ? 'warn' : 'info', t('doctor.riskNote', { id: tItem.id, risk: tItem.risk, flags: tItem.flags.join(', ') }));
}

// ---- external files integrity (global check only) ----
if (!positional.length) {
  const hashes = new Map();
  for (const e of lock.entries ?? []) {
    const p = path.join(HUB_ROOT, e.path);
    if (!fs.existsSync(p)) {
      add('error', t('doctor.lockMissingOnDisk', { kind: e.kind, name: e.name, path: e.path }));
      continue;
    }
    const v = verifyEntry(HUB_ROOT, e, hashes);
    if (v.status === 'hash-mismatch') add('error', t('doctor.hashMismatchReapprove', { kind: e.kind, name: e.name, reason: v.reason }));
    else if (v.status === 'review-pending') add('warn', t('doctor.reviewPending', { kind: e.kind, name: e.name }));
    else if (!e.approval && e.contentHash && hashPath(p) !== e.contentHash) add('info', t('doctor.modifiedLocally', { kind: e.kind, name: e.name }));
  }
  for (const m of settingsProblems(HUB_ROOT)) add('warn', m);
  if (fs.existsSync(path.join(HUB_ROOT, PROVIDERS_FILE))) for (const m of providerProblems(readJson(path.join(HUB_ROOT, PROVIDERS_FILE), {}))) add('warn', m);
  for (const p of readNotes(HUB_ROOT).problems) add(p.level, p.message);
  for (const p of teamProblems(HUB_ROOT, index)) add(p.level, p.message);
  const locked = new Set((lock.entries ?? []).map((e) => `${e.kind}:${e.name}`));
  for (const e of all) {
    if (e.origin === 'external' && !locked.has(e.id)) add('warn', t('doctor.externalNotInLock', { id: e.id }));
  }
}

const errors = problems.filter((p) => p.level === 'error').length;
const warns = problems.filter((p) => p.level === 'warn').length;

if (flags.json) {
  console.log(JSON.stringify({ ok: errors === 0 && (!flags.strict || warns === 0), checked: targets.map((tItem) => tItem.id), problems }, null, 2));
} else {
  console.log(t('doctor.checkedItems', { count: targets.length }));
  const icon = { error: '✖', warn: '⚠', info: 'ℹ' };
  for (const p of problems) console.log(`${icon[p.level]} ${p.message}`);
  console.log(errors || warns ? t('doctor.summaryProblems', { errors, warns }) : t('doctor.allGood'));
}
process.exit(errors > 0 || (flags.strict && warns > 0) ? 1 : 0);
