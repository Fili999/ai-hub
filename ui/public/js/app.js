// Startup: state, tab navigation, real-time updates.
import { h, clear, icon } from './dom.js';
import { store, refresh, subscribe, select } from './store.js';
import { listen } from './api.js';
import { toast } from './ui.js';
import { createDrawer } from './views/detail.js';
import { isDark, toggleTheme } from './theme.js';
import { refreshLocal, startSync } from './sync.js';
import { t } from './i18n.js';

const VIEWS = [
  { id: 'graph', labelKey: 'ui.tab.graph', icon: 'graph', load: () => import('./views/graph.js') },
  { id: 'flow', labelKey: 'ui.tab.flow', icon: 'flow', load: () => import('./views/flow.js') },
  { id: 'catalog', labelKey: 'ui.tab.catalog', icon: 'catalog', load: () => import('./views/catalog.js') },
  { id: 'team', labelKey: 'ui.tab.teams', icon: 'team', load: () => import('./views/teams.js') },
  { id: 'create', labelKey: 'ui.tab.create', icon: 'create', load: () => import('./views/create.js') },
  { id: 'tree', labelKey: 'ui.tab.folders', icon: 'folder', load: () => import('./views/tree.js') },
  { id: 'install', labelKey: 'ui.tab.install', icon: 'install', load: () => import('./views/install.js') },
  { id: 'guide', labelKey: 'ui.tab.guide', icon: 'guide', load: () => import('./views/guide.js') },
  { id: 'system', labelKey: 'ui.tab.system', icon: 'system', load: () => import('./views/system.js') },
  // not a tab: opens from gear icon in top right
  { id: 'settings', labelKey: 'ui.tab.settings', icon: 'settings', menu: true, load: () => import('./views/settings.js') },
  // initial setup: opens automatically until settings.json exists, and from Settings
  { id: 'welcome', labelKey: 'ui.tab.welcome', icon: 'settings', menu: true, load: () => import('./views/welcome.js') },
];

const ALIASES = {
  grafo: 'graph',
  flusso: 'flow',
  catalogo: 'catalog',
  crea: 'create',
  cartelle: 'tree',
  installa: 'install',
  guida: 'guide',
  sistema: 'system',
  impostazioni: 'settings',
};

const main = document.getElementById('view');
const tabs = document.getElementById('tabs');
const live = document.getElementById('live');
const fp = document.getElementById('fp');
const themeBtn = document.getElementById('theme');
const settingsLink = document.getElementById('settings');
settingsLink.append(icon('settings', 18));
settingsLink.setAttribute('aria-label', t('ui.tab.settings'));
settingsLink.title = t('ui.tab.settings');

const skipLink = document.querySelector('.skip');
if (skipLink) skipLink.textContent = t('ui.skip');
const brandLink = document.querySelector('.brand');
if (brandLink) brandLink.setAttribute('aria-label', t('ui.brandLabel'));
if (tabs) tabs.setAttribute('aria-label', t('ui.sections'));
if (live) live.title = t('ui.app.liveTitle');
const drawerEl = document.getElementById('drawer');
if (drawerEl) drawerEl.setAttribute('aria-label', t('ui.detail'));

const drawer = createDrawer(drawerEl, { toast, select });

const ctx = {
  store,
  select,
  toast,
  navigate: (id) => {
    location.hash = `#/${id}`;
  },
  refresh,
};

let current = null; // {id, view}
let token = 0;

function renderTabs(active) {
  clear(tabs);
  if (active === 'settings') settingsLink.setAttribute('aria-current', 'page');
  else settingsLink.removeAttribute('aria-current');
  for (const v of VIEWS.filter((x) => !x.menu)) {
    tabs.append(h('a', { class: 'tab', href: `#/${v.id}`, 'aria-current': v.id === active ? 'page' : undefined }, icon(v.icon, 17), t(v.labelKey)));
  }
  // on narrow screens tabs scroll: keep active tab visible
  tabs.querySelector('[aria-current="page"]')?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
}

function paintTheme() {
  const dark = isDark();
  const label = dark ? t('ui.theme.toLight') : t('ui.theme.toDark');
  clear(themeBtn);
  themeBtn.append(icon(dark ? 'sun' : 'moon', 18));
  themeBtn.setAttribute('aria-label', label);
  themeBtn.title = label;
}
themeBtn.addEventListener('click', toggleTheme);
window.addEventListener('themechange', paintTheme);
paintTheme();

// Catalog fingerprint: SHA-1 of skills, agents, and links. Flashes when something changes.
let lastFp = null;
function paintFingerprint() {
  const v = store.state?.fingerprint;
  if (!v) return;
  fp.hidden = false;
  fp.textContent = `#${v.slice(0, 7)}`;
  fp.title = t('ui.fingerprint.title', { hash: v });
  if (lastFp && lastFp !== v) {
    fp.classList.remove('flash');
    void fp.offsetWidth; // restart animation
    fp.classList.add('flash');
  }
  lastFp = v;
}

function showMessage(node) {
  clear(main);
  main.append(node);
}

async function route() {
  const rawId = (location.hash.match(/^#\/([a-z]+)/) ?? [])[1];
  const id = ALIASES[rawId] ?? rawId;
  const def = VIEWS.find((v) => v.id === id) ?? VIEWS[0];
  if (!rawId || ALIASES[rawId]) history.replaceState(null, '', `#/${def.id}`);
  renderTabs(def.id);
  document.title = `${t(def.labelKey)} · AI Hub`;
  const mine = ++token;
  current?.view.destroy?.();
  current = null;
  if (!store.state) {
    showMessage(store.error ? errorPane() : h('div', { class: 'page' }, h('p', { class: 'hint' }, t('ui.loadingHub'))));
    return;
  }
  try {
    const mod = await def.load();
    if (mine !== token) return;
    const view = mod.default(ctx);
    current = { id: def.id, view };
    clear(main);
    main.append(view.el);
    view.update?.(store);
    main.scrollTop = 0;
  } catch (e) {
    console.error(e);
    showMessage(h('div', { class: 'page' }, h('div', { class: 'banner warn' }, icon('warn'), h('div', null, h('strong', null, `${t('ui.app.tabError')} `), e.message))));
  }
}

function errorPane() {
  return h(
    'div',
    { class: 'page' },
    h('div', { class: 'banner warn' }, icon('warn'), h('div', null, h('strong', null, `${t('ui.app.readError')} `), store.error ?? '')),
    h('p', null, h('button', { class: 'btn', type: 'button', onclick: () => refresh() }, icon('refresh', 16), t('ui.app.retry'))),
  );
}

let firstRender = true;
subscribe(() => {
  paintFingerprint();
  drawer.render();
  if (store.state && (firstRender || !current)) {
    firstRender = false;
    route();
    return;
  }
  if (!store.state && !current) showMessage(errorPane());
  current?.view.update?.(store);
});

window.addEventListener('hashchange', route);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && store.selected && !document.querySelector('.modal-back')) select(null);
});

let timer;
listen(
  () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      await refresh();
      refreshLocal(); // files changed: also refresh "outgoing"
    }, 250);
  },
  (on) => {
    live.dataset.on = String(on);
    clear(live);
    live.append(h('span', null, on ? t('ui.app.live') : t('ui.app.disconnected')));
    live.title = on ? t('ui.app.liveTitle') : t('ui.app.disconnectedTitle');
    if (on && store.state) refresh();
  },
);

renderTabs(VIEWS[0].id);
await refresh();
// cross-machine sync is optional: without it, GitHub button is hidden
if (store.state?.settings?.['sync.github']) startSync();
else document.getElementById('sync').hidden = true;
if (store.state && !store.state.configured && !location.hash.startsWith('#/welcome')) location.hash = '#/welcome';
if (!store.state) toast(store.error ?? t('ui.app.readErrorToast'), 'error');
