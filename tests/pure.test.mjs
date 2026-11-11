// Browserless/serverless tests: graph layout and Guide markdown parser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation, crossings, layered, project, unproject } from '../ui/public/js/layout.js';
import { parseInline, parseMarkdown, outline, slug, splitCells } from '../ui/public/js/markdown.js';

process.env.AI_HUB_LANG ??= 'en';

test('layout: simulation is repeatable, settles, and does not overlap nodes', () => {
  const mk = () => ({
    nodes: Array.from({ length: 60 }, (_, i) => ({ id: `n${i}`, group: `g${i % 5}`, r: 7 })),
    edges: Array.from({ length: 40 }, (_, i) => ({ source: `n${i}`, target: `n${(i * 7 + 3) % 60}`, type: i % 4 ? 'declared' : 'depends' })),
  });
  const a = mk();
  const b = mk();
  new Simulation(a.nodes, a.edges, { seed: 3 }).run(600);
  const sb = new Simulation(b.nodes, b.edges, { seed: 3 }).run(600);
  assert.ok(sb.settled, 'simulation must settle');
  assert.deepEqual(a.nodes.map((n) => [n.x, n.y]), b.nodes.map((n) => [n.x, n.y]), 'same seed, same layout');
  for (const n of a.nodes) assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y));
  let min = Infinity;
  for (let i = 0; i < a.nodes.length; i++) for (let j = i + 1; j < a.nodes.length; j++) min = Math.min(min, Math.hypot(a.nodes[i].x - a.nodes[j].x, a.nodes[i].y - a.nodes[j].y));
  assert.ok(min > 14, `nodes too close: ${min}`);
});

test('layout: edges to nonexistent ids and loops are ignored; resumes from previous positions', () => {
  const nodes = [{ id: 'a' }, { id: 'b' }];
  const sim = new Simulation(nodes, [{ source: 'a', target: 'zzz', type: 'declared' }, { source: 'a', target: 'a', type: 'declared' }, { source: 'a', target: 'b', type: 'declared' }]);
  assert.equal(sim.edges.length, 1);
  sim.run(300);
  const prev = new Map(nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
  const again = new Simulation([{ id: 'a' }, { id: 'b' }], [{ source: 'a', target: 'b', type: 'declared' }], { previous: prev });
  assert.equal(again.nodes[0].x, prev.get('a').x);
});

test('layout 3D: uses depth, settles, does not overlap points; projection is invertible', () => {
  const nodes = Array.from({ length: 60 }, (_, i) => ({ id: `n${i}`, group: `g${i % 6}`, r: 7 }));
  const edges = Array.from({ length: 40 }, (_, i) => ({ source: `n${i}`, target: `n${(i * 7 + 3) % 60}`, type: 'declared' }));
  const sim = new Simulation(nodes, edges, { seed: 5, dims: 3 }).run(800);
  assert.ok(sim.settled);
  const zs = nodes.map((n) => n.z);
  assert.ok(Math.max(...zs) - Math.min(...zs) > 100, 'points occupy depth as well');
  let min = Infinity;
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) min = Math.min(min, Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y, nodes[i].z - nodes[j].z));
  assert.ok(min > 14, `points too close: ${min}`);
  // 2D: z remains 0
  const flat = Array.from({ length: 5 }, (_, i) => ({ id: `f${i}` }));
  new Simulation(flat, [], { dims: 2 }).run(50);
  assert.ok(flat.every((n) => n.z === 0));

  const cam = { yaw: 0.8, pitch: -0.3, dist: 1000, cx: 10, cy: -5, cz: 3 };
  // without rotation and at center depth, projection is identity
  assert.deepEqual(project({ x: 30, y: 15, z: 3 }, { ...cam, yaw: 0, pitch: 0 }), { x: 20, y: 20, s: 1, depth: 0 });
  // farther appears smaller
  const near = project({ x: 0, y: 0, z: -200 }, { ...cam, yaw: 0, pitch: 0, cx: 0, cy: 0, cz: 0 });
  const far = project({ x: 0, y: 0, z: 200 }, { ...cam, yaw: 0, pitch: 0, cx: 0, cy: 0, cz: 0 });
  assert.ok(near.s > 1 && far.s < 1 && far.depth > near.depth);
  // unproject maps camera vector back to world
  const w = unproject(3, -2, 5, cam);
  const back = project({ x: w.x + cam.cx, y: w.y + cam.cy, z: w.z + cam.cz }, { ...cam, dist: 1e12 });
  assert.ok(Math.abs(back.x - 3) < 1e-6 && Math.abs(back.y + 2) < 1e-6 && Math.abs(back.depth - 5) < 1e-6);
});

test('layered column layout: orders to minimize crossings', () => {
  const cols = [['a1', 'a2', 'a3'], ['s1', 's2', 's3', 's4'], ['c1', 'c2']];
  const edges = [['a1', 's3'], ['a2', 's1'], ['a3', 's2'], ['a1', 's4'], ['s1', 'c2'], ['s3', 'c1'], ['s2', 'c2']].map(([from, to]) => ({ from, to }));
  const naive = { columns: cols.map((c, ci) => c.map((id, i) => ({ id, y: i }))) };
  const res = layered(cols, edges);
  assert.ok(crossings(res, edges) <= crossings(naive, edges));
  assert.equal(crossings(res, edges), 0);
  assert.deepEqual(res.columns.map((c) => c.length), [3, 4, 2]);
  assert.ok(res.columns.flat().every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)));
  // short columns centered (default) or top-aligned
  const tall = [['a'], ['s1', 's2', 's3', 's4', 's5']];
  const firstY = (r) => r.columns[0][0].y;
  assert.ok(firstY(layered(tall, [])) > firstY(layered(tall, [], { align: 'top' })));
  assert.equal(firstY(layered(tall, [], { align: 'top' })), layered(tall, [], { align: 'top' }).columns[1][0].y);
});

test('markdown: headings, tables with \\|, lists, code, comments', () => {
  const blocks = parseMarkdown('<!-- note -->\n# Title E\n\nText **strong** and `code`.\n\n| A | B |\n|---|---|\n| `x\\|y` | 2 |\n\n- one\n- two\n\n1. a\n2. b\n\n```text\nnpm run x\n```\n');
  assert.deepEqual(blocks.map((b) => b.type), ['h', 'p', 'table', 'ul', 'ol', 'code']);
  assert.equal(blocks[0].id, 'title-e');
  assert.deepEqual(blocks[2].rows, [['`x|y`', '2']]);
  assert.equal(blocks[5].text, 'npm run x');
  assert.deepEqual(splitCells('| a \\| b | c |'), ['a | b', 'c']);
  assert.equal(slug('How the hub is built'), 'how-the-hub-is-built');
  assert.deepEqual(outline('# T\n## One\n### Two\n#### Three\n').map((o) => o.text), ['One', 'Two']);
});

test('markdown: no dangerous links and no raw HTML evaluated', () => {
  const inl = parseInline('[ok](https://a.example/x) [no](javascript:alert(1)) [data](data:text/html,x) <script>alert(1)</script> <img src=x onerror=alert(1)>');
  const links = inl.filter((n) => n.t === 'link').map((n) => n.href);
  assert.deepEqual(links, ['https://a.example/x']);
  const text = inl.filter((n) => n.t === 'text').map((n) => n.text).join('');
  assert.ok(text.includes('<script>'), 'HTML remains plain text (renderer uses textContent)');
  assert.ok(!inl.some((n) => n.t === 'link' && /^(javascript|data):/i.test(n.href)));
});

// ---- GitHub synchronization: header button text and permitted actions (DOM-less module) ----
test('sync-model: button state, allowed actions, and announcements', async () => {
  const { canPull, canPush, chipInfo, relativeTime, shouldAnnounce } = await import('../ui/public/js/sync-model.js');
  const st = (o) => ({ state: 'synced', ahead: 0, behind: 0, changesTotal: 0, blocked: [], summary: 'phrase', ...o });

  assert.equal(chipInfo(null).tone, 'idle');
  assert.deepEqual(chipInfo(st({})), { tone: 'ok', label: 'Up to date', title: 'phrase' });
  assert.equal(chipInfo(st({ state: 'behind', behind: 3 })).label, '↓ 3 updates');
  assert.equal(chipInfo(st({ state: 'behind', behind: 3 })).tone, 'warn');
  assert.equal(chipInfo(st({ state: 'ahead', ahead: 1 })).label, '↑ to send');
  assert.equal(chipInfo(st({ changesTotal: 2 })).tone, 'info', 'modified files but synced: to send');
  assert.equal(chipInfo(st({ state: 'diverged', ahead: 1, behind: 1 })).tone, 'bad');
  assert.equal(chipInfo(st({ state: 'behind', behind: 1, changesTotal: 4 })).tone, 'warn', 'updates take precedence');
  assert.equal(chipInfo(st({ state: 'no-repo' })).label, 'Not connected');
  const off = chipInfo(st({ fetchError: { message: 'Cannot reach GitHub' } }));
  assert.equal(off.tone, 'idle');
  assert.match(off.title, /reach GitHub/);

  assert.equal(canPull(st({ state: 'behind', behind: 1 })), true);
  for (const s of ['synced', 'ahead', 'diverged', 'no-repo']) assert.equal(canPull(st({ state: s })), false, s);
  assert.equal(canPull(st({ state: 'behind', behind: 1, conflicts: true })), false);

  assert.equal(canPush(st({ changesTotal: 1 })), true);
  assert.equal(canPush(st({ state: 'ahead', ahead: 2 })), true);
  assert.equal(canPush(st({})), false, 'nothing to send');
  assert.equal(canPush(st({ state: 'behind', behind: 1, changesTotal: 1 })), false, 'must pull first');
  assert.equal(canPush(st({ state: 'diverged', ahead: 1, behind: 1 })), false);
  assert.equal(canPush(st({ changesTotal: 2, blocked: ['.env'] })), false, 'files resembling secrets');
  assert.equal(canPush(st({ changesTotal: 1, conflicts: true })), false);
  assert.equal(canPush(null), false);

  const now = Date.parse('2026-10-23T12:00:00Z');
  const ago = (s) => new Date(now - s * 1000).toISOString();
  assert.equal(relativeTime(null), 'never on this computer');
  assert.equal(relativeTime(ago(10), now), 'just now');
  assert.equal(relativeTime(ago(5 * 60), now), '5 min ago');
  assert.equal(relativeTime(ago(3 * 3600), now), '3 h ago');
  assert.equal(relativeTime(ago(86400), now), '1 day ago');
  assert.equal(relativeTime(ago(3 * 86400), now), '3 days ago');
  assert.equal(relativeTime('not a date', now), '—');

  assert.equal(shouldAnnounce(st({ state: 'behind', behind: 2 }), 0), true);
  assert.equal(shouldAnnounce(st({ state: 'behind', behind: 2 }), 2), false, 'same count: does not repeat announcement');
  assert.equal(shouldAnnounce(st({ state: 'behind', behind: 3 }), 2), true, 'more updates: announces again');
  assert.equal(shouldAnnounce(st({}), 0), false);
});

// ---- Create tab: draft, steps, and client-side validations (DOM-less module) ----
test('create-model: slugify, draft, switch kind, steps, and stats', async () => {
  const m = await import('../ui/public/js/create-model.js');
  assert.equal(m.slugify('Reel Editing — it is great!'), 'reel-editing-it-is-great');
  assert.equal(m.slugify('  '), '');
  assert.equal(m.slugify('x'.repeat(63) + ' yy').length <= 64, true);
  assert.ok(!m.slugify('a'.repeat(63) + ' b').endsWith('-'), 'does not end with hyphen after truncation');

  const agent = m.emptyDraft('agent');
  assert.deepEqual(agent.tools, ['Read', 'Glob', 'Grep'], 'an agent starts with read-only tools');
  assert.deepEqual(m.emptyDraft('skill').tools, []);
  assert.equal(agent.folder, null);
  assert.equal(agent.markdown, null);

  const d = { ...m.emptyDraft('skill'), title: 'T', name: 'n', nameTouched: true, description: 'D', goal: 'G', categories: ['video'], model: 'opus', procedure: 'p' };
  const sw = m.switchKind(d, 'agent');
  assert.equal(sw.kind, 'agent');
  assert.deepEqual([sw.title, sw.name, sw.nameTouched, sw.description, sw.goal, sw.model, sw.categories], ['T', 'n', true, 'D', 'G', 'opus', ['video']]);
  assert.equal(sw.procedure, '', 'specific fields do not transfer to other kind');
  assert.notEqual(sw.categories, d.categories, 'lists are cloned, not shared');
  assert.equal(m.switchKind(d, 'skill'), d, 'same kind: draft unchanged');

  assert.ok(!('nameTouched' in m.toPayload(d)), 'client-only fields do not go to server');
  assert.equal(m.toPayload(d).procedure, 'p');

  assert.deepEqual(m.splitList('ffmpeg, git\ngit ; node'), ['ffmpeg', 'git', 'node']);
  assert.deepEqual(m.splitList(''), []);
  assert.deepEqual(m.textStats(''), { chars: 0, words: 0, lines: 0 });
  assert.deepEqual(m.textStats('one two\nthree'), { chars: 13, words: 3, lines: 2 });
  assert.equal(m.statsLabel(''), 'empty');
  assert.match(m.statsLabel('a\nb'), /^2 lines · 2 words · 3 characters$/);
  assert.match(m.statsLabel('a'), /^1 line ·/);

  assert.equal(m.descriptionTone(0).tone, 'idle');
  assert.equal(m.descriptionTone(20).tone, 'warn');
  assert.equal(m.descriptionTone(300).tone, 'ok');
  assert.equal(m.descriptionTone(1100).tone, 'caution');
  assert.equal(m.descriptionTone(1600).tone, 'warn');
  assert.equal(m.combinedLength({ description: 'Hello.', descriptionEn: 'Hi' }), 'Hello. Hi'.length);
  assert.equal(m.combinedLength({ description: 'Hello', descriptionEn: 'Hi' }), 'Hello. Hi'.length, 'like server: appends period');
  assert.equal(m.combinedLength({ description: '', descriptionEn: 'Hi' }), 2);

  assert.equal(m.stepOfField('name'), 1);
  assert.equal(m.stepOfField('procedure'), 2);
  assert.equal(m.stepOfField('model'), 3);
  assert.equal(m.stepOfField('folder'), 4);
  assert.equal(m.stepOfField('something-new'), m.LAST_STEP, 'unknown field maps to last step');
  const st = m.stepStatus([{ field: 'name', level: 'error' }, { field: 'description', level: 'warn' }, { field: 'tools', level: 'info' }, { field: 'folder', level: 'error' }]);
  assert.deepEqual(st.map((s) => [s.errors, s.warns]), [[0, 0], [1, 1], [0, 0], [0, 0], [1, 0]], 'info notices do not count');
  assert.equal(m.issuesByField([{ field: 'a', level: 'info' }, { field: 'a', level: 'warn' }]).get('a').length, 2);

  assert.equal(m.hasContent(m.emptyDraft('skill')), false);
  assert.equal(m.hasContent({ ...m.emptyDraft('skill'), sections: [{ title: '', body: 'x' }] }), true);
  assert.equal(m.canCreate({ canCreate: true }, false), true);
  assert.equal(m.canCreate({ canCreate: true }, true), false, 'cannot save while validation is pending');
  assert.equal(m.canCreate(null, false), false);
});

test('create-model: saved browser draft is restored only when matching expected shape', async () => {
  const m = await import('../ui/public/js/create-model.js');
  assert.equal(m.restoreDraft('not json'), null);
  assert.equal(m.restoreDraft(null), null);
  assert.equal(m.restoreDraft({ kind: 'other' }), null);
  assert.equal(m.restoreDraft('"string"'), null);
  const d = m.restoreDraft(JSON.stringify({ kind: 'agent', name: 'x', description: 5, tools: ['Read', 3, 'Edit'], categories: 'video', toolsMode: 'unknown', skillsMode: 'frontmatter', folder: 'a/b', markdown: '# m', sections: [{ title: 't', body: 'b' }, { title: 1 }, null], _step: 2, invented: true }));
  assert.equal(d.kind, 'agent');
  assert.equal(d.name, 'x');
  assert.equal(d.description, '', 'wrong type resets to empty value');
  assert.deepEqual(d.tools, ['Read', 'Edit']);
  assert.deepEqual(d.categories, []);
  assert.equal(d.toolsMode, 'list');
  assert.equal(d.skillsMode, 'frontmatter');
  assert.equal(d.folder, 'a/b');
  assert.equal(d.markdown, '# m');
  assert.deepEqual(d.sections, [{ title: 't', body: 'b' }]);
  assert.ok(!('invented' in d) && !('_step' in d));
  assert.deepEqual(Object.keys(d).sort(), Object.keys(m.emptyDraft('agent')).sort(), 'has all fields of a fresh draft');
});
