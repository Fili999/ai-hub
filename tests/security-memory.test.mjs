// Security regression: memory/ must never be written through symlinks, junctions, hard links or "..",
// including intermediate folders and a folder swapped for a link between the check and the write (TOCTOU).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cleanupAfter, linkDir, linkFile, makeHub, mktmp, run, snapshotTree, write } from './helpers.mjs';
import { MemoryError, addNote, appendNote, readNotes } from '../scripts/lib/memory.mjs';
import { createFileExclusive, relParts, safeDir, UnsafePathError } from '../scripts/lib/safefs.mjs';

cleanupAfter();

const NOW = new Date('2026-10-26T10:00:00Z');
const lesson = { type: 'lesson', title: 'Safe write', body: 'Body of the note.', tags: 'a' };
const note = '---\ntype: lesson\ntitle: "Victim"\ndate: 2026-10-26\n---\n\n# Victim\n\nOriginal.\n';

/** Hub + a separate "outside" folder that must stay byte-identical. */
function setup() {
  const root = makeHub();
  const outside = mktmp();
  write(outside, 'victim.md', note);
  write(outside, 'keep.txt', 'do not touch');
  return { root, outside, before: snapshotTree(outside) };
}
const untouched = (s) => assert.deepEqual(snapshotTree(s.outside), s.before, 'nothing outside the hub was created, changed or overwritten');

test('memory: intermediate folder memory/lessons is a symlink → addNote refuses, outside untouched', () => {
  const s = setup();
  fs.mkdirSync(path.join(s.root, 'memory'));
  linkDir(s.outside, path.join(s.root, 'memory', 'lessons'));
  assert.throws(() => addNote(s.root, lesson, NOW), (e) => e instanceof MemoryError && /symbolic link|junction/i.test(e.message));
  untouched(s);
});

test('memory: memory/ itself is a symlink → addNote refuses, readNotes ignores it', () => {
  const s = setup();
  linkDir(s.outside, path.join(s.root, 'memory'));
  assert.throws(() => addNote(s.root, lesson, NOW), MemoryError);
  const r = readNotes(s.root);
  assert.deepEqual(r.notes, [], 'files behind the link must not enter the search');
  assert.equal(r.problems[0].level, 'error');
  untouched(s);
});

test('memory: appendNote through a symlinked intermediate folder is refused, outside file unchanged', () => {
  const s = setup();
  fs.mkdirSync(path.join(s.root, 'memory'));
  linkDir(s.outside, path.join(s.root, 'memory', 'lessons'));
  assert.throws(() => appendNote(s.root, 'memory/lessons/victim.md', 'injected line', NOW), MemoryError);
  untouched(s);
});

test('memory: final file is a symlink → appendNote refuses, target unchanged', (t) => {
  const s = setup();
  fs.mkdirSync(path.join(s.root, 'memory', 'lessons'), { recursive: true });
  if (!linkFile(path.join(s.outside, 'victim.md'), path.join(s.root, 'memory', 'lessons', 'link.md'))) return t.skip('file symlinks need privileges on this Windows');
  assert.throws(() => appendNote(s.root, 'memory/lessons/link.md', 'injected line', NOW), MemoryError);
  untouched(s);
});

test('memory: final file is a symlink → addNote never overwrites through it', (t) => {
  const s = setup();
  fs.mkdirSync(path.join(s.root, 'memory', 'lessons'), { recursive: true });
  // the exact name addNote would pick first is a dangling symlink to a NEW file outside the hub
  const name = '2026-10-26-safe-write.md';
  if (!linkFile(path.join(s.outside, 'created-by-attack.md'), path.join(s.root, 'memory', 'lessons', name))) return t.skip('file symlinks need privileges on this Windows');
  const file = addNote(s.root, lesson, NOW);
  assert.equal(file, 'memory/lessons/2026-10-26-safe-write-2.md', 'skips the occupied name instead of following the link');
  assert.equal(fs.existsSync(path.join(s.outside, 'created-by-attack.md')), false, 'the link target was not created');
  untouched(s);
});

test('memory: hard link to an outside file is refused for appends', () => {
  const s = setup();
  fs.mkdirSync(path.join(s.root, 'memory', 'lessons'), { recursive: true });
  try {
    fs.linkSync(path.join(s.outside, 'victim.md'), path.join(s.root, 'memory', 'lessons', 'hard.md'));
  } catch {
    return; // filesystem without hard links: nothing to test
  }
  assert.throws(() => appendNote(s.root, 'memory/lessons/hard.md', 'injected line', NOW), (e) => e instanceof MemoryError && /hard link/i.test(e.message));
  untouched(s);
});

test('memory: "..", absolute, drive-letter, mixed-separator and NUL paths are rejected', () => {
  const s = setup();
  const f = addNote(s.root, lesson, NOW);
  write(s.root, 'secret-outside-memory.md', 'x');
  const bad = [
    'memory/../secret-outside-memory.md',
    'memory/lessons/../../secret-outside-memory.md',
    'memory\\..\\secret-outside-memory.md',
    'memory/lessons\\..\\..\\secret-outside-memory.md',
    path.join(s.root, f), // absolute, even if it points inside memory/
    '/etc/hosts',
    'C:\\Windows\\win.ini',
    '\\\\server\\share\\x.md',
    'memory/lessons/x.md\0.txt',
    '',
    'memory',
    'memory/lessons/not-markdown.txt',
    'Memory-other/lessons/x.md',
  ];
  for (const p of bad) assert.throws(() => appendNote(s.root, p, 'x', NOW), MemoryError, JSON.stringify(p));
  assert.equal(fs.readFileSync(path.join(s.root, 'secret-outside-memory.md'), 'utf8'), 'x');
  // the same path written with the other separator is still the same (inside) note
  assert.equal(appendNote(s.root, f.replaceAll('/', '\\'), 'ok on every platform', NOW), f);
});

test('memory: missing folders — append creates nothing, add creates real folders only', () => {
  const s = setup();
  assert.throws(() => appendNote(s.root, 'memory/nonexistent/x.md', 'x', NOW), /not found/i);
  assert.equal(fs.existsSync(path.join(s.root, 'memory', 'nonexistent')), false, 'append never creates folders');
  const f = addNote(s.root, lesson, NOW);
  assert.ok(fs.lstatSync(path.join(s.root, 'memory', 'lessons')).isDirectory());
  assert.ok(!fs.lstatSync(path.join(s.root, 'memory', 'lessons')).isSymbolicLink());
  assert.equal(f, 'memory/lessons/2026-10-26-safe-write.md');
});

test('memory TOCTOU: folder swapped for a symlink between the check and the create → refused and undone', () => {
  const s = setup();
  fs.mkdirSync(path.join(s.root, 'memory', 'lessons'), { recursive: true });
  const swap = () => {
    fs.renameSync(path.join(s.root, 'memory', 'lessons'), path.join(s.root, 'memory', 'lessons.real'));
    linkDir(s.outside, path.join(s.root, 'memory', 'lessons'));
  };
  assert.throws(() => addNote(s.root, lesson, NOW, { beforeOpen: swap }), (e) => e instanceof MemoryError && /changed while|symbolic/i.test(e.message));
  untouched(s); // the file created through the swapped link was removed again
});

test('memory TOCTOU: folder swapped for a symlink between the check and the append → refused, outside file unchanged', () => {
  const s = setup();
  fs.mkdirSync(path.join(s.root, 'memory', 'lessons'), { recursive: true });
  write(s.root, 'memory/lessons/victim.md', note); // a legitimate note with the same name
  const swap = () => {
    fs.renameSync(path.join(s.root, 'memory', 'lessons'), path.join(s.root, 'memory', 'lessons.real'));
    linkDir(s.outside, path.join(s.root, 'memory', 'lessons'));
  };
  assert.throws(() => appendNote(s.root, 'memory/lessons/victim.md', 'injected line', NOW, { beforeOpen: swap }), MemoryError);
  untouched(s);
});

test('memory TOCTOU: the real write path is still fine when nothing is swapped', () => {
  const s = setup();
  const f = addNote(s.root, lesson, NOW, { beforeOpen: () => {} });
  appendNote(s.root, f, 'Confirmed.', NOW, { beforeOpen: () => {} });
  assert.match(fs.readFileSync(path.join(s.root, f), 'utf8'), /Confirmed\./);
});

test('npm run memory (CLI): a symlinked folder makes both commands fail without touching the outside', () => {
  const s = setup();
  fs.mkdirSync(path.join(s.root, 'memory'));
  linkDir(s.outside, path.join(s.root, 'memory', 'lessons'));
  const add = run('memory.mjs', ['add', '--type', 'lesson', '--title', 'T', '--body', 'B'], { root: s.root });
  assert.equal(add.code, 2, add.err);
  const app = run('memory.mjs', ['append', 'memory/lessons/victim.md', '--body', 'injected'], { root: s.root });
  assert.equal(app.code, 2, app.err);
  untouched(s);
});

test('safefs: relParts / safeDir / createFileExclusive building blocks', () => {
  assert.deepEqual(relParts('a/./b\\c'), ['a', 'b', 'c']);
  for (const bad of ['', '..', 'a/../b', '/abs', 'C:x', '\\\\unc\\x', 'a\0b']) assert.throws(() => relParts(bad), UnsafePathError, JSON.stringify(bad));
  const root = mktmp();
  const outside = mktmp();
  fs.mkdirSync(path.join(root, 'ok'));
  linkDir(outside, path.join(root, 'bad'));
  assert.ok(safeDir(root, ['ok']).endsWith('ok'));
  assert.throws(() => safeDir(root, ['bad']), UnsafePathError);
  assert.throws(() => safeDir(root, ['bad', 'deeper'], { create: true }), UnsafePathError);
  assert.throws(() => createFileExclusive(root, ['bad', 'x.md'], 'x'), UnsafePathError);
  assert.deepEqual(fs.readdirSync(outside), []);
  createFileExclusive(root, ['ok', 'sub', 'x.md'], 'x');
  assert.throws(() => createFileExclusive(root, ['ok', 'sub', 'x.md'], 'y'), (e) => e.code === 'EEXIST', 'never overwrites');
  assert.equal(fs.readFileSync(path.join(root, 'ok', 'sub', 'x.md'), 'utf8'), 'x');
});
