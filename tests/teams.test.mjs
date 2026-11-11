// Teams (teams.json): validation, persistence, members, doctor problems, team matching for requests,
// create wizard suggestions, custom categories, team.mjs command, and server routes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, cleanupAfter, makeHub, run, write } from './helpers.mjs';
import { scanHub } from '../scripts/lib/scan.mjs';
import { route } from '../scripts/lib/route.mjs';
import { addCategory, removeCategory, updateCategory } from '../scripts/lib/ops.mjs';
import { DEFAULT_ROLES, METHOD_SKILLS, TeamError, checkTeam, deleteTeam, loadTeams, matchTeams, saveTeam, suggestMembers, teamMembers, teamProblems } from '../scripts/lib/teams.mjs';
import { startServer } from '../ui/server.mjs';

cleanupAfter();

const team = (o = {}) => ({
  id: 'video',
  name: 'Video',
  description: 'Video editing and publishing',
  categories: ['video'],
  roles: [
    { id: 'editing', name: 'Editing', agents: ['agent:producer'], skills: ['skill:montaggio-video', 'skill:sottotitoli'] },
    { id: 'seo', name: 'SEO', agents: [], skills: ['skill:seo-audit'] },
  ],
  ...o,
});
const readJson = (root, f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));

test('team: controlled shape (id, names, roles, members in right place, known categories)', () => {
  const t = checkTeam(team(), { categories: ['video', 'seo'] });
  assert.equal(t.roles[0].description, '');
  const bad = [
    [team({ id: 'Video Team' }), /team identifier/i],
    [team({ name: ' ' }), /name/i],
    [team({ roles: 'x' }), /roles/i],
    [team({ roles: [{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }] }), /repeated/i],
    [team({ roles: [{ id: 'a', name: 'A', agents: ['skill:x'] }] }), /skill among agents/i],
    [team({ roles: [{ id: 'a', name: 'A', skills: ['agent:x'] }] }), /agent among skills/i],
    [team({ roles: [{ id: 'a', name: 'A', skills: ['../etc'] }] }), /not an agent or a skill/i],
    [team({ categories: ['invented'] }), /Unknown categories/i],
    [team({ description: 'x'.repeat(501) }), /maximum 500/i],
    [null, /invalid/i],
  ];
  for (const [raw, re] of bad) assert.throws(() => checkTeam(raw, { categories: ['video'] }), (e) => e instanceof TeamError && re.test(e.message), JSON.stringify(raw)?.slice(0, 60));
  // same item can be in multiple roles and teams
  const both = checkTeam(team({ roles: [{ id: 'a', name: 'A', skills: ['skill:seo-audit'] }, { id: 'b', name: 'B', skills: ['skill:seo-audit'] }] }));
  assert.deepEqual(teamMembers(both).skills, ['skill:seo-audit']);
});

test('team: save, replace, create only if new, delete; doctor reports missing members and empty roles', () => {
  const root = makeHub();
  assert.deepEqual(loadTeams(root).teams, []);
  saveTeam(root, team());
  saveTeam(root, team({ name: 'Video and YouTube' }));
  assert.deepEqual(loadTeams(root).teams.map((t) => t.name), ['Video and YouTube']);
  assert.throws(() => saveTeam(root, team(), { createOnly: true }), (e) => e.status === 409);
  saveTeam(root, team({ id: 'other', name: 'Other', roles: [{ id: 'empty', name: 'Empty' }, { id: 'r', name: 'R', skills: ['skill:missing'] }] }));
  const problems = teamProblems(root, scanHub(root));
  assert.ok(problems.some((p) => p.level === 'warn' && /skill:missing is not in the hub/i.test(p.message)));
  assert.ok(problems.some((p) => p.level === 'info' && /"Empty" has no members yet/i.test(p.message)));
  assert.ok(!problems.some((p) => /team Video and YouTube/.test(p.message) && p.level !== 'info'), 'first team members exist');
  deleteTeam(root, 'other');
  assert.throws(() => deleteTeam(root, 'other'), (e) => e.status === 404);
  // hand-written file with invalid team is reported by doctor
  write(root, 'teams.json', JSON.stringify({ version: 1, teams: [{ id: 'X Y', name: 'x', roles: [] }] }));
  const d = run('doctor.mjs', [], { root });
  assert.notEqual(d.code, 0);
  assert.match(d.out + d.err, /teams\.json: team "X Y"/);
});

test('team for a request: by domain (categories or name), none if unrelated; route proposes with roles', () => {
  const root = makeHub();
  saveTeam(root, team());
  saveTeam(root, team({ id: 'sites', name: 'Websites', description: 'Websites and landing pages', categories: ['dev-web'], roles: [{ id: 'seo', name: 'SEO', skills: ['skill:seo-audit'] }] }));
  const index = scanHub(root);
  const config = readJson(root, 'hub.config.json');
  const teams = loadTeams(root).teams;
  assert.equal(matchTeams(index, config, teams, 'edit a video for youtube')[0].team.id, 'video');
  assert.equal(matchTeams(index, config, teams, 'create a landing page')[0].team.id, 'sites');
  assert.deepEqual(matchTeams(index, config, teams, 'write a business plan'), []);
  const r = route(index, config, 'edit a video for youtube', { size: 'medium', teams });
  assert.equal(r.team.id, 'video');
  assert.deepEqual(r.team.roles[0].skills, ['montaggio-video', 'sottotitoli']);
  assert.ok(r.notes.some((n) => /Team Video/.test(n)));
  assert.equal(route(index, config, 'edit a video for youtube', { size: 'small', teams }).team, null, 'never on small tasks');
  assert.equal(route(index, config, 'something', { size: 'medium', teams, team: 'sites' }).team.name, 'Websites', 'user-selected team');
  assert.throws(() => route(index, config, 'x', { teams, team: 'none' }), /not found/i);
});

test('create wizard: suggests by role, never method skills; universal default roles', () => {
  const root = makeHub();
  write(root, 'skills/own/security-review/SKILL.md', '---\nname: security-review\ndescription: Security review of code, vulnerabilities and secrets.\ncategories: [security]\n---\n# Security\n');
  write(root, 'skills/own/edit-plan/SKILL.md', '---\nname: edit-plan\ndescription: Video editing plan for any format.\ncategories: [video]\n---\n# Plan\n');
  write(root, 'skills/own/quality-gate/SKILL.md', '---\nname: quality-gate\ndescription: Final verification security video editing.\n---\n# Gate\n');
  const index = scanHub(root);
  const config = readJson(REPO, 'hub.config.json');
  const [sec, vid] = suggestMembers(index, config, { name: 'Mobile App', roles: [{ id: 's', name: 'Security', description: 'security review, vulnerabilities' }, { id: 'v', name: 'Video', description: 'video editing' }] });
  assert.ok(sec.skills.length && sec.skills.every((x) => !METHOD_SKILLS.has(x.id)), JSON.stringify(sec));
  assert.ok(sec.skills.some((x) => /security/.test(x.name)), JSON.stringify(sec));
  assert.ok(vid.skills.some((x) => x.name === 'edit-plan'), JSON.stringify(vid));
  assert.ok(!vid.skills.some((x) => /security/.test(x.name)), 'role decides, not only team domain');
  assert.ok(DEFAULT_ROLES.length >= 4 && DEFAULT_ROLES.every((r) => r.id && r.name));
});

test('custom categories: add, rename, remove (including from registry and teams)', () => {
  const root = makeHub();
  addCategory(root, { id: 'app-mobile', label: 'Mobile app', keywords: 'iOS, android ,flutter' });
  assert.deepEqual(readJson(root, 'hub.config.json').categories['app-mobile'], { label: 'Mobile app', keywords: ['ios', 'android', 'flutter'] });
  assert.throws(() => addCategory(root, { id: 'app-mobile', label: 'x' }), /already exists/i);
  assert.throws(() => addCategory(root, { id: 'App Mobile', label: 'x' }), /identifier/i);
  updateCategory(root, 'app-mobile', { label: 'Mobile' });
  assert.equal(readJson(root, 'hub.config.json').categories['app-mobile'].label, 'Mobile');
  assert.equal(run('link.mjs', ['categorize', 'seo-audit', 'app-mobile,seo'], { root }).code, 0);
  saveTeam(root, team({ categories: ['video', 'app-mobile'] }));
  const r = removeCategory(root, 'app-mobile');
  assert.equal(r.items, 1);
  assert.equal(r.teams, 1);
  assert.equal(readJson(root, 'hub.config.json').categories['app-mobile'], undefined);
  assert.deepEqual(readJson(root, 'registry.json').overrides['skill:seo-audit'].categories, ['seo']);
  assert.deepEqual(loadTeams(root).teams[0].categories, ['video']);
  assert.throws(() => removeCategory(root, 'app-mobile'), /not found/i);
  // from terminal
  assert.equal(run('link.mjs', ['category', 'add', 'podcast', 'Podcast', 'podcast,audio'], { root }).code, 0);
  assert.equal(run('link.mjs', ['category', 'remove', 'podcast'], { root }).code, 0);
});

test('npm run team: list, show, add and remove members, suggestions', () => {
  const root = makeHub();
  saveTeam(root, team());
  const show = JSON.parse(run('team.mjs', ['show', 'video', '--json'], { root }).out);
  assert.deepEqual(show.roles[1].skills, ['seo-audit']);
  assert.equal(run('team.mjs', ['add', 'video', 'seo', 'agent:producer'], { root }).code, 0);
  assert.deepEqual(loadTeams(root).teams[0].roles[1].agents, ['agent:producer']);
  assert.equal(run('team.mjs', ['add', 'video', 'seo', 'skill:nonexistent'], { root }).code, 1);
  assert.equal(run('team.mjs', ['add', 'video', 'role-x', 'agent:producer'], { root }).code, 1);
  assert.equal(run('team.mjs', ['remove', 'video', 'seo', 'agent:producer'], { root }).code, 0);
  assert.deepEqual(loadTeams(root).teams[0].roles[1].agents, []);
  assert.equal(run('team.mjs', ['show', 'none'], { root }).code, 1);
  assert.equal(JSON.parse(run('team.mjs', ['suggest', 'youtube video', '--json'], { root }).out).length, DEFAULT_ROLES.length);
});

test('server: team and category routes with Origin, Content-Type, token and validation', async () => {
  const root = makeHub();
  const app = await startServer({ root, port: 0, quiet: true });
  const origin = `http://127.0.0.1:${app.port}`;
  const post = (p, body, headers = {}) => fetch(origin + p, { method: 'POST', headers: { 'X-Hub-Token': app.token, Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  try {
    for (const url of ['/api/teams/save', '/api/teams/delete', '/api/teams/suggest', '/api/categories']) {
      assert.equal((await post(url, {}, { Origin: 'http://evil.example' })).status, 403, url);
      assert.equal((await post(url, {}, { 'Content-Type': 'text/plain' })).status, 415, url);
      assert.equal((await fetch(origin + url, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' })).status, 401, url);
    }
    assert.equal((await post('/api/teams/save', { team: team({ categories: ['invented'] }) })).status, 400);
    assert.equal((await post('/api/teams/save', { team: 'x' })).status, 400);
    assert.equal((await post('/api/teams/save', { team: team() })).status, 200);
    assert.equal((await post('/api/teams/save', { team: team(), create: true })).status, 409, 'create only if new');
    const got = await (await fetch(`${origin}/api/teams`, { headers: { 'X-Hub-Token': app.token } })).json();
    assert.equal(got.teams[0].id, 'video');
    assert.ok(got.defaultRoles.length);
    const state = await (await fetch(`${origin}/api/state`, { headers: { 'X-Hub-Token': app.token } })).json();
    assert.equal(state.teams[0].name, 'Video');
    assert.ok(Array.isArray(state.categories.video.keywords));
    const sg = await (await post('/api/teams/suggest', { draft: { name: 'Video', roles: [{ id: 'm', name: 'Editing' }] } })).json();
    assert.equal(sg.suggestions.length, 1);
    assert.equal((await post('/api/teams/suggest', { draft: { roles: [{ id: 'm' }] } })).status, 400, 'role name required');
    assert.equal((await post('/api/teams/delete', { id: 'video' })).status, 200);
    assert.equal((await post('/api/teams/delete', { id: 'video' })).status, 404);
    assert.equal((await post('/api/categories', { action: 'add', id: 'podcast', label: 'Podcast', keywords: ['audio'] })).status, 200);
    assert.equal((await post('/api/categories', { action: 'add', id: 'podcast', label: 'Podcast' })).status, 409);
    assert.equal((await post('/api/categories', { action: 'update', id: 'podcast', keywords: 'audio' })).status, 400, 'keywords must be a list');
    assert.equal((await post('/api/categories', { action: 'boh', id: 'podcast' })).status, 400);
    assert.equal((await post('/api/categories', { action: 'remove', id: 'podcast' })).status, 200);
  } finally {
    await app.close();
  }
});

test('repo teams.json: valid and empty (each user creates their teams)', () => {
  const index = scanHub(REPO);
  const teams = loadTeams(REPO).teams;
  assert.deepEqual(teams, []);
  const cats = Object.keys(readJson(REPO, 'hub.config.json').categories);
  for (const t of teams) checkTeam(t, { categories: cats });
  assert.deepEqual(teamProblems(REPO, index).filter((p) => p.level !== 'info'), []);
});
