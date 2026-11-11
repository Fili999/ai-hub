// Test output in English (AI_HUB_LANG=en or unset) for sync, setup, doctor, settings, and guide.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPatch, settingsView } from '../scripts/lib/settings.mjs';
import { renderGuide } from '../scripts/lib/guide.mjs';
import { cleanupAfter, makeHub, REPO, run } from './helpers.mjs';

cleanupAfter();

// ------------------------------------------------------------------ sync
test('sync: English output when AI_HUB_LANG=en or unset', () => {
  const root = makeHub();
  for (const env of [{ AI_HUB_LANG: 'en' }, { AI_HUB_LANG: '' }]) {
    const badMode = run('sync.mjs', ['--mode', 'invalid'], { root, env });
    assert.equal(badMode.code, 2);
    assert.match(badMode.err, /--mode must be auto, link or copy/);
    assert.doesNotMatch(badMode.err, /il modo deve essere/);

    const badProv = run('sync.mjs', ['--provider', 'nope'], { root, env });
    assert.equal(badProv.code, 2);
    assert.match(badProv.err, /Unknown AI tool/);
    assert.doesNotMatch(badProv.err, /Strumento AI sconosciuto/);
  }
});

// ------------------------------------------------------------------ setup
test('setup: English output when AI_HUB_LANG=en or unset', () => {
  const root = makeHub();
  for (const env of [{ AI_HUB_LANG: 'en' }, { AI_HUB_LANG: '' }]) {
    const r = run('setup.mjs', ['--check'], { root, env });
    assert.match(r.out, /AI Hub — setting up this computer/);
    assert.match(r.out, /Programs \(dependencies\.json\)/);
    assert.match(r.out, /The required programs are installed/);
    assert.doesNotMatch(r.out, /AI Hub — configurazione di questo computer/);
    assert.doesNotMatch(r.out, /I programmi obbligatori sono installati/);
  }
});

// ------------------------------------------------------------------ doctor
test('doctor: English output when AI_HUB_LANG=en or unset', () => {
  const root = makeHub();
  for (const env of [{ AI_HUB_LANG: 'en' }, { AI_HUB_LANG: '' }]) {
    const r = run('doctor.mjs', [], { root, env });
    assert.match(r.out, /Checked \d+ items/);
    assert.match(r.out, /errors?/);
    assert.doesNotMatch(r.out, /Controllo di \d+ elementi/);
    assert.doesNotMatch(r.out, /\b(errore|errori)\b/);
  }
});

// ------------------------------------------------------------------ settings
test('settings: English view and error messages when lang=en or AI_HUB_LANG=en', () => {
  const root = makeHub();
  const v = settingsView(root, { lang: 'en' });
  assert.equal(v.sections[0].label, 'AI tools');
  assert.equal(v.sections[1].label, 'Programs required by skills and agents');
  assert.equal(v.sections[2].label, 'Security of skills from GitHub');
  assert.equal(v.schema['dependencies.claudeMayInstall'].label, 'Claude may install missing programs');
  assert.equal(v.schema['security.skillspector'].valueLabels.block, 'Block');
  assert.equal(v.schema['security.skillspector'].valueLabels.warn, 'Warn');
  assert.equal(v.schema['security.skillspector'].valueLabels.off, 'Off');
  assert.equal(v.schema['quality.selfCritique'].label, 'Self-critique (skill self-critique)');
  assert.equal(v.schema['tokens.savingLevel'].valueLabels.max, 'Maximum');

  // Error messages in English when AI_HUB_LANG=en
  const prevLang = process.env.AI_HUB_LANG;
  try {
    process.env.AI_HUB_LANG = 'en';
    assert.throws(() => checkPatch({ 'security.nonEsiste': true }, root), /Unknown setting/);
    assert.throws(() => checkPatch({ 'security.skillspector': 'sempre' }, root), /Disallowed value/);
    assert.throws(() => checkPatch([], root), /Invalid settings/);
    assert.throws(() => checkPatch({}, root), /No settings to change/);
  } finally {
    process.env.AI_HUB_LANG = prevLang;
  }
});

// ------------------------------------------------------------------ guide
test('guide: English output when lang=en or AI_HUB_LANG=en', () => {
  const root = makeHub();
  const text = renderGuide(root, { lang: 'en' });
  assert.match(text, /^<!-- File generated from docs\/guide\.md/);
  assert.match(text, /# AI Hub Guide/);
  assert.match(text, /## In Brief/);
  assert.match(text, /Today the hub contains \*\*\d+ skills?\*\* and \*\*\d+ agents?\*\*/);
  assert.match(text, /## How the Hub Is Structured/);
  assert.match(text, /## Security in Brief/);
  assert.doesNotMatch(text, /# Guida all'AI Hub/);

  // CLI with --stdout and AI_HUB_LANG=en
  const r = run('guide.mjs', ['--stdout', '--lang', 'en'], { root, env: { AI_HUB_LANG: 'en' } });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /# AI Hub Guide/);
  assert.match(r.out, /Today the hub contains/);

  // CLI with --check and AI_HUB_LANG=en
  const c = run('guide.mjs', ['--check', '--lang', 'en'], { root: REPO, env: { AI_HUB_LANG: 'en' } });
  assert.equal(c.code, 0, c.out + c.err);
  assert.match(c.out, /GUIDE\.md is up to date/);
});
