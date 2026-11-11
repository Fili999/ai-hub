// Guided creation of skills and agents: the generated file is readable by the hub, recommended folder makes sense,
// nothing is overwritten, and no input escapes skills/own or agents/own.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cleanupAfter, makeHub, write } from './helpers.mjs';
import { asList, cleanText, createItem, createOptions, FIELD_MAX, normalizeDraft, planPlacement, previewItem, renderMarkdown } from '../scripts/lib/create.mjs';
import { parseFrontmatter, toList } from '../scripts/lib/frontmatter.mjs';
import { ensureIndex, scanHub } from '../scripts/lib/scan.mjs';
import { HubError } from '../scripts/lib/ops.mjs';

cleanupAfter();

const skillDraft = (over = {}) => ({
  kind: 'skill',
  name: 'montaggio-reel',
  title: 'Reel Editing',
  goal: 'Prepares a vertical reel starting from raw clips.',
  description: 'Edits a vertical reel for Instagram and YouTube Shorts: cuts pauses, adds subtitles and music.',
  descriptionEn: 'Edits a vertical reel from raw clips.',
  model: 'sonnet',
  effort: 'high',
  categories: ['video'],
  tools: ['Read', 'Bash(ffmpeg *)'],
  requiresCommands: ['ffmpeg'],
  requiresMcp: ['gmail'],
  depends: ['montaggio-video'],
  conflicts: ['sottotitoli'],
  whenToUse: 'When editing a reel\nWhen I have clips to cut',
  procedure: 'Check clips\nCut pauses\nAdd subtitles',
  output: 'A vertical mp4 file 1080x1920',
  cautions: 'Do not publish without confirmation',
  ...over,
});

const agentDraft = (over = {}) => ({
  kind: 'agent',
  name: 'social-manager',
  title: 'Social manager',
  role: 'You are the social manager of a motorcycle channel.',
  goal: 'Plan content for the week.',
  description: 'Plans social posts for the channel and prepares drafts: use when an editorial calendar is needed.',
  tools: ['Read', 'Glob'],
  howItWorks: 'Read calendar\nPropose three ideas',
  limits: 'Do not publish anything without confirmation',
  ...over,
});

const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const errorsOf = (p) => p.issues.filter((i) => i.level === 'error');

test('create: generated file is identical when read back by hub (frontmatter, lists, tools, description with quotes and colons)', () => {
  const md = renderMarkdown(normalizeDraft(skillDraft({ description: 'Edits: vertical "reels", user uploads them. Then\ncuts #pauses' })));
  const { data, body, error } = parseFrontmatter(md);
  assert.equal(error, undefined);
  assert.equal(data.name, 'montaggio-reel');
  assert.equal(data.description, 'Edits: vertical "reels", user uploads them. Then cuts #pauses. Edits a vertical reel from raw clips.');
  assert.equal(data.model, 'sonnet');
  assert.equal(data.effort, 'high');
  assert.deepEqual(toList(data.categories), ['video']);
  assert.deepEqual(toList(data['allowed-tools']), ['Read', 'Bash(ffmpeg *)']);
  assert.deepEqual(toList(data['requires-commands']), ['ffmpeg']);
  assert.deepEqual(toList(data['requires-mcp']), ['gmail']);
  assert.deepEqual(toList(data.depends), ['montaggio-video']);
  assert.deepEqual(toList(data.conflicts), ['sottotitoli']);
  assert.match(body, /^\n# Reel Editing\n\nPrepares a vertical reel/);
  for (const h of ['## When to use', '## Procedure', '## Expected output', '## Cautions']) assert.ok(body.includes(h), h);
  assert.match(body, /## Procedure\n\n1\. Check clips\n2\. Cut pauses\n3\. Add subtitles/);

  const ag = parseFrontmatter(renderMarkdown(normalizeDraft(agentDraft({ tools: ['Read', 'Bash(git *)'], model: 'opus', skills: ['a', 'b'], skillsMode: 'frontmatter', categories: ['social'] })))).data;
  assert.deepEqual(toList(ag.tools), ['Read', 'Bash(git *)']);
  assert.deepEqual(toList(ag.skills), ['a', 'b']);
  assert.equal(ag.model, 'opus');
  assert.ok(!('effort' in ag), 'empty effort: writes nothing');
});

test('create: empty fields do not leave empty lines or sections; "all tools" omits tools line', () => {
  const md = renderMarkdown(normalizeDraft({ kind: 'skill', name: 'minimal', description: 'Does only one very simple thing.' }));
  assert.ok(!/model:|effort:|categories:|requires|depends|conflicts|allowed-tools/.test(md));
  assert.ok(!md.includes('## '), 'no empty sections');
  assert.match(md, /# Minimal\n$/, 'title derived from name');

  const all = renderMarkdown(normalizeDraft(agentDraft({ toolsMode: 'all', tools: ['Read'] })));
  assert.ok(!/^tools:/m.test(all));
  const none = renderMarkdown(normalizeDraft(agentDraft({ tools: [] })));
  assert.ok(!/^tools:/m.test(none));
});

test('create: auto-bulleted lists only when text is "one line = one bullet"; remainder preserved as written', () => {
  assert.equal(asList('one\ntwo'), '- one\n- two');
  assert.equal(asList('one\ntwo', true), '1. one\n2. two');
  assert.equal(asList('- already\n- list', true), '- already\n- list');
  assert.equal(asList('1) already numbered\n2) yes'), '1) already numbered\n2) yes');
  assert.equal(asList('# My title\ntext'), '# My title\ntext');
  assert.equal(asList('first paragraph\n\nsecond paragraph', true), 'first paragraph\n\nsecond paragraph');
  assert.equal(asList('```\ncode\n```'), '```\ncode\n```');
  assert.equal(asList(''), '');
  const long = 'x'.repeat(401);
  assert.equal(asList(`${long}\nshort`), `${long}\nshort`);
});

test('create: no control characters and no way to escape frontmatter', () => {
  const evil = skillDraft({ description: 'Good skill\n---\nname: evil\ndescription: x\n---\ntext', title: 'T\u0000itle\r\n---', goal: 'ok' });
  const d = normalizeDraft(evil);
  assert.ok(!d.description.includes('\n'));
  const { data } = parseFrontmatter(renderMarkdown(d));
  assert.equal(data.name, 'montaggio-reel');
  assert.match(data.description, /^Good skill --- name: evil/);
  assert.equal(cleanText('a\u0000b\u0007c\r\nd\u000Be'), 'abc\nde');
  assert.equal(cleanText(String.fromCharCode(0xfeff) + 'x' + String.fromCharCode(0x2028) + 'y'), 'x\ny');
});

test('create: validations — name, description, categories, model, effort, tools, references', () => {
  const root = makeHub();
  const bad = (over, field, level = 'error') => {
    const p = previewItem(root, skillDraft(over));
    assert.ok(p.issues.some((i) => i.field === field && i.level === level), `${field}/${level}: ${JSON.stringify(p.issues)}`);
    return p;
  };
  for (const name of ['', 'With Spaces', '../evil', 'a/b', '-ab', 'ab-', 'a--b', 'x'.repeat(65)]) assert.equal(errorsOf(previewItem(root, skillDraft({ name }))).some((i) => i.field === 'name'), true, `name "${name}"`);
  assert.equal(previewItem(root, skillDraft({ name: 'UPPERCASE' })).issues.some((i) => i.field === 'name' && i.level === 'error'), false, 'uppercase is converted automatically');

  bad({ name: 'montaggio-video' }, 'name'); // already exists as a skill
  assert.ok(previewItem(root, skillDraft({ name: 'producer' })).issues.some((i) => i.field === 'name' && i.level === 'info'), 'same name as an agent: only an info notice');
  bad({ name: 'claude-helper' }, 'name', 'warn');
  bad({ description: '', descriptionEn: '' }, 'description');
  bad({ descriptionEn: '', description: 'too short' }, 'description', 'warn');
  bad({ description: 'word '.repeat(200) }, 'description', 'warn');
  bad({ categories: ['invented'] }, 'categories');
  bad({ model: 'gpt' }, 'model', 'warn');
  bad({ model: 'two words' }, 'model');
  assert.equal(previewItem(root, skillDraft({ model: 'claude-sonnet-5-5' })).issues.some((i) => i.field === 'model'), false, 'a full model ID is valid');
  bad({ effort: 'ultra' }, 'effort');
  bad({ tools: ['Bash; rm -rf /'] }, 'tools');
  bad({ requiresCommands: ['ls; rm'] }, 'requiresCommands');
  bad({ depends: ['montaggio-reel'] }, 'depends');
  bad({ depends: ['non-esiste-xyz'] }, 'depends', 'warn');
  bad({ requiresCommands: ['comando-che-non-esiste-xyz'] }, 'requiresCommands', 'info');
  bad({ agents: ['ghost'] }, 'agents');
  bad({ procedure: '' }, 'procedure', 'warn');
  bad({ tools: ['Bash'] }, 'tools', 'info');
  assert.equal(previewItem(root, skillDraft({ model: 'inherit' })).issues.some((i) => i.field === 'model'), false);
  assert.equal(previewItem(root, skillDraft({ model: 'inherit' })).markdown.includes('model:'), false, 'inherit = writes nothing');

  const a = previewItem(root, agentDraft({ skills: ['ghost'], skillsMode: 'link' }));
  assert.ok(a.issues.some((i) => i.field === 'skills' && i.level === 'error'));
  const a2 = previewItem(root, agentDraft({ skills: ['ghost'], skillsMode: 'frontmatter' }));
  assert.ok(a2.issues.some((i) => i.field === 'skills' && i.level === 'warn'));
  const a3 = previewItem(root, agentDraft({ toolsMode: 'all' }));
  assert.ok(a3.issues.some((i) => i.field === 'tools' && i.level === 'warn'), 'all tools: warning');
  const a4 = previewItem(root, agentDraft({ howItWorks: '', limits: '', role: '' }));
  assert.ok(a4.issues.some((i) => i.field === 'howItWorks'));

  // duplicates: a description almost identical to an existing one
  const dup = previewItem(root, skillDraft({ name: 'montaggio-video-bis', descriptionEn: '', description: 'Video editing with ffmpeg for YouTube. Video editing with ffmpeg for YouTube and long videos.' }));
  assert.ok(dup.issues.some((i) => /Resembles skill:montaggio-video/i.test(i.message)));
});

test('create: where to save — chosen category, inferred category from text, otherwise main folder', () => {
  const root = makeHub();
  const explicit = planPlacement(root, normalizeDraft(skillDraft({ categories: ['video'] })));
  assert.equal(explicit.recommended, 'video');
  assert.equal(explicit.chosen.fileRel, 'skills/own/video/montaggio-reel/SKILL.md');
  assert.equal(explicit.chosen.isNew, true);
  assert.match(explicit.options[0].why, /You chose category/i);
  assert.equal(explicit.options[0].recommended, true);
  assert.ok(explicit.options.some((o) => o.folder === '' && o.path === 'skills/own'));
  assert.equal(explicit.categoriesInferred, false);

  const inferred = planPlacement(root, normalizeDraft({ kind: 'skill', name: 'audit-seo-site', description: 'SEO audit of a website: keywords, SEO optimization and ranking.' }));
  assert.equal(inferred.recommended, 'seo');
  assert.equal(inferred.categoriesInferred, true);
  assert.match(inferred.options[0].why, /From the text it seems/i);

  const none = planPlacement(root, normalizeDraft({ kind: 'skill', name: 'zzz', description: 'Something very unusual without any matching terms.' }));
  assert.equal(none.recommended, '');
  assert.equal(none.chosen.fileRel, 'skills/own/zzz/SKILL.md');

  // agents go in agents/own as <name>.md
  const ag = planPlacement(root, normalizeDraft(agentDraft({ categories: ['social'] })));
  assert.equal(ag.chosen.fileRel, 'agents/own/social/social-manager.md');
  assert.equal(ag.chosen.dirRel, 'agents/own/social');

  // user choice wins; existing folder name is recognized
  write(root, 'skills/own/video/youtube/already-here/SKILL.md', '---\nname: already-here\ndescription: x\n---\n');
  const pick = planPlacement(root, normalizeDraft(skillDraft({ folder: 'video/youtube' })));
  assert.equal(pick.chosen.folder, 'video/youtube');
  assert.equal(pick.chosen.isNew, false);
  assert.ok(pick.options.some((o) => o.folder === 'video/youtube' && o.exists));
  assert.ok(!pick.options.some((o) => o.folder === 'video/youtube/already-here'), 'a folder that is already a skill is not a collection folder');
  assert.equal(planPlacement(root, normalizeDraft(skillDraft({ folder: '' }))).chosen.fileRel, 'skills/own/montaggio-reel/SKILL.md', 'empty folder = root, not recommended');
  assert.equal(planPlacement(root, normalizeDraft(skillDraft({ folder: 'skills/own/video\\youtube/' }))).chosen.folder, 'video/youtube', 'accepts full path and Windows backslashes');

  // with a linked agent, agent folder also appears
  assert.ok(planPlacement(root, normalizeDraft(skillDraft({ agents: ['producer'] }))).options.some((o) => o.folder === 'producer'));
});

test('create: invalid folders and path escape attempts are rejected', () => {
  const root = makeHub();
  for (const folder of ['../outside', 'a/b/c', 'video/../../x', 'space here', '.git', 'external', 'a/node_modules', 'C:\\Windows', 'x'.repeat(41)]) {
    const p = previewItem(root, skillDraft({ folder }));
    assert.equal(p.canCreate, false, folder);
    assert.ok(p.issues.some((i) => i.field === 'folder' && i.level === 'error'), folder);
    assert.throws(() => createItem(root, skillDraft({ folder })), (e) => e instanceof HubError && e.status === 422, folder);
  }
  // "absolute" path never escapes: resolved relative to skills/own
  const abs = previewItem(root, skillDraft({ folder: '/etc' }));
  assert.equal(abs.placement.chosen.fileRel, 'skills/own/etc/montaggio-reel/SKILL.md');
  assert.ok(!fs.existsSync(path.join(root, 'outside')) && !fs.existsSync(path.join(root, 'skills', 'outside')));
  assert.ok(!fs.existsSync(path.join(root, 'skills', 'own', 'montaggio-reel')), 'nothing created after rejections');
});

test('create: creates skill, links to agents, and hub sees it (index, graph, model, effort)', () => {
  const root = makeHub();
  const before = read(root, 'registry.json');
  const r = createItem(root, skillDraft({ agents: ['producer'] }));
  assert.equal(r.ok, true);
  assert.equal(r.id, 'skill:montaggio-reel');
  assert.equal(r.file, 'skills/own/video/montaggio-reel/SKILL.md');
  assert.deepEqual(r.links, [{ from: 'agent:producer', to: 'skill:montaggio-reel' }]);

  const text = read(root, r.file);
  assert.ok(text.endsWith('\n') && !text.includes('\r'));
  const e = ensureIndex(root).skills.find((s) => s.name === 'montaggio-reel');
  assert.equal(e.origin, 'own');
  assert.equal(e.model, 'sonnet');
  assert.equal(e.effort, 'high');
  assert.deepEqual(e.categories, ['video']);
  assert.deepEqual(e.requires.commands, ['ffmpeg']);
  assert.deepEqual(e.requires.mcp, ['gmail']);
  assert.deepEqual(e.assignedTo, ['producer']);
  assert.deepEqual(e.tools, ['Read', 'Bash(ffmpeg *)']);
  assert.ok(JSON.parse(read(root, 'registry.json')).links.some((l) => l.from === 'agent:producer' && l.to === 'skill:montaggio-reel'));
  assert.notEqual(read(root, 'registry.json'), before);

  const warn = scanHub(root).warnings.filter((w) => w.id === 'skill:montaggio-reel').map((w) => w.type);
  assert.ok(warn.includes('missing-dependency') === false, 'montaggio-video exists');
  assert.ok(fs.existsSync(path.join(root, 'index/skillindex.json')), 'index regenerated');
});

test('create: creates agent with skills in frontmatter or as hub links', () => {
  const root = makeHub();
  const a = createItem(root, agentDraft({ skills: ['montaggio-video'], skillsMode: 'frontmatter', model: 'opus', effort: 'medium', categories: ['social'], folder: '' }));
  assert.equal(a.file, 'agents/own/social-manager.md');
  assert.deepEqual(a.links, []);
  const ea = ensureIndex(root).agents.find((x) => x.name === 'social-manager');
  assert.deepEqual(ea.skills, ['montaggio-video']);
  assert.equal(ea.model, 'opus');
  assert.equal(ea.effort, 'medium');
  assert.deepEqual(ea.tools, ['Read', 'Glob']);
  assert.deepEqual(JSON.parse(read(root, 'registry.json')).links, [], 'in frontmatter mode registry does not change');

  const b = createItem(root, agentDraft({ name: 'other-agent', skills: ['seo-audit', 'sottotitoli'], skillsMode: 'link' }));
  assert.equal(b.links.length, 2);
  assert.ok(!/^skills:/m.test(read(root, b.file)), 'in link mode file does not declare skills');
  assert.deepEqual(ensureIndex(root).agents.find((x) => x.name === 'other-agent').skills.sort(), ['seo-audit', 'sottotitoli']);
});

test('create: never overwrites, even if file appears after preview, and cleans up new directories', () => {
  const root = makeHub();
  createItem(root, skillDraft());
  const file = path.join(root, 'skills/own/video/montaggio-reel/SKILL.md');
  fs.writeFileSync(file, 'MY TEXT\n');
  assert.throws(() => createItem(root, skillDraft()), (e) => e.status === 422 && /already exists/i.test(e.message));
  assert.equal(fs.readFileSync(file, 'utf8'), 'MY TEXT\n');
  // same location but different name in index: agent exists as file
  write(root, 'agents/own/taken.md', 'DO NOT TOUCH\n');
  const p = previewItem(root, agentDraft({ name: 'taken', folder: '' }));
  assert.equal(p.canCreate, false);
  assert.equal(read(root, 'agents/own/taken.md'), 'DO NOT TOUCH\n');

  // a new folder created for save does not remain if save fails: simulated with file in place of directory
  const blocked = makeHub();
  write(blocked, 'skills/own/new-dir/montaggio-reel', 'i am a file, not a directory\n');
  assert.throws(() => createItem(blocked, skillDraft({ folder: 'new-dir' })));
  assert.equal(read(blocked, 'skills/own/new-dir/montaggio-reel'), 'i am a file, not a directory\n');
});

test('create: does not write through a symbolic link', (t) => {
  const root = makeHub();
  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside`);
  fs.mkdirSync(outside);
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  try {
    fs.mkdirSync(path.join(root, 'skills/own'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, 'skills/own/shortcut'), 'junction');
  } catch {
    return t.skip('this system does not allow creating symbolic links');
  }
  assert.throws(() => createItem(root, skillDraft({ folder: 'shortcut' })), /is a link/i);
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing written outside folder');
});

test('create: hand-edited file in preview is what gets saved (if remaining consistent)', () => {
  const root = makeHub();
  const generated = previewItem(root, skillDraft()).markdown;
  const edited = generated.replace('## Cautions', '## Channel notes\n\nOnly clips recorded by me.\n\n## Cautions');
  const p = previewItem(root, skillDraft({ markdown: edited }));
  assert.equal(p.edited, true);
  assert.equal(p.canCreate, true);
  assert.equal(p.markdown, edited);
  assert.equal(p.generated, generated, 'generated version from fields remains available');
  const r = createItem(root, skillDraft({ markdown: edited }));
  assert.equal(read(root, r.file), edited);

  // different name, broken header, or removed description: does not save
  assert.equal(previewItem(root, skillDraft({ name: 'other-name', markdown: edited })).canCreate, false);
  assert.equal(previewItem(root, skillDraft({ name: 'other-two', markdown: '# without heading\n' })).canCreate, false);
  assert.equal(previewItem(root, skillDraft({ name: 'montaggio-reel2', markdown: generated.replace(/^description:.*$/m, '').replace('montaggio-reel', 'montaggio-reel2') })).canCreate, false);
});

test('create: very long texts are allowed (up to huge limit) and beyond limit error is clear', () => {
  const root = makeHub();
  const huge = 'Very detailed instruction line.\n\n'.repeat(5000); // ~190,000 characters
  const p = previewItem(root, skillDraft({ procedure: huge, sections: [{ title: 'Appendix', body: huge }] }));
  assert.equal(p.canCreate, true);
  assert.ok(p.bytes > 300_000);
  assert.ok(p.issues.some((i) => i.field === 'markdown' && /500 lines/i.test(i.message)), 'warning for 500 lines, not a block');
  const r = createItem(root, skillDraft({ procedure: huge }));
  assert.ok(read(root, r.file).length > 150_000);
  assert.throws(() => previewItem(root, skillDraft({ procedure: 'x'.repeat(FIELD_MAX + 1) })), (e) => e instanceof HubError && e.status === 413 && /too long/i.test(e.message));
  const chunk = 'y'.repeat(FIELD_MAX - 1);
  assert.throws(() => previewItem(root, skillDraft({ procedure: chunk, sections: [{ title: 'A', body: chunk }, { title: 'B', body: chunk }] })), (e) => e instanceof HubError && e.status === 413 && /million characters/i.test(e.message), 'total size also has a ceiling');
});

test('create: wrong types rejected; interface options complete', () => {
  const root = makeHub();
  for (const bad of [null, 'x', [], { kind: 'other' }, { kind: 'skill', name: 5 }, { kind: 'skill', categories: 'video' }, { kind: 'skill', tools: [1] }, { kind: 'skill', sections: 'x' }, { kind: 'skill', sections: [null] }, { kind: 'skill', agents: new Array(100).fill('a') }]) {
    assert.throws(() => normalizeDraft(bad), (e) => e instanceof HubError && e.status >= 400, JSON.stringify(bad));
  }
  const o = createOptions(root);
  assert.deepEqual(o.models.map((m) => m.id), ['', 'sonnet', 'opus', 'haiku', 'fable']);
  assert.deepEqual(o.efforts.map((m) => m.id), ['', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.ok(o.categories.some((c) => c.id === 'video' && c.label));
  assert.deepEqual(o.agents.map((a) => a.id), ['agent:producer']);
  assert.ok(o.skills.some((s) => s.id === 'skill:seo-audit'));
  assert.ok(o.toolGroups.flatMap((g) => g.tools).some((t) => t.name === 'Bash'));
  assert.deepEqual(o.bases, { skill: 'skills/own', agent: 'agents/own' });
  JSON.stringify(o); // must serialize as JSON
});

test('create: portable tiers and values for other AI tools (agents only), with validations', async () => {
  const root = makeHub();
  const base = { kind: 'agent', name: 'reviewer', description: 'Reviews code changes. Use after any major modification.', modelTier: 'high', effortTier: 'max', toolModels: { codex: 'gpt-x-codex', opencode: 'ollama/qwen3:30b' }, toolEfforts: { codex: 'xhigh' } };
  const { data } = parseFrontmatter(renderMarkdown(normalizeDraft(base)));
  assert.equal(data['model-tier'], 'high');
  assert.equal(data['effort-tier'], 'max');
  assert.equal(data['codex-model'], 'gpt-x-codex');
  assert.equal(data['codex-effort'], 'xhigh');
  assert.equal(data['opencode-model'], 'ollama/qwen3:30b');
  const skill = parseFrontmatter(renderMarkdown(normalizeDraft({ ...base, kind: 'skill' }))).data;
  assert.equal(skill['model-tier'], undefined, 'skills of other tools always use session model');
  assert.throws(() => normalizeDraft({ ...base, toolModels: { cursor: 'x' } }), HubError);
  assert.throws(() => normalizeDraft({ ...base, toolModels: ['x'] }), HubError);
  const bad = previewItem(root, { ...base, modelTier: 'huge', toolModels: { codex: 'two words' } });
  const fields = bad.issues.filter((i) => i.level === 'error').map((i) => i.field);
  assert.ok(fields.includes('modelTier') && fields.includes('toolModels'), JSON.stringify(bad.issues));
  write(root, 'settings.json', JSON.stringify({ providers: { claude: true, codex: true, antigravity: false, opencode: false } }));
  assert.deepEqual(createOptions(root).tools.map((t) => t.id), ['claude', 'codex'], 'only active tools in Settings');
});
