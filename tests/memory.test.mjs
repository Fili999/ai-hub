// Hub memory: Markdown notes in memory/, targeted search, no secrets, never overwrite.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, cleanupAfter, makeHub, run, write } from './helpers.mjs';
import { MemoryError, addNote, appendNote, checkNote, memorySecret, readNotes, searchMemory } from '../scripts/lib/memory.mjs';
import { route } from '../scripts/lib/route.mjs';
import { scanHub } from '../scripts/lib/scan.mjs';

cleanupAfter();

const NOW = new Date('2026-10-26T10:00:00Z');
const lesson = { type: 'lesson', title: 'Shorts with face in first two seconds', body: 'Shorts opening with a face had higher retention.\nNext time: hook on face.', tags: 'video,youtube' };

test('memory: saves new note in type folder, never overwrites, secure frontmatter', () => {
  const root = makeHub();
  const f1 = addNote(root, lesson, NOW);
  assert.equal(f1, 'memory/lessons/2026-10-26-shorts-with-face-in-first-two-seconds.md');
  const f2 = addNote(root, lesson, NOW);
  assert.equal(f2, 'memory/lessons/2026-10-26-shorts-with-face-in-first-two-seconds-2.md', 'same title: new file');
  const text = fs.readFileSync(path.join(root, f1), 'utf8');
  assert.match(text, /^---\ntype: lesson\ntitle: "Shorts with face in first two seconds"\ndate: 2026-10-26\ntags: \[video, youtube\]\n---/);
  // title with risky characters remains a quoted value
  const f3 = addNote(root, { type: 'decision', title: 'a: b\n---\nname: x', body: 'text' }, NOW);
  const { notes } = readNotes(root);
  assert.equal(notes.find((n) => n.file === f3).title, 'a: b --- name: x');
  assert.equal(notes.length, 3);
});

test('memory: rejects secrets, unknown types, empty or too long text', () => {
  const bad = [
    [{ ...lesson, type: 'diary' }, /Invalid type/i],
    [{ ...lesson, title: '' }, /title/i],
    [{ ...lesson, body: ' ' }, /body|text/i],
    [{ ...lesson, body: 'x'.repeat(5000) }, /too long/i],
    [{ ...lesson, body: 'key ghp_' + 'a'.repeat(36) }, /GitHub token/i],
    [{ ...lesson, body: 'the password: Secret123!' }, /password or a key/i],
    [{ ...lesson, tags: ['ok', '!!'] }, /tag/i],
  ];
  for (const [n, re] of bad) assert.throws(() => checkNote(n), (e) => e instanceof MemoryError && re.test(e.message), JSON.stringify(n).slice(0, 60));
  assert.equal(memorySecret('the word password alone is fine'), null);
});

test('memory: targeted update only inside memory/, at bottom and dated', () => {
  const root = makeHub();
  const f = addNote(root, lesson, NOW);
  appendNote(root, f, 'Confirmed on second video.', NOW);
  appendNote(root, f, 'And on third.', NOW);
  const text = fs.readFileSync(path.join(root, f), 'utf8');
  assert.equal(text.match(/## Updates/g).length, 1);
  assert.match(text, /- 2026-10-26: Confirmed on second video\.\n\n?- 2026-10-26: And on third\.\n$/);
  write(root, 'outside.md', 'x');
  for (const p of ['outside.md', 'memory/../outside.md', 'memory/lessons/missing.md', 'memory/README']) assert.throws(() => appendNote(root, p, 'x'), MemoryError, p);
  assert.throws(() => appendNote(root, f, 'token: ghp_' + 'b'.repeat(36)), /GitHub token/i);
});

test('memory: targeted search with excerpts, filters, invalid notes and secrets flagged by doctor', () => {
  const root = makeHub();
  addNote(root, lesson, NOW);
  addNote(root, { type: 'decision', title: 'Hosting website on Vercel', body: 'Chose Vercel for the shop website: low costs.', project: 'shop' }, NOW);
  addNote(root, { type: 'metric', title: 'Short views October', body: '12,000 average views. Source: YouTube Studio.', tags: 'video' }, NOW);
  write(root, 'memory/lessons/no-frontmatter.md', 'note');
  write(root, 'memory/.obsidian/workspace.json', '{}');
  const { notes, problems } = readNotes(root);
  assert.equal(notes.length, 3);
  assert.deepEqual(problems.map((p) => p.level), ['warn']);
  const hits = searchMemory(notes, 'hook of the short', { limit: 5 });
  assert.equal(hits[0].title, lesson.title);
  assert.match(hits[0].excerpt, /hook/i);
  assert.equal(hits[0].body, undefined, 'search does not return full note body');
  assert.deepEqual(searchMemory(notes, 'website', { project: 'shop' }).map((h) => h.type), ['decision']);
  assert.deepEqual(searchMemory(notes, 'video', { type: 'metric' }).map((h) => h.type), ['metric']);
  assert.deepEqual(searchMemory(notes, 'astronomy'), []);
  // secret written by hand into a note is an error for doctor
  write(root, 'memory/lessons/key.md', `---\ntype: lesson\ntitle: x\n---\nAKIA${'A'.repeat(16)}\n`);
  const d = run('doctor.mjs', [], { root });
  assert.notEqual(d.code, 0);
  assert.match(d.out + d.err, /AWS key/i);
});

test('npm run memory: search, add, respects disabled setting', () => {
  const root = makeHub();
  const add = run('memory.mjs', ['add', '--type', 'lesson', '--title', 'Test Note', '--body', 'Test note body', '--json'], { root });
  assert.equal(add.code, 0, add.err);
  assert.match(JSON.parse(add.out).file, /^memory\/lessons\/\d{4}-\d\d-\d\d-test-note\.md$/);
  const s = JSON.parse(run('memory.mjs', ['search', 'test', '--json'], { root }).out);
  assert.equal(s[0].title, 'Test Note');
  assert.equal(run('memory.mjs', ['add', '--type', 'lesson', '--title', 'x', '--body', 'api_key=abcdef123456'], { root }).code, 2);
  assert.equal(run('memory.mjs', ['unknown'], { root }).code, 2);
  write(root, 'settings.json', '{"version":1,"memory":{"mode":"off"}}\n');
  assert.equal(run('memory.mjs', ['search', 'test'], { root }).code, 3);
});

test('routing: memory follows Settings and is skipped on small tasks; memory skill present', () => {
  const index = scanHub(REPO);
  const config = JSON.parse(fs.readFileSync(path.join(REPO, 'hub.config.json'), 'utf8'));
  assert.equal(route(index, config, 'fix login bug', { size: 'medium' }).memory, 'propose');
  assert.equal(route(index, config, 'fix login bug', { size: 'medium', memory: 'auto' }).memory, 'auto');
  assert.equal(route(index, config, 'fix login bug', { size: 'small', memory: 'auto' }).memory, 'off');
  assert.equal(route(index, config, 'write business plan', { size: 'large', memory: 'off' }).memory, 'off');
  const skill = fs.readFileSync(path.join(REPO, 'skills', 'own', 'memory', 'SKILL.md'), 'utf8');
  assert.match(skill, /passwords, keys, tokens/i);
  assert.ok(skill.split('\n').length < 90);
  assert.ok(fs.readFileSync(path.join(REPO, '.gitignore'), 'utf8').includes('memory/.obsidian/'));
});
