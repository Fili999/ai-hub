// Create tab model (DOM-free for standalone testing): draft, steps, counts, error-to-step mapping.
import { t, lang } from './i18n.js';

// message keys: the page translates them with t()
export const STEP_LABELS = ['ui.create.step.type', 'ui.create.step.identity', 'ui.create.step.content', 'ui.create.step.settings', 'ui.create.step.save'];
export const LAST_STEP = STEP_LABELS.length - 1;

/** Step location of each field: used to flag steps with errors and navigate to the right field. */
export const FIELD_STEP = {
  name: 1,
  title: 1,
  goal: 1,
  role: 1,
  description: 1,
  whenToUse: 2,
  procedure: 2,
  output: 2,
  cautions: 2,
  howItWorks: 2,
  limits: 2,
  sections: 2,
  model: 3,
  effort: 3,
  modelTier: 3,
  effortTier: 3,
  toolModels: 3,
  toolEfforts: 3,
  tools: 3,
  categories: 3,
  requiresCommands: 3,
  requiresMcp: 3,
  depends: 3,
  conflicts: 3,
  agents: 3,
  skills: 3,
  folder: 4,
  markdown: 4,
};
export const stepOfField = (field) => FIELD_STEP[field] ?? LAST_STEP;

export function slugify(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
}

export const DEFAULT_AGENT_TOOLS = ['Read', 'Glob', 'Grep'];

export function emptyDraft(kind) {
  return {
    kind,
    name: '',
    nameTouched: false, // name follows title until edited manually
    title: '',
    goal: '',
    role: '',
    description: '',
    descriptionEn: '',
    model: '',
    effort: '',
    modelTier: '', // portable tier: applies across AI tools
    effortTier: '',
    toolModels: {}, // {codex: 'id', antigravity: 'pro | flash', opencode: 'ollama/…'}
    toolEfforts: {},
    categories: [],
    tools: kind === 'agent' ? [...DEFAULT_AGENT_TOOLS] : [],
    toolsMode: 'list',
    requiresCommands: [],
    requiresMcp: [],
    depends: [],
    conflicts: [],
    whenToUse: '',
    procedure: '',
    output: '',
    cautions: '',
    howItWorks: '',
    limits: '',
    sections: [],
    agents: [],
    skills: [],
    skillsMode: 'link',
    folder: null, // null = recommended folder
    markdown: null, // null = file generated from fields; text = edited manually
  };
}

/** Switches type preserving common fields (title, name, descriptions, goal, model, categories). */
export function switchKind(draft, kind) {
  if (draft.kind === kind) return draft;
  const next = emptyDraft(kind);
  for (const k of ['name', 'nameTouched', 'title', 'goal', 'description', 'descriptionEn', 'model', 'effort', 'modelTier', 'effortTier', 'categories']) next[k] = Array.isArray(draft[k]) ? [...draft[k]] : draft[k];
  return next;
}

/** Request payload for server: draft without page-only fields. */
export function toPayload(draft) {
  const { nameTouched, ...rest } = draft; // eslint-disable-line no-unused-vars
  return rest;
}

/** "ffmpeg, git" or one per line → ["ffmpeg", "git"] without duplicates. */
export function splitList(text) {
  return [...new Set(String(text ?? '').split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean))];
}

export function textStats(text) {
  const tStr = String(text ?? '');
  if (!tStr.trim()) return { chars: 0, words: 0, lines: 0 };
  return { chars: tStr.length, words: tStr.trim().split(/\s+/).length, lines: tStr.split('\n').length };
}

export const fmtInt = (n) => Number(n).toLocaleString(lang === 'it' ? 'it-IT' : 'en-US');

export function statsLabel(text) {
  const s = textStats(text);
  if (!s.chars) return t('ui.create.empty');
  return `${fmtInt(s.lines)} ${t.n('ui.create.line', s.lines)} · ${fmtInt(s.words)} ${t('ui.create.words')} · ${fmtInt(s.chars)} ${t('ui.create.chars')}`;
}

/** Description length guidance: too short, optimal, long for claude.ai or Claude Code. */
export function descriptionTone(chars) {
  if (!chars) return { tone: 'idle', text: t('ui.create.descRequired') };
  if (chars < 50) return { tone: 'warn', text: t('ui.create.descShort', { chars }) };
  if (chars <= 1024) return { tone: 'ok', text: t('ui.create.descChars', { chars: fmtInt(chars) }) };
  if (chars <= 1536) return { tone: 'caution', text: t('ui.create.descClaudeAiLimit', { chars: fmtInt(chars) }) };
  return { tone: 'warn', text: t('ui.create.descClaudeCodeLimit', { chars: fmtInt(chars) }) };
}

export const combinedLength = (d) => [d.description.trim(), d.descriptionEn.trim()].filter(Boolean).join(' ').length + (d.description.trim() && d.descriptionEn.trim() && !/[.!?…]$/.test(d.description.trim()) ? 1 : 0);

export function issuesByField(issues = []) {
  const map = new Map();
  for (const i of issues) map.set(i.field, [...(map.get(i.field) ?? []), i]);
  return map;
}

/** Per step: error and warning counts (info notices are excluded). */
export function stepStatus(issues = []) {
  const out = STEP_LABELS.map(() => ({ errors: 0, warns: 0 }));
  for (const i of issues) {
    const s = out[stepOfField(i.field)];
    if (i.level === 'error') s.errors++;
    else if (i.level === 'warn') s.warns++;
  }
  return out;
}

export const hasContent = (d) =>
  ['title', 'goal', 'role', 'description', 'descriptionEn', 'whenToUse', 'procedure', 'output', 'cautions', 'howItWorks', 'limits'].some((k) => String(d[k] ?? '').trim()) || d.sections.some((s) => s.title.trim() || s.body.trim());

const LIST_KEYS = ['categories', 'tools', 'requiresCommands', 'requiresMcp', 'depends', 'conflicts', 'agents', 'skills'];
const TEXT_KEYS = ['name', 'title', 'goal', 'role', 'description', 'descriptionEn', 'model', 'effort', 'modelTier', 'effortTier', 'whenToUse', 'procedure', 'output', 'cautions', 'howItWorks', 'limits'];

/** Restores draft saved by browser: discards malformed data, fills default missing fields. */
export function restoreDraft(raw) {
  let data = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== 'object' || !['skill', 'agent'].includes(data.kind)) return null;
  const d = emptyDraft(data.kind);
  for (const k of TEXT_KEYS) if (typeof data[k] === 'string') d[k] = data[k];
  for (const k of LIST_KEYS) if (Array.isArray(data[k])) d[k] = data[k].filter((x) => typeof x === 'string');
  const strMap = (m) => (m && typeof m === 'object' && !Array.isArray(m) ? Object.fromEntries(Object.entries(m).filter(([k, v]) => /^[a-z]{2,20}$/.test(k) && typeof v === 'string')) : {});
  d.toolModels = strMap(data.toolModels);
  d.toolEfforts = strMap(data.toolEfforts);
  d.nameTouched = data.nameTouched === true;
  d.toolsMode = data.toolsMode === 'all' ? 'all' : 'list';
  d.skillsMode = data.skillsMode === 'frontmatter' ? 'frontmatter' : 'link';
  d.folder = typeof data.folder === 'string' ? data.folder : null;
  d.markdown = typeof data.markdown === 'string' ? data.markdown : null;
  if (Array.isArray(data.sections)) d.sections = data.sections.filter((s) => s && typeof s.title === 'string' && typeof s.body === 'string').map((s) => ({ title: s.title, body: s.body }));
  return d;
}

/** Is file ready to be saved? (no server errors and no preview pending) */
export const canCreate = (preview, pending) => Boolean(preview?.canCreate) && !pending;

/** Path displayed before creation. */
export const targetLabel = (preview) => preview?.placement?.chosen?.fileRel ?? '';
