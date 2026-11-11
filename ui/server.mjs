#!/usr/bin/env node
// Local web interface for the hub. Zero dependencies: Node built-in modules only.
//   node ui/server.mjs [--port 4173] [--no-open] [--allow-local]
//
// Security (the server can modify files on your computer, so it is not a plain static site):
//  - listens ONLY on 127.0.0.1 (never across the network);
//  - verifies Host header (against DNS rebinding);
//  - every /api request requires a session token, generated on each launch and delivered only to the page;
//  - state changes (POST) also require Origin identical to the server and JSON Content-Type (against CSRF);
//  - no shell execution: hub scripts are invoked with validated arguments;
//  - local folders as installation sources are rejected (except --allow-local, used in tests);
//  - creation wizard (/api/create*) writes only new files in skills/own and agents/own, never overwrites;
//  - GitHub sync uses only git with fixed arguments, pulls only if fast-forward,
//    never forces, and pushes only with explicit confirmation in the request;
//  - settings accept only keys and values declared in scripts/lib/settings.mjs.
import { DEFAULT_LANGUAGE, hubLanguage, messages, tFor } from '../scripts/lib/i18n.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HUB_ROOT, commandExists, isSafeName, parseArgs, readJson } from '../scripts/lib/util.mjs';
import { ensureIndex, fingerprint } from '../scripts/lib/scan.mjs';
import { searchIndex } from '../scripts/lib/search.mjs';
import { HubError, addCategory, categorize, linkAdd, linkRemove, removeCategory, updateCategory } from '../scripts/lib/ops.mjs';
import { DEFAULT_ROLES, LIMITS as TEAM_LIMITS, TeamError, deleteTeam, loadTeams, saveTeam, suggestMembers, teamProblems } from '../scripts/lib/teams.mjs';
import { parseSource } from '../scripts/lib/source.mjs';
import { refreshGuideSafe, renderGuide } from '../scripts/lib/guide.mjs';
import { checkAll, installPlan, loadDependencies, missingSkillCommands } from '../scripts/lib/deps.mjs';
import { availableManagers, machineInfo } from '../scripts/lib/machine.mjs';
import { loadLock, loadRegistry } from '../scripts/lib/registry.mjs';
import { readAllUsage, updateMachineUsage, usageReport } from '../scripts/lib/usage.mjs';
import { pullUpdates, pushChanges, repoStatus } from '../scripts/lib/repo.mjs';
import { buildTree, treeText } from '../scripts/lib/tree.mjs';
import { BODY_MAX, createItem, createOptions, previewItem } from '../scripts/lib/create.mjs';
import { checkPatch, readSettings, settingsView, writeSettings } from '../scripts/lib/settings.mjs';
import { resolveScanner, scannerVersion } from '../scripts/lib/spector.mjs';
import { verifyEntry } from '../scripts/lib/approval.mjs';

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(UI_DIR, 'public');
const SCRIPTS = path.join(UI_DIR, '..', 'scripts');
const MAX_BODY = 256 * 1024;
const MAX_OUTPUT = 200 * 1024;
// preview of a repo with hundreds of skills is JSON of several hundred KB: do not truncate
const MAX_PREVIEW_OUTPUT = 32 * 1024 * 1024;
const MAX_SCAN_ITEMS = 20;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const REF_RE = /^[\w./@+-]{1,100}$/;
const SUBPATH_RE = /^[\w.@ +/-]{1,200}$/;
const SHA_RE = /^[0-9a-f]{7,64}$/i;
const REF_ITEM_RE = /^(?:(?:skill|agent):)?[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

const trMain = tFor(HUB_ROOT); // messages printed when the file is run directly

export async function startServer({ root = HUB_ROOT, port = 4173, strictPort = false, allowLocal = false, open = false, quiet = false, idleExitMs = 0, onIdle = null } = {}) {
  const tr = tFor(root); // the hub language is re-read on every message
  const token = crypto.randomBytes(24).toString('base64url');
  let hosts = new Set();
  let origins = new Set();
  const clients = new Set();
  const cache = new Map();

  // ---------------------------------------------------------------- utilities
  const watchKey = () => {
    const extra = ['dependencies.json', 'docs/guide.md', 'package.json', 'settings.json', 'teams.json', 'hub.config.json']
      .map((f) => {
        try {
          const st = fs.statSync(path.join(root, f));
          return `${f}:${st.size}:${Math.round(st.mtimeMs)}`;
        } catch {
          return `${f}:-`;
        }
      })
      .join('|');
    return `${fingerprint(root)}|${extra}`;
  };

  const cached = (name, ttlMs, compute, { force = false } = {}) => {
    const key = watchKey();
    const hit = cache.get(name);
    if (!force && hit && hit.key === key && Date.now() - hit.at < ttlMs) return hit.value;
    const value = compute();
    cache.set(name, { key, at: Date.now(), value });
    return value;
  };

  let chain = Promise.resolve();
  const exclusive = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };

  function runScript(script, args, { timeout = 150000, maxOutput = MAX_OUTPUT } = {}) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(SCRIPTS, script), ...args], {
        cwd: root,
        env: { ...process.env, AI_HUB_ROOT: root, NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let out = '';
      let err = '';
      const cap = (s) => (s.length > maxOutput ? s.slice(0, maxOutput) + '\n…(output truncated)' : s);
      child.stdout.on('data', (d) => (out = cap(out + d)));
      child.stderr.on('data', (d) => (err = cap(err + d)));
      const timer = setTimeout(() => {
        err += '\nTimed out: operation aborted.';
        child.kill();
      }, timeout);
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ code: 1, out, err: err + e.message });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, out: out.trim(), err: err.trim() });
      });
    });
  }

  const combine = (r) => [r.out, r.err].filter(Boolean).join('\n');
  const parseInstaller = (r) => {
    try {
      return JSON.parse(r.out);
    } catch {
      throw new HubError(`Installer response unreadable: ${(r.err || r.out).slice(-300)}`, 502);
    }
  };

  // ---------------------------------------------------------------- SSE
  let lastKey = watchKey();
  const broadcast = (event, data) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(msg);
  };
  const tick = () => {
    let key;
    try {
      key = watchKey();
    } catch {
      return;
    }
    if (key !== lastKey) {
      lastKey = key;
      broadcast('change', { at: new Date().toISOString() });
    }
  };
  const poller = setInterval(tick, 1500);
  poller.unref();
  const keepAlive = setInterval(() => {
    for (const c of clients) c.write(': ping\n\n');
  }, 25000);
  keepAlive.unref();

  // ---------------------------------------------------------------- validation
  const str = (v, name, { max = 300, optional = false } = {}) => {
    if (v === undefined || v === null || v === '') {
      if (optional) return undefined;
      throw new HubError(`Missing field "${name}".`);
    }
    if (typeof v !== 'string' || v.length > max) throw new HubError(`Invalid field "${name}".`);
    return v;
  };
  const list = (v, name, test, { max = 50 } = {}) => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.length > max || v.some((x) => typeof x !== 'string' || !test(x))) throw new HubError(`Invalid field "${name}".`);
    return v;
  };

  function sourceArgs(body) {
    const source = str(body.source, 'source');
    const ref = str(body.ref, 'ref', { optional: true, max: 100 });
    const subpath = str(body.path, 'path', { optional: true, max: 200 });
    const kind = str(body.kind, 'kind', { optional: true, max: 10 });
    if (ref && !REF_RE.test(ref)) throw new HubError(tr('server.badRef'));
    if (subpath && (!SUBPATH_RE.test(subpath) || subpath.startsWith('-'))) throw new HubError(tr('server.badPath'));
    if (kind && !['skill', 'agent'].includes(kind)) throw new HubError(tr('server.badKind'));
    let parsed;
    try {
      parsed = parseSource(source, { ref, path: subpath });
    } catch (e) {
      throw new HubError(e.message);
    }
    if (parsed.type === 'local' && !allowLocal) throw new HubError('The web interface installs from GitHub links only (use local folders from the terminal).');
    // Values are passed in --key=value form: they cannot be confused with other flags.
    return [source, ...(ref ? [`--ref=${ref}`] : []), ...(subpath ? [`--path=${subpath}`] : []), ...(kind ? [`--kind=${kind}`] : [])];
  }

  // ---------------------------------------------------------------- API
  const api = {
    'GET /api/health': () => ({ ok: true, name: 'ai-hub-ui' }),

    'GET /api/state': () => {
      const index = ensureIndex(root);
      const config = readJson(path.join(root, 'hub.config.json'), { categories: {} });
      const lock = loadLock(root);
      return {
        fingerprint: index.fingerprint,
        // also changes when dependencies.json, the guide, or package.json change (reloads Guide and System tabs)
        watch: crypto.createHash('sha1').update(watchKey()).digest('hex'),
        generatedAt: index.generatedAt,
        stats: index.stats,
        skills: index.skills,
        agents: index.agents,
        edges: index.edges,
        warnings: index.warnings,
        categories: Object.fromEntries(Object.entries(config.categories ?? {}).map(([id, c]) => [id, { label: c.label ?? id, keywords: c.keywords ?? [] }])),
        registry: loadRegistry(root),
        lock: (lock.entries ?? []).map((e) => ({ kind: e.kind, name: e.name, source: e.source, installedAt: e.installedAt, updatedAt: e.updatedAt })),
        // presence of commands required by skills (checks PATH only, runs nothing)
        commands: Object.fromEntries([...new Set([...index.skills, ...index.agents].flatMap((e) => e.requires?.commands ?? []))].map((c) => [c, commandExists(c)])),
        settings: readSettings(root),
        configured: fs.existsSync(path.join(root, 'settings.json')),
        teams: loadTeams(root).teams,
        allowLocal,
      };
    },

    // project folders (read-only; does not follow symbolic links)
    'GET /api/tree': () => {
      const t = buildTree(root, ensureIndex(root));
      return { ...t, text: treeText(t.tree) };
    },

    // ---- guided creation of skills and agents (writes one new file in skills/own or agents/own, never overwrites)
    'GET /api/create/options': () => createOptions(root),

    // validates fields and previews file to write and target folders: writes nothing
    'POST /api/create/preview': (b) => previewItem(root, b),

    'POST /api/create': async (b) => {
      const r = await exclusive(() => createItem(root, b));
      cache.clear();
      tick();
      return r;
    },

    'GET /api/search': (_b, q) => {
      const index = ensureIndex(root);
      const config = readJson(path.join(root, 'hub.config.json'), { categories: {}, synonymGroups: [] });
      const query = (q.get('q') ?? '').slice(0, 300);
      const kind = ['skill', 'agent'].includes(q.get('kind')) ? q.get('kind') : undefined;
      const category = q.get('category') && /^[\w-]+$/.test(q.get('category')) ? q.get('category') : undefined;
      const limit = Math.min(Math.max(Number(q.get('limit')) || 10, 1), 50);
      return { query, results: searchIndex(index, config, query, { kind, category, limit }).map(({ e, score, matched }) => ({ id: e.id, score, matched })) };
    },

    'GET /api/guide': (_b, q) => {
      return { markdown: cached('guide', 30000, () => renderGuide(root, { machine: true }), { force: q.get('refresh') === '1' }) };
    },

    'GET /api/system': (_b, q) =>
      q.get('only') === 'machine'
        ? { machine: machineInfo(root) } // the Welcome page needs only this (instant); the full check below runs every program
        : cached(
        'system',
        20000,
        () => {
          const deps = loadDependencies(root);
          const managers = availableManagers();
          const tools = checkAll(deps).map((t) => {
            const def = deps.tools.find((d) => d.id === t.id);
            const plan = t.ok ? null : installPlan(def.install, def.manual, { managers });
            return { ...t, installCommand: plan?.auto ? plan.display : null, manual: plan?.manual ?? null };
          });
          const skillCommands = missingSkillCommands(ensureIndex(root)).map((m) => {
            const prov = deps.commandProviders[m.command];
            const plan = prov ? installPlan(prov.install, null, { managers }) : null;
            return { ...m, name: prov?.name ?? m.command, installCommand: plan?.auto ? plan.display : null, known: Boolean(prov) };
          });
          return { machine: machineInfo(root), tools, skillCommands };
        },
        { force: q.get('refresh') === '1' },
      ),

    'GET /api/doctor': async () => {
      const r = await runScript('doctor.mjs', ['--json'], { timeout: 60000 });
      try {
        return JSON.parse(r.out);
      } catch {
        throw new HubError(`doctor did not respond: ${combine(r).slice(0, 400)}`, 500);
      }
    },

    'POST /api/link': (b) => {
      const [agent, skill] = [str(b.agent, 'agent', { max: 100 }), str(b.skill, 'skill', { max: 100 })];
      if (!REF_ITEM_RE.test(agent) || !REF_ITEM_RE.test(skill)) throw new HubError(tr('server.badNames'));
      return exclusive(() => linkAdd(root, agent, skill));
    },

    'POST /api/unlink': (b) => {
      const [agent, skill] = [str(b.agent, 'agent', { max: 100 }), str(b.skill, 'skill', { max: 100 })];
      if (!REF_ITEM_RE.test(agent) || !REF_ITEM_RE.test(skill)) throw new HubError(tr('server.badNames'));
      return exclusive(() => linkRemove(root, agent, skill));
    },

    // ---- teams (teams.json): server validates shape and categories; doctor reports missing members
    'GET /api/teams': () => ({ teams: loadTeams(root).teams, problems: teamProblems(root, ensureIndex(root)), defaultRoles: DEFAULT_ROLES, limits: TEAM_LIMITS }),

    'POST /api/teams/save': (b) => {
      if (!b.team || typeof b.team !== 'object' || Array.isArray(b.team)) throw new HubError(tr('server.noTeam'));
      const categories = Object.keys(readJson(path.join(root, 'hub.config.json'), { categories: {} }).categories ?? {});
      return exclusive(() => {
        try {
          const team = saveTeam(root, b.team, { categories, createOnly: b.create === true });
          tick();
          return { ok: true, team };
        } catch (e) {
          throw e instanceof TeamError ? new HubError(e.message, e.status) : e;
        }
      });
    },

    'POST /api/teams/delete': (b) => {
      const id = str(b.id, 'id', { max: 40 });
      return exclusive(() => {
        try {
          deleteTeam(root, id);
          tick();
          return { ok: true };
        } catch (e) {
          throw e instanceof TeamError ? new HubError(e.message, e.status) : e;
        }
      });
    },

    // guided creation: suggests members for each role (writes nothing)
    'POST /api/teams/suggest': (b) => {
      const d = b.draft ?? {};
      const roles = Array.isArray(d.roles) ? d.roles : [];
      if (roles.length > TEAM_LIMITS.roles) throw new HubError('Too many roles.');
      const draft = {
        name: str(d.name, 'name', { optional: true, max: TEAM_LIMITS.name }) ?? '',
        description: str(d.description, 'description', { optional: true, max: TEAM_LIMITS.description }) ?? '',
        roles: roles.map((r, i) => ({
          id: str(r?.id, `roles[${i}].id`, { max: 40 }),
          name: str(r?.name, `roles[${i}].name`, { max: TEAM_LIMITS.roleName }),
          description: str(r?.description, `roles[${i}].description`, { optional: true, max: TEAM_LIMITS.roleDescription }) ?? '',
        })),
      };
      const config = readJson(path.join(root, 'hub.config.json'), { categories: {}, synonymGroups: [] });
      return { suggestions: suggestMembers(ensureIndex(root), config, draft) };
    },

    // ---- categories (hub.config.json): add, rename/keywords, remove
    'POST /api/categories': (b) => {
      const action = str(b.action, 'action', { max: 10 });
      const id = str(b.id, 'id', { max: 30 });
      const kw = b.keywords === undefined ? undefined : list(b.keywords, 'keywords', (k) => k.length <= 40, { max: 60 });
      if (action === 'add') return exclusive(() => addCategory(root, { id, label: str(b.label, 'label', { max: 50 }), keywords: kw ?? [] }));
      if (action === 'update') return exclusive(() => updateCategory(root, id, { label: str(b.label, 'label', { optional: true, max: 50 }), keywords: kw }));
      if (action === 'remove') return exclusive(() => removeCategory(root, id));
      throw new HubError(tr('server.badAction'));
    },

    'POST /api/categorize': (b) => {
      const id = str(b.id, 'id', { max: 100 });
      if (!REF_ITEM_RE.test(id)) throw new HubError(tr('server.badName'));
      const cats = list(b.categories, 'categories', (c) => /^[\w-]{1,40}$/.test(c), { max: 20 });
      return exclusive(() => categorize(root, id, cats));
    },

    // preview: downloads into temporary directory and inspects contents, writing nothing to hub
    'POST /api/install/preview': async (b) => {
      const args = sourceArgs(b);
      const r = await exclusive(() => runScript('install.mjs', [...args, '--dry-run', '--json'], { maxOutput: MAX_PREVIEW_OUTPUT }));
      if (r.code !== 0) throw new HubError(combine(r).replace(/^✖\s*/, '') || tr('server.previewFailed'), 422);
      return parseInstaller(r);
    },

    // NVIDIA SkillSpector analysis on selected items, on same version seen in preview (writes nothing to hub)
    'POST /api/install/scan': async (b) => {
      const args = sourceArgs(b);
      const only = list(b.only, 'only', (n) => isSafeName(n), { max: MAX_SCAN_ITEMS });
      if (!only.length) throw new HubError(`Choose between 1 and ${MAX_SCAN_ITEMS} items to analyze.`);
      const commit = str(b.expectCommit, 'expectCommit', { optional: true, max: 64 });
      if (commit && !SHA_RE.test(commit)) throw new HubError(tr('server.badCommit'));
      const extra = ['--dry-run', '--json', '--scan', `--only=${only.join(',')}`, ...(commit ? [`--expect-commit=${commit}`] : [])];
      const r = await exclusive(() => runScript('install.mjs', [...args, ...extra], { timeout: 20 * 60 * 1000, maxOutput: MAX_PREVIEW_OUTPUT }));
      if (r.code !== 0) throw new HubError(combine(r).replace(/^✖\s*/, '') || tr('server.scanFailed'), 422);
      return parseInstaller(r);
    },

    'POST /api/install': async (b) => {
      const args = sourceArgs(b);
      // full package: installs everything it contains (use subpath to limit scope)
      const pkg = b.package === true;
      const only = pkg ? [] : list(b.only, 'only', (n) => isSafeName(n), { max: 50 });
      if (!pkg && !only.length) throw new HubError(tr('server.pickOne'));
      const to = list(b.to, 'to', (t) => t === 'global' || /^agent:[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(t), { max: 20 });
      const category = list(b.category, 'category', (c) => /^[\w-]{1,40}$/.test(c), { max: 20 });
      const commit = str(b.expectCommit, 'expectCommit', { optional: true, max: 64 });
      if (commit && !SHA_RE.test(commit)) throw new HubError(tr('server.badCommit'));
      const extra = [...(pkg ? ['--package'] : [`--only=${only.join(',')}`]), '--via=ui', `--to=${(to.length ? to : ['global']).join(',')}`, ...(category.length ? [`--category=${category.join(',')}`] : []), ...(commit ? [`--expect-commit=${commit}`] : []), ...(b.force === true ? ['--force'] : [])];
      // each item passes through SkillSpector before being written: may take a few minutes
      const r = await exclusive(() => runScript('install.mjs', [...args, ...extra], { timeout: 30 * 60 * 1000 }));
      tick();
      return { ok: r.code === 0, output: combine(r) };
    },

    // approval state verified on this machine (hash recomputed): approved, review pending, content mismatch
    'GET /api/approvals': () =>
      cached('approvals', 5 * 60 * 1000, () => {
        const hashes = new Map();
        return { items: loadLock(root).entries.map((e) => ({ kind: e.kind, name: e.name, package: e.package?.sourcePath !== undefined ? e.package.path : null, ...verifyEntry(root, e, hashes), actual: undefined })) };
      }),

    // scans installed version with SkillSpector and approves it (tied to its hash)
    'POST /api/approve': async (b) => {
      const kind = str(b.kind, 'kind', { max: 10 });
      const name = str(b.name, 'name', { max: 80 });
      if (!['skill', 'agent'].includes(kind) || !isSafeName(name)) throw new HubError(tr('server.badItem'));
      const r = await exclusive(() => runScript('install.mjs', ['--approve', name, `--kind=${kind}`, '--via=ui'], { timeout: 30 * 60 * 1000 }));
      cache.delete('approvals');
      tick();
      return { ok: r.code === 0, output: combine(r) };
    },

    'POST /api/update': async (b) => {
      const names = list(b.names, 'names', (n) => REF_ITEM_RE.test(n) && !n.includes(':'), { max: 50 });
      const r = await exclusive(() => runScript('install.mjs', ['--update', ...names, '--via=ui'], { timeout: 30 * 60 * 1000 }));
      tick();
      return { ok: r.code === 0, output: combine(r) };
    },

    'POST /api/remove': async (b) => {
      const kind = str(b.kind, 'kind', { max: 10 });
      const name = str(b.name, 'name', { max: 80 });
      if (!['skill', 'agent'].includes(kind) || !isSafeName(name)) throw new HubError(tr('server.badItem'));
      const r = await exclusive(() => runScript('install.mjs', ['--remove', name, `--kind=${kind}`, '--yes']));
      tick();
      return { ok: r.code === 0, output: combine(r) };
    },

    // ---- settings (settings.json): schema keys and values only
    'GET /api/settings': () => {
      const scanner = resolveScanner();
      return { ...settingsView(root), configured: fs.existsSync(path.join(root, 'settings.json')), skillspector: cached('skillspector', 60000, () => ({ installed: Boolean(scanner), version: scannerVersion(scanner) })) };
    },

    'POST /api/settings': async (b) => {
      try {
        checkPatch(b.values);
      } catch (e) {
        throw new HubError(e.message);
      }
      const values = await exclusive(() => writeSettings(root, b.values));
      tick();
      return { ok: true, values };
    },

    // ---- usage and estimated token consumption (updates usage/<computer>.json if setting enabled)
    'GET /api/usage': (_b, q) =>
      exclusive(() =>
        cached('usage', 60000, () => {
          const index = ensureIndex(root);
          let machine = null;
          if (readSettings(root)['usage.fromTranscripts']) {
            try {
              machine = updateMachineUsage(root, new Set([...index.skills, ...index.agents].map((e) => e.id))).machine;
            } catch {
              /* unreadable history: show already-saved counts */
            }
          }
          const all = readAllUsage(root);
          return { ...usageReport(index, all.items), machines: all.machines, machine, tracking: readSettings(root)['usage.fromTranscripts'] };
        }, { force: q.get('refresh') === '1' })),

    // ---- GitHub sync (status, incoming updates, outgoing changes)
    'GET /api/repo': () => repoStatus(root),

    // checks GitHub (git fetch: does not change local files); never prompts for credentials
    'POST /api/repo/check': () => exclusive(() => repoStatus(root, { fetch: true })),

    'POST /api/repo/pull': async (b) => {
      if (b.setAside !== undefined && typeof b.setAside !== 'boolean') throw new HubError(tr('server.setAsideBool'), 400);
      const r = await exclusive(() => pullUpdates(root, { setAside: b.setAside === true }));
      if (r.changed) {
        ensureIndex(root);
        // generated files reset before pull are regenerated with this machine's state
        if (r.regenerate?.length) refreshGuideSafe(root);
        cache.clear();
      }
      tick();
      return r;
    },

    // push: saves changes to commit and pushes. Requires "confirm": true, never forces
    'POST /api/repo/push': async (b) => {
      if (!readSettings(root)['sync.github']) throw new HubError(tr('server.syncOff'), 409);
      if (b.confirm !== true) throw new HubError(tr('server.confirmNeeded'), 400);
      const message = str(b.message, 'message', { optional: true, max: 200 });
      const r = await exclusive(() => pushChanges(root, { message }));
      cache.delete('guide');
      tick();
      return r;
    },

    'POST /api/sync': async (b) => {
      for (const k of ['instructions', 'claudeMd']) if (b[k] !== undefined && typeof b[k] !== 'boolean') throw new HubError(`${k} must be true or false.`, 400);
      const r = await exclusive(() => runScript('sync.mjs', b.instructions === true || b.claudeMd === true ? ['--instructions'] : []));
      cache.delete('system');
      cache.delete('guide');
      return { ok: r.code === 0, output: combine(r) };
    },
  };

  // ---------------------------------------------------------------- HTTP
  const headers = (extra = {}) => ({
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'Cross-Origin-Resource-Policy': 'same-origin',
    ...extra,
  });
  const sendJson = (res, status, data) => {
    const body = JSON.stringify(data);
    res.writeHead(status, headers({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) }));
    res.end(body);
  };

  function readBody(req, max = MAX_BODY) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > max) {
          reject(new HubError('Request body too large.', 413));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          const data = text ? JSON.parse(text) : {};
          if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
          resolve(data);
        } catch {
          reject(new HubError(tr('server.badBody')));
        }
      });
      req.on('error', reject);
    });
  }

  function serveStatic(req, res, pathname) {
    let rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    const file = path.resolve(PUBLIC, rel);
    if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) return sendJson(res, 403, { error: 'Forbidden.' });
    let real;
    try {
      real = fs.realpathSync(file);
      if (!real.startsWith(fs.realpathSync(PUBLIC) + path.sep) || !fs.statSync(real).isFile()) throw new Error('no');
    } catch {
      return sendJson(res, 404, { error: tr('server.notFound') });
    }
    const type = MIME[path.extname(real).toLowerCase()];
    if (!type) return sendJson(res, 404, { error: tr('server.notFound') });
    let body = fs.readFileSync(real);
    if (path.basename(real) === 'index.html') {
      // the interface messages in the hub language (English fills any gap), as JSON data read by js/i18n.js
      const lang = hubLanguage(root);
      const ui = Object.fromEntries(Object.entries({ ...messages(DEFAULT_LANGUAGE), ...messages(lang) }).filter(([k]) => k.startsWith('ui.')));
      const json = JSON.stringify({ lang, messages: ui }).replace(/</g, '\\u003c');
      body = Buffer.from(body.toString('utf8').replace('__HUB_TOKEN__', token).replace('__HUB_LANG__', lang).replace('__HUB_I18N__', json));
    }
    res.writeHead(200, headers({ 'Content-Type': type, 'Content-Length': body.length }));
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const { pathname } = url;

      // DNS rebinding: browser must contact this exact address
      if (!hosts.has(String(req.headers.host ?? '').toLowerCase())) return sendJson(res, 421, { error: tr('server.badHost') });

      if (!pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: tr('server.badMethod') });
        return serveStatic(req, res, pathname);
      }

      // real-time events (EventSource cannot send headers: token passes in URL)
      const given = req.headers['x-hub-token'] ?? url.searchParams.get('t') ?? '';
      const okToken = given.length === token.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
      if (pathname !== '/api/health' && !okToken) return sendJson(res, 401, { error: 'Session token missing or invalid: reload the page.' });

      if (pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, headers({ 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }));
        res.write(`retry: 3000\nevent: hello\ndata: {}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }

      const handler = api[`${req.method} ${pathname}`];
      if (!handler) return sendJson(res, 404, { error: 'Unknown route.' });

      let body = {};
      if (req.method === 'POST') {
        // CSRF: only pages served by this server may modify state
        if (!origins.has(req.headers.origin ?? '')) return sendJson(res, 403, { error: tr('server.badOrigin') });
        if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return sendJson(res, 415, { error: 'Requires Content-Type: application/json.' });
        // creation routes accept long text (a complex skill can be a large Markdown file)
        body = await readBody(req, pathname.startsWith('/api/create') ? BODY_MAX : MAX_BODY);
      }
      sendJson(res, 200, await handler(body, url.searchParams));
    } catch (e) {
      const status = e instanceof HubError ? e.status : 500;
      if (status === 500 && !quiet) console.error(e);
      if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'Internal server error.' : e.message });
      else res.end();
    }
  });

  // Idle connections kept open longer than Node's default (5 s): browser reuses them, avoiding
  // "fetch failed" race conditions when the server closes them right as a request arrives.
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;

  // ---------------------------------------------------------------- startup
  const listen = (p) =>
    new Promise((resolve, reject) => {
      const onError = (e) => reject(e);
      server.once('error', onError);
      server.listen(p, '127.0.0.1', () => {
        server.off('error', onError);
        resolve(server.address().port);
      });
    });

  let actual;
  for (let p = port, tries = 0; ; p++, tries++) {
    try {
      actual = await listen(p);
      break;
    } catch (e) {
      if (e.code !== 'EADDRINUSE' || strictPort || tries >= 20 || port === 0) throw e;
    }
  }
  hosts = new Set([`127.0.0.1:${actual}`, `localhost:${actual}`]);
  origins = new Set([`http://127.0.0.1:${actual}`, `http://localhost:${actual}`]);
  const url = `http://127.0.0.1:${actual}/`;

  if (open) openBrowser(url);

  // "App" mode (idleExitMs > 0): with no terminal window there is no obvious way to stop the hub, so it stops by itself
  // when no page has been connected (the page keeps /api/events open) for idleExitMs, or if none ever connects in that time.
  let idleCheck = null;
  if (idleExitMs > 0) {
    let emptySince = Date.now();
    idleCheck = setInterval(() => {
      if (clients.size > 0) emptySince = null;
      else if (emptySince === null) emptySince = Date.now();
      else if (Date.now() - emptySince >= idleExitMs) {
        clearInterval(idleCheck);
        if (typeof onIdle === 'function') onIdle();
      }
    }, Math.min(1000, Math.max(50, Math.floor(idleExitMs / 4))));
    idleCheck.unref();
  }

  return {
    url,
    port: actual,
    token,
    server,
    close: () =>
      new Promise((resolve) => {
        clearInterval(poller);
        clearInterval(keepAlive);
        if (idleCheck) clearInterval(idleCheck);
        for (const c of clients) c.end();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

function openBrowser(url) {
  // The URL is constructed here as a constant (127.0.0.1 + numeric port): no external input.
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* URL remains printed in terminal */
  }
}

// ---------------------------------------------------------------- CLI startup
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { flags } = parseArgs(process.argv.slice(2), { boolean: ['no-open', 'allow-local', 'help'] });
  if (flags.help) {
    console.log('Usage: node ui/server.mjs [--port 4173] [--no-open] [--allow-local]');
    process.exit(0);
  }
  const explicit = flags.port !== undefined && flags.port !== true;
  const port = explicit ? Number(flags.port) : 4173;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`✖ ${trMain('server.badPort')}`);
    process.exit(2);
  }
  try {
    const app = await startServer({ port, strictPort: explicit, allowLocal: Boolean(flags['allow-local']), open: !flags['no-open'] });
    console.log(trMain('server.started', { url: app.url }));
    console.log(`  ${trMain('server.folder', { root: HUB_ROOT })}`);
    console.log(`  ${trMain('server.localOnly')}`);
    const stop = () => app.close().then(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } catch (e) {
    console.error(e.code === 'EADDRINUSE' ? `✖ Port ${port} is in use: specify --port <another port>.` : `✖ ${e.message}`);
    process.exit(1);
  }
}
