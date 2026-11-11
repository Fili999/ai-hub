// AI tools (providers): where each one reads skills, agents and instructions, which models and effort levels it offers,
// and how a hub agent is converted into its format. Hub agents are written once (Markdown + flat frontmatter):
//   model-tier: high | balanced | fast      portable choice, mapped per tool with providers.json "tiers"
//   effort-tier: low | medium | high | max  portable choice, mapped per tool with "effortMap"
//   model / effort                          Claude Code native values (override the tiers for Claude)
//   <tool>-model / <tool>-effort            explicit values for one tool (e.g. codex-model, opencode-effort)
// Skills need no conversion: Claude Code reads ~/.claude/skills, Codex and OpenCode read ~/.agents/skills, Antigravity CLI reads ~/.gemini/config/skills
// (the open Agent Skills standard, SKILL.md).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson } from './util.mjs';

const SHIPPED_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const PROVIDERS_FILE = 'providers.json';
export const PROVIDER_IDS = ['claude', 'codex', 'antigravity', 'opencode'];
export const AGENT_FORMATS = ['claude-md', 'codex-toml', 'antigravity-md', 'opencode-md'];
export const MODEL_TIERS = ['high', 'balanced', 'fast'];
export const EFFORT_TIERS = ['low', 'medium', 'high', 'max'];
const ID_RE = /^[A-Za-z0-9][\w.:@/+-]{0,120}$/; // model and effort ids: no spaces, no quotes
const PATH_KEYS = ['home', 'skillsDir', 'agentsDir', 'instructionsFile'];

/** Problems of one tool's declaration. */
function problemsOf(id, p) {
  const out = [];
  if (!PROVIDER_IDS.includes(id)) out.push(`unknown tool "${id}" (known: ${PROVIDER_IDS.join(', ')})`);
  if (!AGENT_FORMATS.includes(p?.agentFormat)) out.push(`${id}.agentFormat must be one of ${AGENT_FORMATS.join(', ')}`);
  for (const k of PATH_KEYS) {
    const v = p?.[k];
    if (typeof v !== 'string' || !(v === '~' || v.startsWith('~/') || path.isAbsolute(v)) || v.split(/[\\/]/).includes('..')) out.push(`${id}.${k} must start with ~/ or be an absolute path`);
  }
  for (const k of ['models', 'efforts']) {
    if (!Array.isArray(p?.[k]) || p[k].some((x) => typeof x !== 'string' || !ID_RE.test(x))) out.push(`${id}.${k} must be a list of ids without spaces`);
  }
  for (const k of ['tiers', 'effortMap']) {
    if (p?.[k] && Object.values(p[k]).some((x) => typeof x !== 'string' || !ID_RE.test(x))) out.push(`${id}.${k} has an invalid value`);
  }
  return out;
}

/** Problems in providers.json (for doctor and the tests). */
export function providerProblems(data) {
  const list = data?.providers;
  if (!list || typeof list !== 'object' || Array.isArray(list)) return [`${PROVIDERS_FILE}: "providers" is missing`];
  return Object.entries(list).flatMap(([id, p]) => problemsOf(id, p).map((m) => `${PROVIDERS_FILE}: ${m}`));
}

/** The tools declared in providers.json, only the valid ones. */
export function loadProviders(root) {
  // the hub's own copy wins; a hub without it uses the defaults shipped with these scripts
  const own = path.join(root, PROVIDERS_FILE);
  const data = readJson(fs.existsSync(own) ? own : path.join(SHIPPED_ROOT, PROVIDERS_FILE), { providers: {} });
  const list = data?.providers && typeof data.providers === 'object' ? data.providers : {};
  return Object.fromEntries(Object.entries(list).filter(([id, p]) => !problemsOf(id, p).length).map(([id, p]) => [id, { id, ...p }]));
}

/** Absolute paths of a tool on this computer: ~ is the home folder; homeEnv (e.g. CLAUDE_CONFIG_DIR) moves the tool's folder. */
export function providerPaths(p, env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const expand = (v) => path.resolve(v === '~' ? home : v.startsWith('~/') ? path.join(home, v.slice(2)) : v);
  const base = expand(p.home);
  const moved = p.homeEnv && env[p.homeEnv] ? path.resolve(env[p.homeEnv]) : null;
  const rebase = (v) => {
    const abs = expand(v);
    return moved && (abs === base || abs.startsWith(base + path.sep)) ? path.join(moved, path.relative(base, abs)) : abs;
  };
  return { home: moved ?? base, skillsDir: rebase(p.skillsDir), agentsDir: rebase(p.agentsDir), instructionsFile: rebase(p.instructionsFile) };
}

const okId = (v) => typeof v === 'string' && ID_RE.test(v) && v !== 'inherit';

/** Model for this tool: explicit value, then the portable tier; null = the session's model. */
export function agentModel(p, data) {
  const explicit = p.id === 'claude' ? data.model : data[`${p.id}-model`] ?? (p.id === 'antigravity' ? data['gemini-model'] : undefined); // gemini-model: old name, still accepted
  if (okId(explicit)) return explicit;
  const tier = p.tiers?.[data['model-tier']];
  return okId(tier) ? tier : null;
}

/** Effort for this tool: explicit value, then the portable tier; null = the session's default. */
export function agentEffort(p, data) {
  const explicit = p.id === 'claude' ? data.effort : data[`${p.id}-effort`];
  if (okId(explicit)) return explicit;
  const mapped = p.effortMap?.[data['effort-tier']];
  return okId(mapped) ? mapped : null;
}

// Claude Code tool names (the hub's reference) → names used by the other tools.
// Only the names Google documents for Antigravity CLI subagents (https://antigravity.google/docs/subagents). A wrong name can
// hang the subagent, so a tool with no documented name is left out: an agent never gets more than the hub agent allowed.
const ANTIGRAVITY_TOOLS = { Read: 'view_file', Edit: 'replace_file_content', Grep: 'grep_search', Bash: 'run_command' };
const toolList = (v) => (Array.isArray(v) ? v : String(v ?? '').split(',')).map((x) => String(x).trim()).filter(Boolean);
const q = (v) => JSON.stringify(String(v)); // a JSON string is a valid YAML and TOML basic string

/** File name and content of a hub agent for one tool. `text` is the original agent file (used as is by Claude when nothing changes). */
export function convertAgent(p, { name, data, body, text }) {
  const tools = toolList(data.tools);
  const model = agentModel(p, data);
  const effort = agentEffort(p, data);
  const desc = String(data.description ?? '').replace(/\s+/g, ' ').trim();
  const prompt = String(body ?? '').trim() + '\n';
  if (p.agentFormat === 'codex-toml') {
    const writes = tools.length === 0 || tools.some((t) => /^(Write|Edit|Bash|NotebookEdit)\b/.test(t));
    const lines = [`# Generated by ai-hub from agents/…/${name}.md: edit the hub file, then run "npm run sync".`, `name = ${q(name)}`, `description = ${q(desc)}`];
    if (model) lines.push(`model = ${q(model)}`);
    if (effort) lines.push(`model_reasoning_effort = ${q(effort)}`);
    lines.push(`sandbox_mode = ${q(writes ? 'workspace-write' : 'read-only')}`, `developer_instructions = ${q(prompt)}`);
    return { file: `${name}.toml`, content: lines.join('\n') + '\n', generated: true };
  }
  if (p.agentFormat === 'antigravity-md') {
    // Antigravity gives a subagent NO tools unless listed, while a hub agent without "tools" may use everything: list all known ones
    const names = tools.length ? tools.map((t) => t.replace(/\(.*$/, '')) : Object.keys(ANTIGRAVITY_TOOLS);
    const mapped = [...new Set(names.map((t) => ANTIGRAVITY_TOOLS[t]).filter(Boolean))];
    const fm = [`name: ${name}`, `description: ${q(desc)}`];
    if (mapped.length) fm.push('tools:', ...mapped.map((t) => `  - ${t}`));
    if (model) fm.push(`model: ${q(model)}`); // pro | flash; without it the subagent inherits the session's model
    return { file: `${name}.md`, content: `---\n${fm.join('\n')}\n---\n\n${prompt}`, generated: true };
  }
  if (p.agentFormat === 'opencode-md') {
    const has = (re) => tools.length === 0 || tools.some((t) => re.test(t));
    const fm = [`description: ${q(desc)}`, 'mode: subagent'];
    if (model) fm.push(`model: ${q(model)}`);
    if (effort) fm.push(`reasoningEffort: ${q(effort)}`);
    const perm = [!has(/^(Write|Edit|NotebookEdit)\b/) && '  edit: deny', !has(/^Bash\b/) && '  bash: deny', !has(/^Web(Fetch|Search)\b/) && '  webfetch: deny'].filter(Boolean);
    if (perm.length) fm.push('permission:', ...perm);
    return { file: `${name}.md`, content: `---\n${fm.join('\n')}\n---\n\n${prompt}`, generated: true };
  }
  // Claude Code: the hub file as is, unless a portable tier must become a native model/effort value
  const needModel = !okId(data.model) && model;
  const needEffort = !okId(data.effort) && effort;
  if (!needModel && !needEffort) return { file: `${name}.md`, content: null, generated: false };
  const t = String(text).replace(/\r\n?/g, '\n');
  const extra = [needModel && `model: ${model}`, needEffort && `effort: ${effort}`].filter(Boolean).join('\n');
  const content = t.replace(/^---\n([\s\S]*?)\n---/, (m, fm) => `---\n${fm.replace(/^(model|effort):.*\n?/gm, '').replace(/\n*$/, '')}\n${extra}\n---`);
  return { file: `${name}.md`, content, generated: true };
}
