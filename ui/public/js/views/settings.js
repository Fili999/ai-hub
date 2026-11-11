// Settings: hub options (settings.json). The page is rendered from the server schema:
// every new option declared in scripts/lib/settings.mjs appears here automatically.
import { h, clear, icon, copyText } from '../dom.js';
import { api } from '../api.js';
import { toast } from '../ui.js';
import { t } from '../i18n.js';

export default function create(ctx) {
  let data = null; // {sections, schema, values, skillspector}
  let saving = null; // key being saved
  let error = '';
  let watch = null;
  const body = h('div', { class: 'stack' });
  const el = h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, t('ui.settings.title')), h('p', null, t('ui.settings.intro'))), h('a', { class: 'btn', href: '#/welcome' }, t('ui.settings.rerunWelcome'))),
    body);

  async function load() {
    try {
      data = await api.settings();
      error = '';
    } catch (e) {
      error = e.message;
    }
    render();
  }

  async function save(key, value) {
    saving = key;
    render();
    try {
      const r = await api.saveSettings({ [key]: value });
      data.values = r.values;
      // language and sync trigger a full page reload (server-rendered text, GitHub button)
      if (key === 'interface.language' || key === 'sync.github') return location.reload();
      toast(t('ui.settings.saved'));
      ctx.refresh();
    } catch (e) {
      toast(e.message, 'error');
    }
    saving = null;
    render();
  }

  const cmdBox = (text) =>
    h('div', { class: 'cmd' }, h('code', null, text), h('button', { class: 'btn small icon-only ghost', type: 'button', 'aria-label': t('ui.settings.copyLabel', { text }), title: t('ui.settings.copy'), onclick: () => copyText(text).then(() => toast(t('ui.settings.copied'))) }, icon('copy', 15)));

  function control(key, spec) {
    const value = data.values[key];
    const busy = saving === key;
    const id = `set-${key.replace(/\W/g, '-')}`;
    if (spec.type === 'boolean') {
      return h('label', { class: 'check setting' },
        h('input', { type: 'checkbox', id, role: 'switch', checked: value, disabled: busy, onchange: (e) => save(key, e.target.checked) }),
        h('span', null, h('strong', null, spec.label), h('div', { class: 'hint' }, spec.help)));
    }
    return h('div', { class: 'field setting' },
      h('div', { class: 'label', id: `${id}-l` }, spec.label),
      h('div', { class: 'chips', role: 'radiogroup', 'aria-labelledby': `${id}-l` },
        spec.values.map((v) => h('button', { type: 'button', class: 'chip', role: 'radio', 'aria-checked': String(value === v), 'aria-pressed': String(value === v), disabled: busy, onclick: () => value !== v && save(key, v) }, spec.valueLabels?.[v] ?? v))),
      h('div', { class: 'hint' }, spec.help));
  }

  // notes below sections: actual host status compared to current setting
  function extra(section) {
    if (section === 'security') {
      const sp = data.skillspector;
      const mode = data.values['security.skillspector'];
      if (sp.installed) return h('div', { class: 'banner ok' }, icon('check'), h('div', null, t('ui.settings.skillspectorInstalled', { version: sp.version ? t('ui.settings.skillspectorVersion', { version: sp.version }) : '' }), mode === 'off' ? t('ui.settings.skillspectorOff') : ''));
      return h('div', { class: 'stack' },
        h('div', { class: `banner ${mode === 'block' ? 'warn' : 'caution'}` }, icon('warn'), h('div', null, h('strong', null, t('ui.settings.skillspectorMissing')),
          mode === 'block' ? t('ui.settings.skillspectorBlockNotice') : t('ui.settings.skillspectorWarnNotice'), t('ui.settings.skillspectorInstallNotice'))),
        cmdBox('npm run setup'));
    }
    if (section === 'dependencies') {
      return h('div', { class: 'stack' },
        h('p', { class: 'hint', style: { margin: 0 } }, t('ui.settings.depsHint')),
        cmdBox('npm run needs -- <skill-name> --install'),
        data.values['dependencies.claudeMayInstall']
          ? h('div', { class: 'banner caution' }, icon('info'), h('div', null, t('ui.settings.depsPermNotice')))
          : null);
    }
    return null;
  }

  function render() {
    clear(body);
    if (error) {
      body.append(h('div', { class: 'banner warn', role: 'alert' }, icon('warn'), h('div', null, error)), h('p', null, h('button', { class: 'btn', type: 'button', onclick: load }, icon('refresh', 16), t('ui.settings.retry'))));
      return;
    }
    if (!data) {
      body.append(h('p', { class: 'hint' }, t('ui.settings.loading')));
      return;
    }
    for (const sec of data.sections) {
      // a choice with a single value (the language, while English is the only one) is not shown: there is nothing to choose
      const keys = Object.entries(data.schema).filter(([, spec]) => spec.section === sec.id && !(spec.type === 'enum' && spec.values.length < 2));
      if (!keys.length) continue;
      body.append(h('section', { class: 'sec' }, h('h2', null, sec.label), h('div', { class: 'stack' }, keys.map(([k, spec]) => control(k, spec)), extra(sec.id))));
    }
  }

  load();
  return {
    el,
    update(store) {
      // settings.json modified externally (manually or via pull): reload
      const w = store.state?.watch;
      if (watch && w !== watch) load();
      watch = w;
    },
    destroy() {},
  };
}
