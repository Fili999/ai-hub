#!/usr/bin/env node
// Installs the hub's skills and agents into your AI tools (Claude Code, Codex, Antigravity CLI, OpenCode), on Mac, Windows and Linux.
//   node scripts/sync.mjs [--provider claude,codex,…] [--target <folder>] [--dry-run] [--mode auto|link|copy] [--instructions] [--force] [--no-prune] [--quiet]
//
// - Which tools: --provider, otherwise the ones enabled in settings.json (providers.*). --target <folder> uses the
//   Claude Code layout inside that folder (skills/, agents/, CLAUDE.md), for tests and custom setups.
// - Skills are linked (symlink, or junction on Windows) or copied one by one; agents are linked when the tool reads the
//   hub format, otherwise written in the tool's format (Codex TOML, Antigravity and OpenCode Markdown).
// - Only what the hub placed is ever replaced or removed; everything else in those folders is left alone.
// - Writes ai-hub.json in each tool's folder with the hub location: that is how the orchestrator skill finds the scripts.
// - --instructions (alias --claude-md) adds a managed block to CLAUDE.md / AGENTS.md / GEMINI.md telling the tool to use the orchestrator.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HUB_ROOT, copyDir, hashPath, isSafeName, parseArgs, readJson, rmrf, sha1, writeJson } from './lib/util.mjs';
import { INDEX_FILE, scanHub, writeIndex } from './lib/scan.mjs';
import { loadLock } from './lib/registry.mjs';
import { verifyEntry } from './lib/approval.mjs';
import { parseFrontmatter } from './lib/frontmatter.mjs';
import { convertAgent, loadProviders, providerPaths } from './lib/providers.mjs';
import { readSettings } from './lib/settings.mjs';
import { isInside } from './lib/safefs.mjs';
import { tFor } from './lib/i18n.mjs';

const t = tFor(HUB_ROOT);
const { flags } = parseArgs(process.argv.slice(2), { boolean: ['dry-run', 'force', 'quiet', 'claude-md', 'instructions', 'no-prune'] });
const mode = flags.mode && flags.mode !== true ? String(flags.mode) : 'auto';
if (!['auto', 'link', 'copy'].includes(mode)) {
  console.error(`✖ ${t('sync.badMode')}`);
  process.exit(2);
}
const dry = Boolean(flags['dry-run']);
const wantInstructions = Boolean(flags.instructions || flags['claude-md']);
const log = (...a) => {
  if (!flags.quiet) console.log(...a);
};

// ---- which tools, and where
const all = loadProviders(HUB_ROOT);
const settings = readSettings(HUB_ROOT);
let targets;
let disabled = []; // tools turned off in Settings: what the hub placed there is removed
if (flags.target && flags.target !== true) {
  const dir = path.resolve(String(flags.target));
  targets = [{ ...all.claude, id: 'claude', name: all.claude?.name ?? 'Claude Code', agentFormat: 'claude-md', paths: { home: dir, skillsDir: path.join(dir, 'skills'), agentsDir: path.join(dir, 'agents'), instructionsFile: path.join(dir, 'CLAUDE.md') } }];
} else {
  const ids = flags.provider && flags.provider !== true ? String(flags.provider).split(',').map((s) => s.trim()).filter(Boolean) : Object.keys(all).filter((id) => settings[`providers.${id}`]);
  const unknown = ids.filter((id) => !all[id]);
  if (unknown.length) {
    console.error(`✖ ${t('sync.unknownProvider', { ids: unknown.join(', '), known: Object.keys(all).join(', ') })}`);
    process.exit(2);
  }
  if (!ids.length) {
    console.error(`✖ ${t('sync.noProvider')}`);
    process.exit(2);
  }
  targets = ids.map((id) => ({ ...all[id], paths: providerPaths(all[id]) }));
  if (!flags.provider) disabled = Object.keys(all).filter((id) => !ids.includes(id)).map((id) => ({ ...all[id], paths: providerPaths(all[id]) }));
}

const index = writeIndex(HUB_ROOT, scanHub(HUB_ROOT));

const lstat = (p) => {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
};
const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};
const hubReal = real(HUB_ROOT);
const pointsIntoHub = (p) => {
  const r = real(p);
  return Boolean(r && hubReal && r.startsWith(hubReal + path.sep));
};

function removeManaged(dest) {
  const st = lstat(dest);
  if (!st) return;
  if (st.isSymbolicLink()) {
    try {
      fs.unlinkSync(dest);
    } catch {
      fs.rmdirSync(dest);
    }
  } else rmrf(dest);
}

function place(w) {
  fs.mkdirSync(path.dirname(w.dest), { recursive: true });
  if (w.content !== undefined) {
    fs.writeFileSync(w.dest, w.content);
    return 'generated';
  }
  const isDir = w.kind === 'skill';
  if (mode !== 'copy') {
    try {
      fs.symlinkSync(w.src, w.dest, isDir ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file');
      return 'link';
    } catch (err) {
      if (mode === 'link') throw err;
    }
  }
  if (isDir) copyDir(w.src, w.dest);
  else fs.copyFileSync(w.src, w.dest);
  return 'copy';
}

// ---- what is wanted (the same for every tool), minus what must not be activated
const items = [];
const skipped = [];
const lock = loadLock(HUB_ROOT);
const hashes = new Map();
for (const e of [...index.skills, ...index.agents]) {
  const entry = e.origin === 'external' ? lock.entries.find((x) => x.kind === e.kind && x.name === e.name) : null;
  if (entry && verifyEntry(HUB_ROOT, entry, hashes).status === 'hash-mismatch') {
    skipped.push(t('sync.skipHash', { id: e.id, name: e.name }));
    continue;
  }
  if (e.duplicate) {
    skipped.push(t('sync.skipDuplicate', { id: e.id }));
    continue;
  }
  if (!isSafeName(e.name)) {
    skipped.push(t('sync.skipName', { id: e.id }));
    continue;
  }
  items.push(e);
}

// ---- previous state of each tool (ai-hub.json in its folder)
const infoOf = (p) => path.join(p.paths.home, 'ai-hub.json');
const prevEntries = new Map(); // dest → previous entry (any tool)
for (const p of [...targets, ...disabled]) for (const e of readJson(infoOf(p), { entries: [] }).entries ?? []) prevEntries.set(e.dest, e);
// ai-hub.json lives in the tool's folder and is only data: an entry whose destination is outside the tool's own
// skills/agents folders (edited by hand, or damaged) must never lead to deleting or replacing that path.
const toolDirs = [...targets, ...disabled].flatMap((p) => [p.paths.skillsDir, p.paths.agentsDir]).filter(Boolean).map((d) => path.resolve(d));
const inToolDir = (dest) => typeof dest === 'string' && toolDirs.some((d) => isInside(d, path.resolve(dest)));
const isManaged = (dest) => inToolDir(dest) && (prevEntries.has(dest) || (lstat(dest)?.isSymbolicLink() && pointsIntoHub(dest)));

// ---- apply, tool by tool; a destination shared by several tools (~/.agents/skills) is handled once
const done = new Map(); // dest → entry
const counts = { link: 0, copy: 0, generated: 0, unchanged: 0 };
const perTool = [];
for (const p of targets) {
  const entries = [];
  for (const e of items) {
    const src = path.join(HUB_ROOT, e.path);
    let w;
    if (e.kind === 'skill') w = { kind: 'skill', name: e.name, src, dest: path.join(p.paths.skillsDir, e.name) };
    else {
      const text = fs.readFileSync(src, 'utf8');
      const { data, body } = parseFrontmatter(text);
      const conv = convertAgent(p, { name: e.name, data, body, text });
      w = { kind: 'agent', name: e.name, src, dest: path.join(p.paths.agentsDir, conv.file), ...(conv.generated ? { content: conv.content } : {}) };
    }
    if (done.has(w.dest)) {
      entries.push(done.get(w.dest));
      continue;
    }
    const st = lstat(w.dest);
    if (st && !isManaged(w.dest) && !flags.force) {
      skipped.push(t('sync.skipExists', { id: `${w.kind}:${w.name}`, dest: w.dest }));
      continue;
    }
    const old = prevEntries.get(w.dest);
    let result;
    let hash;
    if (w.content !== undefined) {
      hash = sha1(w.content);
      if (st && !st.isSymbolicLink() && old?.hash === hash) result = 'unchanged';
    } else if (st?.isSymbolicLink() && mode !== 'copy' && real(w.src) && real(w.dest) === real(w.src)) result = 'unchanged';
    else if (st && !st.isSymbolicLink() && old?.mode === 'copy' && mode !== 'link' && (hash = hashPath(w.src)) === old.hash) result = 'unchanged';
    let placed;
    if (result === 'unchanged') {
      counts.unchanged++;
      placed = old?.mode ?? (w.content !== undefined ? 'generated' : 'link');
    } else if (dry) {
      placed = w.content !== undefined ? 'generated' : mode === 'copy' ? 'copy' : 'link';
      counts[placed]++;
    } else {
      if (st) removeManaged(w.dest);
      placed = place(w);
      counts[placed]++;
    }
    const entry = { kind: w.kind, name: w.name, dest: w.dest, mode: placed, ...(placed === 'copy' ? { hash: hash ?? hashPath(w.src) } : placed === 'generated' ? { hash: hash ?? sha1(w.content) } : {}) };
    done.set(w.dest, entry);
    entries.push(entry);
  }
  perTool.push({ p, entries });
}

// ---- clean up what the hub placed before and no longer wants (never a destination another tool still uses)
const pruned = [];
if (!flags['no-prune']) {
  for (const old of prevEntries.values()) {
    if (done.has(old.dest)) continue;
    if (lstat(old.dest) && !inToolDir(old.dest)) {
      skipped.push(t('sync.skipOutside', { dest: String(old.dest) }));
      continue;
    }
    if (lstat(old.dest) && isManaged(old.dest)) {
      if (!dry) removeManaged(old.dest);
      pruned.push(`${old.kind}:${old.name}`);
    }
  }
}

if (!dry) {
  for (const p of disabled) if (fs.existsSync(infoOf(p))) fs.rmSync(infoOf(p), { force: true });
  for (const { p, entries } of perTool) {
    writeJson(infoOf(p), {
      version: 2,
      tool: p.id,
      root: HUB_ROOT,
      scripts: path.join(HUB_ROOT, 'scripts'),
      index: path.join(HUB_ROOT, INDEX_FILE),
      syncedAt: new Date().toISOString(),
      entries,
    });
  }
}

// ---- managed block in CLAUDE.md / AGENTS.md / GEMINI.md (optional)
if (wantInstructions) {
  const BEGIN = '<!-- ai-hub:begin -->';
  const END = '<!-- ai-hub:end -->';
  const selfRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const names = [`instructions-block.${t.lang}.md`, 'instructions-block.md'];
  const tpl = [HUB_ROOT, selfRoot].flatMap((r) => names.map((n) => path.join(r, 'templates', n))).find((f) => fs.existsSync(f));
  if (!tpl) {
    console.error(`✖ ${t('sync.noTemplate')}`);
    process.exit(1);
  }
  const block = fs.readFileSync(tpl, 'utf8').trim().replaceAll('{{HUB_ROOT}}', HUB_ROOT);
  for (const file of [...new Set(targets.map((p) => p.paths.instructionsFile))]) {
    let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const managed = `${BEGIN}\n${block}\n${END}`;
    const a = text.indexOf(BEGIN);
    const b = a === -1 ? -1 : text.indexOf(END, a);
    text = a !== -1 && b !== -1 ? text.slice(0, a) + managed + text.slice(b + END.length) : (text ? text.replace(/\s*$/, '\n\n') : '') + managed + '\n';
    if (!dry) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
    log(`✔ ${t(dry ? 'sync.instructionsDry' : 'sync.instructionsDone', { file })}`);
  }
}

for (const { p, entries } of perTool) {
  const nSkills = entries.filter((e) => e.kind === 'skill').length;
  const nAgents = entries.filter((e) => e.kind === 'agent').length;
  log(`${dry ? t('sync.dryPrefix') : ''}✔ ${t('sync.doneTool', { tool: p.name, skills: nSkills, agents: nAgents })}`);
}
log(`  ${t('sync.counts', counts)}`);
if (pruned.length) log(`  ${t('sync.pruned', { list: pruned.join(', ') })}`);
for (const s of skipped) log(`  ⚠ ${s}`);
if (counts.copy && !flags.quiet) log(`  ℹ ${t('sync.copyHint')}`);
if (!wantInstructions && !flags.quiet && ![...prevEntries.values()].length) log(`  ${t('sync.instructionsHint')}`);
