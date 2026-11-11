// Reusable UI components: toasts, confirmation dialogs, badges.
import { h, icon } from './dom.js';
import { catLabel, catsOf } from './store.js';
import { t } from './i18n.js';

export function toast(message, kind = 'info', ms = 5200) {
  const box = document.getElementById('toasts');
  const el = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, h('span', { class: 'grow' }, message), h('button', { type: 'button', 'aria-label': t('ui.common.closeNotice'), onclick: () => el.remove() }, icon('close', 16)));
  box.append(el);
  if (kind !== 'error') setTimeout(() => el.remove(), ms);
  else setTimeout(() => el.remove(), 12000);
}

/** Confirmation dialog (no window.confirm: non-blocking and stylable). Returns Promise<boolean>. */
export function confirmDialog({ title, body, confirmLabel = t('ui.common.confirm'), danger = false }) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const done = (v) => {
      back.remove();
      document.removeEventListener('keydown', onKey);
      prevFocus?.focus?.();
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') done(false);
    };
    const ok = h('button', { type: 'button', class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => done(true) }, confirmLabel);
    const back = h(
      'div',
      { class: 'modal-back', onclick: (e) => e.target === back && done(false) },
      h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'modal-title' }, h('h2', { id: 'modal-title' }, title), h('div', null, body), h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn', onclick: () => done(false) }, t('ui.common.cancel')), ok)),
    );
    document.body.append(back);
    document.addEventListener('keydown', onKey);
    ok.focus();
  });
}

export const RISK_LABEL = {
  get low() { return t('ui.common.risk.low'); },
  get medium() { return t('ui.common.risk.medium'); },
  get high() { return t('ui.common.risk.high'); },
};

export function riskBadge(risk, flags = []) {
  if (!risk || risk === 'low') return null;
  const why = flags.filter((f) => f !== 'external').join(', ');
  return h('span', { class: `badge ${risk}`, title: why ? t('ui.common.risk.signals', { why }) : undefined }, icon('warn', 12), RISK_LABEL[risk] ?? risk);
}

export function kindDot(e) {
  return h('span', { class: `kind ${e.kind === 'agent' ? 'agent' : ''} ${e.origin === 'external' ? 'external' : ''}`, title: `${e.kind === 'agent' ? t('ui.common.kind.agent') : t('ui.common.kind.skill')} ${e.origin === 'external' ? t('ui.common.origin.external') : (e.kind === 'agent' ? t('ui.common.origin.ownAgent') : t('ui.common.origin.own'))}`, 'aria-hidden': 'true' });
}

export function catChips(e, { max = 4 } = {}) {
  const cats = catsOf(e);
  const declared = e.categories.length > 0;
  return cats.slice(0, max).map((c) => h('span', { class: 'chip', title: declared ? t('ui.common.cat.declared') : t('ui.common.cat.inferred') }, catLabel(c)));
}

export const originLabel = (e) => (e.origin === 'external' ? t('ui.common.origin.external') : (e.kind === 'agent' ? t('ui.common.origin.ownAgent') : t('ui.common.origin.own')));
export const kindLabel = (e) => (e.kind === 'agent' ? t('ui.common.kind.agent') : t('ui.common.kind.skill'));
