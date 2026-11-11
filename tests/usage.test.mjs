// Usage and consumption of skills and agents: counts from Claude Code transcripts, machine files, token estimation, advice.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cleanupAfter, makeHub, mktmp, run, write } from './helpers.mjs';
import { scanHub } from '../scripts/lib/scan.mjs';
import { startServer } from '../ui/server.mjs';
import {
  advise, countTranscripts, estimateTokens, machineName, mergeMax, readAllUsage, updateMachineUsage, usageLevel, usageReport, usageStats, usesInLine,
  EMPTY_STAT, HEAVY_BODY,
} from '../scripts/lib/usage.mjs';

cleanupAfter();

const NOW = Date.parse('2026-10-26T12:00:00Z');
const skillCall = (skill, id, ts = '2026-10-20T10:00:00Z') => JSON.stringify({ type: 'assistant', uuid: `u-${id}`, timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Skill', input: { skill } }] } });
const agentCall = (agent, id, ts = '2026-10-21T10:00:00Z') => JSON.stringify({ type: 'assistant', uuid: `u-${id}`, timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Agent', input: { subagent_type: agent, prompt: 'private text' } }] } });
const command = (name, uuid, ts = '2026-10-22T10:00:00Z') => JSON.stringify({ type: 'user', uuid, timestamp: ts, message: { role: 'user', content: `<command-name>/${name}</command-name>\n<command-args></command-args>` } });

test('history: counts Skill, agents and /name commands; ignores text, broken lines and other tools', () => {
  assert.deepEqual(usesInLine(skillCall('plugin:seo-audit', 't1'), null), [{ kind: 'skill', name: 'seo-audit', uid: 't1', day: '2026-10-20' }]);
  assert.deepEqual(usesInLine(agentCall('producer', 't2'), null).map((u) => [u.kind, u.name]), [['agent', 'producer']]);
  assert.deepEqual(usesInLine(command('subtitles', 'c1'), null).map((u) => [u.kind, u.name, u.day]), [['skill', 'subtitles', '2026-10-22']]);
  assert.deepEqual(usesInLine('{broken', null), []);
  assert.deepEqual(usesInLine(JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'ls' } }] } }), null), []);
  // Skill tool description mentions `<command-name>` without closing it: not a command
  assert.deepEqual(usesInLine(JSON.stringify({ message: { role: 'user', content: 'if a `<command-name>` block is already present' } }), null), []);
});

test('history: hub items only, counted once per call even in resumed sessions, file cache', () => {
  const dir = mktmp();
  const lines = [skillCall('seo-audit', 'a'), skillCall('seo-audit', 'b', '2026-10-21T09:00:00Z'), skillCall('other-skill', 'c'), agentCall('producer', 'd')];
  write(dir, 'project-a/s1.jsonl', lines.join('\n'));
  write(dir, 'project-a/s2.jsonl', [lines[0], skillCall('seo-audit', 'e')].join('\n')); // "a" copied from resumed session
  const known = new Set(['skill:seo-audit', 'agent:producer']);
  const r = countTranscripts(dir, known);
  assert.deepEqual(r.items, { 'skill:seo-audit': { '2026-10-20': 2, '2026-10-21': 1 }, 'agent:producer': { '2026-10-21': 1 } });
  assert.equal(r.files, 2);
  // with cache unchanged files are not re-read
  const fake = { ...r.cache, 'project-a/s1.jsonl': { ...r.cache['project-a/s1.jsonl'], uses: [] } };
  assert.equal(countTranscripts(dir, known, { cache: fake }).items['agent:producer'], undefined);
  assert.deepEqual(countTranscripts(path.join(dir, 'missing'), known).items, {});
});

test('per-machine file: names and numbers only, writes only on changes, days deleted by Claude Code are preserved', () => {
  const root = makeHub();
  const dir = mktmp();
  const known = new Set(['skill:seo-audit', 'agent:producer']);
  assert.equal(updateMachineUsage(root, known, { dir, machine: 'mac' }).changed, false, 'no usage: no file');
  assert.ok(!fs.existsSync(path.join(root, 'usage')));
  write(dir, 'p/s.jsonl', [skillCall('seo-audit', 'a'), agentCall('producer', 'b')].join('\n'));
  assert.equal(updateMachineUsage(root, known, { dir, machine: 'mac' }).changed, true);
  const text = fs.readFileSync(path.join(root, 'usage', 'mac.json'), 'utf8');
  assert.ok(!text.includes('private text'), 'no conversation text');
  assert.deepEqual(JSON.parse(text), { version: 1, machine: 'mac', items: { 'agent:producer': { '2026-10-21': 1 }, 'skill:seo-audit': { '2026-10-20': 1 } } });
  assert.equal(updateMachineUsage(root, known, { dir, machine: 'mac' }).changed, false);
  fs.rmSync(path.join(dir, 'p'), { recursive: true }); // Claude Code deleted old transcripts
  updateMachineUsage(root, known, { dir, machine: 'mac' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'usage', 'mac.json'), 'utf8')).items['skill:seo-audit']['2026-10-20'], 1);
  // another machine: counts add up
  write(root, 'usage/windows.json', JSON.stringify({ version: 1, machine: 'windows', items: { 'skill:seo-audit': { '2026-10-20': 2, '2026-10-25': 1 }, 'skill:x': { bad: 'no' } } }));
  write(root, 'usage/broken.json', '{');
  const all = readAllUsage(root);
  assert.deepEqual(all.machines, ['mac', 'windows']);
  assert.deepEqual(all.items['skill:seo-audit'], { '2026-10-20': 3, '2026-10-25': 1 });
  assert.equal(all.items['skill:x'], undefined);
  assert.deepEqual(mergeMax({ a: { d1: 2 } }, { a: { d1: 1, d2: 1 } }), { a: { d1: 2, d2: 1 } });
  assert.equal(machineName('Janes-MacBook-Pro.local'), 'janes-macbook-pro');
  assert.equal(machineName(''), 'computer');
});

test('scoring: levels and 30/90 day windows, score relative to most used', () => {
  assert.deepEqual([0, 1, 2, 3, 9, 10].map(usageLevel), ['never', 'low', 'low', 'medium', 'medium', 'high']);
  const s = usageStats({ a: { '2026-10-20': 12 }, b: { '2026-10-01': 2, '2026-06-01': 5 } }, NOW);
  assert.deepEqual({ ...s.a }, { total: 12, last30: 12, last90: 12, lastUsed: '2026-10-20', level: 'high', score: 100 });
  assert.equal(s.b.total, 7);
  assert.equal(s.b.last30, 2);
  assert.equal(s.b.last90, 2);
  assert.equal(s.b.level, 'low');
  assert.ok(s.b.score > 0 && s.b.score < 100);
});

test('estimated tokens in index and advice on what to use or avoid', () => {
  const root = makeHub();
  write(root, 'skills/own/heavy/SKILL.md', `---\nname: heavy\ndescription: Very long skill.\n---\n${'word '.repeat(3500)}\n`);
  write(root, 'skills/own/heavy/references.md', 'x'.repeat(80000));
  const index = scanHub(root);
  const heavy = index.skills.find((e) => e.name === 'heavy');
  assert.ok(heavy.tokens.body >= HEAVY_BODY, JSON.stringify(heavy.tokens));
  assert.equal(heavy.tokens.extra, estimateTokens(80000));
  assert.ok(heavy.tokens.description > 0);
  const producer = index.agents.find((e) => e.name === 'producer');
  // without usage data do not judge usage, but weight yes
  const noData = advise(heavy, EMPTY_STAT, { hasData: false }).map((a) => a.text).join('\n');
  assert.match(noData, /Heavy/);
  assert.match(noData, /other files/);
  assert.doesNotMatch(noData, /No usage/);
  assert.match(advise(producer, EMPTY_STAT, { hasData: false }).map((a) => a.text).join(), /separate context/);
  // with data: never used → unhook; heavily used third-party unapproved → approve
  assert.match(advise(heavy, EMPTY_STAT, { hasData: true })[0].text, /No usage in the last 90 days/);
  const ext = { ...heavy, origin: 'external', approval: 'review-pending', tokens: { description: 50, body: 100, extra: 0 } };
  assert.deepEqual(advise(ext, { ...EMPTY_STAT, last90: 20, level: 'high' }, { hasData: true }).map((a) => a.level), ['warn']);
  const report = usageReport(index, { 'skill:seo-audit': { '2026-10-20': 4 } }, NOW);
  assert.equal(report.hasData, true);
  assert.equal(report.rows[0].name, 'seo-audit');
  assert.equal(report.perSession, [...index.skills, ...index.agents].reduce((s, e) => s + e.tokens.description, 0));
});

test('npm run usage and /api/usage: respect setting and session token', async () => {
  const root = makeHub();
  const claude = mktmp();
  write(claude, 'projects/p/s.jsonl', skillCall('seo-audit', 'a'));
  const env = { AI_HUB_ROOT: root, CLAUDE_CONFIG_DIR: claude };
  const out = run('usage.mjs', ['--json'], { env });
  assert.equal(out.code, 0, out.err);
  const j = JSON.parse(out.out);
  assert.equal(j.rows.find((r) => r.name === 'seo-audit').total, 1);
  assert.equal(j.machines.length, 1);

  // disabled: does not read transcripts
  const root2 = makeHub();
  write(root2, 'settings.json', '{"version":1,"usage":{"fromTranscripts":false}}\n');
  const off = JSON.parse(run('usage.mjs', ['--json'], { env: { ...env, AI_HUB_ROOT: root2 } }).out);
  assert.equal(off.hasData, false);
  assert.ok(!fs.existsSync(path.join(root2, 'usage')));

  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claude;
  const app = await startServer({ root: root2, port: 0, quiet: true });
  try {
    const url = `http://127.0.0.1:${app.port}/api/usage`;
    assert.equal((await fetch(url)).status, 401);
    const body = await (await fetch(url, { headers: { 'X-Hub-Token': app.token } })).json();
    assert.equal(body.tracking, false);
    assert.equal(body.hasData, false);
    assert.ok(body.rows.every((r) => r.tokens && typeof r.tokens.body === 'number'));
  } finally {
    await app.close();
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
  }
});
