// Teams: groups of agents and skills by domain (social media, mobile apps, websites, software…), organized by roles.
// For each team: members by role (with suggestions from catalog), graph and flow scoped to that team.
// Manage teams (wizard) and custom categories. All validated by the server (teams.json, hub.config.json).
import { h, clear, icon } from '../dom.js';
import { api } from '../api.js';
import { store, catLabel, shortName } from '../store.js';
import { confirmDialog, kindDot } from '../ui.js';
import { guarded } from '../actions.js';
import { t } from '../i18n.js';

const SUBS = () => [
  { id: 'members', label: t('ui.teams.sub.members') },
  { id: 'graph', label: t('ui.teams.sub.graph') },
  { id: 'flow', label: t('ui.teams.sub.flow') },
];
const KEY = 'ai-hub.team';

/** Generate identifier from name: lowercase, numbers, and dashes (as required by server). */
export const slugId = (name, max = 40) =>
  String(name ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');

const remember = (id) => {
  try {
    localStorage.setItem(KEY, id ?? '');
  } catch {
    /* browser storage unavailable: ignore */
  }
};
const recalled = () => {
  try {
    return localStorage.getItem(KEY) || null;
  } catch {
    return null;
  }
};

export default function create(ctx) {
  let mode = 'team'; // team | wizard | categories
  let current = recalled();
  let sub = 'members';
  let embedded = null; // {key, view} open scoped team graph or flow
  let suggestions = new Map(); // roleId → {agents, skills}
  let editingRole = null;
  let editingTeam = false;
  let wizard = null;
  let defaults = null; // default roles proposed by server for a new team

  const side = h('aside', { class: 'teams-side' });
  const main = h('section', { class: 'teams-main' });
  const el = h('div', { class: 'teams-layout' }, side, main);

  const teams = () => store.state?.teams ?? [];
  const team = () => teams().find((t) => t.id === current) ?? null;
  const item = (id) => store.byId.get(id);

  async function save(t, msg) {
    return guarded(() => api.saveTeam(t), msg);
  }

  // ------------------------------------------------------------ teams sidebar
  function renderSide() {
    clear(side);
    side.append(
      h('div', { class: 'teams-side-head' }, h('h2', null, t('ui.teams.sideTitle')), h('span', { class: 'hint' }, `${teams().length}`)),
      h('div', { class: 'teams-list', role: 'list' },
        teams().map((tItem) => {
          const n = new Set(tItem.roles.flatMap((r) => [...r.agents, ...r.skills])).size;
          return h('button', { type: 'button', role: 'listitem', class: 'team-card', 'aria-current': mode === 'team' && tItem.id === current ? 'true' : undefined, onclick: () => open(tItem.id) },
            h('strong', null, tItem.name),
            h('span', { class: 'hint' }, t('ui.teams.rolesAndMembers', { roles: tItem.roles.length, members: n })));
        }),
        teams().length ? null : h('p', { class: 'hint' }, t('ui.teams.noTeamsYet'))),
      h('div', { class: 'teams-side-actions' },
        h('button', { type: 'button', class: 'btn primary', onclick: startWizard }, icon('plus', 16), t('ui.teams.newTeam')),
        h('button', { type: 'button', class: 'btn', 'aria-pressed': String(mode === 'categories'), onclick: () => ((mode = 'categories'), render()) }, icon('settings', 16), t('ui.teams.categories'))),
    );
  }

  function open(id) {
    mode = 'team';
    current = id;
    remember(id);
    suggestions = new Map();
    editingRole = null;
    editingTeam = false;
    render();
  }

  // ------------------------------------------------------------ open team
  function renderTeam() {
    const tItem = team();
    if (!tItem) {
      main.append(h('div', { class: 'empty' }, h('strong', null, teams().length ? t('ui.teams.emptySelect') : t('ui.teams.emptyCreate')), t('ui.teams.emptyHint')));
      return;
    }
    main.append(teamHead(tItem), h('nav', { class: 'chips subtabs', 'aria-label': t('ui.teams.subtabsAria') },
      SUBS().map((s) => h('button', { type: 'button', class: 'chip', 'aria-pressed': String(sub === s.id), onclick: () => ((sub = s.id), render()) }, s.label))));
    if (sub === 'members') main.append(members(tItem));
    else main.append(embed(tItem));
  }

  function teamHead(tItem) {
    if (editingTeam) {
      const name = h('input', { type: 'text', value: tItem.name, maxlength: 60, 'aria-label': t('ui.teams.nameAria') });
      const desc = h('textarea', { rows: 2, maxlength: 500, 'aria-label': t('ui.teams.descAria') }, tItem.description);
      const cats = categoryPicker(new Set(tItem.categories));
      return h('div', { class: 'team-head editing' }, name, desc, cats.el,
        h('div', { class: 'addrow' },
          h('button', { type: 'button', class: 'btn primary small', onclick: async () => {
            const r = await save({ ...tItem, name: name.value, description: desc.value, categories: [...cats.value] }, t('ui.teams.updatedToast'));
            if (r) (editingTeam = false), render();
          } }, t('ui.common.confirm')),
          h('button', { type: 'button', class: 'btn ghost small', onclick: () => ((editingTeam = false), render()) }, t('ui.common.cancel'))));
    }
    return h('div', { class: 'team-head' },
      h('div', { style: { flex: '1', minWidth: '0' } },
        h('h1', null, tItem.name),
        tItem.description ? h('p', { class: 'hint' }, tItem.description) : null,
        tItem.categories.length ? h('div', { class: 'chips' }, tItem.categories.map((c) => h('span', { class: 'chip static' }, catLabel(c)))) : null),
      h('div', { class: 'addrow' },
        h('button', { type: 'button', class: 'btn small', onclick: () => ((editingTeam = true), render()) }, icon('edit', 16), t('ui.teams.edit')),
        h('button', { type: 'button', class: 'btn small danger', onclick: async () => {
          const ok = await confirmDialog({ title: t('ui.teams.deleteTitle', { name: tItem.name }), body: t('ui.teams.deleteBody'), confirmLabel: t('ui.teams.delete'), danger: true });
          if (ok && (await guarded(() => api.deleteTeam(tItem.id), t('ui.teams.deletedToast')))) open(null);
        } }, icon('trash', 16), t('ui.teams.delete'))));
  }

  function members(tItem) {
    const box = h('div', { class: 'roles' });
    tItem.roles.forEach((r, i) => box.append(roleCard(tItem, r, i)));
    const name = h('input', { type: 'text', placeholder: t('ui.teams.newRolePlaceholder'), maxlength: 40, 'aria-label': t('ui.teams.newRoleAria') });
    box.append(h('form', { class: 'addrow', onsubmit: async (ev) => {
      ev.preventDefault();
      const n = name.value.trim();
      const id = slugId(n);
      if (!id) return ctx.toast(t('ui.teams.enterRoleName'), 'error');
      if (tItem.roles.some((x) => x.id === id)) return ctx.toast(t('ui.teams.duplicateRole'), 'error');
      await save({ ...tItem, roles: [...tItem.roles, { id, name: n, description: '', agents: [], skills: [] }] }, t('ui.teams.roleAdded', { name: n }));
    } }, name, h('button', { type: 'submit', class: 'btn small' }, icon('plus', 16), t('ui.teams.addRole'))));
    return box;
  }

  function roleCard(tItem, r, i) {
    const replaceRole = (nr) => ({ ...tItem, roles: tItem.roles.map((x, j) => (j === i ? nr : x)) });
    const head = editingRole === r.id
      ? (() => {
          const n = h('input', { type: 'text', value: r.name, maxlength: 40, 'aria-label': t('ui.teams.roleNameAria') });
          const d = h('input', { type: 'text', value: r.description ?? '', maxlength: 200, placeholder: t('ui.teams.roleDescPlaceholder'), 'aria-label': t('ui.teams.roleDescAria') });
          return h('div', { class: 'role-head editing' }, n, d,
            h('button', { type: 'button', class: 'btn primary small', onclick: async () => {
              if (await save(replaceRole({ ...r, name: n.value, description: d.value }), t('ui.teams.roleUpdated'))) (editingRole = null), render();
            } }, t('ui.common.confirm')),
            h('button', { type: 'button', class: 'btn ghost small', onclick: () => ((editingRole = null), render()) }, t('ui.common.cancel')));
        })()
      : h('div', { class: 'role-head' },
          h('div', { style: { flex: '1', minWidth: '0' } }, h('h3', null, r.name), r.description ? h('span', { class: 'hint' }, r.description) : null),
          h('button', { type: 'button', class: 'btn ghost small', 'aria-label': t('ui.teams.suggestMembersAria', { name: r.name }), onclick: () => suggest(tItem, r) }, icon('create', 16), t('ui.teams.suggest')),
          h('button', { type: 'button', class: 'btn ghost small', 'aria-label': t('ui.teams.editRoleAria', { name: r.name }), onclick: () => ((editingRole = r.id), render()) }, icon('edit', 16)),
          h('button', { type: 'button', class: 'btn ghost small', 'aria-label': t('ui.teams.removeRoleAria', { name: r.name }), onclick: async () => {
            if (await confirmDialog({ title: t('ui.teams.removeRoleTitle', { name: r.name }), body: t('ui.teams.removeRoleBody'), confirmLabel: t('ui.teams.removeRoleConfirm'), danger: true })) await save({ ...tItem, roles: tItem.roles.filter((_, j) => j !== i) }, t('ui.teams.roleRemoved'));
          } }, icon('trash', 16)));

    const chip = (id) => {
      const e = item(id);
      const kind = id.startsWith('agent:') ? 'agents' : 'skills';
      return h('span', { class: `member ${e ? '' : 'missing'}` },
        kindDot(e ?? { kind: kind === 'agents' ? 'agent' : 'skill', origin: 'own' }),
        e ? h('button', { type: 'button', class: 'name', onclick: () => ctx.select(id) }, e.name) : h('span', { title: t('ui.teams.notInHub') }, t('ui.teams.missingSuffix', { name: shortName(id) })),
        h('button', { type: 'button', class: 'x', 'aria-label': t('ui.teams.removeMemberAria', { name: shortName(id), role: r.name }), onclick: () => save(replaceRole({ ...r, [kind]: r[kind].filter((m) => m !== id) })) }, '×'));
    };

    const listId = `opts-${tItem.id}-${r.id}`;
    const inRole = new Set([...r.agents, ...r.skills]);
    const options = h('datalist', { id: listId }, [...store.state.agents, ...store.state.skills].filter((e) => !inRole.has(e.id)).map((e) => h('option', { value: e.id }, `${e.name} — ${e.kind === 'agent' ? t('ui.teams.memberAgent') : t('ui.teams.memberSkill')}`)));
    const pick = h('input', { type: 'text', list: listId, placeholder: t('ui.teams.addMemberPlaceholder'), 'aria-label': t('ui.teams.addMemberAria', { name: r.name }) });
    const add = async (id) => {
      const e = item(id) ?? [...store.byId.values()].find((x) => x.name === id);
      if (!e) return ctx.toast(t('ui.teams.chooseFromList'), 'error');
      const kind = e.kind === 'agent' ? 'agents' : 'skills';
      if (r[kind].includes(e.id)) return;
      await save(replaceRole({ ...r, [kind]: [...r[kind], e.id] }), `${e.name} → ${r.name}`);
    };
    const form = h('form', { class: 'addrow', onsubmit: (ev) => (ev.preventDefault(), add(pick.value.trim())) }, pick, options, h('button', { type: 'submit', class: 'btn small' }, icon('plus', 16), t('ui.teams.add')));

    const sg = suggestions.get(r.id);
    const sgBox = sg
      ? h('div', { class: 'suggest' },
          h('span', { class: 'hint' }, t('ui.teams.suggestedByCatalog')),
          [...sg.agents, ...sg.skills].filter((x) => !inRole.has(x.id)).map((x) => h('button', { type: 'button', class: 'chip', onclick: () => add(x.id) }, '+ ', x.name, x.id.startsWith('agent:') ? t('ui.teams.agentSuffix') : '')),
          [...sg.agents, ...sg.skills].some((x) => !inRole.has(x.id)) ? null : h('span', { class: 'hint' }, t('ui.teams.noOtherSuitable')))
      : null;

    return h('div', { class: 'role' }, head,
      h('div', { class: 'members' }, [...r.agents, ...r.skills].map(chip), inRole.size ? null : h('span', { class: 'hint' }, t('ui.teams.noMembers'))),
      sgBox, form);
  }

  async function suggest(t, r) {
    try {
      const res = await api.suggestTeam({ name: t.name, description: t.description, roles: [{ id: r.id, name: r.name, description: r.description ?? '' }] });
      suggestions.set(r.id, res.suggestions[0] ?? { agents: [], skills: [] });
      render();
    } catch (e) {
      ctx.toast(e.message, 'error');
    }
  }

  // scoped graph or flow for the current team (global Graph and Flow views remain unaffected)
  function embed(t) {
    const holder = h('div', { class: sub === 'graph' ? 'team-stage' : 'team-flow' });
    const key = JSON.stringify([sub, t]);
    if (embedded?.key === key) {
      holder.append(embedded.view.el);
      queueMicrotask(() => embedded?.view.update?.(store));
      return holder;
    }
    embedded?.view.destroy?.();
    embedded = null;
    const load = sub === 'graph' ? import('./graph.js') : import('./flow.js');
    load.then((mod) => {
      if (mode !== 'team' || team()?.id !== t.id || !holder.isConnected) return;
      const ids = new Set(t.roles.flatMap((r) => [...r.agents, ...r.skills]));
      const edges = t.roles.flatMap((r) => r.agents.flatMap((a) => r.skills.map((s) => ({ source: a, target: s }))));
      const view = sub === 'graph' ? mod.default(ctx, { scope: { ids, edges } }) : mod.default(ctx, { scope: { roles: t.roles } });
      embedded = { key, view };
      holder.append(view.el);
      view.update?.(store);
    });
    return holder;
  }

  // ------------------------------------------------------------ categories
  function categoryPicker(selected) {
    const box = h('div', { class: 'chips' });
    for (const [id, c] of Object.entries(store.state.categories)) {
      const b = h('button', { type: 'button', class: 'chip', 'aria-pressed': String(selected.has(id)), onclick: () => {
        selected.has(id) ? selected.delete(id) : selected.add(id);
        b.setAttribute('aria-pressed', String(selected.has(id)));
      } }, c.label);
      box.append(b);
    }
    return { el: box, value: selected };
  }

  function renderCategories() {
    const cats = Object.entries(store.state.categories);
    const used = new Map();
    for (const e of [...store.state.skills, ...store.state.agents]) for (const c of new Set([...e.categories, ...e.inferredCategories])) used.set(c, (used.get(c) ?? 0) + 1);
    const rows = cats.map(([id, c]) => {
      const label = h('input', { type: 'text', value: c.label, maxlength: 50, 'aria-label': t('ui.teams.catRowNameAria', { id }) });
      const kw = h('input', { type: 'text', value: (c.keywords ?? []).join(', '), 'aria-label': t('ui.teams.catRowKwAria', { name: c.label }), placeholder: t('ui.teams.catRowKwPlaceholder') });
      return h('div', { class: 'cat-row' },
        h('code', null, id), label, kw,
        h('span', { class: 'hint' }, t('ui.teams.catItemCount', { count: used.get(id) ?? 0 })),
        h('button', { type: 'button', class: 'btn small', onclick: () => guarded(() => api.category({ action: 'update', id, label: label.value, keywords: kw.value.split(',').map((x) => x.trim()).filter(Boolean) }), t('ui.teams.catUpdated')) }, t('ui.common.confirm')),
        h('button', { type: 'button', class: 'btn small ghost', 'aria-label': t('ui.teams.removeCatAria', { name: c.label }), onclick: async () => {
          const ok = await confirmDialog({ title: t('ui.teams.removeCatTitle', { name: c.label }), body: t('ui.teams.removeCatBody'), confirmLabel: t('ui.teams.delete'), danger: true });
          if (ok) await guarded(() => api.category({ action: 'remove', id }), (r) => r.message);
        } }, icon('trash', 16)));
    });
    const nLabel = h('input', { type: 'text', placeholder: t('ui.teams.newCatLabelPlaceholder'), maxlength: 50, 'aria-label': t('ui.teams.newCatLabelAria') });
    const nKw = h('input', { type: 'text', placeholder: t('ui.teams.newCatKwPlaceholder'), 'aria-label': t('ui.teams.newCatKwAria') });
    main.append(
      h('div', { class: 'team-head' }, h('div', null, h('h1', null, t('ui.teams.catsTitle')), h('p', { class: 'hint' }, t('ui.teams.catsDesc')))),
      h('div', { class: 'cats' }, rows),
      h('form', { class: 'addrow cat-new', onsubmit: async (ev) => {
        ev.preventDefault();
        const id = slugId(nLabel.value, 30);
        if (!id) return ctx.toast(t('ui.teams.enterCatName'), 'error');
        if (await guarded(() => api.category({ action: 'add', id, label: nLabel.value, keywords: nKw.value.split(',').map((x) => x.trim()).filter(Boolean) }), t('ui.teams.catAdded'))) {
          nLabel.value = '';
          nKw.value = '';
        }
      } }, nLabel, nKw, h('button', { type: 'submit', class: 'btn primary small' }, icon('plus', 16), t('ui.teams.addCategory'))),
    );
  }

  // ------------------------------------------------------------ guided wizard (3 steps)
  async function startWizard() {
    if (!defaults) {
      try {
        defaults = (await api.teams()).defaultRoles;
      } catch (e) {
        ctx.toast(e.message, 'error');
        defaults = [];
      }
    }
    wizard = { step: 1, name: '', description: '', categories: new Set(), roles: defaults.map((r) => ({ ...r })), picks: null };
    mode = 'wizard';
    render();
  }

  function renderWizard() {
    const w = wizard;
    const steps = h('ol', { class: 'steps' }, [t('ui.teams.wizardStep1'), t('ui.teams.wizardStep2'), t('ui.teams.wizardStep3')].map((s, i) => h('li', { 'aria-current': w.step === i + 1 ? 'step' : undefined }, s)));
    const nav = (back, next, nextLabel = t('ui.teams.next')) => h('div', { class: 'addrow' },
      back ? h('button', { type: 'button', class: 'btn', onclick: back }, t('ui.teams.back')) : h('button', { type: 'button', class: 'btn ghost', onclick: () => ((mode = 'team'), render()) }, t('ui.common.cancel')),
      h('button', { type: 'button', class: 'btn primary', onclick: next }, nextLabel));
    main.append(h('div', { class: 'team-head' }, h('div', null, h('h1', null, t('ui.teams.wizardTitle')), h('p', { class: 'hint' }, t('ui.teams.wizardDesc')))), steps);

    if (w.step === 1) {
      const name = h('input', { type: 'text', value: w.name, maxlength: 60, placeholder: t('ui.teams.namePlaceholder'), 'aria-label': t('ui.teams.nameAria') });
      const desc = h('textarea', { rows: 3, maxlength: 500, placeholder: t('ui.teams.descPlaceholder'), 'aria-label': t('ui.teams.descAria') }, w.description);
      const cats = categoryPicker(w.categories);
      main.append(h('div', { class: 'wizard' }, h('label', null, t('ui.teams.name'), name), h('label', null, t('ui.teams.description'), desc), h('div', null, h('span', { class: 'hint' }, t('ui.teams.catHelper')), cats.el),
        nav(null, () => {
          w.name = name.value.trim();
          w.description = desc.value.trim();
          if (!slugId(w.name)) return ctx.toast(t('ui.teams.needTeamName'), 'error');
          if (teams().some((tItem) => tItem.id === slugId(w.name))) return ctx.toast(t('ui.teams.teamExists'), 'error');
          w.step = 2;
          render();
        })));
    } else if (w.step === 2) {
      const list = h('div', { class: 'wizard' });
      const rows = w.roles.map((r, i) => {
        const n = h('input', { type: 'text', value: r.name, maxlength: 40, 'aria-label': t('ui.teams.roleNameN', { n: i + 1 }) });
        const d = h('input', { type: 'text', value: r.description ?? '', maxlength: 200, placeholder: t('ui.teams.roleDescPlaceholderShort'), 'aria-label': t('ui.teams.roleDescN', { n: i + 1 }) });
        return { r, n, d, el: h('div', { class: 'role-head editing' }, n, d, h('button', { type: 'button', class: 'btn ghost small', 'aria-label': t('ui.teams.removeRoleAria', { name: r.name }), onclick: () => (collect(), w.roles.splice(i, 1), render()) }, icon('trash', 16))) };
      });
      const collect = () => rows.forEach(({ r, n, d }) => ((r.name = n.value.trim()), (r.description = d.value.trim()), (r.id = slugId(r.name) || r.id)));
      list.append(...rows.map((x) => x.el),
        h('button', { type: 'button', class: 'btn small', onclick: () => (collect(), w.roles.push({ id: `role-${w.roles.length + 1}`, name: '', description: '' }), render()) }, icon('plus', 16), t('ui.teams.addRole')),
        nav(() => (collect(), (w.step = 1), render()), async () => {
          collect();
          w.roles = w.roles.filter((r) => r.name);
          const ids = w.roles.map((r) => r.id);
          if (new Set(ids).size !== ids.length) return ctx.toast(t('ui.teams.duplicateRolesError'), 'error');
          try {
            const res = await api.suggestTeam({ name: w.name, description: w.description, roles: w.roles });
            w.picks = res.suggestions.map((s) => ({ ...s, chosen: new Set([...s.agents, ...s.skills].map((x) => x.id)) }));
          } catch (e) {
            return ctx.toast(e.message, 'error');
          }
          w.step = 3;
          render();
        }, t('ui.teams.recommendMembers')));
      main.append(list);
    } else {
      const box = h('div', { class: 'wizard' });
      w.roles.forEach((r, i) => {
        const p = w.picks[i];
        const all = [...p.agents, ...p.skills];
        box.append(h('div', { class: 'role' }, h('div', { class: 'role-head' }, h('h3', null, r.name), r.description ? h('span', { class: 'hint' }, r.description) : null),
          all.length
            ? h('div', { class: 'members' }, all.map((x) => {
                const cb = h('input', { type: 'checkbox', checked: p.chosen.has(x.id), onchange: () => (cb.checked ? p.chosen.add(x.id) : p.chosen.delete(x.id)) });
                return h('label', { class: 'member check' }, cb, x.name, x.id.startsWith('agent:') ? h('span', { class: 'hint' }, t('ui.teams.agentLabel')) : null);
              }))
            : h('p', { class: 'hint' }, t('ui.teams.noCatalogMatches'))));
      });
      box.append(nav(() => ((w.step = 2), render()), async () => {
        const tObj = {
          id: slugId(w.name),
          name: w.name,
          description: w.description,
          categories: [...w.categories],
          roles: w.roles.map((r, i) => {
            const chosen = [...w.picks[i].chosen];
            return { id: r.id, name: r.name, description: r.description ?? '', agents: chosen.filter((x) => x.startsWith('agent:')), skills: chosen.filter((x) => x.startsWith('skill:')) };
          }),
        };
        const res = await guarded(() => api.saveTeam(tObj, true), t('ui.teams.teamCreated', { name: tObj.name }));
        if (res) open(tObj.id);
      }, t('ui.teams.createTeam')));
      main.append(box);
    }
  }

  // ------------------------------------------------------------
  function render() {
    if (!store.state) return;
    if (mode === 'team' && !team() && teams().length) current = teams()[0].id;
    renderSide();
    const keep = embedded;
    clear(main);
    if (mode === 'wizard') renderWizard();
    else if (mode === 'categories') renderCategories();
    else renderTeam();
    // close graph or flow instances that are no longer displayed
    if (keep && !main.contains(keep.view.el)) {
      keep.view.destroy?.();
      if (embedded === keep) embedded = null;
    }
  }

  let lastKey = '';
  return {
    el,
    update() {
      const key = JSON.stringify([store.state?.teams, store.state?.fingerprint, store.state?.categories]);
      if (key !== lastKey) {
        lastKey = key;
        render();
      } else embedded?.view.update?.(store);
    },
    destroy() {
      embedded?.view.destroy?.();
    },
  };
}
