// Live guide: {{live:...}} sections reflect the hub, GUIDE.md does not depend on the host machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BLOCK_NAMES, GUIDE_FILE_EN, refreshGuide, renderGuide } from '../scripts/lib/guide.mjs';
import { ensureIndex } from '../scripts/lib/scan.mjs';
import { cleanupAfter, makeHub, REPO, run, write } from './helpers.mjs';

cleanupAfter();

test('guide: all template sections exist and no placeholder remains', () => {
  const tplFile = 'docs/guide.md';
  const tpl = fs.readFileSync(path.join(REPO, tplFile), 'utf8').replace(/<!--[\s\S]*?-->/, '');
  const used = [...tpl.matchAll(/\{\{live:([a-z-]+)\}\}/g)].map((m) => m[1]);
  assert.ok(used.length >= 5, `${tplFile} has fewer than 5 blocks`);
  for (const name of used) assert.ok(BLOCK_NAMES.includes(name), `unknown block in ${tplFile}: ${name}`);

  const root = makeHub();
  for (const machine of [false, true]) {
    const text = renderGuide(root, { machine });
    assert.ok(!text.includes('{{live:'), 'placeholder remains in rendered guide');
    assert.ok(!/unknown section|cannot read/i.test(text), text);
    assert.ok(!text.includes('\n\n\n'));
    assert.ok(text.endsWith('\n'));
  }
});

test('guide: counts and lists reflect the index in English', () => {
  const root = makeHub();
  write(root, 'skills/own/broken/SKILL.md', '---\nname: broken\ndescription: Depends on missing skill.\ndepends: skill-that-does-not-exist\n---\n');
  const idx = ensureIndex(root);

  const enText = renderGuide(root);
  assert.match(enText, new RegExp(`\\*\\*${idx.stats.skills} skills\\*\\*`));
  assert.match(enText, new RegExp(`\\*\\*${idx.stats.agents} agent\\*\\*`));
  assert.equal(idx.stats.skills, 4);
  for (const name of ['montaggio-video', 'sottotitoli', 'seo-audit', 'producer']) assert.ok(enText.includes('`' + name + '`'), name);
  assert.match(enText, /- `agent:producer` → `skill:montaggio-video`/);
  assert.match(enText, /skill:broken depends on "skill-that-does-not-exist", which is not installed/i);
  assert.doesNotMatch(enText, /No issues reported\.\s*$/m);

  // dependency table reflects dependencies.json
  const deps = JSON.parse(fs.readFileSync(path.join(root, 'dependencies.json'), 'utf8'));
  for (const t of deps.tools) assert.ok(enText.includes(t.name), t.name);
  assert.match(enText, /\| winget Git\.Git \|/);
  // commands match package.json (doctor and test)
  assert.match(enText, /`npm run doctor`/);
  assert.match(enText, /`npm run test`/);
  assert.ok(!enText.includes('`npm run setup`|'), 'table is not broken');
});

test('guide: changes only when hub changes', () => {
  const root = makeHub();
  const first = refreshGuide(root);
  assert.equal(first.changed, true);
  const fileEn = path.join(root, GUIDE_FILE_EN);
  assert.equal(fs.readFileSync(fileEn, 'utf8'), renderGuide(root));
  assert.equal(refreshGuide(root).changed, false, 'idempotent');
  const mtime = fs.statSync(fileEn).mtimeMs;
  refreshGuide(root);
  assert.equal(fs.statSync(fileEn).mtimeMs, mtime, 'file is not rewritten if nothing changed');

  write(root, 'skills/own/new-skill/SKILL.md', '---\nname: new-skill\ndescription: A skill added later.\n---\n');
  assert.equal(refreshGuide(root).changed, true);
  assert.ok(fs.readFileSync(fileEn, 'utf8').includes('new-skill'));
});

test('guide: edits in template are reflected in generated guide', () => {
  const root = makeHub();
  write(root, 'docs/guide.md', '# My Guide\n\nHello.\n\n{{live:stats}}\n\n{{live:nonexistent-block}}\n');
  const text = renderGuide(root);
  assert.match(text, /^<!-- File generated/);
  assert.match(text, /# My Guide/);
  assert.match(text, /\*\*3 skills\*\*/);
  assert.match(text, /unknown section: nonexistent-block/);
});

test('guide: GUIDE.md does not contain machine-specific data; UI version does', () => {
  const root = makeHub();
  const file = renderGuide(root, { machine: false });
  const ui = renderGuide(root, { machine: true });
  assert.ok(!file.includes('This computer:'));
  assert.ok(!file.includes(process.version));
  assert.ok(!file.includes(root));
  assert.match(file, /web interface/);
  assert.match(ui, /This computer: \*\*(Windows|macOS|Linux) /);
  assert.ok(ui.includes(process.version.replace(/^v/, '')));
  assert.ok(!ui.startsWith('<!--'), 'UI does not display generated file notice');
  assert.ok(file.startsWith('<!--'));
  const strip = (t) => t.replace(/^<!--.*?-->\n/, '').replace(/This computer: \*\*[\s\S]*?(?=\n## )/, '').replace(/_The status of this computer[^\n]*\n/, '');
  assert.equal(strip(file).length > 500, true);
});

test('guide: --check flags outdated guide and regenerating fixes it', () => {
  const root = makeHub();
  assert.equal(run('guide.mjs', ['--check', '--quiet'], { root }).code, 1, 'does not exist yet');
  assert.equal(run('guide.mjs', ['--quiet'], { root }).code, 0);
  assert.equal(run('guide.mjs', ['--check', '--quiet'], { root }).code, 0);
  write(root, 'skills/own/another/SKILL.md', '---\nname: another\ndescription: Another skill.\n---\n');
  assert.equal(run('guide.mjs', ['--check', '--quiet'], { root }).code, 1);
  assert.match(run('guide.mjs', ['--stdout'], { root }).out, /another/);
  assert.equal(run('guide.mjs', ['--quiet'], { root }).code, 0);
  assert.equal(run('guide.mjs', ['--check', '--quiet'], { root }).code, 0);
});

test('guide: inventory, install and link keep it up to date automatically', () => {
  const root = makeHub();
  const file = path.join(root, 'GUIDE.md');
  const r = run('inventory.mjs', [], { root });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /GUIDE\.md (updated|already up to date)/);
  assert.ok(fs.readFileSync(file, 'utf8').includes('seo-audit'));
  assert.match(fs.readFileSync(file, 'utf8'), /_No links|`agent:producer`/);

  const l = run('link.mjs', ['add', 'producer', 'seo-audit'], { root });
  assert.equal(l.code, 0, l.err);
  assert.match(fs.readFileSync(file, 'utf8'), /`agent:producer` → `skill:seo-audit` \(selected in registry\.json\)/);
  assert.equal(run('link.mjs', ['remove', 'producer', 'seo-audit'], { root }).code, 0);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /skill:seo-audit` \(selected/);
  assert.equal(run('guide.mjs', ['--check', '--quiet'], { root }).code, 0, 'guide remains aligned after operations');
});

test('guide: repo GUIDE.md matches template', () => {
  const r = run('guide.mjs', ['--check'], { root: REPO });
  assert.equal(r.code, 0, r.out + r.err);
});
