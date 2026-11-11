// Flow: visual circuit diagram. Agents → skills → required tools, with red sockets where dependencies are missing.
import { h, clear, s } from '../dom.js';
import { api } from '../api.js';
import { layered } from '../layout.js';
import { store, shortName } from '../store.js';
import { t } from '../i18n.js';

// one shade of blue per agent (defined in style.css: adapts with light/dark theme)
const WIRES = ['var(--w1)', 'var(--w2)', 'var(--w3)', 'var(--w4)', 'var(--w5)', 'var(--w6)', 'var(--w7)'];
const NODE_W = 210;
const NODE_H = 38;
const COL_GAP = 320;
const ROW = 56;

/**
 * @param {object} ctx
 * @param {{scope?: {roles: {id: string, name: string, agents: string[], skills: string[]}[]}}} [opts]
 *   scope: team flow with roles column (role → agents → skills → tools); without scope, full hub flow
 */
export default function create(ctx, opts = {}) {
  const scope = opts.scope ?? null;
  let query = '';
  let scopeAgent = '';
  let results = []; // [{id, score}]
  let searching = false;
  let focus = null;
  let lastKey = '';
  let lastWidth = 0;
  let nodeEls = new Map();

  const input = h('input', { type: 'search', placeholder: t('ui.flow.goalPlaceholder'), 'aria-label': t('ui.flow.goalAria'), value: '' });
  const agentSel = h('select', { 'aria-label': t('ui.flow.showOneAgent'), onchange: () => ((scopeAgent = agentSel.value), render()) });
  const form = h('form', { onsubmit: async (ev) => {
    ev.preventDefault();
    query = input.value.trim();
    results = [];
    if (query) {
      searching = true;
      render();
      try {
        const all = (await api.search(query, { limit: 10 })).results;
        const top = all[0]?.score ?? 0;
        results = all.filter((r) => r.score >= top * 0.25);
      } catch (e) {
        ctx.toast(e.message, 'error');
      }
      searching = false;
    }
    render();
  } }, input, h('button', { class: 'btn primary', type: 'submit' }, t('ui.flow.showFlow')), query ? h('button', { class: 'btn', type: 'button' }, t('ui.flow.showAll')) : null, agentSel);
  const summary = h('div', { class: 'hint', 'aria-live': 'polite' });
  const scroller = h('div', { class: 'flow-scroll' });
  const el = h('div', { class: 'flow-grid' }, h('div', { class: 'flow-head' }, form, summary), scroller);

  function pickEntries() {
    const st = store.state;
    const byId = store.byId;
    const skills = new Set();
    const agents = new Set();
    if (scope) {
      // only team members that exist in this hub
      for (const r of scope.roles) {
        for (const a of r.agents) if (byId.has(a)) agents.add(a);
        for (const s of r.skills) if (byId.has(s)) skills.add(s);
      }
      return { agents: [...agents], skills: [...skills] };
    }
    const addSkillClosure = (id) => {
      if (skills.has(id) || !byId.has(id)) return;
      skills.add(id);
      for (const e of st.edges) if (e.type === 'depends' && e.from === id) addSkillClosure(e.to);
    };
    if (query) {
      for (const r of results) {
        const e = byId.get(r.id);
        if (!e) continue;
        if (e.kind === 'skill') addSkillClosure(e.id);
        else agents.add(e.id);
      }
      for (const a of [...agents]) for (const e of st.edges) if (e.type !== 'depends' && e.from === a) addSkillClosure(e.to);
      for (const e of st.edges) if (e.type !== 'depends' && skills.has(e.to)) agents.add(e.from);
    } else {
      const wanted = scopeAgent ? st.agents.filter((a) => a.id === scopeAgent) : st.agents;
      for (const a of wanted) {
        agents.add(a.id);
        for (const e of st.edges) if (e.type !== 'depends' && e.from === a.id) addSkillClosure(e.to);
      }
      // full view: includes unassigned skills, after agent skills
      if (!scopeAgent) for (const sk of st.skills) addSkillClosure(sk.id);
    }
    return { agents: [...agents], skills: [...skills] };
  }

  function render() {
    const st = store.state;
    if (!st) return;
    lastKey = keyOf();
    const keepT = scroller.scrollTop;
    const keepL = scroller.scrollLeft;
    // agent list in dropdown
    const keep = agentSel.value;
    clear(agentSel);
    agentSel.append(h('option', { value: '' }, t('ui.flow.allAgents')), ...st.agents.map((a) => h('option', { value: a.id }, a.name)));
    agentSel.value = st.agents.some((a) => a.id === keep) ? keep : '';
    scopeAgent = agentSel.value;
    agentSel.hidden = !st.agents.length || Boolean(query);
    form.hidden = Boolean(scope); // search is hidden in team flow: displays roles instead
    const showAll = form.querySelector('button[type="button"]');
    if (query && !showAll) {
      form.insertBefore(h('button', { class: 'btn', type: 'button', onclick: () => ((query = ''), (results = []), (input.value = ''), render()) }, t('ui.flow.showAll')), agentSel);
    } else if (!query && showAll) showAll.remove();

    const { agents, skills } = pickEntries();
    clear(scroller);
    clear(summary);

    if (query && searching) {
      summary.textContent = t('ui.flow.searching');
      return;
    }
    if (query) {
      if (!results.length) {
        summary.textContent = '';
        scroller.append(h('div', { class: 'page' }, h('div', { class: 'empty' }, h('strong', null, t('ui.flow.noSkillFound')), t('ui.flow.noSkillFoundHint'))));
        return;
      }
      const names = results.slice(0, 5).map((r) => shortName(r.id));
      const more = results.length > 5 ? t('ui.flow.moreResults', { n: results.length - 5 }) : '';
      summary.textContent = t('ui.flow.orchestratorStart', { names: names.join(', '), more });
    } else if (scope) {
      summary.textContent = t('ui.flow.teamRolesSummary');
    } else {
      const linked = st.edges.some((e) => e.type !== 'depends' && agents.includes(e.from));
      summary.textContent = !agents.length
        ? t('ui.flow.noAgentsSummary')
        : linked
          ? t('ui.flow.agentsWithSkillsSummary')
          : t('ui.flow.noLinkedSkillsSummary');
    }

    if (!agents.length && !skills.length) {
      scroller.append(h('div', { class: 'page' }, h('div', { class: 'empty' }, h('strong', null, t('ui.flow.nothingToShow')), scope ? t('ui.flow.noTeamMembers') : t('ui.flow.noItemsHint'))));
      return;
    }

    // required tools
    const byId = store.byId;
    const tools = new Map(); // id → {kind,name}
    const needEdges = [];
    for (const id of [...skills, ...agents]) {
      const e = byId.get(id);
      for (const c of e.requires.commands) {
        tools.set(`cmd:${c}`, { kind: 'cmd', name: c, ok: Boolean(st.commands?.[c]) });
        needEdges.push({ from: id, to: `cmd:${c}` });
      }
      for (const m of e.requires.mcp) {
        tools.set(`mcp:${m}`, { kind: 'mcp', name: m });
        needEdges.push({ from: id, to: `mcp:${m}` });
      }
    }
    const useEdges = st.edges.filter((e) => e.type !== 'depends' && agents.includes(e.from) && skills.includes(e.to)).map((e) => ({ from: e.from, to: e.to, type: e.type }));
    // team: role → role agents; agent → role skills; role → skills directly if role has no agents
    const roleIds = scope ? scope.roles.map((r) => `role:${r.id}`) : [];
    const roleEdges = [];
    if (scope) {
      const seen = new Set(useEdges.map((e) => `${e.from}>${e.to}`));
      for (const r of scope.roles) {
        const ra = r.agents.filter((a) => agents.includes(a));
        const rs = r.skills.filter((x) => skills.includes(x));
        for (const a of ra) roleEdges.push({ from: `role:${r.id}`, to: a });
        if (!ra.length) for (const x of rs) roleEdges.push({ from: `role:${r.id}`, to: x });
        for (const a of ra) for (const x of rs) if (!seen.has(`${a}>${x}`)) (seen.add(`${a}>${x}`), useEdges.push({ from: a, to: x, type: 'team' }));
      }
    }
    const depEdges = st.edges.filter((e) => e.type === 'depends' && skills.includes(e.from) && skills.includes(e.to));

    const colDefs = [];
    const titles = [];
    if (scope) {
      colDefs.push(roleIds);
      titles.push(t('ui.flow.colRoles'));
    }
    if (agents.length) {
      colDefs.push(agents);
      titles.push(t('ui.flow.colAgents'));
    }
    colDefs.push(skills);
    titles.push(t('ui.flow.colSkills'));
    if (tools.size) {
      colDefs.push([...tools.keys()]);
      titles.push(t('ui.flow.colTools'));
    }
    const lay = layered(colDefs, [...roleEdges, ...useEdges, ...needEdges], { rowHeight: ROW, colGap: COL_GAP, nodeWidth: NODE_W, top: 56, align: 'top' });
    const pos = new Map(lay.columns.flat().map((n) => [n.id, n]));
    const margin = 56;
    const W = Math.max(lay.width + margin * 2 + 70, scroller.clientWidth || 0);
    const offX = Math.max(margin, (W - lay.width) / 2 - 20);
    const svg = s('svg', { width: W, height: lay.height + 24, viewBox: `0 0 ${W} ${lay.height + 24}`, role: 'group', 'aria-label': t('ui.flow.svgAria') });
    const gWires = s('g');
    const gNodes = s('g');
    svg.append(gWires, gNodes);

    colDefs.forEach((_, i) => svg.append(s('text', { class: 'flow-col-title', x: offX + i * COL_GAP, y: 30 }, titles[i])));

    const agentColor = new Map(agents.map((a, i) => [a, WIRES[i % WIRES.length]]));
    const wires = [];
    const addWire = (from, to, { color, cls = '', dash = false }) => {
      const a = pos.get(from);
      const b = pos.get(to);
      if (!a || !b) return;
      const x1 = offX + a.x + NODE_W / 2;
      const x2 = offX + b.x - NODE_W / 2;
      const dx = Math.max(40, (x2 - x1) * 0.5);
      const d = `M${x1} ${a.y} C${x1 + dx} ${a.y} ${x2 - dx} ${b.y} ${x2} ${b.y}`;
      const path = s('path', { class: `wire ${cls}`, d, stroke: color, style: { color } });
      gWires.append(path, s('rect', { class: 'plug', x: x1 - 1, y: a.y - 5, width: 6, height: 10, rx: 1.5, fill: color }), s('rect', { class: 'plug', x: x2 - 5, y: b.y - 5, width: 6, height: 10, rx: 1.5, fill: color }));
      wires.push({ from, to, path });
    };

    const roleColor = new Map(roleIds.map((r, i) => [r, WIRES[i % WIRES.length]]));
    for (const e of roleEdges) addWire(e.from, e.to, { color: roleColor.get(e.from) });
    for (const e of useEdges) addWire(e.from, e.to, { color: agentColor.get(e.from) ?? WIRES[0], cls: e.type === 'team' ? 'team' : '' });
    for (const e of needEdges) {
      const t = tools.get(e.to);
      addWire(e.from, e.to, { color: t.kind === 'cmd' && !t.ok ? 'var(--signal-hi)' : 'var(--ink-3)', cls: `need ${t.kind === 'cmd' && !t.ok ? 'missing' : ''}` });
    }
    for (const e of depEdges) {
      const a = pos.get(e.from);
      const b = pos.get(e.to);
      if (!a || !b) continue;
      const x = offX + a.x + NODE_W / 2;
      const bulge = 46 + Math.abs(a.y - b.y) * 0.12;
      const path = s('path', { class: 'wire dep', d: `M${x} ${a.y} C${x + bulge} ${a.y} ${x + bulge} ${b.y} ${x} ${b.y}`, stroke: 'var(--skill)', style: { color: 'var(--skill)' } });
      gWires.append(path);
      wires.push({ from: e.from, to: e.to, path });
    }

    const rank = new Map(results.map((r, i) => [r.id, i]));
    nodeEls = new Map();
    const trunc = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t);

    for (const n of lay.columns.flat()) {
      const x = offX + n.x - NODE_W / 2;
      const y = n.y - NODE_H / 2;
      let g;
      if (n.id.startsWith('role:')) {
        const r = scope.roles.find((x) => `role:${x.id}` === n.id);
        const count = r.agents.length + r.skills.length;
        g = s('g', { class: 'fnode role', tabindex: '0', role: 'img', 'aria-label': t('ui.flow.roleAria', { name: r.name, count }) },
          s('rect', { class: 'body', x, y, width: NODE_W, height: NODE_H, rx: 10 }),
          s('text', { x: x + 12, y: y + 16 }, trunc(r.name, 24)),
          s('text', { class: 'sub', x: x + 12, y: y + 30 }, count ? t('ui.flow.roleMembers', { agents: r.agents.length, skills: r.skills.length }) : t('ui.flow.noRoleMembers')));
      } else if (tools.has(n.id)) {
        const tTool = tools.get(n.id);
        const state = tTool.kind === 'mcp' ? 'unknown' : tTool.ok ? '' : 'missing';
        const kindLabel = tTool.kind === 'mcp' ? t('ui.flow.connector') : t('ui.flow.command');
        const stateLabel = tTool.kind === 'mcp' ? t('ui.flow.stateToVerify') : tTool.ok ? t('ui.flow.stateFound') : t('ui.flow.stateMissing');
        g = s('g', { class: `fnode socket ${state}`, tabindex: '0', role: 'img', 'aria-label': t('ui.flow.toolAria', { kind: kindLabel, name: tTool.name, state: stateLabel }) },
          s('rect', { class: 'body', x, y, width: NODE_W, height: NODE_H, rx: 6 }),
          s('text', { x: x + 12, y: y + 16 }, trunc(tTool.name, 24)),
          s('text', { class: 'sub', x: x + 12, y: y + 30 }, tTool.kind === 'mcp' ? t('ui.flow.connectorSession') : tTool.ok ? t('ui.flow.toolFound') : t('ui.flow.toolMissing')));
      } else {
        const e = byId.get(n.id);
        const isAgent = e.kind === 'agent';
        const r = rank.get(n.id);
        g = s('g', { class: `fnode ${isAgent ? 'agent' : ''} ${r !== undefined && r < 5 ? 'hit' : ''} ${store.selected === n.id ? 'sel' : ''}`, tabindex: '0', role: 'button', 'aria-label': t('ui.flow.openDetailAria', { kind: isAgent ? t('ui.catalog.agent') : t('ui.catalog.skill'), name: e.name }), onclick: () => ctx.select(n.id), onkeydown: (ev) => (ev.key === 'Enter' || ev.key === ' ') && (ev.preventDefault(), ctx.select(n.id)) },
          s('rect', { class: 'body', x, y, width: NODE_W, height: NODE_H, rx: isAgent ? 4 : 19, ...(e.origin === 'external' ? { 'stroke-dasharray': '5 3' } : {}) }),
          s('text', { x: x + (isAgent ? 12 : 18), y: y + 16 }, trunc(e.name, 22)),
          s('text', { class: 'sub', x: x + (isAgent ? 12 : 18), y: y + 30 }, isAgent ? t('ui.flow.agentSkillsCount', { n: scope ? useEdges.filter((x) => x.from === n.id).length : e.skills.length, team: scope ? t('ui.flow.inTeam') : '' }) : e.origin === 'external' ? t('ui.flow.fromGithub') : e.scope === 'assigned' ? t('ui.flow.assignedSkill') : t('ui.flow.genericSkill')),
          s('title', null, e.description));
      }
      g.addEventListener('mouseenter', () => setFocus(n.id));
      g.addEventListener('mouseleave', () => setFocus(null));
      g.addEventListener('focus', () => setFocus(n.id));
      g.addEventListener('blur', () => setFocus(null));
      nodeEls.set(n.id, g);
      gNodes.append(g);
    }

    function setFocus(id) {
      focus = id;
      const near = new Set(id ? [id] : []);
      if (id) for (const w of wires) if (w.from === id || w.to === id) (near.add(w.from), near.add(w.to));
      for (const w of wires) w.path.classList.toggle('dim', Boolean(id) && w.from !== id && w.to !== id);
      for (const [nid, g] of nodeEls) g.classList.toggle('dim', Boolean(id) && !near.has(nid));
    }

    scroller.append(svg);
    scroller.scrollTop = keepT;
    scroller.scrollLeft = keepL;
  }

  const keyOf = () => JSON.stringify([store.state?.fingerprint, query, scopeAgent, results.map((r) => r.id), store.state?.commands]);
  const markSelected = () => {
    for (const [id, g] of nodeEls) g.classList.toggle('sel', store.selected === id);
  };

  const ro = new ResizeObserver(() => {
    const w = scroller.clientWidth;
    if (store.state && w !== lastWidth) {
      lastWidth = w;
      render();
    }
  });
  ro.observe(scroller);

  return {
    el,
    update() {
      if (!store.state) return;
      if (keyOf() !== lastKey) render();
      else markSelected();
    },
    destroy() {
      ro.disconnect();
    },
  };
}
