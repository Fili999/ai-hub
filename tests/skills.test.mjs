// Core hub skills: file structure and activation via catalog search.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './helpers.mjs';
import { scanHub } from '../scripts/lib/scan.mjs';
import { searchIndex } from '../scripts/lib/search.mjs';
import { parseFrontmatter } from '../scripts/lib/frontmatter.mjs';
import { KEBAB_RE } from '../scripts/lib/schema.mjs';
import { stem, stemCollisions } from '../scripts/lib/text.mjs';

const CORE = ['task-intake', 'acceptance-criteria', 'quality-gate', 'structured-handoff', 'source-verification', 'decision-record', 'self-critique'];
const index = scanHub(REPO);
const config = JSON.parse(fs.readFileSync(path.join(REPO, 'hub.config.json'), 'utf8'));
// skills only: starter agents (planner, researcher...) have their own tests
const top = (q) => searchIndex(index, config, q, { limit: 5, kind: 'skill' }).map((r) => r.e.name);

test('core skills: present, contract satisfied, required sections, concise', () => {
  for (const name of CORE) {
    const file = path.join(REPO, 'skills', 'own', name, 'SKILL.md');
    const text = fs.readFileSync(file, 'utf8');
    const { data } = parseFrontmatter(text);
    assert.equal(data.name, name);
    assert.match(name, KEBAB_RE);
    assert.ok(Array.isArray(data.capabilities) && data.capabilities.includes(name), `${name}: must declare its capability`);
    assert.ok(data.description && data.description.length > 20, `${name}: description in English required`);
    for (const h of ['## When to use', '## When not to use', '## Procedure', '## Expected output']) assert.ok(text.includes(h), `${name}: missing "${h}"`);
    assert.ok(text.split('\n').length < 90, `${name}: too long (costs context on every use)`);
  }
  const own = new Set(index.warnings.filter((w) => w.level !== 'info' && CORE.some((n) => w.id === `skill:${n}`)).map((w) => w.message));
  assert.deepEqual([...own], [], 'no warnings from inventory');
});

test('core skills: activate for matching requests in English', () => {
  const cases = {
    'task-intake': ['clarify goal and constraints of a request', 'task intake', 'how many agents are needed'],
    'acceptance-criteria': ['define acceptance criteria', 'acceptance criteria', 'measurable success criteria'],
    'quality-gate': ['verify deliverable before publishing', 'quality check deliverable', 'quality gate'],
    'structured-handoff': ['pass work to another agent', 'resume work later', 'handoff'],
    'source-verification': ['verify sources for research', 'reliable market data', 'check sources'],
    'decision-record': ['record architectural decision', 'decision log', 'log significant choice'],
    'self-critique': ['retrospective on completed work', 'what could be improved', 'retrospective', 'rate work by dimension'],
  };
  for (const [name, queries] of Object.entries(cases)) for (const q of queries) assert.equal(top(q)[0], name, `"${q}" → ${top(q).join(', ')}`);
});

test('self-critique: dimension evaluation with 1-5 score, reason and improvement step, no average', () => {
  const text = fs.readFileSync(path.join(REPO, 'skills', 'own', 'self-critique', 'SKILL.md'), 'utf8');
  assert.ok(text.includes('## Point-by-point evaluation'));
  for (const p of ['Correctness', 'Completeness', 'Robustness', 'Simplicity', 'Verification', 'Process', 'Tooling']) assert.match(text, new RegExp(`\\| ${p} \\|`), p);
  assert.match(text, /Correctness 4\/5 — .* → for 5:/, 'output shows score, rationale, and next step');
  assert.match(text, /under 4 must produce/);
  assert.match(text, /No overall average/);
});

test('search: stem collision checks', () => {
  assert.equal(stem('content'), 'conten');
  assert.equal(stem('context'), 'contes');
  const found = stemCollisions(['fix an error', 'quick fix', 'task management']);
  assert.deepEqual(found.map((c) => c.stem), []);
});

test('core skills: do not trigger on unrelated domain requests', () => {
  for (const q of ['youtube video editing', 'create a landing page', 'optimize blog seo', 'install a skill from github']) {
    assert.ok(!CORE.includes(top(q)[0]), `"${q}" must not have a core skill at top: ${top(q).join(', ')}`);
  }
});

test('starter agents: planner, researcher, implementer and reviewer exist, are optional, least-privilege and linked to core skills', () => {
  const links = { planner: ['task-intake', 'acceptance-criteria', 'decision-record'], researcher: ['source-verification', 'memory'], implementer: ['structured-handoff'], reviewer: ['quality-gate', 'self-critique'] };
  for (const [name, skills] of Object.entries(links)) {
    const agent = index.agents.find((a) => a.name === name);
    assert.ok(agent, name);
    assert.equal(agent.origin, 'own');
    assert.ok(/\buse\b/i.test(agent.description), `${name}: description in English`);
    assert.deepEqual([...agent.skills].sort(), [...skills].sort(), `${name}: linked skills`);
  }
  const text = (n) => fs.readFileSync(path.join(REPO, 'agents', 'own', `${n}.md`), 'utf8');
  for (const n of ['planner', 'researcher', 'reviewer']) assert.doesNotMatch(text(n).match(/^tools:.*$/m)[0], /Write|Edit/, `${n} cannot edit files`);
  assert.doesNotMatch(text('planner').match(/^tools:.*$/m)[0], /Bash/);
  assert.match(text('implementer'), /Ask before anything hard to undo/);
});
