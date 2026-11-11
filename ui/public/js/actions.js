// Shared actions (update, remove, link): invoke server and update local state.
import { h } from './dom.js';
import { api } from './api.js';
import { refresh } from './store.js';
import { confirmDialog, toast } from './ui.js';
import { t } from './i18n.js';

export async function guarded(fn, okMessage) {
  try {
    const r = await fn();
    await refresh();
    if (okMessage) toast(typeof okMessage === 'function' ? okMessage(r) : okMessage);
    return r;
  } catch (e) {
    toast(e.message, 'error');
    return null;
  }
}

export async function updateItems(names = []) {
  const r = await guarded(() => api.update(names));
  if (!r) return null;
  toast(r.ok ? t('ui.actions.updateDone') : t('ui.actions.updateFailed'), r.ok ? 'info' : 'error');
  return r;
}

export async function approveItem(e) {
  const r = await guarded(() => api.approve(e.kind, e.name));
  if (r) toast(r.ok ? t('ui.actions.itemApproved', { name: e.name }) : t('ui.actions.itemNotApproved'), r.ok ? 'info' : 'error');
  return r;
}

export async function removeItem(e) {
  const ok = await confirmDialog({
    title: t('ui.actions.removeTitle', { name: e.name }),
    body: h('div', null,
      h('p', null, e.kind === 'agent' ? t('ui.actions.removeBodyAgent') : t('ui.actions.removeBodySkill')),
      e.package ? h('p', null, h('strong', null, t('ui.actions.removePackageWarning', { package: e.package }))) : null,
      h('p', { class: 'hint' }, t('ui.actions.removeHint'))),
    confirmLabel: t('ui.actions.removeConfirm'),
    danger: true,
  });
  if (!ok) return null;
  const r = await guarded(() => api.remove(e.kind, e.name));
  if (r) toast(r.ok ? t('ui.actions.itemRemoved', { name: e.name }) : r.output || t('ui.actions.removeFailed'), r.ok ? 'info' : 'error');
  return r;
}
