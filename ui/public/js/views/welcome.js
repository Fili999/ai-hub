// Welcome: the first-run configuration (also reachable later from Settings). AI tools, security, sync between
// computers; then the hub installs its skills and agents into the chosen tools. Nothing is installed on the system here:
// programs are installed only by "npm run setup" in a terminal.
import { h, clear, icon } from '../dom.js';
import { api } from '../api.js';
import { toast } from '../ui.js';
import { t, lang } from '../i18n.js';

export default function create(ctx) {
  let sys = null;
  let values = null;
  let busy = false;
  let out = null;
  let instructions = true;
  const choice = {};
  const body = h('div', { class: 'stack' });
  const el = h('div', { class: 'page' }, h('div', { class: 'page-head' }, h('div', null, h('h1', null, t('ui.welcome.title')), h('p', null, t('ui.welcome.intro')))), body);

  async function load() {
    try {
      // only the machine part: the full system check runs every program and takes seconds (the page needs milliseconds)
      const [s, st] = await Promise.all([api.machine(), api.settings()]);
      sys = s;
      values = st.values;
      for (const tool of sys.machine.aiTools) choice[`providers.${tool.id}`] = st.configured ? values[`providers.${tool.id}`] : tool.installed || (tool.id === 'claude' && !sys.machine.aiTools.some((x) => x.installed));
      for (const k of ['security.skillspector', 'dependencies.claudeMayInstall', 'sync.github']) choice[k] = values[k];
    } catch (e) {
      toast(e.message, 'error');
    }
    render();
  }

  const sec = (title, hint, ...kids) => h('section', { class: 'sec' }, h('h2', null, title), hint ? h('p', { class: 'hint' }, hint) : null, ...kids);
  const check = (key, label, hint) =>
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: Boolean(choice[key]), onchange: (e) => (choice[key] = e.target.checked) }), h('span', null, h('strong', null, label), hint ? h('span', { class: 'hint' }, ` — ${hint}`) : null));

  async function save() {
    busy = true;
    out = null;
    render();
    try {
      await api.saveSettings({ ...choice, 'interface.language': lang });
      if (sys.machine.aiTools.some((x) => choice[`providers.${x.id}`])) out = await api.sync(instructions);
      else out = { ok: true, output: t('ui.welcome.noTools') };
      toast(out.ok ? t('ui.welcome.done') : t('ui.welcome.syncFailed'), out.ok ? 'info' : 'error');
    } catch (e) {
      toast(e.message, 'error');
    }
    busy = false;
    render();
  }

  function render() {
    clear(body);
    if (!sys || !values) {
      body.append(h('p', { class: 'hint' }, t('ui.loading')));
      return;
    }
    body.append(
      sec(
        t('ui.welcome.tools'),
        t('ui.welcome.toolsHint'),
        h('div', { class: 'stack tight' }, sys.machine.aiTools.map((tool) =>
          h('div', null, check(`providers.${tool.id}`, tool.name, t(tool.installed ? 'ui.welcome.installed' : 'ui.welcome.notInstalled')), h('div', { class: 'hint mono', style: { marginLeft: '26px' } }, `${tool.paths.skillsDir} · ${tool.paths.agentsDir}`)))),
      ),
      sec(
        t('ui.welcome.security'),
        t('ui.welcome.securityHint'),
        h('select', { 'aria-label': t('ui.welcome.security'), onchange: (e) => (choice['security.skillspector'] = e.target.value) }, ['block', 'warn', 'off'].map((v) => h('option', { value: v, selected: choice['security.skillspector'] === v }, t(`ui.welcome.security.${v}`)))),
        check('dependencies.claudeMayInstall', t('ui.welcome.mayInstall'), t('ui.welcome.mayInstallHint')),
      ),
      sec(t('ui.welcome.github'), null, check('sync.github', t('ui.welcome.githubLabel'), t('ui.welcome.githubHint'))),
      sec(
        t('ui.welcome.finish'),
        t('ui.welcome.finishHint'),
        check('__instructions', t('ui.welcome.instructions'), t('ui.welcome.instructionsHint')),
        h('div', { class: 'toolbar' },
          h('button', { class: 'btn primary', type: 'button', disabled: busy, onclick: save }, icon('check', 16), busy ? t('ui.welcome.saving') : t('ui.welcome.save')),
          out?.ok ? h('button', { class: 'btn', type: 'button', onclick: () => location.replace('#/catalog') }, t('ui.welcome.open')) : null),
        out ? h('pre', { class: 'pre' }, out.output || '') : null,
        h('p', { class: 'hint' }, t('ui.welcome.programs')),
      ),
    );
  }

  // "__instructions" is only a local choice for the sync, not a setting
  Object.defineProperty(choice, '__instructions', { enumerable: false, get: () => instructions, set: (v) => (instructions = v) });

  load();
  return { el };
}
