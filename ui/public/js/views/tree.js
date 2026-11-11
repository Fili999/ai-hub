// Tree: project directory structure, with inline explanations next to relevant files.
import { h, clear, icon, copyText } from '../dom.js';
import { api } from '../api.js';
import { store } from '../store.js';
import { toast, kindDot } from '../ui.js';
import { t } from '../i18n.js';

const size = (n) => (n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1048576).toFixed(1)} MB`);

export default function create(ctx) {
  let data = null;
  let key = '';
  let loading = false;
  let filter = '';
  let expanded = new Set(['skills/own', 'agents/own']);
  let firstLoad = true;
  const body = h('div', { class: 'tree-wrap' });
  const search = h('input', { type: 'search', placeholder: t('ui.tree.searchPlaceholder'), 'aria-label': t('ui.tree.searchAria') });
  const summary = h('p', { class: 'hint' });

  const allDirs = (n, out = []) => {
    for (const c of n.children ?? []) if (c.type === 'dir') (out.push(c.path), allDirs(c, out));
    return out;
  };

  async function load() {
    if (loading) return;
    loading = true;
    try {
      data = await api.tree();
      if (firstLoad) {
        firstLoad = false;
        for (const c of data.tree.children) if (c.type === 'dir') expanded.add(c.path); // start with first level expanded
      }
    } catch (e) {
      data = null;
      toast(e.message, 'error');
    }
    loading = false;
    render();
  }

  const matches = (n, q) => n.name.toLowerCase().includes(q) || n.path.toLowerCase().includes(q) || (n.note ?? '').toLowerCase().includes(q);
  // on search, only keep matching items (and the parent folders containing them)
  function prune(n, q) {
    if (!q) return n;
    if (n.type !== 'dir') return matches(n, q) ? n : null;
    const kids = (n.children ?? []).map((c) => prune(c, q)).filter(Boolean);
    return kids.length || matches(n, q) ? { ...n, children: kids } : null;
  }

  function row(n, depth, q) {
    const isDir = n.type === 'dir';
    const open = isDir && (q ? true : expanded.has(n.path));
    const toggle = () => {
      if (expanded.has(n.path)) expanded.delete(n.path);
      else expanded.add(n.path);
      render();
    };
    const label = h(
      'span',
      { class: 'tree-name' },
      n.item ? kindDot(n) : icon(isDir ? 'folder' : 'file', 16),
      h('code', null, n.name + (isDir ? '/' : '')),
      n.type === 'link' ? h('span', { class: 'badge' }, `→ ${n.target ?? t('ui.tree.linkBadge')}`) : null,
      n.item ? h('span', { class: 'badge' }, `${n.kind === 'agent' ? t('ui.catalog.agent') : t('ui.catalog.skill')} ${n.origin === 'external' ? t('ui.graph.fromGithub') : t('ui.graph.own')}`) : null,
      n.generated ? h('span', { class: 'badge' }, t('ui.tree.generatedBadge')) : null,
    );
    const head = isDir
      ? h('button', { type: 'button', class: 'tree-row', 'aria-expanded': String(open), onclick: toggle }, h('span', { class: `tree-caret ${open ? 'open' : ''}` }, icon('right', 14)), label)
      : n.item
        ? h('button', { type: 'button', class: 'tree-row', title: t('ui.tree.openDetailTitle'), onclick: () => ctx.select(n.item) }, h('span', { class: 'tree-caret' }), label)
        : h('div', { class: 'tree-row plain' }, h('span', { class: 'tree-caret' }), label);
    const li = h('li', null, h('div', { class: 'tree-line', style: { paddingLeft: `${depth * 18}px` } }, head, n.note ? h('span', { class: 'tree-note' }, n.note) : null, !isDir && n.size != null ? h('span', { class: 'tree-size' }, size(n.size)) : null));
    if (open && n.children?.length) li.append(h('ul', { class: 'tree-list', role: 'group' }, n.children.map((c) => row(c, depth + 1, q))));
    if (open && n.truncated) li.append(h('p', { class: 'hint', style: { paddingLeft: `${(depth + 1) * 18}px` } }, t('ui.tree.maxDepthNote')));
    return li;
  }

  function render() {
    clear(body);
    if (!data) {
      body.append(h('p', { class: 'hint' }, loading ? t('ui.tree.loading') : t('ui.tree.error')));
      return;
    }
    const q = filter.trim().toLowerCase();
    const root = prune(data.tree, q);
    const truncated = data.counts.truncated ? t('ui.tree.truncated') : '';
    summary.textContent = t('ui.tree.summary', { dirs: data.counts.dirs, files: data.counts.files, truncated });
    if (!root || !root.children.length) {
      body.append(h('p', { class: 'hint' }, t('ui.tree.noResults')));
      return;
    }
    body.append(h('div', { class: 'tree-root' }, icon('folder', 16), h('code', null, `${data.tree.name}/`), h('span', { class: 'tree-note' }, t('ui.tree.hubRootNote'))), h('ul', { class: 'tree-list', role: 'tree' }, root.children.map((c) => row(c, 0, q))));
  }

  search.addEventListener('input', () => {
    filter = search.value;
    render();
  });

  const el = h(
    'div',
    { class: 'page' },
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, t('ui.tree.title')), h('p', null, t('ui.tree.intro')))),
    h(
      'div',
      { class: 'tree-tools' },
      search,
      h('button', { type: 'button', class: 'btn', onclick: () => (data && (expanded = new Set(allDirs(data.tree))), render()) }, t('ui.tree.openAll')),
      h('button', { type: 'button', class: 'btn', onclick: () => ((expanded = new Set()), render()) }, t('ui.tree.closeAll')),
      h(
        'button',
        {
          type: 'button',
          class: 'btn',
          onclick: () => data && copyText(data.text).then(() => toast(t('ui.tree.copiedToast'))),
        },
        icon('copy', 16),
        t('ui.tree.copyText'),
      ),
    ),
    summary,
    body,
  );

  render();
  load();
  return {
    el,
    update() {
      const k = store.state?.watch ?? '';
      if (k !== key) {
        key = k;
        load();
      }
    },
    destroy() {},
  };
}
