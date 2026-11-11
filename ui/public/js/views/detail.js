// Detail drawer for a skill or agent: categories, connections, requirements, origin.
import { h, clear, icon } from '../dom.js';
import { api } from '../api.js';
import { store, catLabel, catsOf, links, shortName } from '../store.js';
import { catChips, kindDot, kindLabel, riskBadge } from '../ui.js';
import { guarded, removeItem, updateItems } from '../actions.js';
import { t } from '../i18n.js';

export function createDrawer(el, { select }) {
  let editingCats = false;
  let lastId = null;
  let usage = null; // /api/usage: requested on first drawer open
  let usageAsked = false;

  const nameBtn = (id) => h('button', { type: 'button', class: 'name', onclick: () => select(id) }, shortName(id));

  function section(title, ...kids) {
    return h('section', null, h('h3', null, title), ...kids);
  }

  function categories(e) {
    if (!editingCats) {
      const cats = catChips(e, { max: 20 });
      return section(
        t('ui.detail.categories'),
        h('div', { class: 'chips' }, cats.length ? cats : h('span', { class: 'hint' }, t('ui.detail.noCats'))),
        h('p', { class: 'hint', style: { margin: '6px 0 8px' } }, e.categories.length ? t('ui.detail.catsYours') : t('ui.detail.catsInferred')),
        h('button', { type: 'button', class: 'btn small', onclick: () => ((editingCats = true), render()) }, t('ui.detail.editCats')),
      );
    }
    const chosen = new Set(e.categories);
    const buttons = Object.entries(store.state.categories).map(([id, c]) => {
      const b = h('button', { type: 'button', class: 'chip', 'aria-pressed': String(chosen.has(id)), onclick: () => {
        chosen.has(id) ? chosen.delete(id) : chosen.add(id);
        b.setAttribute('aria-pressed', String(chosen.has(id)));
      } }, c.label);
      return b;
    });
    return section(
      t('ui.detail.categories'),
      h('div', { class: 'catpick' }, buttons),
      h('div', { class: 'addrow' },
        h('button', { type: 'button', class: 'btn small primary', onclick: async () => {
          await guarded(() => api.categorize(e.id, [...chosen]), t('ui.detail.savedInRegistry'));
          editingCats = false;
          render();
        } }, t('ui.detail.save')),
        h('button', { type: 'button', class: 'btn small', onclick: async () => {
          await guarded(() => api.categorize(e.id, []), t('ui.detail.resetDone'));
          editingCats = false;
          render();
        } }, t('ui.detail.resetCats')),
        h('button', { type: 'button', class: 'btn small ghost', onclick: () => ((editingCats = false), render()) }, t('ui.common.cancel')),
      ),
    );
  }

  function linkRow(edge, otherId, { unlink }) {
    return h('div', { class: 'linkrow' },
      kindDot(store.byId.get(otherId) ?? { kind: otherId.startsWith('agent:') ? 'agent' : 'skill', origin: 'own' }),
      h('span', { class: 'grow' }, nameBtn(otherId), ' ', h('span', { class: 'hint' }, edge.type === 'declared' ? t('ui.detail.inAgentFile') : t('ui.detail.inRegistry'))),
      edge.type === 'assigned'
        ? h('button', { type: 'button', class: 'btn small ghost', title: t('ui.detail.unlink'), 'aria-label': t('ui.detail.unlinkAria', { name: shortName(otherId) }), onclick: unlink }, icon('unlink', 16), t('ui.detail.unlink'))
        : null,
    );
  }

  function connections(e) {
    const l = links(e.id);
    if (e.kind === 'skill') {
      const users = l.usedBy;
      const taken = new Set(users.map((x) => x.from));
      const free = store.state.agents.filter((a) => !taken.has(a.id));
      const sel = h('select', { 'aria-label': t('ui.detail.agentToLink') }, free.map((a) => h('option', { value: a.id }, a.name)));
      return section(
        t('ui.detail.usedBy'),
        h('p', { class: 'hint', style: { marginTop: 0 } }, users.length ? t.n('ui.detail.assignedToCount', users.length) : t('ui.detail.globalSkill')),
        ...users.map((x) => linkRow(x, x.from, { unlink: () => guarded(() => api.unlink(x.from, e.id), t('ui.detail.unlinked')) })),
        store.state.agents.length
          ? free.length
            ? h('div', { class: 'addrow' }, sel, h('button', { type: 'button', class: 'btn small', onclick: () => guarded(() => api.link(sel.value, e.id), t('ui.detail.linked')) }, icon('link', 16), t('ui.detail.link')))
            : h('p', { class: 'hint' }, t('ui.detail.alreadyLinkedAll'))
          : h('p', { class: 'hint' }, t('ui.detail.noAgentsYet')),
      );
    }
    const mine = l.uses;
    const taken = new Set(mine.map((x) => x.to));
    const free = store.state.skills.filter((s) => !taken.has(s.id));
    const sel = h('select', { 'aria-label': t('ui.detail.skillToLink') }, free.map((s) => h('option', { value: s.id }, s.name)));
    return section(
      t('ui.detail.skillsUsed'),
      mine.length ? null : h('p', { class: 'hint', style: { marginTop: 0 } }, t('ui.detail.noSkillsLinked')),
      ...mine.map((x) => linkRow(x, x.to, { unlink: () => guarded(() => api.unlink(e.id, x.to), t('ui.detail.unlinked')) })),
      free.length ? h('div', { class: 'addrow' }, sel, h('button', { type: 'button', class: 'btn small', onclick: () => guarded(() => api.link(e.id, sel.value), t('ui.detail.linked')) }, icon('link', 16), t('ui.detail.link'))) : null,
    );
  }

  function requirements(e) {
    const rows = [];
    for (const c of e.requires.commands) {
      const ok = store.state.commands?.[c];
      rows.push(h('div', { class: 'linkrow' }, h('code', null, c), h('span', { class: 'grow' }), h('span', { class: `badge ${ok ? 'ok' : 'warn'}` }, ok ? t('ui.detail.cmdFound') : t('ui.detail.cmdMissing'))));
    }
    for (const m of e.requires.mcp) rows.push(h('div', { class: 'linkrow' }, h('code', null, m), h('span', { class: 'grow' }), h('span', { class: 'badge' }, t('ui.detail.mcpVerify'))));
    if (!rows.length) return null;
    return section(t('ui.detail.toolsRequired'), ...rows, rows.some((r) => r.querySelector('.badge.warn')) ? h('p', { class: 'hint' }, t('ui.detail.toolsInstallHint')) : null);
  }

  function dependencies(e) {
    const l = links(e.id);
    const rows = [
      ...l.dependsOn.map((x) => h('div', { class: 'linkrow' }, kindDot(store.byId.get(x.to) ?? { kind: 'skill', origin: 'own' }), h('span', { class: 'grow' }, t('ui.detail.dependsOn', { name: '' }), nameBtn(x.to)))),
      ...l.neededBy.map((x) => h('div', { class: 'linkrow' }, kindDot(store.byId.get(x.from) ?? { kind: 'skill', origin: 'own' }), h('span', { class: 'grow' }, t('ui.detail.neededBy', { name: '' }), nameBtn(x.from)))),
      ...e.conflictsWith.map((c) => h('div', { class: 'linkrow' }, h('span', { class: 'badge warn' }, t('ui.detail.conflicts')), h('span', { class: 'grow' }, store.byId.has(c) ? nameBtn(c) : shortName(c)))),
    ];
    return rows.length ? section(t('ui.detail.depsAndConflicts'), ...rows) : null;
  }

  function origin(e) {
    const kv = [[t('ui.detail.file'), h('code', null, e.file)]];
    if (e.capabilities?.length) kv.push([t('ui.detail.capabilities'), e.capabilities.join(', ')]);
    if (e.hasScripts) kv.push([t('ui.detail.scripts'), t('ui.detail.scriptsNotice')]);
    const lock = store.state.lock.find((x) => x.kind === e.kind && x.name === e.name);
    if (e.origin === 'external') {
      const src = lock?.source ?? e.source;
      kv.push([t('ui.detail.from'), src?.repo ? `${src.repo}${src.ref ? ` @ ${src.ref}` : ''}` : t('ui.detail.unknownSource')]);
      if (src?.commit) kv.push([t('ui.detail.version'), h('code', null, String(src.commit).slice(0, 7))]);
      if (lock?.updatedAt) kv.push([t('ui.detail.updated'), lock.updatedAt.slice(0, 10)]);
    }
    return section(
      t('ui.detail.origin'),
      h('dl', { class: 'kv' }, kv.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
      e.origin === 'external'
        ? h('div', { class: 'addrow' },
            h('button', { type: 'button', class: 'btn small', onclick: () => updateItems([e.name]) }, icon('refresh', 16), t('ui.detail.checkUpdates')),
            h('button', { type: 'button', class: 'btn small danger', onclick: () => removeItem(e) }, icon('trash', 16), t('ui.detail.remove')))
        : h('p', { class: 'hint' }, t('ui.detail.ownItemHint')),
    );
  }

  const levelLabel = (lvl) => t(`ui.detail.usageLevel.${lvl}`);
  function usageSection(e) {
    if (!usageAsked) {
      usageAsked = true;
      api.usage().then((u) => ((usage = u), render())).catch(() => {});
    }
    const tTokens = e.tokens;
    const row = usage?.rows.find((r) => r.id === e.id);
    const kv = [];
    if (row && usage.hasData) kv.push([t('ui.detail.usage'), `${levelLabel(row.level)} · ${t('ui.detail.usageTimes', { times: row.last90 })}${row.lastUsed ? ` · ${t('ui.detail.usageLast', { date: row.lastUsed })}` : ''} · ${t('ui.detail.usageScore', { score: row.score })}`]);
    else kv.push([t('ui.detail.usage'), usage ? (usage.tracking ? t('ui.detail.noUsageYet') : t('ui.detail.usageOff')) : t('ui.detail.usageCalculating')]);
    if (tTokens) {
      kv.push([t('ui.detail.tokens'), t('ui.detail.tokensDetail', { desc: tTokens.description, body: tTokens.body, extra: tTokens.extra ? t('ui.detail.tokensExtra', { extra: tTokens.extra }) : '' })]);
    }
    const advice = row?.advice ?? [];
    return section(
      t('ui.detail.usageSection'),
      h('dl', { class: 'kv' }, kv.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
      ...advice.map((a) => a.level === 'warn'
        ? h('div', { class: 'banner caution', style: { marginTop: '6px' } }, icon('warn', 16), h('div', null, a.text))
        : h('p', { class: 'hint', style: { margin: '6px 0 0' } }, a.text)),
    );
  }

  function warnings(e) {
    const w = store.state.warnings.filter((x) => x.id === e.id && x.level !== 'info');
    return w.length ? section(t('ui.detail.warnings'), ...w.map((x) => h('div', { class: `banner ${x.level === 'error' ? 'warn' : 'caution'}`, style: { marginBottom: '6px' } }, icon('warn', 16), h('div', null, x.message)))) : null;
  }

  function render() {
    const e = store.selected ? store.byId.get(store.selected) : null;
    document.body.classList.toggle('has-drawer', Boolean(e));
    if (!e) {
      el.hidden = true;
      clear(el);
      lastId = null;
      return;
    }
    if (lastId !== e.id) editingCats = false;
    const keepScroll = lastId === e.id ? el.scrollTop : 0;
    lastId = e.id;
    clear(el);
    el.hidden = false;
    el.append(
      h('div', { class: 'drawer-head' },
        kindDot(e),
        h('div', { style: { flex: '1', minWidth: '0' } },
          h('h2', null, e.name),
          h('div', { class: 'sub' }, h('span', null, `${kindLabel(e)} ${e.origin === 'external' ? t('ui.common.origin.external') : (e.kind === 'agent' ? t('ui.common.origin.ownAgent') : t('ui.common.origin.own'))}`), riskBadge(e.risk, e.flags))),
        h('button', { type: 'button', class: 'btn ghost icon-only', 'aria-label': t('ui.detail.closeDrawer'), onclick: () => select(null) }, icon('close'))),
      h('div', { class: 'drawer-body' },
        h('p', { style: { margin: 0 } }, e.description || h('em', null, t('ui.detail.noDescription'))),
        warnings(e),
        categories(e),
        connections(e),
        requirements(e),
        dependencies(e),
        usageSection(e),
        origin(e)),
    );
    el.scrollTop = keepScroll;
  }

  return { render };
}
