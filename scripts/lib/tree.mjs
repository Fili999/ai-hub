// Project folder tree, with descriptions for key components and links to catalog skills and agents.
// Does not follow symlinks, skips .git and node_modules, and applies depth and node limits.
import fs from 'node:fs';
import path from 'node:path';
import { tFor } from './i18n.mjs';

const t = tFor();

const SKIP = new Set(['.git', 'node_modules', '.tmp', '.DS_Store', 'Thumbs.db']);
const MAX_DEPTH = 10;
const MAX_NODES = 4000;
const MAX_PER_DIR = 300;

const NOTE_KEYS = {
  skills: 'tree.note.skills',
  'skills/own': 'tree.note.skillsOwn',
  'skills/external': 'tree.note.skillsExternal',
  agents: 'tree.note.agents',
  'agents/own': 'tree.note.agentsOwn',
  'agents/external': 'tree.note.agentsExternal',
  'teams.json': 'tree.note.teamsJson',
  memory: 'tree.note.memory',
  evaluations: 'tree.note.evaluations',
  usage: 'tree.note.usage',
  templates: 'tree.note.templates',
  workflows: 'tree.note.workflows',
  scripts: 'tree.note.scripts',
  'scripts/lib': 'tree.note.scriptsLib',
  ui: 'tree.note.ui',
  'ui/server.mjs': 'tree.note.uiServerMjs',
  'ui/public': 'tree.note.uiPublic',
  'ui/public/js': 'tree.note.uiPublicJs',
  'ui/public/js/views': 'tree.note.uiPublicJsViews',
  'ui/public/brand': 'tree.note.uiPublicBrand',
  'ui/public/fonts': 'tree.note.uiPublicFonts',
  docs: 'tree.note.docs',
  'docs/guide.md': 'tree.note.docsGuide',
  'docs/architecture.md': 'tree.note.docsArchitecture',
  'docs/contracts.md': 'tree.note.docsContracts',
  'docs/external-skills.md': 'tree.note.docsExternalSkills',
  'docs/security.md': 'tree.note.docsSecurity',
  'docs/design.md': 'tree.note.docsDesign',
  'docs/naming.md': 'tree.note.docsNaming',
  'docs/principles.md': 'tree.note.docsPrinciples',
  'docs/roadmap.md': 'tree.note.docsRoadmap',
  'docs/decisions.md': 'tree.note.docsDecisions',
  'GUIDE.md': 'tree.note.guideMd',
  tests: 'tree.note.tests',
  index: 'tree.note.index',
  'index/skillindex.json': 'tree.note.indexSkillindexJson',
  'registry.json': 'tree.note.registryJson',
  'manifest.lock.json': 'tree.note.manifestLockJson',
  'hub.config.json': 'tree.note.hubConfigJson',
  'dependencies.json': 'tree.note.dependenciesJson',
  'settings.json': 'tree.note.settingsJson',
  'package.json': 'tree.note.packageJson',
  'bootstrap.cmd': 'tree.note.bootstrapCmd',
  'bootstrap.sh': 'tree.note.bootstrapSh',
  'start.cmd': 'tree.note.startCmd',
  'start.command': 'tree.note.startCommand',
  'README.md': 'tree.note.readmeMd',
  'CLAUDE.md': 'tree.note.claudeMd',
  '.gitignore': 'tree.note.gitignore',
  '.gitattributes': 'tree.note.gitattributes',
  '.githooks': 'tree.note.githooks',
  '.github': 'tree.note.github',
};

/** What each known part of the project contains (key = relative path with "/"). */
export const NOTES = new Proxy(NOTE_KEYS, {
  get(target, prop) {
    if (typeof prop === 'string' && target[prop]) {
      return t(target[prop]);
    }
    return target[prop];
  },
  has(target, prop) {
    return prop in target;
  },
});
const GENERATED = new Set(['index/skillindex.json', 'GUIDE.md']);

const byName = (a, b) => a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' });

/**
 * Returns { tree, counts }. tree = { name, path:'', type:'dir', children:[...] };
 * each entry: { name, path, type: 'dir'|'file'|'link', size?, note?, generated?, item?: id, kind?: 'skill'|'agent', origin?, target?, truncated? }
 */
export function buildTree(root, index = { skills: [], agents: [] }) {
  const items = new Map([...index.skills, ...index.agents].map((e) => [e.path, e]));
  const counts = { dirs: 0, files: 0, truncated: false };
  let nodes = 0;

  function walk(abs, rel, depth) {
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return [];
    }
    const out = [];
    for (const ent of entries) {
      if (SKIP.has(ent.name)) continue;
      if (out.length >= MAX_PER_DIR || nodes >= MAX_NODES) {
        counts.truncated = true;
        break;
      }
      nodes++;
      const p = rel ? `${rel}/${ent.name}` : ent.name;
      const node = { name: ent.name, path: p, type: 'file' };
      if (NOTES[p]) node.note = NOTES[p];
      if (GENERATED.has(p)) node.generated = true;
      const it = items.get(p);
      if (it) Object.assign(node, { item: it.id, kind: it.kind, origin: it.origin, note: node.note ?? it.description });
      if (ent.isSymbolicLink()) {
        node.type = 'link';
        try {
          node.target = fs.readlinkSync(path.join(abs, ent.name));
        } catch {
          /* unreadable symlink */
        }
      } else if (ent.isDirectory()) {
        node.type = 'dir';
        counts.dirs++;
        if (depth >= MAX_DEPTH) {
          node.truncated = true;
          node.children = [];
          counts.truncated = true;
        } else node.children = walk(path.join(abs, ent.name), p, depth + 1);
      } else if (ent.isFile()) {
        counts.files++;
        try {
          node.size = fs.statSync(path.join(abs, ent.name)).size;
        } catch {
          /* removed concurrently */
        }
      } else continue;
      out.push(node);
    }
    return out.sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || byName(a, b));
  }

  return { tree: { name: path.basename(root), path: '', type: 'dir', children: walk(root, '', 0) }, counts };
}

/** The same tree as text (├── └──), ready to paste. */
export function treeText(tree, { notes = true } = {}) {
  const lines = [`${tree.name}/`];
  const rec = (children, prefix) =>
    children.forEach((n, i) => {
      const last = i === children.length - 1;
      const note = notes && n.note ? `   # ${n.note.length > 70 ? `${n.note.slice(0, 67)}…` : n.note}` : '';
      lines.push(`${prefix}${last ? '└── ' : '├── '}${n.name}${n.type === 'dir' ? '/' : ''}${note}`);
      if (n.children?.length) rec(n.children, prefix + (last ? '    ' : '│   '));
    });
  rec(tree.children, '');
  return lines.join('\n');
}
