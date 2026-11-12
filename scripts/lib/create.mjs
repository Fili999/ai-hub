// Guided creation of skills and agents: validates fields, generates Markdown from template, suggests placement folder, and writes.
// Used by the "Create" tab of the UI. No shell, no arbitrary commands: only reads the index and writes ONE file
// inside skills/own or agents/own (never overwriting an existing file) plus, if requested, links in registry.json.
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from './frontmatter.mjs';
import { jaccard, stems } from './text.mjs';
import { HubError } from './ops.mjs';
import { ensureIndex, inferCategories, scanHub, writeIndex } from './scan.mjs';
import { addLink, loadRegistry, saveRegistry } from './registry.mjs';
import { refreshGuideSafe } from './guide.mjs';
import { commandExists, readJson, toPosix } from './util.mjs';
import { EFFORT_TIERS, MODEL_TIERS, PROVIDER_IDS, loadProviders } from './providers.mjs';
import { readSettings } from './settings.mjs';
import { UnsafePathError, createFileExclusive } from './safefs.mjs';
import { hubLanguage, tFor } from './i18n.mjs';

const t = tFor();
const loc = () => (hubLanguage() === 'it' ? 'it-IT' : 'en-US');

// ---------------------------------------------------------------- choices offered by the UI
export const FIELD_MAX = 1_000_000; // characters per field: effectively unlimited
export const MARKDOWN_MAX = 2_000_000; // max size of the entire file
export const BODY_MAX = 8 * 1024 * 1024; // max HTTP request body size for creation endpoints

export const MODELS = [
  { id: '', label: 'Match session (recommended)', hint: 'Leaves empty: uses the model you are already using.' },
  { id: 'sonnet', label: 'Sonnet', hint: 'Fast and balanced: great for almost everything.' },
  { id: 'opus', label: 'Opus', hint: 'Reasons better on complex tasks, but slower and more expensive.' },
  { id: 'haiku', label: 'Haiku', hint: 'Very fast and cost-effective: for simple, repetitive tasks.' },
  { id: 'fable', label: 'Fable', hint: 'Highest tier, if available in your plan.' },
];
export const EFFORTS = [
  { id: '', label: 'Default', hint: 'Leaves empty: decided by the session.' },
  { id: 'low', label: 'Low', hint: 'Fast responses, minimal reasoning.' },
  { id: 'medium', label: 'Medium', hint: 'A balanced trade-off.' },
  { id: 'high', label: 'High', hint: 'More reasoning: for complex tasks.' },
  { id: 'xhigh', label: 'Very high', hint: 'Available on select models only.' },
  { id: 'max', label: 'Maximum', hint: 'Slowest and most thorough; select models only.' },
];
export const TOOL_GROUPS = [
  { id: 'read', label: 'Read', tools: [{ name: 'Read', hint: 'reads files' }, { name: 'Glob', hint: 'finds files by name' }, { name: 'Grep', hint: 'searches inside files' }] },
  { id: 'write', label: 'Edit files', tools: [{ name: 'Write', hint: 'creates or overwrites files' }, { name: 'Edit', hint: 'edits existing files' }, { name: 'NotebookEdit', hint: 'edits Jupyter notebooks' }] },
  { id: 'run', label: 'Run commands', tools: [{ name: 'Bash', hint: 'runs terminal commands: use only when needed' }] },
  { id: 'web', label: 'Web', tools: [{ name: 'WebSearch', hint: 'searches the web' }, { name: 'WebFetch', hint: 'fetches a web page' }] },
];
export const TOOL_PRESETS = [
  { id: 'readonly', label: 'Read-only', tools: ['Read', 'Glob', 'Grep'] },
  { id: 'edit', label: 'Read and edit', tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit'] },
  { id: 'shell', label: 'With terminal', tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash'] },
  { id: 'web', label: 'Read and web', tools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'] },
];

const MODEL_IDS = new Set(MODELS.map((m) => m.id).concat('inherit'));
const EFFORT_IDS = new Set(EFFORTS.map((e) => e.id));
const CUSTOM_MODEL_RE = /^[A-Za-z0-9][\w.:@-]{2,100}$/; // complete model ID (including Bedrock/Vertex)
const TOOL_ID_RE = /^[A-Za-z0-9][\w.:@/+-]{0,120}$/; // models and efforts for other tools (e.g. ollama/qwen3:30b)
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/; // as required by Claude Code and claude.ai
const TOOL_RE = /^[A-Za-z][A-Za-z0-9_:.*-]{0,100}(?:\([^(),\n"'#]{1,120}\))?$/; // Read, mcp__x__y, Bash(git *)
const WORD_RE = /^[A-Za-z0-9_][\w.:@+/-]{0,80}$/; // names of MCP and similar
const COMMAND_RE = /^[A-Za-z0-9._+-]{1,60}$/;
const REF_RE = /^(?:(?:skill|agent):)?[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const RESERVED_SEGMENTS = new Set(['external', 'node_modules']);

const BASES = { skill: 'skills/own', agent: 'agents/own' };
const KINDS = ['skill', 'agent'];

// ---------------------------------------------------------------- normalization
/** Clean text: uniform newlines, no control characters (which would break frontmatter). */
export function cleanText(v) {
  return String(v)
    .replace(new RegExp('^' + String.fromCharCode(0xfeff)), '')
    .replace(/\r\n?/g, '\n')
    .replace(new RegExp('[' + String.fromCharCode(0x2028, 0x2029) + ']', 'g'), '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

function text(v, name, max = FIELD_MAX) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new HubError(t('create.error.invalidField', { name }));
  if (v.length > max) throw new HubError(t('create.error.fieldTooLong', { name, length: v.length.toLocaleString(loc()), max: max.toLocaleString(loc()) }), 413);
  return cleanText(v).trim();
}
const oneLine = (v, name, max = 400) => text(v, name, max).replace(/\s+/g, ' ').trim();

function strings(v, name, { max = 40, itemMax = 120 } = {}) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > max) throw new HubError(t('create.error.invalidField', { name }));
  const out = [];
  for (const x of v) {
    if (typeof x !== 'string' || x.length > itemMax) throw new HubError(t('create.error.invalidField', { name }));
    const tStr = cleanText(x).replace(/\s+/g, ' ').trim();
    if (tStr && !out.includes(tStr)) out.push(tStr);
  }
  return out;
}

/**
 * Normalizes received data (UI JSON) into a safe and complete shape.
 * Rejects only invalid types and excessive sizes; content errors are caught by checkDraft.
 */
const OTHER_TOOLS = PROVIDER_IDS.filter((id) => id !== 'claude');
/** {codex: 'id', …}: only known tools, one-line values; empty values are dropped. */
function toolMap(v, field) {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new HubError(t('create.error.invalidField', { name: field }));
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (!OTHER_TOOLS.includes(k)) throw new HubError(t('create.error.unknownSystem', { field, system: String(k).slice(0, 30) }));
    const one = oneLine(val, field, 120);
    if (one && one !== 'inherit') out[k] = one;
  }
  return out;
}

export function normalizeDraft(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HubError(t('create.error.invalidData'));
  const kind = raw.kind;
  if (!KINDS.includes(kind)) throw new HubError(t('create.error.chooseKind'));
  const sections = [];
  if (raw.sections !== undefined && raw.sections !== null) {
    if (!Array.isArray(raw.sections) || raw.sections.length > 30) throw new HubError(t('create.error.invalidField', { name: 'sections' }));
    for (const s of raw.sections) {
      if (!s || typeof s !== 'object') throw new HubError(t('create.error.invalidField', { name: 'sections' }));
      const title = oneLine(s.title, 'section title', 120);
      const body = text(s.body, 'section body');
      if (title || body) sections.push({ title, body });
    }
  }
  const folder = raw.folder === undefined || raw.folder === null ? null : text(raw.folder, 'folder', 200);
  const markdown = raw.markdown === undefined || raw.markdown === null || raw.markdown === '' ? null : text(raw.markdown, 'markdown', MARKDOWN_MAX);
  const model = oneLine(raw.model, 'model', 120);
  return {
    kind,
    name: oneLine(raw.name, 'name', 100).toLowerCase(),
    title: oneLine(raw.title, 'title', 160),
    goal: text(raw.goal, 'goal'),
    role: text(raw.role, 'role'),
    description: oneLine(raw.description, 'description', 4000),
    descriptionEn: oneLine(raw.descriptionEn, 'descriptionEn', 4000),
    model: model === 'inherit' ? '' : model,
    effort: oneLine(raw.effort, 'effort', 20),
    // portable levels (every AI tool) and explicit values for the other tools (Claude uses model/effort)
    modelTier: oneLine(raw.modelTier, 'modelTier', 20),
    effortTier: oneLine(raw.effortTier, 'effortTier', 20),
    toolModels: toolMap(raw.toolModels, 'toolModels'),
    toolEfforts: toolMap(raw.toolEfforts, 'toolEfforts'),
    categories: strings(raw.categories, 'categories', { max: 20, itemMax: 40 }),
    tools: strings(raw.tools, 'tools', { max: 60 }),
    toolsMode: raw.toolsMode === 'all' ? 'all' : 'list',
    requiresCommands: strings(raw.requiresCommands, 'requiresCommands'),
    requiresMcp: strings(raw.requiresMcp, 'requiresMcp'),
    depends: strings(raw.depends, 'depends'),
    conflicts: strings(raw.conflicts, 'conflicts'),
    whenToUse: text(raw.whenToUse, 'whenToUse'),
    procedure: text(raw.procedure, 'procedure'),
    output: text(raw.output, 'output'),
    cautions: text(raw.cautions, 'cautions'),
    howItWorks: text(raw.howItWorks, 'howItWorks'),
    limits: text(raw.limits, 'limits'),
    sections,
    agents: strings(raw.agents, 'agents', { max: 60, itemMax: 100 }),
    skills: strings(raw.skills, 'skills', { max: 100, itemMax: 100 }),
    skillsMode: raw.skillsMode === 'frontmatter' ? 'frontmatter' : 'link',
    folder,
    markdown,
  };
}

// ---------------------------------------------------------------- file generation
/**
 * If the text is "one line = one item" (no pre-existing lists, headings, or paragraphs), formats it as a list;
 * otherwise leaves it as is so callers using custom Markdown or paragraphs keep control.
 */
export function asList(value, ordered = false) {
  const t = String(value ?? '').trim();
  if (!t) return '';
  const lines = t.split('\n');
  const structured = lines.some((l) => /^\s*(?:[-*+]|\d+[.)])\s+\S/.test(l) || /^\s*(?:#{1,6}\s|```|~~~|>\s|\|)/.test(l));
  if (structured || lines.some((l) => !l.trim()) || lines.some((l) => l.length > 400)) return t;
  return lines
    .map((l) => l.trim())
    .map((l, i) => (ordered ? `${i + 1}. ${l}` : `- ${l}`))
    .join('\n');
}

function yamlScalar(v) {
  const s = String(v);
  const plain = /^[\p{L}\p{N}][\p{L}\p{N} ,.()/+_'-]*$/u.test(s) && !/\s$/.test(s) && !/^(true|false|null|yes|no|on|off|y|n)$/i.test(s) && !/^[\d.]+$/.test(s);
  return plain ? s : JSON.stringify(s); // hub parser and Claude Code parser both read quoted strings
}

const titleFromName = (n) => (n ? n.charAt(0).toUpperCase() + n.slice(1).replace(/-/g, ' ') : '');

export function combinedDescription(d) {
  const it = d.description;
  const en = d.descriptionEn;
  if (!en) return it;
  if (!it) return en;
  return `${it}${/[.!?…]$/.test(it) ? '' : '.'} ${en}`;
}

function frontmatterText(d) {
  const lines = ['---', `name: ${d.name}`, `description: ${yamlScalar(combinedDescription(d))}`];
  const list = (key, items) => items.length && lines.push(`${key}: [${items.join(', ')}]`);
  if (d.kind === 'agent') {
    if (d.toolsMode === 'list' && d.tools.length) lines.push(`tools: ${d.tools.join(', ')}`);
  } else if (d.tools.length) {
    lines.push('allowed-tools:', ...d.tools.map((t) => `  - ${yamlScalar(t)}`));
  }
  if (d.model) lines.push(`model: ${yamlScalar(d.model)}`);
  if (d.effort) lines.push(`effort: ${d.effort}`);
  if (d.kind === 'agent') {
    // other AI tools read only agents' models: skills always use the session model there
    if (d.modelTier) lines.push(`model-tier: ${d.modelTier}`);
    if (d.effortTier) lines.push(`effort-tier: ${d.effortTier}`);
    for (const id of OTHER_TOOLS) {
      if (d.toolModels?.[id]) lines.push(`${id}-model: ${yamlScalar(d.toolModels[id])}`);
      if (d.toolEfforts?.[id]) lines.push(`${id}-effort: ${yamlScalar(d.toolEfforts[id])}`);
    }
  }
  if (d.kind === 'agent' && d.skillsMode === 'frontmatter') list('skills', d.skills);
  list('categories', d.categories);
  if (d.kind === 'skill') {
    list('requires-commands', d.requiresCommands);
    list('requires-mcp', d.requiresMcp);
    list('depends', d.depends);
    list('conflicts', d.conflicts);
  }
  lines.push('---');
  return lines.join('\n') + '\n';
}

/** Full file (frontmatter + body) from fields. Pure function. */
export function renderMarkdown(d) {
  const blocks = [`# ${d.title || titleFromName(d.name) || t('create.section.titleFallback')}`];
  const section = (title, body) => body && blocks.push(`## ${title}\n\n${body}`);
  if (d.kind === 'skill') {
    if (d.goal) blocks.push(d.goal);
    section(t('create.section.whenToUse'), asList(d.whenToUse));
    section(t('create.section.procedure'), asList(d.procedure, true));
    section(t('create.section.output'), asList(d.output));
    section(t('create.section.cautions'), asList(d.cautions));
  } else {
    if (d.role) blocks.push(d.role);
    section(t('create.section.goal'), d.goal);
    section(t('create.section.howItWorks'), asList(d.howItWorks, true));
    section(t('create.section.limits'), asList(d.limits));
  }
  for (const s of d.sections) {
    if (s.body) blocks.push(`## ${s.title || t('create.section.notesFallback')}\n\n${s.body}`);
    else if (s.title) blocks.push(`## ${s.title}`);
  }
  return `${frontmatterText(d)}\n${blocks.join('\n\n')}\n`;
}

// ---------------------------------------------------------------- folders
function cleanFolder(kind, value) {
  let s = String(value ?? '').replace(/\\/g, '/').replace(/^\.?\/+/, '').replace(/\/+$/, '');
  if (s.toLowerCase().startsWith(`${BASES[kind]}/`)) s = s.slice(BASES[kind].length + 1);
  else if (s === BASES[kind]) s = '';
  if (!s) return '';
  const segs = s.split('/');
  if (segs.length > 2) throw new HubError(t('create.error.maxFolderDepth'));
  for (const seg of segs) {
    if (!SEGMENT_RE.test(seg)) throw new HubError(t('create.error.invalidFolderName', { seg }));
    if (RESERVED_SEGMENTS.has(seg.toLowerCase())) throw new HubError(t('create.error.reservedFolderName', { seg }));
  }
  return segs.join('/');
}

const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const exists = (p) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/** Pre-existing subfolders under skills/own or agents/own (up to 2 levels, excluding folders that are already skills). */
function listFolders(root, kind) {
  const base = path.join(root, BASES[kind]);
  const out = [];
  const walk = (dir, rel, depth) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!ent.isDirectory() || ent.name.startsWith('.') || ent.name.startsWith('_') || RESERVED_SEGMENTS.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (kind === 'skill' && exists(path.join(full, 'SKILL.md'))) continue; // it is a skill, not a collection folder
      const folder = rel ? `${rel}/${ent.name}` : ent.name;
      out.push(folder);
      if (depth < 1) walk(full, folder, depth + 1);
    }
  };
  walk(base, '', 0);
  return out;
}

function targetPaths(d, folder) {
  const base = [BASES[d.kind], folder].filter(Boolean).join('/');
  const nm = NAME_RE.test(d.name) && d.name.length <= 64 ? d.name : '<name>'; // do not touch disk until name is valid
  return d.kind === 'skill' ? { dirRel: `${base}/${nm}`, fileRel: `${base}/${nm}/SKILL.md`, valid: nm !== '<name>' } : { dirRel: base, fileRel: `${base}/${nm}.md`, valid: nm !== '<name>' };
}

/** Where to save: list of choices (with recommended) and current selection. */
export function planPlacement(root, d, { index = ensureIndex(root), config = readJson(path.join(root, 'hub.config.json'), { categories: {} }) } = {}) {
  const label = (id) => config.categories?.[id]?.label ?? id;
  const countIn = (prefix) => [...index.skills, ...index.agents].filter((e) => e.path.startsWith(`${prefix}/`)).length;
  const explicit = d.categories.filter((c) => config.categories?.[c]);
  const inferred = explicit.length ? [] : inferCategories(config, d.name, [combinedDescription(d), d.goal, d.role, d.whenToUse, d.howItWorks].join(' '));
  const cats = explicit.length ? explicit : inferred;
  const existing = listFolders(root, d.kind);
  const lower = new Map(existing.map((f) => [f.toLowerCase(), f]));

  const options = [];
  const seen = new Set();
  const add = (folder, why, extra = {}) => {
    if (seen.has(folder)) return;
    seen.add(folder);
    const pathRel = [BASES[d.kind], folder].filter(Boolean).join('/');
    options.push({ folder, path: pathRel, exists: folder === '' || existing.includes(folder), count: countIn(pathRel), why, ...extra });
  };

  let recommended;
  if (cats.length) {
    const folder = lower.get(cats[0].toLowerCase()) ?? cats[0];
    recommended = folder;
    add(folder, explicit.length ? t('create.placement.whyExplicit', { label: label(cats[0]) }) : t('create.placement.whyInferred', { label: label(cats[0]) }), { recommended: true });
  } else {
    recommended = '';
    add('', t('create.placement.whyRootDefault'), { recommended: true });
  }
  add('', t('create.placement.whyRoot'));
  for (const c of cats.slice(1)) add(lower.get(c.toLowerCase()) ?? c, t('create.placement.whyOtherCat', { label: label(c) }));
  if (d.kind === 'skill' && d.agents[0]) add(d.agents[0], t('create.placement.whyAgent', { agent: d.agents[0] }));
  for (const f of existing) add(f, t('create.placement.whyExisting'));

  let chosen = recommended;
  if (d.folder !== null) chosen = cleanFolder(d.kind, d.folder);
  const { dirRel, fileRel, valid } = targetPaths(d, chosen);
  const rootDir = path.join(root, BASES[d.kind], ...chosen.split('/').filter(Boolean));
  const insideSkill = d.kind === 'skill' && chosen && exists(path.join(rootDir, 'SKILL.md'));
  return {
    options,
    recommended,
    chosen: { folder: chosen, dirRel, fileRel, isNew: chosen !== '' && !existing.includes(chosen), insideSkill, taken: valid && (exists(path.join(root, ...fileRel.split('/'))) || (d.kind === 'skill' && exists(path.join(root, ...dirRel.split('/'))))) },
    categoriesUsed: cats,
    categoriesInferred: !explicit.length && inferred.length > 0,
  };
}

// ---------------------------------------------------------------- checks
const issue = (level, field, message) => ({ level, field, message });

/** Draft checks: errors (blocking), warnings, and tips. Does not write anything. */
export function checkDraft(root, d, { index = ensureIndex(root), config = readJson(path.join(root, 'hub.config.json'), { categories: {} }), placement = null } = {}) {
  const out = [];
  const byId = new Map([...index.skills, ...index.agents].map((e) => [e.id, e]));
  const kindLabel = d.kind === 'skill' ? 'skill' : 'agent';
  const other = d.kind === 'skill' ? 'agent' : 'skill';

  // name
  if (!d.name) out.push(issue('error', 'name', t('create.issue.nameEmpty')));
  else if (d.name.length > 64 || !NAME_RE.test(d.name)) out.push(issue('error', 'name', t('create.issue.nameInvalid')));
  else {
    const same = byId.get(`${d.kind}:${d.name}`);
    if (same) out.push(issue('error', 'name', t('create.issue.nameExists', { id: same.id, path: same.path })));
    else if (byId.has(`${other}:${d.name}`)) out.push(issue('info', 'name', t('create.issue.nameClashOther', { other: other === 'skill' ? 'a skill' : 'an agent' })));
    if (/claude|anthropic/.test(d.name)) out.push(issue('warn', 'name', t('create.issue.namePlatformReserved')));
  }

  // description
  const desc = combinedDescription(d);
  if (!desc) out.push(issue('error', 'description', t('create.issue.descEmpty', { item: d.kind === 'skill' ? 'the skill' : 'the agent' })));
  else {
    if (desc.length < 50) out.push(issue('warn', 'description', t('create.issue.descShort')));
    if (desc.length > 1536) out.push(issue('warn', 'description', t('create.issue.descLongClaudeCode', { length: desc.length })));
    else if (desc.length > 1024) out.push(issue('warn', 'description', t('create.issue.descLongClaudeAi', { length: desc.length })));
  }

  // model, effort
  if (d.model && !MODEL_IDS.has(d.model)) {
    if (!CUSTOM_MODEL_RE.test(d.model)) out.push(issue('error', 'model', t('create.issue.modelInvalid')));
    else if (!/claude/i.test(d.model)) out.push(issue('warn', 'model', t('create.issue.modelNotClaude', { model: d.model, kind: d.kind === 'agent' ? 'agent' : 'skill' })));
  }
  if (!EFFORT_IDS.has(d.effort)) out.push(issue('error', 'effort', t('create.issue.effortInvalid')));
  if (d.modelTier && !MODEL_TIERS.includes(d.modelTier)) out.push(issue('error', 'modelTier', t('create.issue.modelTierInvalid')));
  if (d.effortTier && !EFFORT_TIERS.includes(d.effortTier)) out.push(issue('error', 'effortTier', t('create.issue.effortTierInvalid')));
  for (const field of ['toolModels', 'toolEfforts']) {
    for (const [id, v] of Object.entries(d[field] ?? {})) if (!TOOL_ID_RE.test(v)) out.push(issue('error', field, t('create.issue.toolIdInvalid', { id, value: v })));
  }

  // categories and lists
  for (const c of d.categories) if (!config.categories?.[c]) out.push(issue('error', 'categories', t('create.issue.unknownCategory', { category: c })));
  for (const tool of d.tools) if (!TOOL_RE.test(tool)) out.push(issue('error', 'tools', t('create.issue.invalidToolName', { tool })));
  for (const c of d.requiresCommands) if (!COMMAND_RE.test(c)) out.push(issue('error', 'requiresCommands', t('create.issue.invalidCommandName', { command: c })));
  for (const m of d.requiresMcp) if (!WORD_RE.test(m)) out.push(issue('error', 'requiresMcp', t('create.issue.invalidMcpName', { mcp: m })));
  for (const r of d.depends) if (!REF_RE.test(r)) out.push(issue('error', 'depends', t('create.issue.invalidRef', { ref: r })));
  for (const r of d.conflicts) if (!REF_RE.test(r)) out.push(issue('error', 'conflicts', t('create.issue.invalidRef', { ref: r })));
  const bare = (r) => r.replace(/^(?:skill|agent):/, '');
  if (d.depends.some((r) => bare(r) === d.name)) out.push(issue('error', 'depends', t('create.issue.selfDepends')));
  if (d.conflicts.some((r) => bare(r) === d.name)) out.push(issue('error', 'conflicts', t('create.issue.selfConflicts')));
  const known = (r) => byId.has(/^(skill|agent):/.test(r) ? r : `skill:${r}`) || byId.has(`agent:${r}`);
  for (const r of d.depends) if (REF_RE.test(r) && !known(r)) out.push(issue('warn', 'depends', t('create.issue.missingDepNotice', { ref: r })));
  for (const c of d.requiresCommands) if (COMMAND_RE.test(c) && !commandExists(c)) out.push(issue('info', 'requiresCommands', t('create.issue.missingCommandNotice', { command: c })));

  // links
  for (const a of d.agents) {
    if (d.kind !== 'skill') break;
    const ref = a.replace(/^agent:/, '');
    if (!REF_RE.test(a) || !byId.has(`agent:${ref}`)) out.push(issue('error', 'agents', t('create.issue.missingAgent', { agent: a })));
  }
  for (const s of d.skills) {
    if (d.kind !== 'agent') break;
    const ref = s.replace(/^skill:/, '');
    if (!REF_RE.test(s) || !byId.has(`skill:${ref}`)) out.push(issue(d.skillsMode === 'link' ? 'error' : 'warn', 'skills', t('create.issue.missingSkill', { skill: s })));
  }

  // content
  if (d.kind === 'skill') {
    if (!d.procedure && !d.sections.some((s) => s.body)) out.push(issue('warn', 'procedure', t('create.issue.procedureEmpty')));
    if (!d.whenToUse) out.push(issue('info', 'whenToUse', t('create.issue.whenToUseEmpty')));
  } else {
    if (!d.role) out.push(issue('info', 'role', t('create.issue.roleEmpty')));
    if (!d.howItWorks) out.push(issue('warn', 'howItWorks', t('create.issue.howItWorksEmpty')));
    if (!d.limits) out.push(issue('info', 'limits', t('create.issue.limitsEmpty')));
    if (d.toolsMode === 'all' || !d.tools.length) out.push(issue('warn', 'tools', t('create.issue.toolsEmptyAll')));
  }
  if (d.tools.some((tool) => /^(Bash|PowerShell)\b/.test(tool))) out.push(issue('info', 'tools', d.kind === 'agent' ? t('create.issue.bashAgent') : t('create.issue.bashSkill')));

  // duplicates
  const mine = new Set(stems(desc));
  if (mine.size >= 5) {
    const pool = d.kind === 'skill' ? index.skills : index.agents;
    for (const e of pool) {
      if (e.name === d.name) continue;
      const theirs = new Set(stems(e.description));
      if (theirs.size < 4) continue;
      const sim = jaccard(mine, theirs);
      if (sim >= 0.5) out.push(issue('warn', 'description', t('create.issue.similarDuplicate', { id: e.id, percent: Math.round(sim * 100) })));
    }
  }

  // where to save
  if (placement) {
    if (placement.chosen.insideSkill) out.push(issue('error', 'folder', t('create.issue.folderIsSkill')));
    if (placement.chosen.taken && !byId.has(`${d.kind}:${d.name}`)) out.push(issue('error', 'folder', t('create.issue.fileRelTaken', { path: placement.chosen.fileRel })));
  }
  return { issues: out, kindLabel };
}

// ---------------------------------------------------------------- preview and creation
/** Verifies a file manually edited in preview: must remain consistent with fields. */
function checkMarkdownOverride(d, md) {
  const out = [];
  const { data, error } = parseFrontmatter(md);
  if (error) out.push(issue('error', 'markdown', t('create.issue.manualMarkdownMissingHeader')));
  else {
    if (String(data.name ?? '').trim() !== d.name) out.push(issue('error', 'markdown', t('create.issue.manualMarkdownNameMismatch', { file: data.name ?? '', fields: d.name })));
    if (!String(data.description ?? '').trim()) out.push(issue('error', 'markdown', t('create.issue.manualMarkdownMissingDesc')));
  }
  return out;
}

export function previewItem(root, raw) {
  const d = normalizeDraft(raw);
  const index = ensureIndex(root);
  const config = readJson(path.join(root, 'hub.config.json'), { categories: {} });
  let placement;
  const issues = [];
  try {
    placement = planPlacement(root, d, { index, config });
  } catch (e) {
    if (!(e instanceof HubError)) throw e;
    placement = planPlacement(root, { ...d, folder: null }, { index, config });
    issues.push(issue('error', 'folder', e.message));
  }
  issues.push(...checkDraft(root, d, { index, config, placement }).issues);
  const generated = renderMarkdown(d);
  if (generated.length > MARKDOWN_MAX) throw new HubError(t('create.error.fileTooLargeMillions', { size: (generated.length / 1e6).toFixed(1).replace('.', ','), max: MARKDOWN_MAX / 1e6 }), 413);
  let markdown = generated;
  if (d.markdown !== null) {
    markdown = cleanText(d.markdown).replace(/\s*$/, '\n');
    issues.push(...checkMarkdownOverride(d, markdown));
  }
  const lines = markdown.split('\n').length - 1;
  if (d.kind === 'skill' && lines > 500) issues.push(issue('info', 'markdown', t('create.issue.fileLinesNotice', { lines })));
  const order = { error: 0, warn: 1, info: 2 };
  issues.sort((a, b) => order[a.level] - order[b.level]);
  return { issues, markdown, generated, edited: d.markdown !== null, placement, lines, bytes: Buffer.byteLength(markdown), canCreate: !issues.some((i) => i.level === 'error') };
}

/** First missing folder path component: used to clean up if writing fails. */
function firstMissing(abs, stopAt) {
  let cur = abs;
  let missing = null;
  while (cur !== stopAt && cur.startsWith(stopAt + path.sep) && !exists(cur)) {
    missing = cur;
    cur = path.dirname(cur);
  }
  return missing;
}

export function createItem(root, raw) {
  const d = normalizeDraft(raw);
  const prev = previewItem(root, raw);
  const errors = prev.issues.filter((i) => i.level === 'error');
  if (errors.length) throw new HubError(t('create.error.cannotCreateYet', { errors: errors.map((e) => e.message).join(' ') }), 422);

  const { dirRel, fileRel, folder } = { ...prev.placement.chosen };
  const baseAbs = path.resolve(root, BASES[d.kind]);
  const fileAbs = path.resolve(root, ...fileRel.split('/'));
  const dirAbs = path.resolve(root, ...dirRel.split('/'));
  if (!fileAbs.startsWith(baseAbs + path.sep) || !dirAbs.startsWith(baseAbs)) throw new HubError(t('create.error.pathNotAllowed'), 400);

  // The new file is created through safefs: every folder from the hub root down is checked (never a symlink or
  // junction, also not `skills/` or `skills/own` themselves), the file is opened with O_EXCL|O_NOFOLLOW and the
  // result is verified, so nothing is written "through" a link even if one appears while we work.
  const toClean = firstMissing(path.dirname(fileAbs), baseAbs);
  try {
    createFileExclusive(root, fileRel.split('/'), prev.markdown, { t });
  } catch (e) {
    if (toClean) fs.rmSync(toClean, { recursive: true, force: true });
    if (e instanceof UnsafePathError) throw new HubError(e.message, 400);
    if (e.code === 'EEXIST') throw new HubError(t('create.error.fileExistsNoOverwrite', { path: fileRel }), 409);
    throw new HubError(t('create.error.cannotWriteFile', { error: e.message }), 500);
  }

  // hub connections (registry.json): from skill to agents, or from agent to skills
  const id = `${d.kind}:${d.name}`;
  const links = [];
  const reg = loadRegistry(root);
  let touched = false;
  if (d.kind === 'skill') for (const a of d.agents) links.push({ from: `agent:${a.replace(/^agent:/, '')}`, to: id });
  else if (d.skillsMode === 'link') for (const s of d.skills) links.push({ from: id, to: `skill:${s.replace(/^skill:/, '')}` });
  for (const l of links) touched = addLink(reg, l.from, l.to) || touched;
  if (touched) saveRegistry(root, reg);

  const index = writeIndex(root, scanHub(root));
  refreshGuideSafe(root);
  const entry = [...index.skills, ...index.agents].find((e) => e.id === id);
  return {
    ok: true,
    id,
    kind: d.kind,
    name: d.name,
    file: toPosix(fileRel),
    folder,
    links,
    lines: prev.lines,
    bytes: prev.bytes,
    risk: entry?.risk ?? 'low',
    warnings: index.warnings.filter((w) => w.id === id).map((w) => w.message),
    message: t('create.log.created', { id, path: toPosix(fileRel) }),
  };
}

// ---------------------------------------------------------------- UI options
export function createOptions(root) {
  const index = ensureIndex(root);
  const config = readJson(path.join(root, 'hub.config.json'), { categories: {} });
  const brief = (e) => ({ id: e.id, name: e.name, origin: e.origin, description: e.description.slice(0, 180) });
  return {
    models: MODELS.map((m) => ({
      id: m.id,
      label: m.id === '' ? t('create.model.inheritLabel') : m.label,
      hint: m.id === '' ? t('create.model.inheritHint') : m.id === 'sonnet' ? t('create.model.sonnetHint') : m.id === 'opus' ? t('create.model.opusHint') : m.id === 'haiku' ? t('create.model.haikuHint') : t('create.model.fableHint'),
    })),
    efforts: EFFORTS.map((e) => ({
      id: e.id,
      label: e.id === '' ? t('create.effort.defaultLabel') : e.id === 'low' ? t('create.effort.lowLabel') : e.id === 'medium' ? t('create.effort.mediumLabel') : e.id === 'high' ? t('create.effort.highLabel') : e.id === 'xhigh' ? t('create.effort.xhighLabel') : t('create.effort.maxLabel'),
      hint: e.id === '' ? t('create.effort.defaultHint') : e.id === 'low' ? t('create.effort.lowHint') : e.id === 'medium' ? t('create.effort.mediumHint') : e.id === 'high' ? t('create.effort.highHint') : e.id === 'xhigh' ? t('create.effort.xhighHint') : t('create.effort.maxHint'),
    })),
    modelTiers: MODEL_TIERS,
    effortTiers: EFFORT_TIERS,
    // AI tools enabled in Settings, with their model and effort lists (providers.json)
    tools: Object.values(loadProviders(root))
      .filter((p) => readSettings(root)[`providers.${p.id}`])
      .map((p) => ({ id: p.id, name: p.name, models: p.models, efforts: p.efforts, tiers: p.tiers ?? {}, effortMap: p.effortMap ?? {} })),
    toolGroups: [
      { id: 'read', label: t('create.toolGroup.read'), tools: [{ name: 'Read', hint: t('create.toolHint.read') }, { name: 'Glob', hint: t('create.toolHint.glob') }, { name: 'Grep', hint: t('create.toolHint.grep') }] },
      { id: 'write', label: t('create.toolGroup.write'), tools: [{ name: 'Write', hint: t('create.toolHint.write') }, { name: 'Edit', hint: t('create.toolHint.edit') }, { name: 'NotebookEdit', hint: t('create.toolHint.notebookEdit') }] },
      { id: 'run', label: t('create.toolGroup.run'), tools: [{ name: 'Bash', hint: t('create.toolHint.bash') }] },
      { id: 'web', label: t('create.toolGroup.web'), tools: [{ name: 'WebSearch', hint: t('create.toolHint.webSearch') }, { name: 'WebFetch', hint: t('create.toolHint.webFetch') }] },
    ],
    toolPresets: [
      { id: 'readonly', label: t('create.toolPreset.readonly'), tools: ['Read', 'Glob', 'Grep'] },
      { id: 'edit', label: t('create.toolPreset.edit'), tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit'] },
      { id: 'shell', label: t('create.toolPreset.shell'), tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash'] },
      { id: 'web', label: t('create.toolPreset.web'), tools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'] },
    ],
    categories: Object.entries(config.categories ?? {}).map(([id, c]) => ({ id, label: c.label ?? id })),
    agents: index.agents.map(brief),
    skills: index.skills.map(brief),
    bases: BASES,
    limits: { field: FIELD_MAX, markdown: MARKDOWN_MAX },
  };
}
