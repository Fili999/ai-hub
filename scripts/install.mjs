#!/usr/bin/env node
// Installs, updates, and removes skills and agents from GitHub. Tracked in manifest.lock.json.
// Usage: see USAGE below (or --help).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HUB_ROOT, ask, confirm, copyDir, csv, hashPath, isInteractive, isSafeName, listFiles, parseArgs, readJson, rmrf, toPosix } from './lib/util.mjs';
import { analyzeRisk, ensureIndex, scanHub, writeIndex } from './lib/scan.mjs';
import { addLink, dropRefs, loadLock, loadRegistry, saveLock, saveRegistry, setCategories } from './lib/registry.mjs';
import { cloneSource, discoverItems, parseSource } from './lib/source.mjs';
import { refreshGuideSafe } from './lib/guide.mjs';
import { approvalRecord, packageHash, packagePath } from './lib/approval.mjs';
import { IntegrityError, Transaction, assertHash, snapshotItem } from './lib/integrity.mjs';
import { HubLockError, acquireHubLock } from './lib/hublock.mjs';
import { UnsafePathError, assertContained } from './lib/safefs.mjs';
import { describeScan, missingScannerHelp, resolveScanner, scanTarget, scannerVersion, securityPolicy, verdict } from './lib/spector.mjs';
import { tFor } from './lib/i18n.mjs';

const t = tFor(HUB_ROOT);
const USAGE = t('install.usage');

const { flags, positional } = parseArgs(process.argv.slice(2), {
  boolean: ['all', 'yes', 'dry-run', 'json', 'force', 'sync', 'update', 'remove', 'list', 'help', 'scan', 'package', 'approve'],
});
const root = HUB_ROOT;
const str = (v) => (v === undefined || v === true ? undefined : String(v));
const now = () => new Date().toISOString();

async function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-'));
  try {
    return await fn(dir);
  } finally {
    rmrf(dir);
  }
}

// who made the decision: UI passes --via=ui, CLI (or Claude after prompting) defaults to "cli"
const via = () => (flags.via === 'ui' ? 'ui' : 'cli');

// Full package limits: GitHub rejects files over 100 MB, and an overly large hub slows down syncing.
const PKG_MAX_FILE = 95 * 1024 * 1024;
const PKG_MAX_TOTAL = 300 * 1024 * 1024;

function packageSize(dir) {
  let total = 0;
  for (const rel of listFiles(dir, { maxFiles: 200000, maxDepth: 40 })) {
    const size = fs.statSync(path.join(dir, rel)).size;
    if (size > PKG_MAX_FILE) throw new Error(t('install.error.fileTooLarge', { file: rel, size: Math.round(size / 1048576) }));
    total += size;
  }
  if (total > PKG_MAX_TOTAL) throw new Error(t('install.error.pkgTooLarge', { size: Math.round(total / 1048576), max: PKG_MAX_TOTAL / 1048576 }));
  return total;
}

/** Package folder name: owner-repo (plus last part of --path), safe characters only. */
function packageDirName(src) {
  const parts = [src.repo.replace('/', '-'), src.subpath ? src.subpath.split('/').pop() : ''].filter(Boolean);
  const name = parts.join('-').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 79);
  if (!isSafeName(name)) throw new Error(t('install.error.invalidPkgName'));
  return name;
}

const destOf = (kind, name) =>
  kind === 'skill' ? path.join(root, 'skills', 'external', name) : path.join(root, 'agents', 'external', `${name}.md`);

// Names are compared without case: on macOS/Windows "Foo" and "foo" are the SAME folder, so installing one over the
// other would silently replace it (or remove it with --force) without the lock knowing.
const keyOf = (kind, name) => `${kind}:${String(name).toLowerCase()}`;

function riskOf(it) {
  return analyzeRisk(it.srcPath, { external: true, tools: it.tools, isAgent: it.kind === 'agent' });
}

// ---------------------------------------------------------------- SkillSpector
/**
 * Analyzes items according to settings.json policy. Returns {policy, version, results: Map(id → scan), blocked: [id]}.
 * With "block" and missing SkillSpector throws an error before writing anything.
 */
function securityGate(targets, { quiet = false, policy = securityPolicy(root) } = {}) {
  const results = new Map();
  const out = { policy, version: null, results, blocked: [], warned: [] };
  if (policy.mode === 'off' || !targets.length) return out;
  const say = (...a) => {
    if (!quiet) console.log(...a);
  };
  if (!policy.scanner) {
    if (policy.mode === 'block') throw new Error(missingScannerHelp());
    say(`⚠ ${missingScannerHelp()}`);
    for (const t of targets) out.warned.push(t.id);
    return out;
  }
  out.version = scannerVersion(policy.scanner);
  const modeTxt = policy.llm ? t('install.mode.ai') : t('install.mode.static');
  const verTxt = out.version ? ` ${out.version}` : '';
  say(t('install.gate.start', { version: verTxt, mode: modeTxt }));
  for (const t of targets) {
    const scan = scanTarget(policy.scanner, t.path, { llm: policy.llm });
    results.set(t.id, scan);
    const v = verdict(scan, policy.mode);
    if (v === 'block') out.blocked.push(t.id);
    if (v === 'warn') out.warned.push(t.id);
    say(`  ${v === 'pass' ? '✔' : v === 'warn' ? '⚠' : '✖'} ${t.id}: ${describeScan(scan)}`);
    if (v !== 'pass' && scan.ok) for (const i of scan.issues.slice(0, 3)) say(`      ${i.severity} ${i.id} ${i.pattern}${i.file ? ` — ${i.file}${i.line ? `:${i.line}` : ''}` : ''}`);
  }
  say(`  ℹ ${t('install.gate.notSandbox')}`);
  return out;
}

const securityRecord = (gate, id) => {
  const scan = gate.results.get(id);
  if (!scan?.ok) return undefined;
  return { scanner: 'skillspector', version: gate.version, score: scan.score, severity: scan.severity, recommendation: scan.recommendation, complete: scan.complete === true, issues: scan.issueCount, llm: scan.llm, scannedAt: now() };
};

function printItems(items, indent = '  ') {
  items.forEach((it, i) => {
    const r = it.risk ?? riskOf(it);
    const flagsTxt = r.flags.filter((f) => f !== 'external').join(', ');
    console.log(`${indent}${i + 1}. [${it.kind}] ${it.name} — ${t('install.print.risk', { risk: r.risk })}${flagsTxt ? ` (${flagsTxt})` : ''}${it.validName ? '' : t('install.print.invalidName')}`);
    if (it.description) console.log(`${indent}   ${it.description.slice(0, 150)}`);
    console.log(`${indent}   ${t('install.print.inRepo', { path: it.repoPath })}`);
  });
}

// ---------------------------------------------------------------- add
async function cmdAdd(input) {
  const src = parseSource(input, { ref: str(flags.ref), path: str(flags.path) });
  const dryRun = Boolean(flags['dry-run']);

  await withTmp(async (tmp) => {
    const repoDir = path.join(tmp, 'repo');
    const commit = cloneSource(src, repoDir);
    const expect = str(flags['expect-commit']);
    if (expect && !commit.startsWith(expect.toLowerCase())) {
      throw new Error(t('install.error.repoChanged', { commit: commit.slice(0, 7), expected: expect.slice(0, 7) }));
    }
    let items = discoverItems(repoDir, src.subpath, src.repo.split('/').pop());
    const kind = str(flags.kind);
    if (kind) items = items.filter((i) => i.kind === kind);
    if (!items.length) {
      throw new Error(t('install.error.noItemsFound'));
    }
    for (const it of items) it.risk = riskOf(it);

    if (dryRun) {
      const policy = securityPolicy(root);
      let gate = null;
      if (flags.scan) {
        // analysis explicitly requested: runs even with "off" policy (just to show the result)
        const scanPolicy = policy.mode === 'off' ? { ...policy, mode: 'warn', scanner: resolveScanner() } : policy;
        if (!scanPolicy.scanner) throw new Error(missingScannerHelp());
        const only = csv(flags.only);
        const targets = items.filter((i) => !only.length || only.includes(i.name)).map((i) => ({ id: `${i.kind}:${i.name}`, path: i.srcPath }));
        gate = securityGate(targets, { quiet: Boolean(flags.json), policy: scanPolicy });
        for (const it of items) {
          const scan = gate.results.get(`${it.kind}:${it.name}`);
          if (scan) it.spector = { ...scan, verdict: verdict(scan, scanPolicy.mode) };
        }
      }
      if (flags.json) {
        // compact: a repository with hundreds of skills still produces a response of a few hundred KB
        const security = { mode: policy.mode, available: Boolean(policy.scanner), llm: policy.llm, ...(gate ? { version: gate.version } : {}) };
        console.log(JSON.stringify({ source: { ...src, commit }, security, items: items.map(({ srcPath, ...rest }) => rest) }));
      } else {
        console.log(t('install.dryRun.header', { display: src.display, ref: src.ref ? `@${src.ref}` : '', commit: commit.slice(0, 7), count: items.length }));
        printItems(items);
        const modeLabel = policy.mode === 'block' ? t('install.mode.block') : t('install.mode.warn');
        if (!flags.scan && policy.mode !== 'off') console.log(t('install.dryRun.scannerNotice', { mode: modeLabel }));
        console.log(t('install.dryRun.noFilesWritten'));
      }
      return;
    }

    // --- selection
    const invalid = items.filter((i) => !i.validName);
    let chosen = items.filter((i) => i.validName);
    for (const it of invalid) console.log(`⚠ ${t('install.skippedInvalidName', { name: it.name })}`);

    const only = csv(flags.only);
    if (flags.package) {
      // the package is installed as a whole: to pick part of it use --path
      if (only.length) throw new Error(t('install.error.packageWhole'));
      if (chosen.length > 50) throw new Error(t('install.error.packageLimit', { count: chosen.length }));
    } else if (only.length) {
      const missing = only.filter((n) => !chosen.some((i) => i.name === n));
      if (missing.length) throw new Error(t('install.error.missingItems', { missing: missing.join(', '), available: chosen.map((i) => i.name).join(', ') }));
      chosen = chosen.filter((i) => only.includes(i.name));
    } else if (!flags.all && chosen.length > 1) {
      if (isInteractive()) {
        console.log(t('install.prompt.linkContains', { count: chosen.length }));
        printItems(chosen);
        const ans = await ask(t('install.prompt.whichToInstall'));
        if (ans.toLowerCase() !== 'a') {
          const nums = csv(ans).map(Number);
          chosen = chosen.filter((_, i) => nums.includes(i + 1));
        }
      } else {
        console.log(t('install.prompt.linkContains', { count: chosen.length }));
        printItems(chosen);
        throw new Error(t('install.error.indicateWhich'));
      }
    }
    if (!chosen.length) throw new Error(t('install.error.noneSelected'));
    const clash = chosen.find((it, i) => chosen.findIndex((x) => keyOf(x.kind, x.name) === keyOf(it.kind, it.name)) !== i);
    if (clash && !flags.package) throw new Error(t('install.error.duplicateClash', { name: clash.name }));

    // --- assignment and categories
    const index = ensureIndex(root);
    const config = readJson(path.join(root, 'hub.config.json'), { categories: {} });
    const validCats = Object.keys(config.categories ?? {});
    const hasSkills = chosen.some((i) => i.kind === 'skill');

    let to = csv(flags.to);
    if (!to.length && hasSkills && isInteractive() && !flags.yes) {
      const names = index.agents.map((a) => a.name);
      console.log(names.length ? t('install.prompt.agentsAvailable', { agents: names.join(', ') }) : t('install.prompt.noAgents'));
      to = csv(await ask(t('install.prompt.whereToAssign')));
    }
    to = to.filter((t) => t !== 'global').map((t) => t.replace(/^agent:/, ''));
    const knownAgents = new Set([...index.agents.map((a) => a.name), ...chosen.filter((i) => i.kind === 'agent').map((i) => i.name)]);
    const unknownAgents = to.filter((n) => !knownAgents.has(n));
    if (unknownAgents.length) throw new Error(t('install.error.unknownAgents', { unknown: unknownAgents.join(', '), available: [...knownAgents].join(', ') || '(none)' }));

    let cats = csv(flags.category);
    if (!cats.length && isInteractive() && !flags.yes) {
      cats = csv(await ask(t('install.prompt.categories', { valid: validCats.join(', ') })));
    }
    const badCats = cats.filter((c) => !validCats.includes(c));
    if (badCats.length) throw new Error(t('install.error.unknownCategories', { unknown: badCats.join(', '), valid: validCats.join(', ') }));

    // --- full package: destination and size
    const base = path.resolve(repoDir, src.subpath || '.');
    const pkgRel = flags.package ? toPosix(path.join('skills', 'external', packageDirName(src))) : null;
    if (pkgRel) {
      if (!fs.statSync(base).isDirectory()) throw new Error(t('install.error.packageNotFile'));
      const size = packageSize(base);
      console.log(t('install.log.fullPackage', { source: `${src.display}${src.subpath ? `/${src.subpath}` : ''}`, dest: pkgRel, size: (size / 1048576).toFixed(1) }));
    }
    // destination for each item: skills in a package remain in their folder inside the package
    const destFor = (it) => (pkgRel && it.kind === 'skill' ? path.join(root, pkgRel, path.relative(base, it.srcPath)) : destOf(it.kind, it.name));

    // --- collision checks (before writing anything)
    const lock = loadLock(root);
    const byId = new Map([...index.skills, ...index.agents].map((e) => [e.id.toLowerCase(), e]));
    if (pkgRel && fs.existsSync(path.join(root, pkgRel)) && !flags.force) throw new Error(t('install.error.packageExists', { path: pkgRel }));
    for (const it of chosen) {
      const id = `${it.kind}:${it.name}`;
      const dest = destFor(it);
      if (byId.get(id.toLowerCase())?.origin === 'own') throw new Error(t('install.error.existsOwn', { id }));
      const locked = lock.entries.find((e) => keyOf(e.kind, e.name) === keyOf(it.kind, it.name));
      if ((locked || fs.existsSync(dest)) && !flags.force) {
        const from = locked ? ` da ${locked.source.repo}` : '';
        throw new Error(t('install.error.alreadyInstalled', { id, from }));
      }
    }

    // --- immutable snapshot: the scanner, the hash, the approval and the installed copy all refer to the SAME bytes.
    // Whatever happens to the downloaded files from now on cannot reach the hub (see lib/integrity.mjs).
    const stage = path.join(tmp, 'stage');
    const pkgSnap = pkgRel ? snapshotItem(base, path.join(stage, 'pkg'), path.basename(base) || 'package') : null;
    const snapOf = new Map();
    const ownSnaps = []; // real snapshots (not views into the package one): each is re-verified after the scan
    chosen.forEach((it, i) => {
      // a skill inside a package is covered by the package snapshot (and its hash)
      if (pkgSnap && it.kind === 'skill') snapOf.set(it, { path: path.join(pkgSnap.path, path.relative(base, it.srcPath)), hash: pkgSnap.hash });
      else {
        const snap = snapshotItem(it.srcPath, path.join(stage, `i${i}`));
        snapOf.set(it, snap);
        ownSnaps.push(snap);
      }
    });

    // --- security analysis (before writing anything), on the snapshot. A full package is scanned as a whole too:
    // its shared files (outside the skill folders) are installed and approved with it.
    const targets = chosen.map((it) => ({ id: `${it.kind}:${it.name}`, path: snapOf.get(it).path }));
    if (pkgSnap) targets.push({ id: `package:${pkgRel}`, path: pkgSnap.path });
    const gate = securityGate(targets);
    if (gate.blocked.length) {
      throw new Error(t('install.error.gateBlocked', { blocked: gate.blocked.join(', ') }));
    }
    // the content that was scanned must still be exactly the content that was hashed
    for (const snap of [pkgSnap, ...ownSnaps].filter(Boolean)) assertHash(snap.path, snap.hash, snap.path);

    // --- writing (installing after viewing preview and analysis is user decision: recorded as approval).
    // Everything below is one transaction: the old version is moved aside, the new one is verified before and after
    // being renamed into place, and any failure restores the previous state.
    const reg = loadRegistry(root);
    const tx = new Transaction(root);
    try {
      // items replaced with --force: move old copies aside first (and packages left empty)
      const replaced = lock.entries.filter((e) => chosen.some((it) => keyOf(it.kind, it.name) === keyOf(e.kind, e.name)));
      for (const e of replaced) removeEntryFiles(e, lock.entries.filter((x) => !replaced.includes(x)), tx);
      if (pkgSnap) tx.place(pkgSnap.path, path.join(root, pkgRel), pkgSnap.hash);
      for (const it of chosen) {
        const id = `${it.kind}:${it.name}`;
        const dest = destFor(it);
        const snap = snapOf.get(it);
        const inPackage = Boolean(pkgRel && it.kind === 'skill');
        if (!inPackage) tx.place(snap.path, dest, snap.hash);
        const rel = toPosix(path.relative(root, dest));
        const hash = snap.hash; // verified equal to the installed copy by tx.place()

        lock.entries = lock.entries.filter((e) => keyOf(e.kind, e.name) !== keyOf(it.kind, it.name));
        lock.entries.push({
          kind: it.kind,
          name: it.name,
          path: rel,
          source: { type: src.type, url: src.type === 'local' ? src.display : src.url, repo: src.repo, ref: src.ref, subpath: it.repoPath, commit },
          installedAt: now(),
          updatedAt: now(),
          contentHash: hashPath(dest),
          package: inPackage ? { path: pkgRel, hash, sourcePath: src.subpath || '.' } : { path: rel, hash },
          approval: approvalRecord(hash, { via: via() }),
          ...(securityRecord(gate, id) ? { security: securityRecord(gate, id) } : {}),
        });
        if (it.kind === 'skill') for (const a of to) addLink(reg, `agent:${a}`, id);
        if (cats.length) setCategories(reg, id, cats);
      }
      saveRegistry(root, reg);
      saveLock(root, lock);
      tx.commit();
    } catch (e) {
      tx.rollback();
      throw e;
    } finally {
      tx.dispose();
    }
    const idx = writeIndex(root, scanHub(root));
    refreshGuideSafe(root);

    // --- outcome
    console.log(`✔ ${t('install.log.installedCount', { count: chosen.length, display: src.display, ref: src.ref ? `@${src.ref}` : '', commit: commit.slice(0, 7) })}`);
    for (const it of chosen) {
      const r = idx.skills.concat(idx.agents).find((e) => e.id === `${it.kind}:${it.name}`);
      const where = it.kind === 'skill' ? (to.length ? t('install.where.assignedTo', { agents: to.join(', ') }) : t('install.where.generic')) : t('install.where.agent');
      const risk = r && r.risk !== 'low' ? ` — ${t('install.print.risk', { risk: r.risk })} (${r.flags.filter((f) => f !== 'external').join(', ')})` : '';
      console.log(`  • ${it.kind}:${it.name} → ${toPosix(path.relative(root, destFor(it)))}  [${where}]${risk}`);
      // provenance: where it came from, which exact commit, and the hash the approval is tied to
      const rec = lock.entries.find((e) => e.kind === it.kind && e.name === it.name);
      if (rec) console.log(`      ${t('install.log.provenance', { repo: `${rec.source.repo}${rec.source.subpath && rec.source.subpath !== '.' ? `/${rec.source.subpath}` : ''}`, commit: rec.source.commit, hash: rec.approval.hash })}`);
    }
    const names = new Set(chosen.map((i) => `${i.kind}:${i.name}`));
    for (const w of idx.warnings.filter((x) => x.level !== 'info' && (!x.id || names.has(x.id)))) console.log(`  ⚠ ${w.message}`);
    if (chosen.some((i) => i.kind === 'agent')) console.log(`  ℹ ${t('install.hint.linkAgent')}`);
    if (chosen.some((i) => riskOf(i).risk !== 'low')) console.log(`  ⚠ ${t('install.hint.riskyContent')}`);
  });

  if (dryRun) return;
  if (flags.sync) {
    spawnSync(process.execPath, [path.join(root, 'scripts', 'sync.mjs')], { stdio: 'inherit' });
  } else {
    console.log(t('install.hint.sync'));
  }
}

/**
 * Resolves a path taken from the lock file and checks that it is inside skills/external or agents/external with no
 * symlink/junction on the way (the lock file comes from GitHub, so it is untrusted input).
 */
function externalTarget(rel) {
  for (const base of ['skills/external', 'agents/external']) {
    try {
      return assertContained(root, base, path.resolve(root, rel), { t });
    } catch (e) {
      if (!(e instanceof UnsafePathError)) throw e;
    }
  }
  throw new Error(t('install.error.lockPathNotAllowed', { path: rel }));
}

/**
 * Removes files for a lock entry. For a skill in a package, the package is removed only if no other entry
 * (among `others`) still uses it. Only writes inside skills/external and agents/external.
 * With a Transaction the files are moved aside (restorable) instead of deleted.
 */
function removeEntryFiles(e, others, tx = null) {
  const pkg = e.package?.sourcePath !== undefined ? e.package.path : null;
  const target = externalTarget(pkg ?? e.path);
  if (pkg && others.some((o) => o.package?.path === pkg)) return;
  if (tx) tx.removeAside(target);
  else rmrf(target);
}

// ---------------------------------------------------------------- list
function cmdList() {
  const lock = loadLock(root);
  if (!lock.entries.length) return console.log(t('install.list.empty'));
  for (const e of lock.entries) {
    const s = e.source;
    const installed = t('install.list.installedOn', { date: e.installedAt.slice(0, 10) });
    console.log(`${e.kind.padEnd(5)} ${e.name}  ←  ${s.repo}${s.ref ? `@${s.ref}` : ''} ${s.commit.slice(0, 7)}  (${s.subpath})  ${installed}`);
  }
}

// ---------------------------------------------------------------- update
const isPackaged = (e) => e.package?.sourcePath !== undefined;

/** Unit to update/approve/remove: full package (with all its entries) or single entry. */
function units(entries, all) {
  const out = [];
  const seen = new Set();
  for (const e of entries) {
    if (isPackaged(e)) {
      if (seen.has(e.package.path)) continue;
      seen.add(e.package.path);
      out.push({ pkg: e.package.path, members: all.filter((x) => isPackaged(x) && x.package.path === e.package.path) });
    } else out.push({ pkg: null, members: [e] });
  }
  return out;
}
const unitLabel = (u) => (u.pkg ? t('install.unit.package', { pkg: u.pkg, members: u.members.map((m) => `${m.kind}:${m.name}`).join(', ') }) : `${u.members[0].kind}:${u.members[0].name}`);

async function cmdUpdate() {
  const lock = loadLock(root);
  const wanted = positional;
  const entries = lock.entries.filter((e) => !wanted.length || wanted.includes(e.name));
  if (!entries.length) return console.log(wanted.length ? t('install.update.noneWithName') : t('install.update.nothingToUpdate'));

  await withTmp(async (tmp) => {
    const cache = new Map();
    let n = 0;
    let updated = 0;
    let failed = 0;
    for (const u of units(entries, lock.entries)) {
      const first = u.members[0];
      const label = unitLabel(u);
      const key = `${first.source.url}|${first.source.ref ?? ''}`;
      try {
        if (!cache.has(key)) {
          const src = parseSource(first.source.url, { ref: first.source.ref ?? undefined });
          const dir = path.join(tmp, `r${n++}`);
          cache.set(key, { dir, commit: cloneSource(src, dir) });
        }
        const { dir, commit } = cache.get(key);
        const sub = (x) => path.join(dir, x === '.' ? '' : x);
        const from = u.pkg ? sub(first.package.sourcePath) : sub(first.source.subpath);
        const missing = u.members.filter((m) => !fs.existsSync(sub(m.source.subpath)));
        if (!fs.existsSync(from) || missing.length) {
          const missingStr = missing.length ? t('install.update.missingItem', { names: missing.map((m) => m.name).join(', ') }) : t('install.update.missingPackage');
          console.log(`⚠ ${label}: ${t('install.update.missingInSource', { missing: missingStr, repo: first.source.repo })}`);
          continue;
        }
        if (commit === first.source.commit) {
          console.log(`= ${label}: ${t('install.update.alreadyUpdated', { commit: commit.slice(0, 7) })}`);
          continue;
        }
        const target = path.join(root, u.pkg ?? first.path);
        const touched = u.pkg
          ? first.approval?.hash && fs.existsSync(target) && packageHash(target) !== first.approval.hash
          : fs.existsSync(target) && first.contentHash && hashPath(target) !== first.contentHash;
        if (touched && !flags.force) {
          console.log(`⚠ ${label}: ${t('install.update.modifiedLocally')}`);
          continue;
        }
        if (u.pkg) packageSize(from);
        // immutable snapshot of the new version: it is what gets scanned, hashed, approved and installed
        const snap = snapshotItem(from, path.join(tmp, `s${n++}`));
        const memberPath = (m) => {
          const rel = path.relative(from, sub(m.source.subpath));
          return rel.startsWith('..') || path.isAbsolute(rel) ? sub(m.source.subpath) : path.join(snap.path, rel);
        };
        const targets = u.members.map((m) => ({ id: `${m.kind}:${m.name}`, path: memberPath(m) }));
        if (u.pkg) targets.push({ id: `package:${u.pkg}`, path: snap.path });
        // new version passes through SkillSpector before replacing installed version
        const gate = securityGate(targets);
        if (gate.blocked.length) {
          console.log(`✖ ${label}: ${t('install.update.blockedByScanner', { commit: first.source.commit.slice(0, 7) })}`);
          failed++;
          continue;
        }
        assertHash(snap.path, snap.hash, label); // the scan must not have changed what was scanned
        const hash = snap.hash;
        const before = first.source.commit.slice(0, 7);
        const saved = structuredClone(u.members);
        const tx = new Transaction(root);
        try {
          tx.place(snap.path, target, hash);
          for (const m of u.members) {
            const id = `${m.kind}:${m.name}`;
            if (securityRecord(gate, id)) m.security = securityRecord(gate, id);
            m.source.commit = commit;
            m.updatedAt = now();
            m.contentHash = hashPath(path.join(root, m.path));
            m.package = u.pkg ? { ...m.package, hash } : { path: m.path, hash };
            // updating after analysis is user decision: approval moves to new version
            m.approval = approvalRecord(hash, { via: via() });
          }
          saveLock(root, lock); // saved per unit: a crash later cannot leave files and lock out of step
          tx.commit();
        } catch (e) {
          tx.rollback();
          u.members.forEach((m, i) => {
            for (const k of Object.keys(m)) delete m[k];
            Object.assign(m, saved[i]);
          });
          throw e;
        } finally {
          tx.dispose();
        }
        updated++;
        const r = analyzeRisk(target, { external: true, isAgent: first.kind === 'agent' && !u.pkg });
        console.log(`✔ ${label}: ${before} → ${commit.slice(0, 7)}${r.risk !== 'low' ? `  ⚠ ${t('install.print.risk', { risk: r.risk })} (${r.flags.filter((f) => f !== 'external').join(', ')})` : ''}`);
      } catch (err) {
        console.log(`✖ ${label}: ${err.message}`);
        failed++;
      }
    }
    saveLock(root, lock);
    if (failed) process.exitCode = 1;
    if (updated) {
      writeIndex(root, scanHub(root));
      refreshGuideSafe(root);
      console.log(t('install.update.checkDiff'));
    }
  });
  if (flags.sync) spawnSync(process.execPath, [path.join(root, 'scripts', 'sync.mjs')], { stdio: 'inherit' });
}

/** Lock entries picked by name (with --kind if ambiguous). */
function pickEntries(lock, names) {
  const kind = str(flags.kind);
  return names.map((name) => {
    const hits = lock.entries.filter((e) => e.name === name && (!kind || e.kind === kind));
    if (!hits.length) throw new Error(t('install.error.notInLock', { name }));
    if (hits.length > 1) throw new Error(t('install.error.ambiguousKind', { name }));
    return hits[0];
  });
}

// ---------------------------------------------------------------- approve
// Analyzes installed version with SkillSpector and records approval linked to its hash. Used for items
// with review pending (installed before approvals). Full package is approved together.
async function cmdApprove() {
  if (!positional.length) throw new Error(t('install.approve.usage'));
  const lock = loadLock(root);
  let failed = 0;
  await withTmp(async (tmp) => {
    let n = 0;
    for (const u of units(pickEntries(lock, positional), lock.entries)) {
      const label = unitLabel(u);
      const target = path.join(root, u.pkg ?? u.members[0].path);
      if (!fs.existsSync(target)) {
        console.log(`✖ ${label}: ${t('install.approve.missing', { path: toPosix(path.relative(root, target)) })}`);
        failed++;
        continue;
      }
      try {
        // hash BEFORE the scan, scan a private snapshot of exactly those bytes, hash AGAIN afterwards: the approval is
        // recorded only if the installed content never changed in between.
        const hash = packageHash(target);
        const snap = snapshotItem(target, path.join(tmp, `a${n++}`));
        if (snap.hash !== hash) throw new IntegrityError(t('integrity.changed', { what: label, expected: hash.slice(0, 19), actual: snap.hash.slice(0, 19) }));
        const targets = u.members.map((m) => ({ id: `${m.kind}:${m.name}`, path: path.join(snap.path, path.relative(target, path.join(root, m.path))) }));
        if (u.pkg) targets.push({ id: `package:${u.pkg}`, path: snap.path });
        const gate = securityGate(targets);
        if (gate.blocked.length) {
          console.log(`✖ ${label}: ${t('install.approve.blocked')}`);
          failed++;
          continue;
        }
        assertHash(snap.path, hash, label);
        assertHash(target, hash, label);
        for (const m of u.members) {
          const id = `${m.kind}:${m.name}`;
          if (securityRecord(gate, id)) m.security = securityRecord(gate, id);
          m.package = u.pkg ? { ...m.package, hash } : { path: m.path, hash };
          m.approval = approvalRecord(hash, { via: via() });
        }
        console.log(`✔ ${label}: ${t('install.approve.approved', { hash: hash.slice(0, 19) })}`);
      } catch (err) {
        if (!(err instanceof IntegrityError)) throw err;
        console.log(`✖ ${label}: ${err.message}`);
        failed++;
      }
    }
  });
  saveLock(root, lock);
  writeIndex(root, scanHub(root));
  if (failed) process.exitCode = 1;
}

// ---------------------------------------------------------------- remove
async function cmdRemove() {
  if (!positional.length) throw new Error(t('install.remove.usage'));
  const lock = loadLock(root);
  // a skill belonging to a package cannot be removed alone (would alter approved package): remove full package
  const targets = units(pickEntries(lock, positional), lock.entries).flatMap((u) => u.members);
  for (const e of targets) externalTarget(e.package?.sourcePath !== undefined ? e.package.path : e.path);
  const list = targets.map((t) => `${t.kind}:${t.name}`).join(', ');
  if (!flags.yes) {
    if (!isInteractive()) throw new Error(t('install.remove.confirmHelp', { list }));
    if (!(await confirm(t('install.remove.confirm', { list })))) return console.log(t('install.remove.cancelled'));
  }
  if (targets.length > positional.length) console.log(`ℹ ${t('install.remove.packageNotice', { list })}`);
  const reg = loadRegistry(root);
  const remaining = lock.entries.filter((x) => !targets.includes(x));
  for (const e of targets) {
    removeEntryFiles(e, remaining);
    dropRefs(reg, `${e.kind}:${e.name}`);
    console.log(`✔ ${t('install.remove.removed', { id: `${e.kind}:${e.name}` })}`);
  }
  lock.entries = remaining;
  saveLock(root, lock);
  saveRegistry(root, reg);
  writeIndex(root, scanHub(root));
  refreshGuideSafe(root);
  console.log(t('install.remove.nextSyncHint'));
}

// ---------------------------------------------------------------- main
// Anything that changes what is installed holds the hub lock, so two runs (terminal + web interface) cannot interleave.
const mutating = flags.remove || flags.update || flags.approve || Boolean(positional[0] && !flags.list && !flags.help && !flags['dry-run']);
let release = () => {};
try {
  if (mutating) release = acquireHubLock(root, flags.remove ? 'remove' : flags.update ? 'update' : flags.approve ? 'approve' : 'add');
  if (flags.help) console.log(USAGE);
  else if (flags.list) cmdList();
  else if (flags.remove) await cmdRemove();
  else if (flags.update) await cmdUpdate();
  else if (flags.approve) await cmdApprove();
  else if (!positional[0]) {
    console.log(USAGE);
    release();
    process.exit(2);
  } else await cmdAdd(positional[0]);
  release();
} catch (e) {
  release();
  console.error(`✖ ${e.message}`);
  process.exit(1);
}
