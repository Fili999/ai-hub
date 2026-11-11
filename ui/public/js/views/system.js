// System: machine tools, AI tool connections, doctor diagnostics.
import { h, clear, icon, copyText } from '../dom.js';
import { api } from '../api.js';
import { store } from '../store.js';
import { toast } from '../ui.js';
import { guarded } from '../actions.js';
import { t } from '../i18n.js';

export default function create(ctx) {
  let sys = null;
  let doctor = null;
  let syncOut = null;
  let claudeMd = false;
  let key = '';
  let loading = false;
  let busy = false;
  const body = h('div', { class: 'stack' });
  const el = h('div', { class: 'page' }, h('div', { class: 'page-head' }, h('div', null, h('h1', null, t('ui.system.title')), h('p', null, t('ui.system.intro')))), body);

  async function load(force = false) {
    if (loading) return;
    loading = true;
    if (!sys) render(); // the first check takes a few seconds: show the "checking" message meanwhile
    try {
      sys = await api.system(force);
    } catch (e) {
      sys = null;
      toast(e.message, 'error');
    }
    loading = false;
    render();
  }

  const cmdBox = (text) =>
    h('div', { class: 'cmd' }, h('code', null, text), h('button', { class: 'btn small icon-only ghost', type: 'button', 'aria-label': t('ui.settings.copyLabel', { text }), title: t('ui.settings.copy'), onclick: () => copyText(text).then(() => toast(t('ui.settings.copied'))) }, icon('copy', 15)));

  const LV = { required: t('ui.system.level.required'), recommended: t('ui.system.level.recommended'), optional: t('ui.system.level.optional') };

  function toolsSection() {
    const missingReq = sys.tools.filter((tTool) => !tTool.ok && tTool.level === 'required');
    const rows = sys.tools.map((tTool) => h('tr', null,
      h('td', null, h('strong', null, tTool.name), h('div', { class: 'hint' }, tTool.why)),
      h('td', null, LV[tTool.level]),
      h('td', null, h('span', { class: `badge ${tTool.ok ? 'ok' : tTool.level === 'required' ? 'warn' : tTool.level === 'recommended' ? 'medium' : ''}` }, tTool.ok ? t('ui.system.foundVersion', { version: tTool.version ?? '' }) : tTool.reason)),
      h('td', null, tTool.ok ? null : tTool.installCommand ? cmdBox(tTool.installCommand) : h('span', { class: 'hint' }, tTool.manual ? h('a', { href: tTool.manual, target: '_blank', rel: 'noopener noreferrer' }, t('ui.system.installGuide')) : t('ui.system.manualInstall')))));
    return h('section', { class: 'sec' },
      h('h2', null, t('ui.system.toolsHeader')),
      h('p', { class: 'hint' }, t('ui.system.toolsDescription')),
      h('div', { class: 'table-wrap' }, h('table', { class: 'data' }, h('thead', null, h('tr', null, [t('ui.system.col.tool'), t('ui.system.col.level'), t('ui.system.col.state'), t('ui.system.col.toInstall')].map((x) => h('th', null, x)))), h('tbody', null, rows))),
      sys.tools.some((tTool) => !tTool.ok)
        ? h('div', { class: 'stack' }, h('div', { class: `banner ${missingReq.length ? 'warn' : 'caution'}` }, icon(missingReq.length ? 'warn' : 'check'), h('div', null, missingReq.length ? t('ui.system.missingReq') : t('ui.system.missingOpt'), t('ui.system.toInstallAll'))), cmdBox('npm run setup'))
        : h('div', { class: 'banner ok' }, icon('check'), h('div', null, t('ui.system.allPresent'))));
  }

  function skillToolsSection() {
    if (!sys.skillCommands.length) return null;
    return h('section', { class: 'sec' },
      h('h2', null, t('ui.system.skillToolsTitle')),
      h('p', { class: 'hint' }, t('ui.system.skillToolsDesc')),
      h('div', { class: 'rows' }, sys.skillCommands.map((m) => h('div', { class: 'row', style: { cursor: 'default', gridTemplateColumns: 'minmax(0,1fr) auto' } },
        h('div', null, h('div', { class: 'name' }, m.command), h('div', { class: 'hint' }, t('ui.system.neededBy'), m.requiredBy.map((id, i) => [i ? ', ' : '', h('button', { type: 'button', class: 'btn small ghost', style: { minHeight: '22px', padding: '0 4px' }, onclick: () => ctx.select(id) }, id.replace(/^(skill|agent):/, ''))]))),
        h('div', null, m.installCommand ? cmdBox(m.installCommand) : h('span', { class: 'hint' }, m.known ? t('ui.system.noManager') : t('ui.system.manualNotInDeps')))))));
  }

  function syncSection() {
    const tools = sys.machine.aiTools ?? [];
    const on = tools.filter((x) => x.enabled);
    const anyBlock = on.some((x) => x.instructionsBlock);
    const state = (x) =>
      x.sync.active ? h('span', { class: 'badge ok' }, t('ui.system.synced', { n: x.sync.items })) : x.sync.root ? h('span', { class: 'badge warn' }, t('ui.system.otherHub')) : h('span', { class: 'badge warn' }, t('ui.system.never'));
    const rows = tools.map((x) => h('tr', null,
      h('td', null, h('strong', null, x.name), h('div', { class: 'hint' }, x.enabled ? t('ui.system.enabled') : t('ui.system.disabled'))),
      h('td', null, h('span', { class: `badge ${x.installed ? 'ok' : ''}` }, x.installed ? t('ui.system.installed') : t('ui.system.notInstalled'))),
      h('td', { class: 'mono hint' }, x.paths.skillsDir, h('br'), x.paths.agentsDir),
      h('td', null, x.enabled ? state(x) : '—', x.sync.syncedAt ? h('div', { class: 'hint' }, new Date(x.sync.syncedAt).toLocaleString('en-US')) : null, x.enabled ? h('div', { class: 'hint' }, x.instructionsBlock ? t('ui.system.blockYes') : t('ui.system.blockNo')) : null)));
    return h('section', { class: 'sec' },
      h('h2', null, t('ui.system.tools')),
      h('p', { class: 'hint' }, t('ui.system.toolsHint')),
      h('div', { class: 'table-wrap' }, h('table', { class: 'data' }, h('thead', null, h('tr', null, [t('ui.system.col.tool'), t('ui.system.col.program'), t('ui.system.col.folders'), t('ui.system.col.state')].map((x) => h('th', null, x)))), h('tbody', null, rows))),
      on.length
        ? h('div', { class: 'toolbar', style: { marginTop: '12px' } },
            h('button', { class: 'btn primary', type: 'button', disabled: busy, onclick: async () => {
              busy = true;
              render();
              const r = await guarded(() => api.sync(claudeMd && !anyBlock));
              syncOut = r;
              busy = false;
              if (r) toast(r.ok ? t('ui.system.syncDone') : t('ui.system.syncFailed'), r.ok ? 'info' : 'error');
              await load(true);
            } }, icon('refresh', 16), busy ? t('ui.system.syncing') : t('ui.system.syncNow')),
            anyBlock ? null : h('label', { class: 'check hint' }, h('input', { type: 'checkbox', checked: claudeMd, onchange: (e) => (claudeMd = e.target.checked) }), t('ui.system.addBlock')))
        : h('div', { class: 'banner caution' }, icon('warn'), h('div', null, t('ui.system.noTools'), ' ', h('a', { href: '#/welcome' }, t('ui.system.choose')))),
      h('p', { class: 'hint' }, t('ui.system.syncHint')),
      syncOut ? h('pre', { class: 'pre' }, syncOut.output || '') : null);
  }

  function doctorSection() {
    const icons = { error: '✖', warn: '⚠', info: 'ℹ' };
    return h('section', { class: 'sec' },
      h('h2', null, t('ui.system.doctorTitle')),
      h('p', { class: 'hint' }, t('ui.system.doctorDesc')),
      h('div', { class: 'toolbar' }, h('button', { class: 'btn', type: 'button', disabled: busy, onclick: async () => {
        busy = true;
        render();
        try {
          doctor = await api.doctor();
        } catch (e) {
          toast(e.message, 'error');
        }
        busy = false;
        render();
      } }, t('ui.system.runDoctor'))),
      doctor
        ? h('div', { class: 'stack' },
            h('div', { class: `banner ${doctor.ok ? 'ok' : doctor.problems.some((p) => p.level === 'error') ? 'warn' : 'caution'}` }, icon(doctor.ok ? 'check' : 'warn'), h('div', null, t('ui.system.doctorChecked', { checked: doctor.checked.length, errors: doctor.problems.filter((p) => p.level === 'error').length, warns: doctor.problems.filter((p) => p.level === 'warn').length }))),
            doctor.problems.length ? h('ul', { style: { margin: 0, paddingLeft: '1.2em' } }, doctor.problems.map((p) => h('li', null, `${icons[p.level]} ${p.message}`))) : null)
        : null);
  }

  function machineSection() {
    const m = sys.machine;
    return h('section', { class: 'sec' }, h('h2', null, t('ui.system.thisMachine')),
      h('dl', { class: 'kv' }, h('dt', null, t('ui.system.system')), h('dd', null, `${m.platformLabel} ${m.arch}`), h('dt', null, t('ui.system.node')), h('dd', null, m.node),
        h('dt', null, t('ui.system.pkgManagers')), h('dd', null, Object.entries(m.managers).map(([k, v]) => `${k} ${v ? '✔' : '✖'}`).join('   ')),
        h('dt', null, t('ui.system.gitHooks')), h('dd', null, m.isGitRepo ? t('ui.system.gitRepoPresent') : t('ui.system.notGitRepo'))));
  }

  function render() {
    clear(body);
    if (!sys) {
      body.append(...[h('p', { class: 'hint' }, loading ? t('ui.system.checkingMachine') : t('ui.system.readFailed')), loading ? null : h('button', { class: 'btn', type: 'button', onclick: () => load(true) }, t('ui.settings.retry'))].filter(Boolean));
      return;
    }
    body.append(...[toolsSection(), skillToolsSection(), syncSection(), doctorSection(), machineSection()].filter(Boolean), h('div', null, h('button', { class: 'btn small', type: 'button', onclick: () => load(true) }, icon('refresh', 15), t('ui.system.recheckMachine'))));
  }

  return {
    el,
    update() {
      const k = store.state?.watch ?? '';
      if (k !== key) {
        key = k;
        load();
      } else if (sys) {
        // nothing to reload: selection only affects detail drawer links
      }
    },
    destroy() {},
  };
}
