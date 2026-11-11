// Graph: agents (squares) and skills (circles) connected by lines. Rendered on canvas, laid out with force simulation,
// in 3D (perspective, rotation, depth; zero dependencies) or in 2D. Initial mode configured in Settings.
import { h, clear, icon, debounce } from '../dom.js';
import { api } from '../api.js';
import { Simulation, project, unproject } from '../layout.js';
import { store, catsOf, catLabel } from '../store.js';
import { kindLabel, originLabel } from '../ui.js';
import { resolveColors } from '../theme.js';
import { t } from '../i18n.js';

const FONT = '"Space Grotesk", "Segoe UI", system-ui, sans-serif';
const GLOW_MAX_NODES = 300; // above this threshold glow is limited to focused elements (saves draw time)

/**
 * @param {object} ctx
 * @param {{scope?: {ids: Set<string>, edges?: {source: string, target: string}[]}, embedded?: boolean}} [opts]
 *   scope: only show these elements (a team's graph) plus role connections (type "team");
 *   without scope the full hub graph is shown
 */
export default function create(ctx, opts = {}) {
  const scope = opts.scope ?? null;
  const filters = { q: '', kinds: new Set(['agent', 'skill']), origins: new Set(['own', 'external']), cat: null, linkedOnly: false };
  const hits = new Set();
  let nodes = [];
  let edges = [];
  let sim = null;
  let signature = '';
  let view = { x: 0, y: 0, k: 1 };
  let hover = null;
  let drag = null;
  let pan = null;
  let needsDraw = true;
  let raf = 0;
  let fitPending = true;
  let size = { w: 0, h: 0, dpr: 1 };
  let colors = {};
  let destroyed = false;
  let mode = store.state?.settings?.['interface.graphMode'] === '2d' ? '2d' : '3d';
  const cam = { yaw: 0.55, pitch: 0.32, dist: 1100, cx: 0, cy: 0, cz: 0 };
  let spin = true;
  let orbit = null;

  const canvas = h('canvas', { role: 'img', 'aria-label': t('ui.graph.canvasAria'), tabindex: '0' });
  const c2 = canvas.getContext('2d');
  const tip = h('div', { class: 'tip', hidden: true });
  const counter = h('div', { class: 'hint', 'aria-live': 'polite' });

  // ------------------------------------------------------------ pannello filtri
  const search = h('input', { type: 'search', placeholder: t('ui.graph.searchPlaceholder'), 'aria-label': t('ui.graph.searchAria') });
  const kindBtns = h('div', { class: 'chips' });
  const catBtns = h('div', { class: 'chips' });
  const linkedBox = h('input', { type: 'checkbox', id: 'g-linked', onchange: () => ((filters.linkedOnly = linkedBox.checked), rebuild(true)) });

  const runSearch = debounce(async () => {
    const q = search.value.trim();
    hits.clear();
    if (q) {
      try {
        const r = await api.search(q, { limit: 12 });
        const top = r.results[0]?.score ?? 0;
        r.results.filter((x) => x.score >= top * 0.25).forEach((x) => hits.add(x.id));
      } catch (e) {
        ctx.toast(e.message, 'error');
      }
    }
    draw();
  }, 220);
  search.addEventListener('input', runSearch);

  function toggleSet(set, value, min1 = true) {
    if (set.has(value) && (!min1 || set.size > 1)) set.delete(value);
    else set.add(value);
  }

  function renderFilters() {
    clear(kindBtns);
    const mk = (label, set, value) => h('button', { type: 'button', class: 'chip', 'aria-pressed': String(set.has(value)), onclick: () => { toggleSet(set, value); renderFilters(); rebuild(true); } }, label);
    kindBtns.append(mk(t('ui.graph.agents'), filters.kinds, 'agent'), mk(t('ui.graph.skills'), filters.kinds, 'skill'), mk(t('ui.graph.own'), filters.origins, 'own'), mk(t('ui.graph.fromGithub'), filters.origins, 'external'));
    clear(catBtns);
    const used = new Map();
    for (const e of [...store.state.skills, ...store.state.agents]) for (const c of catsOf(e)) used.set(c, (used.get(c) ?? 0) + 1);
    if (!used.size) return;
    catBox.firstChild.textContent = filters.cat ? t('ui.graph.categoryPrefix', { name: catLabel(filters.cat) }) : t('ui.graph.categories');
    catBtns.append(h('button', { type: 'button', class: 'chip', 'aria-pressed': String(!filters.cat), onclick: () => { filters.cat = null; renderFilters(); rebuild(true); } }, t('ui.graph.catAll')));
    for (const [c, n] of [...used].sort((a, b) => b[1] - a[1])) {
      catBtns.append(h('button', { type: 'button', class: 'chip', 'aria-pressed': String(filters.cat === c), onclick: () => { filters.cat = filters.cat === c ? null : c; renderFilters(); rebuild(true); } }, `${catLabel(c)} ${n}`));
    }
  }

  const catBox = h('details', { class: 'catbox' }, h('summary', { class: 'hint', style: { cursor: 'pointer' } }, t('ui.graph.categories')), h('div', { style: { marginTop: '8px' } }, catBtns));
  const more = h('details', { class: 'fmore' }, h('summary', { class: 'hint', style: { cursor: 'pointer', marginBottom: '8px' } }, t('ui.graph.filters')), h('div', { style: { display: 'grid', gap: '8px' } }, kindBtns, catBox, h('label', { class: 'check hint', for: 'g-linked' }, linkedBox, t('ui.graph.hideUnlinked'))));
  if (window.innerWidth > 720) more.open = true;
  const panel = h('div', { class: 'floating filters' }, search, more, counter);
  const legend = h('div', { class: 'floating legend' },
    h('span', null, h('span', { class: 'kind agent' }), t('ui.graph.legend.agent')),
    h('span', null, h('span', { class: 'kind' }), t('ui.graph.legend.ownSkill')),
    h('span', null, h('span', { class: 'kind external' }), t('ui.graph.legend.github')),
    h('span', null, h('i'), t('ui.graph.legend.declared')),
    h('span', null, h('i', { class: 'assigned' }), t('ui.graph.legend.assigned')),
    h('span', null, h('i', { class: 'depends' }), t('ui.graph.legend.depends')),
    h('span', null, h('i', { class: 'conflict' }), t('ui.graph.legend.conflict')),
    scope ? h('span', null, h('i', { class: 'team' }), t('ui.graph.legend.teamRole')) : null);
  const modeBtn = h('button', { class: 'btn mode', type: 'button', onclick: () => setMode(mode === '3d' ? '2d' : '3d') });
  const spinBtn = h('button', { class: 'btn', type: 'button', onclick: () => setSpin(!spin) });
  const zoom = h('div', { class: 'floating zoom' },
    modeBtn,
    spinBtn,
    h('button', { class: 'btn', type: 'button', 'aria-label': t('ui.graph.zoomIn'), title: t('ui.graph.zoomIn'), onclick: () => zoomBy(1.25) }, icon('plus')),
    h('button', { class: 'btn', type: 'button', 'aria-label': t('ui.graph.zoomOut'), title: t('ui.graph.zoomOut'), onclick: () => zoomBy(0.8) }, h('span', { 'aria-hidden': 'true' }, '−')),
    h('button', { class: 'btn', type: 'button', 'aria-label': t('ui.graph.fit'), title: t('ui.graph.fit'), onclick: () => fit() }, icon('refresh', 16)));
  const hint3d = h('div', { class: 'floating hint3d hint' }, t('ui.graph.hint3d'));
  const el = h('div', { class: 'stage' }, canvas, panel, legend, zoom, hint3d, tip);

  function paintControls() {
    clear(modeBtn);
    modeBtn.append(mode === '3d' ? '2D' : '3D');
    modeBtn.setAttribute('aria-label', mode === '3d' ? t('ui.graph.to2d') : t('ui.graph.to3d'));
    modeBtn.title = modeBtn.getAttribute('aria-label');
    spinBtn.hidden = mode !== '3d' || reduceMotion.matches;
    clear(spinBtn);
    spinBtn.append(h('span', { 'aria-hidden': 'true' }, spin ? '❚❚' : '↻'));
    spinBtn.setAttribute('aria-label', spin ? t('ui.graph.stopRotation') : t('ui.graph.startRotation'));
    spinBtn.setAttribute('aria-pressed', String(spin));
    spinBtn.title = spinBtn.getAttribute('aria-label');
    hint3d.hidden = mode !== '3d';
  }

  function setSpin(on) {
    spin = on;
    paintControls();
    schedule();
  }

  function setMode(m) {
    if (m === mode) return;
    mode = m;
    nodes = []; // new layout: 3D doesn't start from a graph flattened on a single plane
    fitPending = true;
    paintControls();
    rebuild(true);
  }

  // ------------------------------------------------------------ dati
  function readColors() {
    colors = resolveColors(el, {
      paper: '--paper', raised: '--raised', ink: '--ink', ink2: '--ink-2', ink3: '--ink-3', rule: '--rule',
      agent: '--agent', skill: '--skill', signal: '--signal-hi', amber: '--amber-hi',
      glowAgent: '--glow-agent', glowSkill: '--glow-skill', glowAmber: '--glow-amber', glowSignal: '--glow-signal',
    });
  }

  function rebuild(force = false) {
    const st = store.state;
    if (!st || !size.w) return;
    let ents = [...st.agents, ...st.skills].filter((e) => (!scope || scope.ids.has(e.id)) && filters.kinds.has(e.kind) && filters.origins.has(e.origin) && (!filters.cat || catsOf(e).includes(filters.cat)));
    let ids = new Set(ents.map((e) => e.id));
    const E = [];
    for (const ed of st.edges) if (ids.has(ed.from) && ids.has(ed.to)) E.push({ source: ed.from, target: ed.to, type: ed.type });
    // in a team graph: agent and skills with the same role work together (if not already connected)
    const have = new Set(E.map((x) => `${x.source}>${x.target}`));
    for (const ed of scope?.edges ?? []) if (ids.has(ed.source) && ids.has(ed.target) && !have.has(`${ed.source}>${ed.target}`)) E.push({ source: ed.source, target: ed.target, type: 'team' });
    const seen = new Set();
    for (const e of ents) {
      for (const c of e.conflictsWith) {
        const k = [e.id, c].sort().join('|');
        if (ids.has(c) && !seen.has(k)) {
          seen.add(k);
          E.push({ source: e.id, target: c, type: 'conflict' });
        }
      }
    }
    const deg = new Map();
    for (const ed of E) {
      deg.set(ed.source, (deg.get(ed.source) ?? 0) + 1);
      deg.set(ed.target, (deg.get(ed.target) ?? 0) + 1);
    }
    if (filters.linkedOnly) {
      ents = ents.filter((e) => deg.get(e.id));
      ids = new Set(ents.map((e) => e.id));
    }
    const sig = JSON.stringify([ents.map((e) => e.id), E.map((x) => `${x.source}>${x.target}:${x.type}`)]);
    if (!force && sig === signature && sim) {
      const m = new Map(ents.map((e) => [e.id, e]));
      for (const n of nodes) n.e = m.get(n.id) ?? n.e;
      draw();
      return;
    }
    signature = sig;
    const prev = new Map(nodes.map((n) => [n.id, { x: n.x, y: n.y, z: n.z }]));
    nodes = ents.map((e) => {
      const d = Math.min(deg.get(e.id) ?? 0, 8);
      return { id: e.id, e, group: catsOf(e)[0] ?? '_', r: e.kind === 'agent' ? 10 + d * 0.8 : 6 + d * 0.7 };
    });
    edges = E;
    sim = new Simulation(nodes, E, { width: size.w, height: size.h, previous: prev, dims: mode === '3d' ? 3 : 2 });
    sim.run(prev.size ? 30 : 160);
    if (fitPending || !prev.size) fit(false);
    counter.textContent = t('ui.graph.counts', { nodes: nodes.length, edges: E.filter((x) => x.type !== 'conflict').length });
    if (!nodes.length) counter.textContent = t('ui.graph.noMatches');
    schedule();
  }

  // ------------------------------------------------------------ view
  // 2D: world x,y -> screen with zoom (k) and pan (x,y). 3D: perspective camera projection first.
  const proj = new Map(); // id -> {x, y, s, depth} in screen pixels (updated on every draw)

  function screenOf(n) {
    if (mode !== '3d') return { x: n.x * view.k + view.x, y: n.y * view.k + view.y, s: 1, depth: 0 };
    const p = project(n, cam);
    return { x: p.x * view.k + view.x, y: p.y * view.k + view.y, s: p.s, depth: p.depth };
  }

  function centerCamera() {
    if (!nodes.length) return;
    let x = 0;
    let y = 0;
    let z = 0;
    for (const n of nodes) {
      x += n.x;
      y += n.y;
      z += n.z ?? 0;
    }
    cam.cx = x / nodes.length;
    cam.cy = y / nodes.length;
    cam.cz = z / nodes.length;
  }

  function fit(animate = true) {
    if (!nodes.length || !size.w) return;
    let b;
    if (mode === '3d') {
      centerCamera();
      b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      for (const n of nodes) {
        const p = project(n, cam);
        const r = n.r * p.s;
        b.minX = Math.min(b.minX, p.x - r);
        b.minY = Math.min(b.minY, p.y - r);
        b.maxX = Math.max(b.maxX, p.x + r);
        b.maxY = Math.max(b.maxY, p.y + r);
      }
    } else b = sim.bounds();
    const pad = 70;
    const w = Math.max(b.maxX - b.minX, 120);
    const hgt = Math.max(b.maxY - b.minY, 120);
    const k = Math.max(0.25, Math.min(1.5, Math.min((size.w - pad * 2) / w, (size.h - pad * 2) / hgt)));
    view = { k, x: size.w / 2 - ((b.minX + b.maxX) / 2) * k, y: size.h / 2 - ((b.minY + b.maxY) / 2) * k };
    fitPending = false;
    if (animate) draw();
  }

  function zoomBy(f, cx = size.w / 2, cy = size.h / 2) {
    const k = Math.max(0.2, Math.min(3.5, view.k * f));
    view.x = cx - ((cx - view.x) / view.k) * k;
    view.y = cy - ((cy - view.y) / view.k) * k;
    view.k = k;
    draw();
  }

  function rotateBy(dyaw, dpitch) {
    cam.yaw += dyaw;
    cam.pitch = Math.max(-1.45, Math.min(1.45, cam.pitch + dpitch));
    draw();
  }

  function pick(px, py) {
    let best = null;
    let bd = Infinity;
    for (const n of nodes) {
      const p = proj.get(n.id) ?? screenOf(n);
      const d = Math.hypot(p.x - px, p.y - py);
      const lim = n.r * p.s * view.k + 5;
      // in 3D, at equal distance the point closer to the camera wins
      const score = d - (mode === '3d' ? p.s * 2 : 0);
      if (d <= lim && score < bd) {
        best = n;
        bd = score;
      }
    }
    return best;
  }

  // ------------------------------------------------------------ render
  function schedule() {
    needsDraw = true;
    if (!raf && !destroyed) raf = requestAnimationFrame(frame);
  }
  const draw = schedule;

  // While an element is in focus (hover or selection) small light pulses travel
  // along its connections: motion responds to user action and halts when reduced motion is preferred.
  // In 3D the graph gently auto-rotates until interacted with (toggle button to stop or restart).
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const hasFocus = () => Boolean((hover?.id ?? store.selected) && sim);
  const spinning = () => mode === '3d' && spin && !reduceMotion.matches && !drag && !pan && !orbit && !hover && nodes.length > 0;
  const animating = () => (hasFocus() && !reduceMotion.matches) || spinning();

  function frame() {
    raf = 0;
    if (destroyed) return;
    if (sim && !sim.settled) {
      sim.tick();
      sim.tick();
      needsDraw = true;
    }
    if (spinning()) cam.yaw += 0.0022;
    if (animating()) needsDraw = true;
    if (needsDraw) {
      paint(performance.now());
      needsDraw = false;
    }
    if ((sim && !sim.settled) || animating()) raf = requestAnimationFrame(frame);
  }

  function roundRect(x, y, w, hh, r) {
    c2.beginPath();
    c2.moveTo(x + r, y);
    c2.arcTo(x + w, y, x + w, y + hh, r);
    c2.arcTo(x + w, y + hh, x, y + hh, r);
    c2.arcTo(x, y + hh, x, y, r);
    c2.arcTo(x, y, x + w, y, r);
    c2.closePath();
  }

  function glow(color, blur) {
    c2.shadowColor = color;
    c2.shadowBlur = blur * size.dpr;
  }
  const noGlow = () => {
    c2.shadowColor = 'transparent';
    c2.shadowBlur = 0;
  };

  function paint(now = 0) {
    if (!size.w) return;
    c2.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
    c2.clearRect(0, 0, size.w, size.h);
    const sel = store.selected;
    const focus = hover?.id ?? sel;
    const near = focus && sim ? new Set([focus, ...(sim.neighbors.get(focus) ?? [])]) : null;
    const searching = hits.size > 0;
    const glowAll = nodes.length <= GLOW_MAX_NODES;
    const three = mode === '3d';

    // screen positions and depth fog (in 3D distant items fade)
    proj.clear();
    let dMin = Infinity;
    let dMax = -Infinity;
    for (const n of nodes) {
      const p = screenOf(n);
      proj.set(n.id, p);
      dMin = Math.min(dMin, p.depth);
      dMax = Math.max(dMax, p.depth);
    }
    const span = Math.max(dMax - dMin, 1);
    const fog = (p) => (three ? 1 - ((p.depth - dMin) / span) * 0.62 : 1);
    const rad = (n, p) => n.r * p.s * view.k;

    // edges
    const pulses = [];
    for (const e of sim?.edges ?? []) {
      const touches = near ? near.has(e.source) && near.has(e.target) && (e.source === focus || e.target === focus) : true;
      const lit = Boolean(near) && touches;
      const a = proj.get(e.source);
      const b = proj.get(e.target);
      if (!a || !b) continue;
      const color = e.type === 'conflict' ? colors.signal : e.type === 'depends' ? colors.skill : colors.agent;
      const base = near ? (touches ? 0.95 : 0.08) : searching && !(hits.has(e.source) || hits.has(e.target)) ? 0.14 : 0.5;
      c2.globalAlpha = base * (lit ? 1 : (fog(a) + fog(b)) / 2);
      c2.strokeStyle = color;
      c2.lineWidth = (lit ? 2.2 : 1.4) * (three ? Math.min(1.4, (a.s + b.s) / 2) : 1);
      c2.setLineDash(e.type === 'assigned' ? [7, 4] : e.type === 'depends' ? [2, 4] : e.type === 'conflict' ? [3, 3] : e.type === 'team' ? [1, 5] : []);
      if (lit) glow(e.type === 'conflict' ? colors.glowSignal : e.type === 'depends' ? colors.glowSkill : colors.glowAgent, 12);
      c2.beginPath();
      c2.moveTo(a.x, a.y);
      c2.lineTo(b.x, b.y);
      c2.stroke();
      noGlow();
      if (e.type === 'depends') {
        c2.setLineDash([]);
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        const off = rad(e.b, b) + 3;
        const tx = b.x - Math.cos(ang) * off;
        const ty = b.y - Math.sin(ang) * off;
        c2.beginPath();
        c2.moveTo(tx, ty);
        c2.lineTo(tx - Math.cos(ang - 0.45) * 8, ty - Math.sin(ang - 0.45) * 8);
        c2.lineTo(tx - Math.cos(ang + 0.45) * 8, ty - Math.sin(ang + 0.45) * 8);
        c2.closePath();
        c2.fillStyle = colors.skill;
        c2.fill();
      }
      if (lit && e.type !== 'conflict') pulses.push({ a, b, glowColor: e.type === 'depends' ? colors.glowSkill : colors.glowAgent, seed: (e.source.length * 7 + e.target.length * 13) % 11 });
    }
    c2.setLineDash([]);

    // light pulses on focused connections (from caller to callee)
    if (pulses.length && !reduceMotion.matches) {
      c2.globalAlpha = 1;
      for (const p of pulses) {
        const t = (now / 2400 + p.seed * 0.093) % 1;
        glow(p.glowColor, 16);
        c2.fillStyle = colors.ink;
        c2.beginPath();
        c2.arc(p.a.x + (p.b.x - p.a.x) * t, p.a.y + (p.b.y - p.a.y) * t, 2.6, 0, Math.PI * 2);
        c2.fill();
      }
      noGlow();
    }

    // nodes (in 3D sorted from farthest to closest so near elements occlude far ones)
    const order = three ? [...nodes].sort((x, y) => proj.get(y.id).depth - proj.get(x.id).depth) : nodes;
    for (const n of order) {
      const e = n.e;
      const p = proj.get(n.id);
      const r = rad(n, p);
      const dim = (near && !near.has(n.id)) || (searching && !hits.has(n.id));
      const f = near?.has(n.id) || hits.has(n.id) || n.id === sel ? 1 : fog(p);
      c2.globalAlpha = (dim ? 0.2 : 1) * f;
      const col = e.kind === 'agent' ? colors.agent : colors.skill;
      const colGlow = e.kind === 'agent' ? colors.glowAgent : colors.glowSkill;
      const shine = !dim && (glowAll || n.id === sel || n.id === focus || hits.has(n.id) || near?.has(n.id));
      if (hits.has(n.id) || n.id === sel) {
        const hit = n.id !== sel;
        c2.strokeStyle = hit ? colors.amber : colors.ink;
        c2.lineWidth = 2.4;
        glow(hit ? colors.glowAmber : colors.glowAgent, 18);
        c2.beginPath();
        if (e.kind === 'agent') roundRect(p.x - r - 5, p.y - r - 5, r * 2 + 10, r * 2 + 10, 6);
        else c2.arc(p.x, p.y, r + 5, 0, Math.PI * 2);
        c2.stroke();
        noGlow();
      }
      c2.beginPath();
      if (e.kind === 'agent') roundRect(p.x - r, p.y - r, r * 2, r * 2, Math.min(3.5 * p.s * view.k, r));
      else c2.arc(p.x, p.y, r, 0, Math.PI * 2);
      if (shine) glow(colGlow, (e.kind === 'agent' ? 26 : 20) * (three ? Math.min(p.s, 1.3) : 1));
      if (e.origin === 'external') {
        c2.fillStyle = colors.raised;
        c2.fill();
        c2.strokeStyle = col;
        c2.lineWidth = 2.2 * Math.min(Math.max(p.s * view.k, 0.6), 1.6);
        c2.setLineDash([4, 2.5]);
        c2.stroke();
        c2.setLineDash([]);
      } else {
        c2.fillStyle = col;
        c2.fill();
      }
      noGlow();
      // in 3D a specular highlight adds volume to skill spheres
      if (three && e.kind === 'skill' && e.origin !== 'external' && r > 3) {
        const g = c2.createRadialGradient(p.x - r * 0.35, p.y - r * 0.4, r * 0.1, p.x, p.y, r);
        g.addColorStop(0, 'rgba(255,255,255,0.55)');
        g.addColorStop(0.6, 'rgba(255,255,255,0)');
        c2.fillStyle = g;
        c2.beginPath();
        c2.arc(p.x, p.y, r, 0, Math.PI * 2);
        c2.fill();
      }
      if (e.risk !== 'low') {
        const high = e.risk === 'high';
        c2.beginPath();
        c2.arc(p.x + r * 0.8, p.y - r * 0.8, 4, 0, Math.PI * 2);
        c2.fillStyle = high ? colors.signal : colors.amber;
        if (!dim) glow(high ? colors.glowSignal : colors.glowAmber, 10);
        c2.fill();
        noGlow();
        c2.strokeStyle = colors.paper;
        c2.lineWidth = 1.2;
        c2.stroke();
      }
    }

    // labels (crisp, in screen pixels)
    c2.globalAlpha = 1;
    c2.textBaseline = 'middle';
    c2.lineJoin = 'round';
    const many = nodes.length > 70;
    for (const n of order) {
      const p = proj.get(n.id);
      const isFocus = near?.has(n.id);
      const important = n.e.kind === 'agent' || n.id === sel || n.id === hover?.id || hits.has(n.id) || (isFocus && near.size < 14);
      const scale = view.k * p.s;
      if (!important && (many ? scale < 1.15 : scale < 0.55)) continue;
      const dim = (near && !near.has(n.id)) || (searching && !hits.has(n.id));
      if (p.x < -80 || p.y < -20 || p.x > size.w + 80 || p.y > size.h + 20) continue;
      c2.font = `${n.e.kind === 'agent' || n.id === sel ? 600 : 500} 13px ${FONT}`;
      c2.globalAlpha = (dim ? 0.3 : 1) * (important ? 1 : fog(p));
      c2.strokeStyle = colors.paper;
      c2.lineWidth = 4;
      c2.strokeText(n.e.name, p.x + rad(n, p) + 7, p.y);
      c2.fillStyle = colors.ink;
      c2.fillText(n.e.name, p.x + rad(n, p) + 7, p.y);
    }
    c2.globalAlpha = 1;
  }

  // ------------------------------------------------------------ interazione
  const local = (ev) => {
    const r = canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  };

  function showTip(n, p) {
    if (!n) {
      tip.hidden = true;
      return;
    }
    const e = n.e;
    clear(tip);
    tip.append(h('b', null, e.name), h('div', null, `${kindLabel(e)}, ${originLabel(e)}`), e.description ? h('div', { style: { opacity: '0.85', marginTop: '3px' } }, e.description.length > 130 ? e.description.slice(0, 129) + '…' : e.description) : null);
    tip.hidden = false;
    const w = tip.offsetWidth;
    tip.style.left = `${Math.min(p.x + 14, size.w - w - 8)}px`;
    tip.style.top = `${Math.max(8, Math.min(p.y + 14, size.h - tip.offsetHeight - 8))}px`;
  }

  canvas.addEventListener('pointerdown', (ev) => {
    const p = local(ev);
    const n = pick(p.x, p.y);
    canvas.setPointerCapture(ev.pointerId);
    canvas.classList.add('dragging');
    tip.hidden = true;
    if (n) {
      drag = { n, moved: false, sx: p.x, sy: p.y, lx: p.x, ly: p.y };
      n.fixed = true;
      sim.reheat(0.25);
    } else if (mode === '3d' && !ev.shiftKey && ev.button === 0) {
      // in 3D dragging the background rotates the graph; Shift+drag (or right click) pans
      orbit = { sx: p.x, sy: p.y, lx: p.x, ly: p.y, moved: false };
    } else pan = { sx: p.x, sy: p.y, vx: view.x, vy: view.y, moved: false };
  });
  canvas.addEventListener('pointermove', (ev) => {
    const p = local(ev);
    if (drag) {
      if (Math.hypot(p.x - drag.sx, p.y - drag.sy) > 3) drag.moved = true;
      if (mode === '3d') {
        // node moves on the plane parallel to the screen at its depth
        const sc = Math.max(project(drag.n, cam).s * view.k, 0.05);
        const d = unproject((p.x - drag.lx) / sc, (p.y - drag.ly) / sc, 0, cam);
        drag.n.x += d.x;
        drag.n.y += d.y;
        drag.n.z += d.z;
        drag.lx = p.x;
        drag.ly = p.y;
      } else {
        drag.n.x = (p.x - view.x) / view.k;
        drag.n.y = (p.y - view.y) / view.k;
      }
      sim.reheat(0.2);
      schedule();
      return;
    }
    if (orbit) {
      if (Math.hypot(p.x - orbit.sx, p.y - orbit.sy) > 3) orbit.moved = true;
      rotateBy((p.x - orbit.lx) * 0.008, (p.y - orbit.ly) * 0.008);
      orbit.lx = p.x;
      orbit.ly = p.y;
      return;
    }
    if (pan) {
      if (Math.hypot(p.x - pan.sx, p.y - pan.sy) > 3) pan.moved = true;
      view.x = pan.vx + (p.x - pan.sx);
      view.y = pan.vy + (p.y - pan.sy);
      schedule();
      return;
    }
    const n = pick(p.x, p.y);
    if (n !== hover) {
      hover = n;
      canvas.style.cursor = n ? 'pointer' : '';
      schedule();
    }
    showTip(n, p);
  });
  const end = () => {
    canvas.classList.remove('dragging');
    if (drag) {
      if (!drag.moved) ctx.select(drag.n.id);
      drag.n.fixed = false;
      drag = null;
    } else if (pan || orbit) {
      if (!(pan ?? orbit).moved) ctx.select(null);
      else if (orbit) setSpin(false); // user rotated manually: keep current orientation
      pan = null;
      orbit = null;
    }
    schedule();
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
  canvas.addEventListener('pointerleave', () => {
    if (!drag && !pan && !orbit && hover) {
      hover = null;
      showTip(null);
      schedule();
    }
  });
  canvas.addEventListener('dblclick', (ev) => {
    const p = local(ev);
    if (!pick(p.x, p.y)) fit();
  });
  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const p = local(ev);
    zoomBy(Math.exp(-ev.deltaY * 0.0015), p.x, p.y);
  }, { passive: false });
  canvas.addEventListener('keydown', (ev) => {
    if (ev.key === '+' || ev.key === '=') zoomBy(1.2);
    else if (ev.key === '-') zoomBy(0.83);
    else if (ev.key === '0') fit();
    else if (mode === '3d' && ev.key.startsWith('Arrow')) {
      ev.preventDefault();
      setSpin(false);
      const st = 0.12;
      rotateBy(ev.key === 'ArrowLeft' ? -st : ev.key === 'ArrowRight' ? st : 0, ev.key === 'ArrowUp' ? -st : ev.key === 'ArrowDown' ? st : 0);
    }
  });

  const ro = new ResizeObserver(() => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dpr = window.devicePixelRatio || 1;
    const first = !size.w;
    size = { w: Math.round(r.width), h: Math.round(r.height), dpr };
    canvas.width = Math.round(size.w * dpr);
    canvas.height = Math.round(size.h * dpr);
    readColors();
    if (first) rebuild(true);
    else schedule();
  });
  ro.observe(el);
  const onTheme = () => (readColors(), schedule());
  window.addEventListener('themechange', onTheme);
  document.fonts?.load?.('600 13px "Space Grotesk"').then(schedule, () => {});

  paintControls();
  reduceMotion.addEventListener?.('change', () => (paintControls(), schedule()));

  return {
    el,
    update() {
      if (!store.state) return;
      renderFilters();
      if (!store.state.skills.length && !store.state.agents.length) {
        counter.textContent = t('ui.graph.emptyHub');
      }
      rebuild(false);
    },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('themechange', onTheme);
    },
  };
}
