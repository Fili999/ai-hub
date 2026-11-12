// Banner shown above the page when a new version of AI Hub is out. The server decides everything (what is
// available, whether this copy can update itself); this only shows it and sends the button press.
import { h, clear, icon } from './dom.js';
import { api } from './api.js';
import { t } from './i18n.js';

export function startUpdates(bar, { everyMs = 60_000 } = {}) {
  let busy = false;
  let failed = '';

  function render(s) {
    clear(bar);
    const info = s?.info;
    if (!s?.enabled) return void (bar.hidden = true);
    if (s.phase === 'restart') {
      bar.hidden = false;
      bar.append(h('div', { class: 'banner ok' }, icon('check'), h('div', null, t('ui.update.done', { version: s.result?.to ?? info?.latest ?? '' }))));
      return;
    }
    if (!info?.available) return void (bar.hidden = true);
    bar.hidden = false;
    const apply = h('button', { class: 'btn small', type: 'button', disabled: busy || s.phase === 'applying' }, icon('refresh', 15), busy || s.phase === 'applying' ? t('ui.update.applying') : t('ui.update.apply'));
    apply.addEventListener('click', async () => {
      busy = true;
      failed = '';
      render(s);
      try {
        const next = await api.updateApply();
        busy = false;
        failed = next.error ?? '';
        render(next);
      } catch (e) {
        busy = false;
        failed = e.message;
        render(s);
      }
    });
    bar.append(
      h(
        'div',
        { class: 'banner caution' },
        icon('refresh'),
        h(
          'div',
          { class: 'update-text' },
          h('strong', null, t('ui.update.available', { latest: info.latest, current: info.current })),
          ' ',
          info.url ? h('a', { href: info.url, target: '_blank', rel: 'noopener noreferrer' }, t('ui.update.notes')) : null,
          info.canApply ? null : ` ${t('ui.update.manual')}`,
          failed || s.error ? h('div', { class: 'hint' }, t('ui.update.failed'), failed || s.error) : null,
        ),
        info.canApply ? apply : null,
      ),
    );
  }

  async function refresh() {
    try {
      render(await api.updateStatus());
    } catch {
      /* the server is not answering: nothing to show */
    }
  }
  refresh();
  const timer = setInterval(refresh, everyMs);
  return () => clearInterval(timer);
}
