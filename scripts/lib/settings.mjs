// Hub settings (settings.json, versioned: shared across all computers).
// Every option is declared in SCHEMA with type, allowed values, and explanation: the interface renders from here,
// and the server only accepts listed keys and values. A missing or invalid value defaults to its fallback.
import path from 'node:path';
import { readJson, writeJson } from './util.mjs';
import { hubLanguage, translator } from './i18n.mjs';

export const SETTINGS_FILE = 'settings.json';

export const SECTIONS = [
  { id: 'providers', label: 'AI tools' },
  { id: 'dependencies', label: 'Programs required by skills and agents' },
  { id: 'security', label: 'Security of skills from GitHub' },
  { id: 'quality', label: 'Self-critique and improvement' },
  { id: 'tokens', label: 'Token saving (optional)' },
  { id: 'usage', label: 'Skill and agent usage' },
  { id: 'memory', label: 'Memory' },
  { id: 'interface', label: 'Interface' },
  { id: 'sync', label: 'Multi-computer sync' },
];

const LEGACY_GEMINI = 'providers.gemini'; // old name of providers.antigravity: still read, never written

export const SCHEMA = {
  'providers.claude': {
    section: 'providers',
    type: 'boolean',
    default: true,
    label: 'Claude Code',
    help: 'Skills in ~/.claude/skills, agents in ~/.claude/agents, instructions in ~/.claude/CLAUDE.md.',
  },
  'providers.codex': {
    section: 'providers',
    type: 'boolean',
    default: false,
    label: 'Codex (OpenAI)',
    help: 'Skills in ~/.agents/skills, agents converted to TOML in ~/.codex/agents, instructions in ~/.codex/AGENTS.md.',
  },
  'providers.antigravity': {
    section: 'providers',
    type: 'boolean',
    default: false,
    label: 'Antigravity CLI',
    help: 'Skills in ~/.gemini/config/skills, agents in ~/.gemini/config/agents, instructions in ~/.gemini/GEMINI.md.',
  },
  'providers.opencode': {
    section: 'providers',
    type: 'boolean',
    default: false,
    label: 'OpenCode (local models: Ollama, LM Studio…)',
    help: 'Skills in ~/.agents/skills, agents in ~/.config/opencode/agents, instructions in ~/.config/opencode/AGENTS.md. Pick your local model in providers.json or in the Create tab.',
  },
  'dependencies.claudeMayInstall': {
    section: 'dependencies',
    type: 'boolean',
    default: false,
    label: 'Claude may install missing programs',
    help:
      'If a skill or agent requires a missing program (e.g. ffmpeg), Claude installs it automatically with "npm run needs -- --install". ' +
      'Only programs listed in dependencies.json, using the command built by the hub (winget, brew, npm or uv): never commands written by a skill. ' +
      'Disabled: Claude asks you before installing. Claude Code may still ask you to approve the command.',
  },
  'security.skillspector': {
    section: 'security',
    type: 'enum',
    values: ['block', 'warn', 'off'],
    valueLabels: { block: 'Block', warn: 'Warn', off: 'Off' },
    default: 'block',
    label: 'Scan with NVIDIA SkillSpector before installing or updating',
    help:
      'Block: every skill or agent from GitHub is scanned; if SkillSpector says "do not install", if the scan fails, or if SkillSpector is missing, it is not installed. ' +
      'Warn: scans if SkillSpector is present and shows the result, but does not block. Off: no scan (hub checks still apply).',
  },
  'security.skillspectorLlm': {
    section: 'security',
    type: 'boolean',
    default: false,
    label: 'Semantic analysis with an AI model',
    help:
      'In addition to static analysis, SkillSpector has an AI model inspect the skill (more accurate, slower). ' +
      'Requires SKILLSPECTOR_PROVIDER configured in the environment (e.g. claude_cli, anthropic): see the SkillSpector guide.',
  },
  'quality.selfCritique': {
    section: 'quality',
    type: 'enum',
    values: ['final', 'phases', 'off'],
    valueLabels: { final: 'At the end of work', phases: 'At each phase', off: 'Off' },
    default: 'final',
    label: 'Self-critique (skill self-critique)',
    help:
      'After the quality gate, Claude critically reviews the outcome and how it was achieved: weaknesses, unverified assumptions, better alternatives, ' +
      'weak points of skills, agents, and workflows used, with up to 3 concrete proposals. "At each phase" is more accurate but uses more tokens. Skipped for small tasks.',
  },
  'quality.improvements': {
    section: 'quality',
    type: 'enum',
    values: ['propose', 'apply-own'],
    valueLabels: { propose: 'Propose, I decide', 'apply-own': 'Apply to my skills' },
    default: 'propose',
    label: 'What to do with identified improvements',
    help:
      'Propose: Claude presents suggestions to you and you decide. Apply to my skills: Claude automatically modifies your own skills, agents, and workflows ' +
      '(skills/own, agents/own, workflows), then runs doctor and tests and shows you what changed. Third-party items are never modified, ' +
      'and nothing is pushed to GitHub without your confirmation.',
  },
  'quality.recordEvaluations': {
    section: 'quality',
    type: 'boolean',
    default: true,
    label: 'Record evaluations for each task and use them to improve',
    help:
      'After self-critique, Claude records in evaluations/<computer>.jsonl scores per point, the quality gate outcome, retry attempts, and whether the chosen workflow was right. ' +
      '"npm run evaluate -- report" shows recurring weak points, regressions, skills to review, and duplicates; before a similar task Claude receives a heads-up. ' +
      'Only summarized requests and numbers, never secrets. Disabled: does not record or warn.',
  },
  'tokens.savingLevel': {
    section: 'tokens',
    type: 'enum',
    values: ['off', 'light', 'medium', 'max'],
    valueLabels: { off: 'Off', light: 'Light', medium: 'Medium', max: 'Maximum' },
    default: 'off',
    label: 'Token saving level',
    help:
      'Off (default): the system operates normally, quality first. ' +
      'Light: targeted reads and brief reports. Medium: additionally at most one agent and the most capable model only for difficult tasks. ' +
      'Maximum: additionally no agents and the fast model for mechanical tasks. ' +
      'At every level, criteria, tests, quality gate, source verification, and security checks remain mandatory. ' +
      'Claude reads this via "npm run route" (scripts/lib/budget.mjs).',
  },
  'usage.fromTranscripts': {
    section: 'usage',
    type: 'boolean',
    default: true,
    label: 'Count skill and agent usage from Claude Code history',
    help:
      'Reads sessions saved by Claude Code on this machine solely to count how many times each hub skill or agent is used. ' +
      'Saves only name, date, and usage count in usage/<computer>.json (never conversation text); the file syncs to GitHub with the rest, ' +
      'so Windows and Mac counts add together. Disabled: reads nothing, existing saved counts remain. See "npm run usage".',
  },
  'memory.mode': {
    section: 'memory',
    type: 'enum',
    values: ['propose', 'auto', 'off'],
    valueLabels: { propose: 'Search and propose what to save', auto: 'Search and save automatically', off: 'Off' },
    default: 'propose',
    label: 'Memory across tasks (memory/ folder, openable with Obsidian)',
    help:
      'At the start of a non-trivial task, Claude searches notes for relevant decisions, lessons, and metrics; at the end, proposes what to save ' +
      '(or saves automatically with "Search and save automatically"). Only what is useful in the future, never secrets: notes sync to GitHub with the rest. ' +
      'Off: Claude neither reads nor writes notes.',
  },
  'interface.language': {
    section: 'interface',
    type: 'enum',
    values: ['en'],
    valueLabels: { en: 'English' },
    default: 'en',
    label: 'Language',
    help: 'Language of the interface, the guide and command messages.',
  },
  'sync.github': {
    section: 'sync',
    type: 'boolean',
    default: false,
    label: 'Sync this hub between computers through your GitHub repository',
    help: 'Shows the GitHub button (check, download, save and send) and enables "npm run update". Useful if you keep your hub in your own repository and use it on more than one computer.',
  },
  'interface.graphMode': {
    section: 'interface',
    type: 'enum',
    values: ['3d', '2d'],
    valueLabels: { '3d': '3D', '2d': '2D' },
    default: '3d',
    label: 'Initial graph view',
    help: 'In 3D drag to rotate, Shift + drag to pan, wheel to zoom. The button in the graph toggles views on the fly.',
  },
};

function valid(spec, v) {
  if (spec.type === 'boolean') return typeof v === 'boolean';
  if (spec.type === 'enum') return spec.values.includes(v);
  return false;
}

const getPath = (obj, key) => key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
function setPath(obj, key, value) {
  const parts = key.split('.');
  let o = obj;
  for (const k of parts.slice(0, -1)) o = o[k] && typeof o[k] === 'object' && !Array.isArray(o[k]) ? o[k] : (o[k] = {});
  o[parts.at(-1)] = value;
}

/** Flattened settings values {"security.skillspector": "block", …}, always complete and valid. */
export function readSettings(root) {
  let data = {};
  try {
    data = readJson(path.join(root, SETTINGS_FILE), {});
  } catch {
    /* unreadable file: defaults apply (doctor flags it) */
  }
  return Object.fromEntries(Object.entries(SCHEMA).map(([k, spec]) => {
    let v = getPath(data, k);
    if (v === undefined && k === 'providers.antigravity') v = getPath(data, LEGACY_GEMINI); // the choice made when it was called Gemini CLI
    return [k, valid(spec, v) ? v : spec.default];
  }));
}

/** Settings problems (unknown keys, invalid values), for doctor. */
export function settingsProblems(root) {
  let data;
  try {
    data = readJson(path.join(root, SETTINGS_FILE), {});
  } catch (e) {
    return [e.message];
  }
  const t = translator(hubLanguage(root));
  const out = [];
  const walk = (o, prefix) => {
    for (const [k, v] of Object.entries(o ?? {})) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (key === 'version' || key === LEGACY_GEMINI || k.startsWith('_')) continue;
      if (SCHEMA[key]) {
        if (!valid(SCHEMA[key], v)) {
          out.push(t('settings.problem.disallowedValue', {
            file: SETTINGS_FILE,
            key,
            default: JSON.stringify(SCHEMA[key].default),
          }));
        }
      } else if (v && typeof v === 'object' && !Array.isArray(v)) {
        walk(v, key);
      } else {
        out.push(t('settings.problem.unknownOption', {
          file: SETTINGS_FILE,
          key,
        }));
      }
    }
  };
  walk(data, '');
  return out;
}

/** Validates a patch {key: value}; throws readable Error if invalid. */
export function checkPatch(patch, root = null) {
  const t = translator(hubLanguage(root));
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error(t('settings.error.invalid'));
  const entries = Object.entries(patch);
  if (!entries.length) throw new Error(t('settings.error.noChanges'));
  for (const [k, v] of entries) {
    const spec = Object.prototype.hasOwnProperty.call(SCHEMA, k) ? SCHEMA[k] : null;
    if (!spec) throw new Error(t('settings.error.unknown', { key: String(k).slice(0, 60) }));
    if (!valid(spec, v)) throw new Error(t('settings.error.disallowed', { key: k }));
  }
  return entries;
}

/** Applies patch and rewrites settings.json (schema keys only; remainder of file is untouched). */
export function writeSettings(root, patch) {
  const entries = checkPatch(patch, root);
  const file = path.join(root, SETTINGS_FILE);
  let data;
  try {
    data = readJson(file, {});
  } catch {
    data = {};
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
  data.version ??= 1;
  for (const [k, v] of entries) setPath(data, k, v);
  writeJson(file, data);
  return readSettings(root);
}

/** Schema to display (without functions), with current values, localized to hub language. */
export function settingsView(root, { lang } = {}) {
  const l = lang ?? hubLanguage(root);
  const t = translator(l);
  const sections = SECTIONS.map((sec) => ({
    ...sec,
    label: t(`settings.section.${sec.id}.label`),
  }));
  const schema = Object.fromEntries(
    Object.entries(SCHEMA).map(([key, spec]) => {
      const s = { ...spec };
      s.label = t(`settings.${key}.label`);
      s.help = t(`settings.${key}.help`);
      if (spec.valueLabels) {
        s.valueLabels = Object.fromEntries(
          Object.entries(spec.valueLabels).map(([vk, _vl]) => [
            vk,
            t(`settings.${key}.valueLabel.${vk}`),
          ]),
        );
      }
      return [key, s];
    }),
  );
  return { sections, schema, values: readSettings(root) };
}
