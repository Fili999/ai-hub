// The Guide tab runs in the browser, where a mistake such as an undefined variable only shows up as an error banner
// ("Cannot read the guide: lang is not defined"). This runs the real view against a minimal fake DOM and a fake API.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO } from './helpers.mjs';

const created = []; // every text node the view creates (including error banners)
class FakeNode {
  constructor(text = '') {
    this.text = text;
    this.dataset = {};
    this.style = {};
    this.classList = { toggle() {}, add() {}, remove() {} };
    this.scrollTop = 0;
    this.firstChild = null;
  }
  setAttribute() {}
  addEventListener() {}
  append() {}
  removeChild() {}
  closest() {
    return null;
  }
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
}
globalThis.Node = FakeNode;
globalThis.document = {
  createElement: () => new FakeNode(),
  createElementNS: () => new FakeNode(),
  createDocumentFragment: () => new FakeNode(),
  createTextNode: (text) => (created.push(String(text)), new FakeNode(String(text))),
  getElementById: () => new FakeNode(),
  querySelector: () => null,
};
globalThis.IntersectionObserver = class {
  observe() {}
  disconnect() {}
};
const requests = [];
globalThis.fetch = async (url) => {
  requests.push(String(url));
  return { ok: true, json: async () => ({ markdown: '# Guide\n\n## Section\n\nSome text.\n' }) };
};

test('guide view: loads the guide without errors (no undefined variables) and asks the server for /api/guide', async () => {
  const { default: create } = await import('../ui/public/js/views/guide.js');
  const { store } = await import('../ui/public/js/store.js');
  store.state = { watch: 'first' };
  const view = create({});
  view.update();
  await new Promise((r) => setTimeout(r, 50)); // load() is async
  assert.deepEqual(requests, ['/api/guide?'], 'the guide was requested');
  const errors = created.filter((t) => /not defined|Cannot read the guide|ui\.guide\.loadError/i.test(t));
  assert.deepEqual(errors, [], 'no error banner');
  assert.ok(created.some((t) => t === 'Guide' || t === 'Section'), 'the Markdown was rendered');
  view.destroy();
});

test('every browser script parses (a syntax error there only shows up in the browser)', () => {
  const files = [];
  (function walk(d) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (full.endsWith('.js')) files.push(full);
    }
  })(path.join(REPO, 'ui', 'public', 'js'));
  assert.ok(files.length > 20);
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${path.relative(REPO, f)}: ${r.stderr}`);
  }
});
