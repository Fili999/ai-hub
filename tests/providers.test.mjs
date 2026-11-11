// AI tools: providers.json, paths, agent conversion for each tool, multi-tool sync, languages of the messages.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, cleanupAfter, makeHub, mktmp, run, write } from './helpers.mjs';
import { agentEffort, agentModel, convertAgent, loadProviders, providerPaths, providerProblems } from '../scripts/lib/providers.mjs';
import { LANGUAGES, messages, translator } from '../scripts/lib/i18n.mjs';

cleanupAfter();

const providers = loadProviders(REPO);
const agent = {
  name: 'reviewer',
  data: { name: 'reviewer', description: 'Reviews a change.\nUse it after editing code.', tools: 'Read, Grep, Glob', 'model-tier': 'high', 'effort-tier': 'max' },
  body: 'You review "code" with \\ care.\n',
  text: '---\nname: reviewer\ndescription: Reviews a change.\ntools: Read, Grep, Glob\nmodel-tier: high\neffort-tier: max\n---\nYou review.\n',
};

test('providers.json shipped with the hub: valid, the four tools, shared skills folder for the open standard (Antigravity has its own)', () => {
  const data = JSON.parse(fs.readFileSync(path.join(REPO, 'providers.json'), 'utf8'));
  assert.deepEqual(providerProblems(data), []);
  assert.deepEqual(Object.keys(providers), ['claude', 'codex', 'antigravity', 'opencode']);
  for (const id of ['codex', 'opencode']) assert.equal(providers[id].skillsDir, '~/.agents/skills', id);
  assert.equal(providers.antigravity.command, 'agy');
  assert.equal(providers.antigravity.skillsDir, '~/.gemini/config/skills');
  assert.equal(providers.antigravity.agentsDir, '~/.gemini/config/agents');
});

test('providers.json: bad paths, formats and model ids are reported and the tool is ignored', () => {
  const bad = { providers: { claude: { ...providers.claude, home: '../x' }, codex: { ...providers.codex, agentFormat: 'yaml' }, antigravity: { ...providers.antigravity, models: ['has space'] }, cursor: {} } };
  const problems = providerProblems(bad).join('\n');
  assert.match(problems, /claude\.home/);
  assert.match(problems, /codex\.agentFormat/);
  assert.match(problems, /antigravity\.models/);
  assert.match(problems, /unknown tool "cursor"/);
  const root = makeHub();
  write(root, 'providers.json', JSON.stringify(bad));
  assert.deepEqual(Object.keys(loadProviders(root)), ['opencode'].filter((id) => bad.providers[id]), 'only valid tools are loaded');
});

test('paths: ~ is the home folder, the tool variable moves its folder (CLAUDE_CONFIG_DIR, CODEX_HOME)', () => {
  const home = path.resolve('/home/someone');
  assert.deepEqual(providerPaths(providers.codex, { HOME: home }), { home: path.join(home, '.codex'), skillsDir: path.join(home, '.agents/skills'), agentsDir: path.join(home, '.codex/agents'), instructionsFile: path.join(home, '.codex/AGENTS.md') });
  const moved = path.resolve('/elsewhere/claude');
  const c = providerPaths(providers.claude, { HOME: home, CLAUDE_CONFIG_DIR: moved });
  assert.deepEqual([c.home, c.skillsDir, c.instructionsFile], [moved, path.join(moved, 'skills'), path.join(moved, 'CLAUDE.md')]);
  assert.equal(providerPaths(providers.codex, { HOME: home, CODEX_HOME: moved }).skillsDir, path.join(home, '.agents/skills'), 'skills outside the tool folder do not move');
});

test('model and effort: explicit value for the tool, then the portable tier, otherwise the session decides', () => {
  assert.equal(agentModel(providers.claude, agent.data), 'opus');
  assert.equal(agentModel(providers.claude, { ...agent.data, model: 'sonnet' }), 'sonnet');
  assert.equal(agentModel(providers.codex, agent.data), null, 'no Codex tier configured: the session model');
  assert.equal(agentModel(providers.codex, { ...agent.data, 'codex-model': 'gpt-x-codex' }), 'gpt-x-codex');
  assert.equal(agentModel(providers.claude, { model: 'inherit' }), null);
  assert.equal(agentModel(providers.codex, { 'codex-model': 'bad id; rm -rf' }), null, 'ids with spaces or symbols are ignored');
  assert.equal(agentEffort(providers.codex, agent.data), 'xhigh', 'max maps to the highest Codex level');
  assert.equal(agentEffort(providers.antigravity, agent.data), null, 'Antigravity has no effort setting');
  assert.equal(agentEffort(providers.opencode, { ...agent.data, 'opencode-effort': 'low' }), 'low');
});

test('agent conversion: Codex TOML, Antigravity and OpenCode Markdown, Claude only when a tier must become a model', () => {
  const codex = convertAgent(providers.codex, agent);
  assert.equal(codex.file, 'reviewer.toml');
  assert.match(codex.content, /^name = "reviewer"$/m);
  assert.match(codex.content, /^description = "Reviews a change\. Use it after editing code\."$/m);
  assert.match(codex.content, /^model_reasoning_effort = "xhigh"$/m);
  assert.match(codex.content, /^sandbox_mode = "read-only"$/m, 'read-only tools: read-only sandbox');
  assert.match(codex.content, /^developer_instructions = "You review \\"code\\" with \\\\ care\.\\n"$/m, 'escaped as a TOML basic string');
  assert.match(convertAgent(providers.codex, { ...agent, data: { ...agent.data, tools: 'Read, Edit' } }).content, /workspace-write/);

  const agy = convertAgent(providers.antigravity, agent);
  assert.equal(agy.file, 'reviewer.md');
  assert.match(agy.content, /^name: reviewer$/m);
  assert.match(agy.content, /^tools:\n {2}- view_file\n {2}- grep_search$/m, 'Read and Grep have documented names; Glob has none, so it is left out');
  assert.doesNotMatch(agy.content, /run_command|replace_file_content/, 'never more tools than the hub agent has');
  assert.doesNotMatch(agy.content, /kind: local/, 'that was Gemini CLI\'s format');
  assert.match(agy.content, /^model: "pro"$/m, 'tier high → pro');
  assert.match(agy.content, /\n---\n\nYou review "code"/);
  // no "tools" on the hub agent = it may use everything, but Antigravity gives none unless listed
  const open = convertAgent(providers.antigravity, { ...agent, data: { ...agent.data, tools: '', 'model-tier': 'balanced' } });
  assert.match(open.content, /^tools:\n {2}- view_file\n {2}- replace_file_content\n {2}- grep_search\n {2}- run_command$/m);
  assert.doesNotMatch(open.content, /^model:/m, 'balanced → inherit: nothing written');
  assert.equal(agentModel(providers.antigravity, { 'gemini-model': 'flash' }), 'flash', 'old gemini-model name still works');
  assert.equal(agentModel(providers.antigravity, { 'antigravity-model': 'pro', 'gemini-model': 'flash' }), 'pro');

  const oc = convertAgent(providers.opencode, agent);
  assert.match(oc.content, /^mode: subagent$/m);
  assert.match(oc.content, /^permission:\n {2}edit: deny\n {2}bash: deny\n {2}webfetch: deny$/m);
  assert.match(oc.content, /^reasoningEffort: "high"$/m);

  const cl = convertAgent(providers.claude, agent);
  assert.match(cl.content, /^model: opus$/m);
  assert.match(cl.content, /^effort: max$/m);
  assert.deepEqual(convertAgent(providers.claude, { ...agent, data: { name: 'x', description: 'y' } }), { file: 'reviewer.md', content: null, generated: false }, 'nothing to convert: linked as is');
});

test('sync to four tools: skills once in ~/.agents/skills, agents converted, only hub items touched, disabled tools cleaned', () => {
  const root = makeHub();
  write(root, 'agents/own/checker.md', '---\nname: checker\ndescription: Checks things. Use it to check.\ntools: Read\nmodel-tier: fast\n---\nCheck carefully.\n');
  const home = mktmp();
  write(home, '.agents/skills/my-own/SKILL.md', '---\nname: my-own\ndescription: not from the hub\n---\n');
  const env = { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), AI_HUB_LANG: 'en' };
  let r = run('sync.mjs', ['--provider', 'claude,codex,antigravity,opencode', '--mode', 'copy'], { root, env });
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, /Codex \(OpenAI\): \d+ skills, \d+ agents/);
  assert.ok(fs.existsSync(path.join(home, '.claude/skills/seo-audit/SKILL.md')));
  assert.ok(fs.existsSync(path.join(home, '.agents/skills/seo-audit/SKILL.md')));
  assert.match(fs.readFileSync(path.join(home, '.codex/agents/checker.toml'), 'utf8'), /developer_instructions = "Check carefully/);
  assert.match(fs.readFileSync(path.join(home, '.gemini/config/agents/checker.md'), 'utf8'), /^name: checker$/m);
  assert.ok(fs.existsSync(path.join(home, '.gemini/config/skills/seo-audit/SKILL.md')), 'Antigravity reads its own skills folder');
  assert.match(fs.readFileSync(path.join(home, '.config/opencode/agents/checker.md'), 'utf8'), /mode: subagent/);
  assert.match(fs.readFileSync(path.join(home, '.claude/agents/checker.md'), 'utf8'), /^model: haiku$/m);
  assert.ok(fs.existsSync(path.join(home, '.agents/skills/my-own/SKILL.md')), 'other skills untouched');
  for (const dir of ['.claude', '.codex', '.gemini', '.config/opencode']) assert.equal(JSON.parse(fs.readFileSync(path.join(home, dir, 'ai-hub.json'), 'utf8')).root, root, dir);

  r = run('sync.mjs', ['--provider', 'claude,codex,antigravity,opencode', '--mode', 'copy'], { root, env });
  assert.match(r.out, /linked: 0, copied: 0, converted: 0, unchanged: \d+/, 'second run changes nothing');

  // Settings: only Codex on. Claude, Antigravity and OpenCode are cleaned; the shared skills stay for Codex
  write(root, 'settings.json', JSON.stringify({ providers: { claude: false, codex: true, antigravity: false, opencode: false } }));
  r = run('sync.mjs', ['--mode', 'copy'], { root, env });
  assert.equal(r.code, 0, r.err + r.out);
  assert.ok(!fs.existsSync(path.join(home, '.claude/skills/seo-audit')));
  assert.ok(!fs.existsSync(path.join(home, '.gemini/config/agents/checker.md')));
  assert.ok(!fs.existsSync(path.join(home, '.gemini/config/skills/seo-audit')));
  assert.ok(!fs.existsSync(path.join(home, '.claude/ai-hub.json')));
  assert.ok(fs.existsSync(path.join(home, '.agents/skills/seo-audit/SKILL.md')), 'still used by Codex');
  assert.ok(fs.existsSync(path.join(home, '.codex/agents/checker.toml')));

  // instructions block in AGENTS.md, in the hub language, idempotent
  assert.equal(run('sync.mjs', ['--instructions'], { root, env }).code, 0);
  assert.equal(run('sync.mjs', ['--instructions'], { root, env }).code, 0);
  const md = fs.readFileSync(path.join(home, '.codex/AGENTS.md'), 'utf8');
  assert.equal(md.split('ai-hub:begin').length, 2);
  assert.ok(md.includes(root) && /orchestrator/.test(md) && /Skills and agents hub/.test(md));

  // nothing enabled: a clear error, nothing removed
  write(root, 'settings.json', JSON.stringify({ providers: { claude: false, codex: false, antigravity: false, opencode: false } }));
  r = run('sync.mjs', [], { root, env });
  assert.equal(r.code, 2);
  assert.match(r.err, /No AI tool selected/);
  assert.equal(run('sync.mjs', ['--provider', 'cursor'], { root, env }).code, 2);
});

test('languages: English default, messages load, placeholders and fallback work', () => {
  assert.deepEqual(Object.keys(LANGUAGES), ['en']);
  const en = messages('en');
  assert.ok(Object.keys(en).length > 50, 'en messages loaded');
  assert.match(translator('en')('sync.pruned', { list: 'a' }), /^Removed .* a$/);
  assert.equal(translator('en')('does.not.exist'), 'does.not.exist');
  const root = makeHub();
  const r = run('sync.mjs', ['--provider', 'nope'], { root, env: { AI_HUB_LANG: '' } });
  assert.match(r.err, /Unknown AI tool/, 'no language set: English');
});
