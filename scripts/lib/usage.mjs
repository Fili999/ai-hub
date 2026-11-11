// Skill and agent usage and consumption: how often Claude uses them, token estimates, guidance.
// Counts are read from local Claude Code history (~/.claude/projects/**/*.jsonl):
// only calls to the Skill tool, agents (Agent/Task), and /name commands are counted, and only for
// hub items. Saved in usage/<computer>.json (name, date, count: no conversation text),
// versioned: each machine writes only its file and the hub aggregates across machines (Windows + Mac via GitHub).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeDir, listFiles, readJson, slugify, writeJson } from './util.mjs';
import { tFor } from './i18n.mjs';

export const USAGE_DIR = 'usage';
const CACHE_FILE = 'index/usage-cache.json'; // local, unversioned (index/*.json)

/** Estimated tokens for text (~3.5 chars per token across English, code, etc.; ±30%). */
export const estimateTokens = (chars) => Math.ceil(Math.max(0, chars) / 3.5);

/** This machine's filename (from hostname, without domain). */
export function machineName(hostname = os.hostname()) {
  return slugify(String(hostname).split('.')[0]) || 'computer';
}

const day = (ts) => {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};
const lastPart = (n) => String(n ?? '').split(':').pop().trim();
const COMMAND_RE = /<command-name>\/?([A-Za-z0-9][A-Za-z0-9:._-]{0,120})<\/command-name>/g;

/** Uses found in a history line: [{kind, name, uid, day}]. Unreadable lines are ignored. */
export function usesInLine(line, fallbackDay) {
  if (!line.includes('"tool_use"') && !line.includes('<command-name>')) return [];
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return [];
  }
  const msg = obj?.message;
  if (!msg) return [];
  const d = day(obj.timestamp) ?? fallbackDay;
  const out = [];
  const content = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }];
  for (const [i, c] of content.entries()) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'tool_use' && msg.role === 'assistant') {
      const uid = String(c.id ?? `${obj.uuid}:${i}`);
      if (c.name === 'Skill' && c.input?.skill) out.push({ kind: 'skill', name: lastPart(c.input.skill), uid, day: d });
      else if ((c.name === 'Agent' || c.name === 'Task') && c.input?.subagent_type) out.push({ kind: 'agent', name: lastPart(c.input.subagent_type), uid, day: d });
    } else if (msg.role === 'user' && typeof c.text === 'string' && c.text.includes('<command-name>')) {
      for (const m of c.text.matchAll(COMMAND_RE)) out.push({ kind: 'skill', name: lastPart(m[1]), uid: `${obj.uuid}:cmd:${m[1]}`, day: d });
    }
  }
  return out;
}

function usesInFile(file, fsx = fs) {
  const st = fsx.statSync(file);
  const fallback = day(st.mtimeMs);
  const out = [];
  for (const line of fsx.readFileSync(file, 'utf8').split('\n')) for (const u of usesInLine(line, fallback)) out.push([u.kind, u.name, u.uid, u.day]);
  return { size: st.size, mtimeMs: Math.round(st.mtimeMs), uses: out };
}

/**
 * Daily usage counts for known items, from Claude Code history.
 * @param {string} dir   Claude Code projects folder
 * @param {Set<string>} known hub ids ("skill:name", "agent:name"): other names are not tracked
 * @param {{cache?: object}} opt per-file cache (size + mtime): unmodified files are not re-read
 * @returns {{items: Record<string, Record<string, number>>, cache: object, files: number}}
 */
export function countTranscripts(dir, known, { cache = {} } = {}) {
  const files = fs.existsSync(dir) ? listFiles(dir, { maxDepth: 5, maxFiles: 50000 }).filter((f) => f.endsWith('.jsonl')) : [];
  const next = {};
  const seen = new Set(); // a resumed session duplicates prior messages: count each invocation once
  const items = {};
  for (const rel of files) {
    const full = path.join(dir, rel);
    let rec = cache[rel];
    try {
      const st = fs.statSync(full);
      if (!rec || rec.size !== st.size || rec.mtimeMs !== Math.round(st.mtimeMs)) rec = usesInFile(full);
    } catch {
      continue;
    }
    next[rel] = rec;
    for (const [kind, name, uid, d] of rec.uses) {
      const id = `${kind}:${name}`;
      if (!d || seen.has(uid) || !known.has(id)) continue;
      seen.add(uid);
      (items[id] ??= {})[d] = (items[id][d] ?? 0) + 1;
    }
  }
  return { items, cache: next, files: files.length };
}

/** Merges two daily counts taking the max (Claude Code purges old history: saved days persist). */
export function mergeMax(a = {}, b = {}) {
  const out = {};
  for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const days = {};
    for (const d of new Set([...Object.keys(a[id] ?? {}), ...Object.keys(b[id] ?? {})])) days[d] = Math.max(a[id]?.[d] ?? 0, b[id]?.[d] ?? 0);
    out[id] = days;
  }
  return out;
}

const sorted = (items) => Object.fromEntries(Object.keys(items).sort().map((id) => [id, Object.fromEntries(Object.entries(items[id]).sort())]));

/**
 * Updates usage/<computer>.json from local history. Writes only if counts change.
 * @returns {{machine, changed: boolean, files: number}}
 */
export function updateMachineUsage(root, known, { dir = path.join(claudeDir(), 'projects'), machine = machineName() } = {}) {
  const cacheFile = path.join(root, CACHE_FILE);
  let cache = {};
  try {
    cache = readJson(cacheFile, {}).files ?? {};
  } catch {
    /* unreadable cache: re-read everything */
  }
  const r = countTranscripts(dir, known, { cache });
  try {
    writeJson(cacheFile, { version: 1, files: r.cache });
  } catch {
    /* cache is only a performance accelerator */
  }
  const file = path.join(root, USAGE_DIR, `${machine}.json`);
  let prev = {};
  try {
    prev = readJson(file, {}).items ?? {};
  } catch {
    /* corrupted file: rebuild */
  }
  const items = sorted(mergeMax(prev, r.items));
  const changed = JSON.stringify(items) !== JSON.stringify(sorted(prev));
  if (changed) writeJson(file, { version: 1, machine, items });
  return { machine, changed, files: r.files };
}

/** Aggregates files across all machines: {items, machines}. */
export function readAllUsage(root) {
  const dir = path.join(root, USAGE_DIR);
  const items = {};
  const machines = [];
  if (!fs.existsSync(dir)) return { items, machines };
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    let data;
    try {
      data = readJson(path.join(dir, f), {});
    } catch {
      continue;
    }
    machines.push(path.basename(f, '.json'));
    for (const [id, days] of Object.entries(data.items ?? {})) {
      for (const [d, n] of Object.entries(days ?? {})) if (Number.isInteger(n) && n > 0) (items[id] ??= {})[d] = (items[id][d] ?? 0) + n;
    }
  }
  return { items, machines };
}

/** Usage level from uses in the last 90 days. */
export function usageLevel(n90) {
  return n90 === 0 ? 'never' : n90 < 3 ? 'low' : n90 < 10 ? 'medium' : 'high';
}
export const LEVEL_LABEL = { never: 'never used', low: 'rarely used', medium: 'used', high: 'heavily used' };

/** Stats per id: total, last 30 and 90 days, last used, tier, and 0-100 score (relative to most used). */
export function usageStats(items, now = Date.now()) {
  const since = (n) => new Date(now - n * 86400000).toISOString().slice(0, 10);
  const d30 = since(30);
  const d90 = since(90);
  const stats = {};
  for (const [id, days] of Object.entries(items)) {
    const e = Object.entries(days);
    stats[id] = {
      total: e.reduce((s, [, n]) => s + n, 0),
      last30: e.filter(([d]) => d >= d30).reduce((s, [, n]) => s + n, 0),
      last90: e.filter(([d]) => d >= d90).reduce((s, [, n]) => s + n, 0),
      lastUsed: e.map(([d]) => d).sort().at(-1) ?? null,
    };
  }
  const max = Math.max(0, ...Object.values(stats).map((s) => s.last90));
  for (const s of Object.values(stats)) {
    s.level = usageLevel(s.last90);
    s.score = max ? Math.round((100 * Math.log1p(s.last90)) / Math.log1p(max)) : 0;
  }
  return stats;
}

export const EMPTY_STAT = { total: 0, last30: 0, last90: 0, lastUsed: null, level: 'never', score: 0 };

// recommendation thresholds (estimated tokens)
export const HEAVY_BODY = 5000;
export const LONG_DESCRIPTION = 300;
export const BIG_EXTRA = 20000;

/**
 * Guidance on when to use (or avoid) an item: [{level: 'warn'|'tip', text}].
 * @param {object} e    index item (with tokens)
 * @param {object} stat usage stats (EMPTY_STAT if never used)
 * @param {{hasData: boolean}} opt hasData: whether usage counts exist (without data, no usage judgment is made)
 */
export function advise(e, stat, { hasData }, t = tFor()) {
  const tk = e.tokens ?? { description: 0, body: 0, extra: 0 };
  const what = e.kind === 'agent' ? t('usage.thisAgent') : t('usage.thisSkill');
  const out = [];
  if (hasData && stat.last90 === 0) out.push({ level: 'warn', text: t('usage.adviceNotUsed90', { what, desc: tk.description }) });
  if (hasData && (stat.level === 'high' || stat.level === 'alto') && e.origin === 'external' && e.approval !== 'approved') out.push({ level: 'warn', text: t('usage.adviceOftenUsedNotApproved') });
  if (tk.body >= HEAVY_BODY) out.push({ level: 'warn', text: t('usage.adviceHeavy', { body: tk.body }) });
  if (tk.description >= LONG_DESCRIPTION) out.push({ level: 'tip', text: e.origin === 'own' ? t('usage.adviceLongDescriptionOwn', { desc: tk.description }) : t('usage.adviceLongDescriptionThird', { desc: tk.description }) });
  if (tk.extra >= BIG_EXTRA) out.push({ level: 'tip', text: t('usage.adviceExtraFiles', { extra: tk.extra }) });
  if (e.kind === 'agent') out.push({ level: 'tip', text: t('usage.adviceAgentContext', { body: tk.body }) });
  if (hasData && (stat.level === 'high' || stat.level === 'alto') && e.origin === 'own') out.push({ level: 'tip', text: t('usage.adviceMostUsed') });
  return out;
}

/** Full report for CLI and UI. */
export function usageReport(index, items, now = Date.now(), t = tFor()) {
  const stats = usageStats(items, now);
  const hasData = Object.keys(items).length > 0;
  const entries = [...index.skills, ...index.agents].filter((e) => !e.duplicate);
  const rows = entries.map((e) => {
    const stat = stats[e.id] ?? EMPTY_STAT;
    return { id: e.id, name: e.name, kind: e.kind, origin: e.origin, tokens: e.tokens ?? null, ...stat, advice: advise(e, stat, { hasData }, t) };
  });
  rows.sort((a, b) => b.score - a.score || b.total - a.total || a.name.localeCompare(b.name));
  const perSession = entries.reduce((s, e) => s + (e.tokens?.description ?? 0), 0);
  return { hasData, perSession, rows };
}
