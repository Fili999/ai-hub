// Inventory: scans skills/ and agents/, reads frontmatter, and generates the index.
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter, toList } from './frontmatter.mjs';
import { HUB_ROOT, hashPath, listFiles, readJson, sha1, toPosix, writeJson } from './util.mjs';
import { jaccard, stems, tokens, stem } from './text.mjs';
import { normalizeSize, checkFrontmatter, findCycles, parseCapabilities } from './schema.mjs';
import { estimateTokens } from './usage.mjs';
import { OTHER_ASSISTANT_DIRS } from './source.mjs';
import { tFor } from './i18n.mjs';

const t = tFor();

const ORIGINS = ['own', 'external'];
export const INDEX_FILE = 'index/skillindex.json';
// Index format version: included in fingerprint, so an index written by an older version
// of the code regenerates automatically (even if skill and agent files haven't changed).
const INDEX_FORMAT = 6;

// ---------- file discovery ----------

function findSkillDirs(base, depth = 0, acc = []) {
  if (!fs.existsSync(base)) return acc;
  for (const ent of fs.readdirSync(base, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.name.startsWith('.') || ent.name === 'node_modules' || OTHER_ASSISTANT_DIRS.has(ent.name)) continue;
    const dir = path.join(base, ent.name);
    if (fs.existsSync(path.join(dir, 'SKILL.md'))) acc.push(dir);
    // skills in full packages are nested deeper (skills/external/<package>/.../<skill>)
    else if (depth < 8) findSkillDirs(dir, depth + 1, acc);
  }
  return acc;
}

function findAgentFiles(base, depth = 0, acc = []) {
  if (!fs.existsSync(base)) return acc;
  for (const ent of fs.readdirSync(base, { withFileTypes: true })) {
    if (ent.name.startsWith('.') || ent.name.startsWith('_') || ent.name === 'node_modules') continue;
    const full = path.join(base, ent.name);
    if (ent.isDirectory()) {
      if (depth < 3) findAgentFiles(full, depth + 1, acc);
    } else if (ent.isFile() && /\.md$/i.test(ent.name) && !/^readme\.md$/i.test(ent.name)) acc.push(full);
  }
  return acc;
}

/** Workflows: workflows/<name>.md (including subfolders), excluding README. */
function findWorkflowFiles(base, depth = 0, acc = []) {
  if (!fs.existsSync(base)) return acc;
  for (const ent of fs.readdirSync(base, { withFileTypes: true })) {
    if (ent.name.startsWith('.') || ent.name.startsWith('_')) continue;
    const full = path.join(base, ent.name);
    if (ent.isDirectory() && depth < 2) findWorkflowFiles(full, depth + 1, acc);
    else if (ent.isFile() && /\.md$/i.test(ent.name) && !/^readme/i.test(ent.name)) acc.push(full);
  }
  return acc;
}

function discover(root) {
  const skills = [];
  const agents = [];
  for (const origin of ORIGINS) {
    for (const dir of findSkillDirs(path.join(root, 'skills', origin))) skills.push({ origin, dir });
    for (const file of findAgentFiles(path.join(root, 'agents', origin))) agents.push({ origin, file });
  }
  return { skills, agents, workflows: findWorkflowFiles(path.join(root, 'workflows')) };
}

/** Fast lightweight fingerprint of files that determine the index: tells whether regeneration is needed. */
export function fingerprint(root = HUB_ROOT) {
  const { skills, agents, workflows } = discover(root);
  const parts = [];
  const add = (f) => {
    try {
      const st = fs.statSync(f);
      parts.push(`${toPosix(path.relative(root, f))}:${st.size}:${Math.round(st.mtimeMs)}`);
    } catch {
      parts.push(`${toPosix(path.relative(root, f))}:missing`);
    }
  };
  skills.forEach((s) => add(path.join(s.dir, 'SKILL.md')));
  agents.forEach((a) => add(a.file));
  workflows.forEach((f) => add(f));
  ['registry.json', 'manifest.lock.json', 'hub.config.json'].forEach((f) => add(path.join(root, f)));
  return sha1([`format:${INDEX_FORMAT}`, ...parts.sort()].join('\n'));
}

// ---------- risk analysis ----------

const SCRIPT_RE = /\.(sh|bash|zsh|py|js|mjs|cjs|ts|ps1|bat|cmd|rb|pl)$/i;
const RISK_PATTERNS = [
  { flag: 'pipe-to-shell', high: true, re: /(curl|wget|iwr|Invoke-WebRequest)[^\n|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b|\|\s*iex\b/i },
  { flag: 'destructive-cmd', high: true, re: /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r|Remove-Item[^\n]*-Recurse|\bmkfs\b|\bdd\s+if=/i },
  { flag: 'privileged', high: true, re: /\bsudo\b|\bchmod\s+(-R\s+)?777\b/i },
  { flag: 'reads-secrets', high: true, re: /\.ssh\/|\.aws\/credentials|id_rsa/i },
  { flag: 'network-fetch', high: false, re: /\b(curl|wget)\s|\bfetch\(|requests\.(get|post)|Invoke-WebRequest|\biwr\s/i },
];

/** Risk heuristics on a skill (folder) or agent (file). These do not replace human review. */
export function analyzeRisk(target, { external = false, tools = null, isAgent = false } = {}) {
  const flags = new Set();
  let files = [];
  let base = target;
  if (fs.statSync(target).isFile()) {
    base = path.dirname(target);
    files = [path.basename(target)];
  } else files = listFiles(target, { maxDepth: 3, maxFiles: 200 });

  const scripts = files.filter((f) => SCRIPT_RE.test(f));
  const hasScripts = scripts.length > 0;
  if (hasScripts) flags.add('has-scripts');

  const toScan = files.filter((f) => /\.md$/i.test(f) || SCRIPT_RE.test(f)).slice(0, 40);
  for (const f of toScan) {
    let text = '';
    try {
      const full = path.join(base, f);
      if (fs.statSync(full).size > 200_000) continue;
      text = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    for (const p of RISK_PATTERNS) if (p.re.test(text)) flags.add(p.flag);
  }

  const toolList = tools ?? [];
  if (toolList.some((t) => /^(Bash|PowerShell|Shell)\b/i.test(t))) flags.add('uses-shell');
  if (isAgent && tools === null) flags.add('all-tools');
  if (external) flags.add('external');

  const highFlag = RISK_PATTERNS.some((p) => p.high && flags.has(p.flag));
  let risk = 'low';
  if (highFlag) risk = external ? 'high' : 'medium';
  else if (external && ['has-scripts', 'uses-shell', 'network-fetch', 'all-tools'].some((f) => flags.has(f))) risk = 'medium';
  return { flags: [...flags].sort(), risk, hasScripts };
}

// ---------- lettura entry ----------

export function inferCategories(config, name, description) {
  const nameSt = new Set(stems(name));
  const descSt = new Set(stems(description));
  const scored = [];
  for (const [id, cat] of Object.entries(config.categories ?? {})) {
    let score = 0;
    for (const kw of cat.keywords ?? []) {
      const k = stem(tokens(kw)[0] ?? '');
      if (!k) continue;
      if (nameSt.has(k)) score += 2;
      else if (descSt.has(k)) score += 1;
    }
    if (score >= 2) scored.push([id, score]);
  }
  return scored.sort((a, b) => b[1] - a[1]).slice(0, 2).map(([id]) => id);
}

const TEXT_RE = /\.(md|markdown|txt|py|m?js|cjs|ts|sh|ps1|json|ya?ml|toml|html|css|csv|xml)$/i;

/** Estimated tokens: description (in every session where linked), body (on every invocation), other text files (only when read). */
function tokenEstimate(kind, name, description, absPath, absFile) {
  let body = '';
  try {
    body = parseFrontmatter(fs.readFileSync(absFile, 'utf8')).body;
  } catch {
    /* unreadable file: empty body */
  }
  let extra = 0;
  if (kind === 'skill') {
    for (const rel of listFiles(absPath, { maxDepth: 4, maxFiles: 300 })) {
      if (rel === 'SKILL.md' || !TEXT_RE.test(rel)) continue;
      try {
        extra += fs.statSync(path.join(absPath, rel)).size;
      } catch {
        /* deleted in the meantime */
      }
    }
  }
  return { description: estimateTokens(name.length + description.length + 20), body: estimateTokens(body.trim().length), extra: estimateTokens(extra) };
}

const mergeUnique = (...lists) => [...new Set(lists.flat().filter(Boolean))];

function buildEntry({ root, config, registry, lock, kind, origin, name, data, absPath, absFile, hintDirs, warnings }) {
  const id = `${kind}:${name}`;
  for (const w of checkFrontmatter(kind, data, { origin, name })) warnings.push({ ...w, id, message: `${id}: ${w.message}` });
  const description = (Array.isArray(data.description) ? data.description.join(' ') : String(data.description ?? '')).replace(/\s+/g, ' ').trim();
  const ov = registry.overrides?.[id] ?? {};
  const hinted = hintDirs.filter((d) => config.categories?.[d]);
  const categories = mergeUnique(toList(data.categories), toList(ov.categories), hinted);
  for (const c of categories) {
    if (!config.categories?.[c]) warnings.push({ level: 'info', type: 'unknown-category', id, message: t('scan.warning.unknownCategory', { id, category: c }) });
  }
  const tools = toList(kind === 'skill' ? data['allowed-tools'] : data.tools);
  const toolsDeclared = kind === 'skill' ? data['allowed-tools'] != null : data.tools != null;
  const external = origin === 'external';
  const risk = analyzeRisk(absPath, { external, tools: toolsDeclared ? tools : null, isAgent: kind === 'agent' });
  const lockEntry = (lock.entries ?? []).find((e) => e.kind === kind && e.name === name) ?? null;

  return {
    id,
    kind,
    name,
    description,
    origin,
    path: toPosix(path.relative(root, absPath)),
    file: toPosix(path.relative(root, absFile)),
    categories,
    inferredCategories: categories.length ? [] : inferCategories(config, name, description),
    tools,
    capabilities: mergeUnique(parseCapabilities(data.capabilities), parseCapabilities(ov.capabilities)),
    model: data.model ? String(data.model) : null,
    effort: data.effort ? String(data.effort) : null,
    declaredSkills: kind === 'agent' ? toList(data.skills) : [],
    requires: {
      commands: mergeUnique(toList(data['requires-commands']), toList(ov.requiresCommands)),
      mcp: mergeUnique(toList(data['requires-mcp']), toList(ov.requiresMcp)),
    },
    dependsOn: mergeUnique(toList(data.depends), toList(ov.dependsOn)),
    conflictsWith: mergeUnique(toList(data.conflicts), toList(ov.conflictsWith)),
    flags: risk.flags,
    risk: risk.risk,
    hasScripts: risk.hasScripts,
    source: lockEntry?.source ?? null,
    // state declared in lock (hash verification is done by sync, doctor, and /api/approvals)
    approval: lockEntry ? (lockEntry.approval?.status ?? 'review-pending') : external ? 'unregistered' : null,
    package: lockEntry?.package?.sourcePath !== undefined ? lockEntry.package.path : null,
    tokens: tokenEstimate(kind, name, description, absPath, absFile),
    assignedTo: [],
    scope: 'global',
  };
}

// ---------- full scan ----------

export function scanHub(root = HUB_ROOT) {
  const config = readJson(path.join(root, 'hub.config.json'), { categories: {} });
  const registry = readJson(path.join(root, 'registry.json'), { overrides: {}, links: [] });
  const lock = readJson(path.join(root, 'manifest.lock.json'), { entries: [] });
  const warnings = [];
  const found = discover(root);
  const skills = [];
  const agents = [];

  for (const { origin, dir } of found.skills) {
    const file = path.join(dir, 'SKILL.md');
    const { data, error } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    const dirName = path.basename(dir);
    const rel = toPosix(path.relative(path.join(root, 'skills', origin), dir)).split('/').slice(0, -1);
    if (error) warnings.push({ level: 'error', type: 'invalid-frontmatter', id: `skill:${dirName}`, message: `skills/${origin}/${dirName}: ${error}` });
    if (!data.description) warnings.push({ level: 'warn', type: 'missing-description', id: `skill:${dirName}`, message: t('scan.warning.skillMissingDescription', { name: dirName }) });
    const name = data.name ? String(data.name).trim() : dirName;
    if (data.name && name !== dirName) warnings.push({ level: 'warn', type: 'name-mismatch', id: `skill:${name}`, message: t('scan.warning.nameMismatch', { name, dirName }) });
    skills.push(buildEntry({ root, config, registry, lock, kind: 'skill', origin, name, data, absPath: dir, absFile: file, hintDirs: rel, warnings }));
  }

  for (const { origin, file } of found.agents) {
    const { data, error } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    const base = path.basename(file, path.extname(file));
    if (error || !data.name) {
      warnings.push({ level: 'warn', type: 'not-an-agent', id: `agent:${base}`, message: t('scan.warning.notAnAgent', { path: toPosix(path.relative(root, file)) }) });
      continue;
    }
    const rel = toPosix(path.relative(path.join(root, 'agents', origin), file)).split('/').slice(0, -1);
    if (!data.description) warnings.push({ level: 'warn', type: 'missing-description', id: `agent:${String(data.name).trim()}`, message: t('scan.warning.agentMissingDescription', { name: String(data.name).trim() }) });
    agents.push(buildEntry({ root, config, registry, lock, kind: 'agent', origin, name: String(data.name).trim(), data, absPath: file, absFile: file, hintDirs: rel, warnings }));
  }

  // workflows: processes read only by the hub for routing (docs/contracts.md)
  const workflows = [];
  for (const file of found.workflows) {
    const { data, error } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    const rel = toPosix(path.relative(root, file));
    if (error || !data.name) {
      warnings.push({ level: 'warn', type: 'invalid-frontmatter', id: `workflow:${path.basename(file, '.md')}`, message: t('scan.warning.workflowMissingFrontmatter', { path: rel }) });
      continue;
    }
    const name = String(data.name).trim();
    const id = `workflow:${name}`;
    for (const w of checkFrontmatter('workflow', data, { origin: 'own', name })) warnings.push({ ...w, id, message: `${id}: ${w.message}` });
    if (!data.description) warnings.push({ level: 'warn', type: 'missing-description', id, message: t('scan.warning.workflowMissingDescription', { name }) });
    const description = String(data.description ?? '').replace(/\s+/g, ' ').trim();
    const categories = toList(data.categories);
    workflows.push({
      id,
      kind: 'workflow',
      name,
      description,
      origin: 'own',
      path: rel,
      file: rel,
      categories,
      inferredCategories: categories.length ? [] : inferCategories(config, name, description),
      capabilities: parseCapabilities(data.capabilities),
      optionalCapabilities: parseCapabilities(data['optional-capabilities']),
      sizes: [...new Set(toList(data.sizes).map(normalizeSize).filter(Boolean))],
      assignedTo: [],
      risk: 'low',
    });
  }

  // duplicate names. Two IDENTICAL copies of an external item (e.g. a repository publishing the same skills
  // in two folders, such as remotion with packages/skills and packages/codex-plugin) are not an error: the copy
  // with the shorter path is used and the other is ignored.
  const byId = new Map();
  const mirrors = new Set();
  const hashes = new Map();
  const contentHash = (e) => {
    if (!hashes.has(e.path)) hashes.set(e.path, hashPath(path.join(root, e.path)));
    return hashes.get(e.path);
  };
  const preferred = (a, b) => (a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path)) <= 0;
  for (const e of [...skills, ...agents]) {
    const first = byId.get(e.id);
    if (!first) {
      byId.set(e.id, e);
      continue;
    }
    if (first.origin !== 'external' || e.origin !== 'external' || first.duplicate) continue;
    let same = false;
    try {
      same = contentHash(first) === contentHash(e);
    } catch {
      /* unreadable: remains a duplicate */
    }
    if (!same) continue;
    const [keep, drop] = preferred(first, e) ? [first, e] : [e, first];
    mirrors.add(drop);
    byId.set(e.id, keep);
    warnings.push({ level: 'info', type: 'mirror', id: e.id, message: t('scan.warning.mirror', { id: e.id, drop: drop.path, keep: keep.path }) });
  }
  for (const list of [skills, agents]) for (let i = list.length - 1; i >= 0; i--) if (mirrors.has(list[i])) list.splice(i, 1);
  // (in the first pass byId was only used to find identical copies; reconstructed here)
  byId.clear();
  const all = [...skills, ...agents];
  for (const e of all) {
    if (byId.has(e.id)) {
      const first = byId.get(e.id);
      first.duplicate = e.duplicate = true;
      warnings.push({ level: 'error', type: 'duplicate-name', id: e.id, message: t('scan.warning.duplicateName', { id: e.id, first: first.path, second: e.path }), paths: [first.path, e.path] });
    } else byId.set(e.id, e);
  }

  // graph edges
  const edges = [];
  const edgeKeys = new Set();
  const addEdge = (from, to, type) => {
    const k = `${from}>${to}>${type}`;
    if (edgeKeys.has(k)) return;
    edgeKeys.add(k);
    edges.push({ from, to, type });
  };
  const resolveRef = (ref) => (/^(skill|agent):/.test(ref) ? ref : byId.has(`skill:${ref}`) ? `skill:${ref}` : `agent:${ref}`);

  for (const a of agents) {
    for (const s of a.declaredSkills) {
      const to = `skill:${s}`;
      addEdge(a.id, to, 'declared');
      if (!byId.has(to)) warnings.push({ level: 'warn', type: 'missing-skill-ref', id: a.id, message: t('scan.warning.missingSkillRef', { id: a.id, skill: s }) });
    }
  }
  for (const id of Object.keys(registry.overrides ?? {})) {
    if (!byId.has(id)) warnings.push({ level: 'info', type: 'stale-override', id, message: t('scan.warning.staleOverride', { id }) });
  }
  for (const l of registry.links ?? []) {
    if (!byId.has(l.from) || !byId.has(l.to)) {
      warnings.push({ level: 'warn', type: 'broken-link', message: t('scan.warning.brokenLink', { from: l.from, to: l.to }) });
      continue;
    }
    addEdge(l.from, l.to, 'assigned');
  }
  for (const e of all) {
    const written = e.dependsOn; // as written by author: unprefixed name does not specify skill vs agent
    e.dependsOn = written.map(resolveRef);
    e.conflictsWith = e.conflictsWith.map(resolveRef);
    e.dependsOn.forEach((d, i) => {
      addEdge(e.id, d, 'depends');
      if (!byId.has(d)) warnings.push({ level: 'warn', type: 'missing-dependency', id: e.id, message: t('scan.warning.missingDependency', { id: e.id, dependency: written[i] }) });
    });
    for (const c of e.conflictsWith) {
      if (byId.has(c)) warnings.push({ level: 'warn', type: 'conflict', id: e.id, message: t('scan.warning.conflict', { id: e.id, conflict: c }) });
    }
  }

  // capabilities required by workflows without any providing skill or agent
  const offered = new Set(all.flatMap((e) => e.capabilities));
  for (const wf of workflows) {
    for (const c of wf.capabilities) if (!offered.has(c)) warnings.push({ level: 'warn', type: 'capability-unprovided', id: wf.id, message: t('scan.warning.workflowUnprovided', { id: wf.id, capability: c }) });
    for (const c of wf.optionalCapabilities) if (!offered.has(c)) warnings.push({ level: 'info', type: 'capability-unprovided', id: wf.id, message: t('scan.warning.workflowOptionalUnprovided', { id: wf.id, capability: c }) });
  }

  // circular dependencies: neither can be prepared first
  for (const cyc of findCycles(new Map(all.map((e) => [e.id, e.dependsOn])))) {
    warnings.push({ level: 'warn', type: 'dependency-cycle', id: cyc[0], message: t('scan.warning.circularDependencies', { cycles: cyc.join(' → ') }) });
  }

  for (const edge of edges) {
    if (edge.type === 'depends' || !edge.from.startsWith('agent:')) continue;
    const skill = byId.get(edge.to);
    const agent = byId.get(edge.from);
    if (!skill || !agent) continue;
    if (!skill.assignedTo.includes(agent.name)) skill.assignedTo.push(agent.name);
    skill.scope = 'assigned';
  }
  for (const a of agents) {
    a.skills = edges.filter((e) => e.from === a.id && e.type !== 'depends').map((e) => e.to.replace(/^skill:/, ''));
    delete a.declaredSkills;
  }
  for (const s of skills) delete s.declaredSkills;

  // nearly identical skills (potential duplicates)
  if (skills.length <= 3000) {
    const sets = skills.map((s) => new Set(stems(s.description)));
    for (let i = 0; i < skills.length; i++) {
      if (sets[i].size < 6) continue;
      for (let j = i + 1; j < skills.length; j++) {
        if (sets[j].size < 6 || skills[i].name === skills[j].name) continue;
        const sim = jaccard(sets[i], sets[j]);
        if (sim >= 0.7) warnings.push({ level: 'warn', type: 'similar', id: skills[i].id, message: t('scan.warning.similar', { first: skills[i].id, second: skills[j].id, percent: Math.round(sim * 100) }) });
      }
    }
  }

  const sortFn = (a, b) => a.name.localeCompare(b.name);
  skills.sort(sortFn);
  agents.sort(sortFn);

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    fingerprint: fingerprint(root),
    stats: {
      skills: skills.length,
      agents: agents.length,
      workflows: workflows.length,
      own: all.filter((e) => e.origin === 'own').length,
      external: all.filter((e) => e.origin === 'external').length,
      errors: warnings.filter((w) => w.level === 'error').length,
      warnings: warnings.filter((w) => w.level === 'warn').length,
    },
    categories: Object.fromEntries(Object.entries(config.categories ?? {}).map(([id, c]) => [id, { label: c.label }])),
    skills,
    agents,
    workflows,
    edges,
    warnings,
  };
}

export function writeIndex(root = HUB_ROOT, index = scanHub(root)) {
  writeJson(path.join(root, INDEX_FILE), index);
  return index;
}

/** Reads the index; regenerates automatically if missing or files have changed. */
export function ensureIndex(root = HUB_ROOT) {
  const file = path.join(root, INDEX_FILE);
  try {
    const idx = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (idx.fingerprint === fingerprint(root)) return idx;
  } catch {
    /* missing or corrupt: regenerate */
  }
  return writeIndex(root);
}
