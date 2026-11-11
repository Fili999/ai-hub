// Hub memory: Markdown notes in memory/, openable as an Obsidian vault and synchronized via GitHub.
// Only what has future value: decisions, lessons, metrics. Never secrets: every write passes the secret
// check from repo.mjs plus assignment checks ("password: ..."). Writes only inside memory/, never overwriting.
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter, toList } from './frontmatter.mjs';
import { listFiles, slugify, toPosix } from './util.mjs';
import { secretInText } from './repo.mjs';
import { norm, stems } from './text.mjs';
import { tFor } from './i18n.mjs';

export const MEMORY_DIR = 'memory';

/** Note types and their folders (as they appear in Obsidian). */
export const TYPES = {
  decision: { folder: 'decisions', label: 'Decision' },
  lesson: { folder: 'lessons', label: 'Lesson' },
  metric: { folder: 'metrics', label: 'Metric' },
};

export const TITLE_MAX = 120;
export const BODY_MAX = 4000; // a useful note is brief: beyond, summarize
const TAG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ASSIGNED_SECRET = /\b(password|passwd|pwd|api[_-]?key|secret|token|bearer)\b\s*[:=]\s*\S{6,}/i;

/** Reason why text cannot enter memory (secret), or null. */
export function memorySecret(text, t = tFor()) {
  return secretInText(text) ?? (ASSIGNED_SECRET.test(text) ? t('memory.assignedSecret') : null);
}

export class MemoryError extends Error {}

const yaml = (s) => JSON.stringify(String(s));

/** Checks and normalizes a new note. Throws MemoryError with a clear message. */
export function checkNote({ type, title, body, tags = [], project = '' } = {}, t = tFor()) {
  if (!TYPES[type]) throw new MemoryError(t('memory.badType', { types: Object.keys(TYPES).join(', ') }));
  const titleStr = String(title ?? '').replace(/\s+/g, ' ').trim();
  if (!titleStr) throw new MemoryError(t('memory.badTitle'));
  if (titleStr.length > TITLE_MAX) throw new MemoryError(t('memory.badTitleTooLong', { max: TITLE_MAX }));
  const b = String(body ?? '').replace(/\r\n/g, '\n').trim();
  if (!b) throw new MemoryError(t('memory.badBody'));
  if (b.length > BODY_MAX) throw new MemoryError(t('memory.badBodyTooLong', { max: BODY_MAX }));
  const raw = toList(tags).map((x) => String(x).trim()).filter(Boolean);
  const tg = raw.map((x) => slugify(x));
  const bad = raw.find((x, i) => !TAG_RE.test(tg[i]));
  if (bad !== undefined) throw new MemoryError(t('memory.badTag', { bad: bad.slice(0, 40) }));
  const p = slugify(project ?? '');
  const why = memorySecret(`${titleStr}\n${b}\n${tg.join(' ')}\n${p}`, t);
  if (why) throw new MemoryError(t('memory.secretRejected', { why }));
  return { type, title: titleStr, body: b, tags: [...new Set(tg)], project: p };
}

/** Markdown text of the note (frontmatter with JSON-quoted values). */
export function renderNote(n, date) {
  const fm = [`type: ${n.type}`, `title: ${yaml(n.title)}`, `date: ${date}`];
  if (n.tags.length) fm.push(`tags: [${n.tags.join(', ')}]`);
  if (n.project) fm.push(`project: ${n.project}`);
  return `---\n${fm.join('\n')}\n---\n\n# ${n.title}\n\n${n.body}\n`;
}

/** Saves a new note in memory/<folder>/<date>-<title>.md. Never overwrites. Returns relative path. */
export function addNote(root, raw, now = new Date()) {
  const t = tFor(root);
  const n = checkNote(raw, t);
  const date = now.toISOString().slice(0, 10);
  const dir = path.join(root, MEMORY_DIR, TYPES[n.type].folder);
  fs.mkdirSync(dir, { recursive: true });
  const base = `${date}-${slugify(n.title).slice(0, 60) || 'note'}`;
  for (let i = 1; i < 100; i++) {
    const file = path.join(dir, `${base}${i > 1 ? `-${i}` : ''}.md`);
    try {
      fs.writeFileSync(file, renderNote(n, date), { flag: 'wx' });
      return toPosix(path.relative(root, file));
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw new MemoryError(t('memory.tooManyNotesSameDay'));
}

/** Path of an existing note inside memory/ (no "..", no symlinks, .md only). */
function notePath(root, rel, t = tFor(root)) {
  const base = path.resolve(root, MEMORY_DIR);
  const full = path.resolve(root, String(rel ?? ''));
  if (!full.startsWith(base + path.sep) || !full.endsWith('.md')) throw new MemoryError(t('memory.badAppendPath'));
  let st;
  try {
    st = fs.lstatSync(full);
  } catch {
    throw new MemoryError(t('memory.noteNotFound', { rel }));
  }
  if (!st.isFile()) throw new MemoryError(t('memory.badNotFile'));
  return full;
}

/** Appends a dated line at the bottom, without touching the rest. */
export function appendNote(root, rel, text, now = new Date()) {
  const t = tFor(root);
  const full = notePath(root, rel, t);
  const textStr = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (!textStr) throw new MemoryError(t('memory.badAppendText'));
  const current = fs.readFileSync(full, 'utf8');
  if (current.length + textStr.length > BODY_MAX * 2) throw new MemoryError(t('memory.badAppendTooLong'));
  const why = memorySecret(textStr, t);
  if (why) throw new MemoryError(t('memory.secretRejectedAppend', { why }));
  const head = current.includes('\n## Updates\n') ? '' : '\n## Updates\n';
  fs.appendFileSync(full, `${current.endsWith('\n') ? '' : '\n'}${head}\n- ${now.toISOString().slice(0, 10)}: ${textStr.replace(/\n+/g, ' ')}\n`);
  return toPosix(path.relative(root, full));
}

/** All readable notes: {file, type, title, date, tags, project, body}. Invalid notes are reported separately. */
export function readNotes(root) {
  const t = tFor(root);
  const dir = path.join(root, MEMORY_DIR);
  if (!fs.existsSync(dir)) return { notes: [], problems: [] };
  const notes = [];
  const problems = [];
  for (const rel of listFiles(dir, { maxDepth: 4, maxFiles: 5000 }).filter((f) => f.endsWith('.md') && !f.startsWith('.obsidian/'))) {
    const file = `${MEMORY_DIR}/${rel}`;
    let text;
    try {
      text = fs.readFileSync(path.join(dir, rel), 'utf8');
    } catch {
      continue;
    }
    if (rel === 'README.md') continue;
    const { data, body, error } = parseFrontmatter(text);
    const why = memorySecret(text, t);
    if (why) problems.push({ level: 'error', file, message: t('memory.problemSecret', { file, why }) });
    if (error || !TYPES[data.type] || !data.title) {
      problems.push({ level: 'warn', file, message: t('memory.problemMissingFields', { file, types: Object.keys(TYPES).join(', ') }) });
      continue;
    }
    notes.push({ file, type: data.type, title: String(data.title), date: data.date ? String(data.date) : null, tags: toList(data.tags).map(String), project: data.project ? String(data.project) : null, body: body.trim() });
  }
  return { notes, problems };
}

/**
 * Targeted search: title and tags are weighted more than body text; returns an excerpt rather than the full note.
 * @returns {{file, type, title, date, tags, project, score, excerpt}[]}
 */
export function searchMemory(notes, query, { type, tag, project, limit = 5 } = {}) {
  const q = [...new Set(stems(query))];
  const out = [];
  for (const n of notes) {
    if (type && n.type !== type) continue;
    if (tag && !n.tags.includes(tag)) continue;
    if (project && n.project !== project) continue;
    const title = new Set(stems(n.title));
    const tags = new Set(stems(n.tags.join(' ')));
    const body = new Set(stems(n.body));
    let score = 0;
    for (const s of q) score += (title.has(s) ? 3 : 0) + (tags.has(s) ? 2 : 0) + (body.has(s) ? 1 : 0);
    if (q.length > 1 && norm(n.body).includes(norm(query))) score += 2;
    if (!q.length || score > 0) out.push({ ...n, score, excerpt: excerpt(n.body, q) });
  }
  return out
    .sort((a, b) => b.score - a.score || String(b.date).localeCompare(String(a.date)))
    .slice(0, limit)
    .map(({ body, ...rest }) => rest);
}

/** Lines containing searched terms (up to 3), or the start of the note. */
function excerpt(body, q) {
  const lines = body.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('# '));
  const hits = lines.filter((l) => stems(l).some((s) => q.includes(s)));
  return (hits.length ? hits : lines).slice(0, 3).join(' · ').slice(0, 400);
}
