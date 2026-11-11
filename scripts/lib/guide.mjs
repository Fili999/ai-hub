// Live guide: docs/guide.md is the template;
// {{live:name}} sections are populated with the actual hub state.
//   renderGuide(root)                    → GUIDE.md text (identical on every machine, no local host data)
//   renderGuide(root, { machine: true }) → as above, but with THIS computer's state (for the UI)
//   refreshGuide(root)                   → rewrites GUIDE.md if changed
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson } from './util.mjs';
import { ensureIndex } from './scan.mjs';
import { catsOf } from './search.mjs';
import { checkAll, loadDependencies } from './deps.mjs';
import { machineInfo } from './machine.mjs';

export const GUIDE_TEMPLATE_EN = 'docs/guide.md';
export const GUIDE_FILE_EN = 'GUIDE.md';

export const GUIDE_TEMPLATE = GUIDE_TEMPLATE_EN;
export const GUIDE_FILE = GUIDE_FILE_EN;

const SELF_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();
const table = (head, rows) => (rows.length ? [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n') : '');
const firstSentence = (s, max = 140) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(t);
  const out = m ? m[1] : t;
  return out.length > max ? out.slice(0, max - 1) + '…' : out;
};
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const NPM_NOTES = {
  'setup-hooks': 'Enable git hooks: after every "git pull" the link to Claude refreshes automatically.',
  test: 'Run automated tests (before every commit).',
};

function scriptNote(root, name, cmd) {
  if (NPM_NOTES[name]) return NPM_NOTES[name];
  const m = /node\s+(\S+\.mjs)/.exec(cmd);
  if (!m) return '';
  for (const r of [root, SELF_ROOT]) {
    try {
      const lines = fs.readFileSync(path.join(r, m[1]), 'utf8').split(/\r?\n/);
      const c = lines.find((l, i) => i > 0 && l.startsWith('//'));
      if (c) return c.replace(/^\/\/\s*/, '');
    } catch {
      /* try next root */
    }
  }
  return '';
}

const STRUCTURE_NOTES = {
  'skills/own': 'your skills',
  'skills/external': 'skills from GitHub (managed by the installer)',
  'agents/own': 'your agents',
  'agents/external': 'agents from GitHub (managed by the installer)',
  'registry.json': 'your choices: agent→skill links, categories',
  'manifest.lock.json': 'where each external item comes from and its version',
  'hub.config.json': 'categories and synonyms for search',
  'dependencies.json': 'programs to install on each computer',
  'index/skillindex.json': 'generated catalog (not versioned)',
  scripts: 'commands (Node, zero dependencies)',
  ui: 'local web interface',
  templates: 'templates for new skills and agents',
  docs: 'source templates of the guide',
  tests: 'automated tests',
  'bootstrap.sh': 'startup on Mac/Linux',
  'bootstrap.cmd': 'startup on Windows',
  'GUIDE.md': 'this guide (generated)',
  'CLAUDE.md': 'rules for Claude Code when working on the repo',
  'README.md': 'quick overview',
};

function structureBlock(root, index) {
  const count = (dir, kind) => index[kind === 'skill' ? 'skills' : 'agents'].filter((e) => e.path.startsWith(dir + '/')).length;
  const lines = ['```text', 'ai-hub/'];
  const entries = [
    'skills/own', 'skills/external', 'agents/own', 'agents/external', 'registry.json', 'manifest.lock.json', 'hub.config.json', 'dependencies.json',
    'index/skillindex.json', 'scripts', 'ui', 'templates', 'docs', 'tests', 'bootstrap.sh', 'bootstrap.cmd', 'GUIDE.md', 'CLAUDE.md', 'README.md',
  ].filter((p) => fs.existsSync(path.join(root, p)) || p === 'index/skillindex.json' || p === 'GUIDE.md' || p === GUIDE_FILE);
  const w = Math.max(...entries.map((e) => e.length)) + 2;
  for (const p of entries) {
    const isDir = fs.existsSync(path.join(root, p)) && fs.statSync(path.join(root, p)).isDirectory();
    let extra = '';
    if (p.startsWith('skills/')) extra = ` — now ${count(p, 'skill')}`;
    if (p.startsWith('agents/')) extra = ` — now ${count(p, 'agent')}`;
    lines.push(`  ${(p + (isDir ? '/' : '')).padEnd(w)}${STRUCTURE_NOTES[p] ?? ''}${extra}`);
  }
  lines.push('```');
  return lines.join('\n');
}

export const BLOCKS = {
  stats(root, ctx) {
    const s = ctx.index.stats;
    const links = ctx.index.edges.filter((e) => e.type !== 'depends').length;
    const issue = s.errors || s.warnings ? ` Issues: ${plural(s.errors, 'error', 'errors')} and ${plural(s.warnings, 'warning', 'warnings')}.` : ' No issues reported.';
    return `Today the hub contains **${plural(s.skills, 'skill', 'skills')}** and **${plural(s.agents, 'agent', 'agents')}**: ${s.own} ${s.own === 1 ? 'is yours' : 'are yours'}, ${s.external} ${s.external === 1 ? 'comes' : 'come'} from GitHub. There are ${plural(links, 'link', 'links')} between agents and skills.${issue}`;
  },

  dependencies(root, ctx) {
    const deps = loadDependencies(root, ctx.lang);
    const how = (t, p) => (t.install?.[p] ? `${t.install[p].manager} ${t.install[p].package}` : '—');
    const headers = ['Tool', 'Level', 'Purpose', 'Windows', 'Mac'];
    const fallback = '_No dependencies declared._';
    return table(
      headers,
      deps.tools.map((t) => [t.name ?? t.id, t.level, t.why ?? '', how(t, 'win32'), how(t, 'darwin')]),
    ) || fallback;
  },

  status(root, ctx) {
    if (!ctx.machine) {
      return '_The status of this computer depends on the machine, so it is not stored in this file. You can see it in the **System** tab of the interface, or with `npm run setup -- --check`._';
    }
    const m = machineInfo(root);
    const tools = checkAll(loadDependencies(root, ctx.lang));
    const rows = tools.map((t) => [
      t.name,
      t.ok ? `✔ ${t.version ?? 'ok'}` : `✖ ${t.reason}`,
      t.level,
    ]);
    const sync = m.sync.active ? `active (${m.sync.items} items${m.sync.syncedAt ? `, last sync ${m.sync.syncedAt.slice(0, 16).replace('T', ' ')}` : ''})` : m.sync.root ? `linked to another folder (${m.sync.root})` : 'not yet run: run `npm run sync`';
    const headers = ['Tool', 'Status', 'Level'];
    const thisComputer = `This computer: **${m.platformLabel} ${m.arch}**, Node ${m.node}.`;
    const linkLabel = `Link to Claude Code (\`${m.claudeDir}\`)`;
    const instrLabel = `Orchestrator instruction in CLAUDE.md: ${m.claudeMdBlock ? 'present' : 'not present (`npm run sync -- --claude-md`)'}`;
    const pkgManagers = 'Package managers';
    return [
      thisComputer,
      '',
      table(headers, rows),
      '',
      `- ${linkLabel}: ${sync}`,
      `- ${instrLabel}`,
      `- ${pkgManagers}: ${Object.entries(m.managers).map(([k, v]) => `${k} ${v ? '✔' : '✖'}`).join(', ')}`,
    ].join('\n');
  },

  structure: (root, ctx) => structureBlock(root, ctx.index),

  commands(root, ctx) {
    const pkg = readJson(path.join(root, 'package.json'), { scripts: {} });
    const rows = Object.entries(pkg.scripts ?? {}).map(([name, cmd]) => [`\`npm run ${name}\``, scriptNote(root, name, cmd)]);
    const headers = ['Command', 'What it does'];
    const fallback = '_No commands._';
    return table(headers, rows) || fallback;
  },

  categories(root, ctx) {
    const cfg = readJson(path.join(root, 'hub.config.json'), { categories: {} });
    const all = [...ctx.index.skills, ...ctx.index.agents];
    const rows = Object.entries(cfg.categories ?? {}).map(([id, c]) => [`\`${id}\``, c.label ?? id, String(all.filter((e) => catsOf(e).includes(id)).length)]);
    const headers = ['Category', 'Name', 'Items'];
    const fallback = '_No categories declared._';
    return table(headers, rows) || fallback;
  },

  own(root, ctx) {
    const own = [...ctx.index.skills, ...ctx.index.agents].filter((e) => e.origin === 'own');
    if (!own.length) return '_None yet. You can create your own skills in `skills/own/<name>/SKILL.md` and agents in `agents/own/<name>.md`._';
    return own.map((e) => {
      const kind = e.kind === 'agent' ? 'Agent' : 'Skill';
      return `- **${kind} \`${e.name}\`** — ${firstSentence(e.description)}`;
    }).join('\n');
  },

  external(root, ctx) {
    const ext = [...ctx.index.skills, ...ctx.index.agents].filter((e) => e.origin === 'external');
    if (!ext.length) return '_None yet. Paste a GitHub link in the **Install** tab or use `npm run add -- <link>`._';
    const headers = ['Item', 'Source', 'Version', 'Risk', 'Assigned to'];
    return table(
      headers,
      ext.map((e) => [
        `${e.kind === 'agent' ? 'agent' : 'skill'} \`${e.name}\``,
        e.source?.repo ?? e.source?.url ?? '—',
        e.source?.commit ? String(e.source.commit).slice(0, 7) : e.source?.ref ?? '—',
        e.risk,
        e.assignedTo.length ? e.assignedTo.join(', ') : 'global',
      ]),
    );
  },

  links(root, ctx) {
    const rows = ctx.index.edges.filter((e) => e.type !== 'depends');
    if (!rows.length) return '_No links: no agent uses hub skills yet._';
    return rows.map((e) => {
      const reason = e.type === 'declared' ? 'written in agent file' : 'selected in registry.json';
      return `- \`${e.from}\` → \`${e.to}\` (${reason})`;
    }).join('\n');
  },

  warnings(root, ctx) {
    const w = ctx.index.warnings.filter((x) => x.level !== 'info');
    if (!w.length) return '✔ No issues reported.';
    return w.map((x) => `- ${x.level === 'error' ? '✖' : '⚠'} ${x.message}`).join('\n');
  },
};

export const BLOCK_NAMES = Object.keys(BLOCKS);

export function guideTemplatePath(root) {
  const fallbacks = [GUIDE_TEMPLATE_EN];
  for (const rel of fallbacks) {
    const found = [root, SELF_ROOT].map((r) => path.join(r, rel)).find((f) => fs.existsSync(f));
    if (found) return found;
  }
  return null;
}

export function guideFilePath(root) {
  return path.join(root, GUIDE_FILE_EN);
}

export function renderGuide(root, { machine = false } = {}) {
  const tplPath = guideTemplatePath(root);
  if (!tplPath) return `# Guide\n\nMissing guide template.\n`;
  const ctx = { index: ensureIndex(root), machine, lang: 'en' };
  const body = fs
    .readFileSync(tplPath, 'utf8')
    .replace(/<!--[\s\S]*?-->\s*/, '') // template preamble comment
    .replace(/\{\{live:([a-z-]+)\}\}/g, (_, name) => {
      const fn = BLOCKS[name];
      if (!fn) return `_(unknown section: ${name})_`;
      try {
        return fn(root, ctx);
      } catch (e) {
        return `_(cannot read this section: ${e.message})_`;
      }
    });
  const tplRel = GUIDE_TEMPLATE_EN;
  const header = machine
    ? ''
    : `<!-- File generated from ${tplRel} with "npm run guide": do not edit by hand. -->\n`;
  return header + body.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

export function refreshGuide(root) {
  let anyChanged = false;
  const file = guideFilePath(root);
  const text = renderGuide(root);
  let prev = null;
  try {
    prev = fs.readFileSync(file, 'utf8');
  } catch {
    /* first run */
  }
  if (prev !== text) {
    fs.writeFileSync(file, text);
    anyChanged = true;
  }
  return { changed: anyChanged, files: [file], file };
}

/** Like refreshGuide, but never throws (guide generation is non-blocking). */
export function refreshGuideSafe(root, opts = {}) {
  try {
    return refreshGuide(root, opts);
  } catch (e) {
    return { changed: false, error: e.message };
  }
}
