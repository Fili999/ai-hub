// Catalog: searchable directory of all skills and agents.
import { h, clear, debounce } from '../dom.js';
import { api } from '../api.js';
import { store, catsOf, catLabel } from '../store.js';
import { catChips, kindDot, riskBadge } from '../ui.js';
import { t } from '../i18n.js';

export default function create(ctx) {
  const f = { q: '', kind: '', origin: '', risk: '', cat: '' };
  let ranked = null; // id → rank position when searching
  let seq = 0;

  const search = h('input', { type: 'search', placeholder: t('ui.catalog.searchPlaceholder'), 'aria-label': t('ui.catalog.searchAria') });
  const sel = (label, key, options) => {
    const s = h('select', { 'aria-label': label, onchange: () => ((f[key] = s.value), render()) }, options.map(([v, labelText]) => h('option', { value: v }, labelText)));
    return s;
  };
  const kindSel = sel(t('ui.catalog.filterType'), 'kind', [['', t('ui.catalog.typeAll')], ['skill', t('ui.catalog.typeSkill')], ['agent', t('ui.catalog.typeAgent')]]);
  const originSel = sel(t('ui.catalog.filterOrigin'), 'origin', [['', t('ui.catalog.originAll')], ['own', t('ui.catalog.originOwn')], ['external', t('ui.catalog.originExternal')]]);
  const riskSel = sel(t('ui.catalog.filterRisk'), 'risk', [['', t('ui.catalog.riskAll')], ['attention', t('ui.catalog.riskAttention')]]);
  const catSel = h('select', { 'aria-label': t('ui.catalog.filterCat'), onchange: () => ((f.cat = catSel.value), render()) });
  const count = h('div', { class: 'hint', 'aria-live': 'polite' });
  const list = h('div', { class: 'rows', role: 'list' });

  search.addEventListener('input', debounce(async () => {
    f.q = search.value.trim();
    const mine = ++seq;
    if (!f.q) {
      ranked = null;
      render();
      return;
    }
    try {
      const r = await api.search(f.q, { limit: 50 });
      if (mine !== seq) return;
      ranked = new Map(r.results.map((x, i) => [x.id, i]));
    } catch (e) {
      ctx.toast(e.message, 'error');
    }
    render();
  }, 200));

  const el = h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, t('ui.catalog.title')), h('p', null, t('ui.catalog.intro')))),
    h('div', { class: 'toolbar' }, h('div', { class: 'grow' }, search), kindSel, originSel, riskSel, catSel),
    count,
    list);

  function render() {
    const st = store.state;
    if (!st) return;
    const keep = catSel.value;
    clear(catSel);
    catSel.append(h('option', { value: '' }, t('ui.catalog.catAll')));
    const used = new Set(st.skills.concat(st.agents).flatMap((e) => catsOf(e)));
    for (const c of Object.keys(st.categories)) if (used.has(c)) catSel.append(h('option', { value: c }, catLabel(c)));
    catSel.value = used.has(keep) ? keep : '';
    f.cat = catSel.value;

    let items = [...st.agents, ...st.skills];
    if (ranked) items = items.filter((e) => ranked.has(e.id)).sort((a, b) => ranked.get(a.id) - ranked.get(b.id));
    else items.sort((a, b) => a.name.localeCompare(b.name));
    items = items.filter((e) => (!f.kind || e.kind === f.kind) && (!f.origin || e.origin === f.origin) && (!f.risk || e.risk !== 'low') && (!f.cat || catsOf(e).includes(f.cat)));

    count.textContent = ranked ? t('ui.catalog.resultsFor', { n: items.length, q: f.q }) : t.n('ui.catalog.itemCount', items.length);
    clear(list);
    if (!items.length) {
      list.append(h('div', { class: 'empty', style: { marginTop: '12px' } }, h('strong', null, ranked ? t('ui.catalog.noResults') : t('ui.catalog.empty')), ranked ? t('ui.catalog.emptySearchHint') : t('ui.catalog.emptyHint')));
      return;
    }
    for (const e of items) {
      const row = h('div', { class: 'row', role: 'listitem', tabindex: '0', 'aria-selected': String(store.selected === e.id), onclick: () => ctx.select(e.id), onkeydown: (ev) => (ev.key === 'Enter' || ev.key === ' ') && (ev.preventDefault(), ctx.select(e.id)) },
        kindDot(e),
        h('div', null,
          h('div', { class: 'name' }, e.name, ' ', h('span', { class: 'hint', style: { fontFamily: 'var(--font-body)', fontWeight: '400', fontSize: '13px' } }, e.kind === 'agent' ? t('ui.catalog.agent') : t('ui.catalog.skill'))),
          h('div', { class: 'desc' }, e.description),
          h('div', { class: 'meta' }, catChips(e, { max: 3 }), e.scope === 'assigned' ? h('span', { class: 'chip' }, t('ui.catalog.assignedTo', { list: e.assignedTo.join(', ') })) : null)),
        h('div', { class: 'side' }, e.origin === 'external' ? h('span', { class: 'badge' }, 'GitHub') : null, riskBadge(e.risk, e.flags)));
      list.append(row);
    }
  }

  return {
    el,
    update() {
      render();
    },
    destroy() {},
  };
}
