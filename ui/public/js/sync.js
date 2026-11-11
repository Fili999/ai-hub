// GitHub synchronization in the interface: top button with status and dialog with updates, changes, and actions.
// Automatic check runs on open, every 5 minutes, and on tab focus; pull and push run only on explicit user click.
import { h, clear, icon } from './dom.js';
import { api } from './api.js';
import { toast } from './ui.js';
import { canPull, canPush, chipInfo, relativeTime, shouldAnnounce } from './sync-model.js';
import { t } from './i18n.js';

const CHECK_EVERY = 5 * 60 * 1000;
const MIN_GAP = 2 * 60 * 1000;
const chip = document.getElementById('sync');

let status = null;
let busy = null; // in-progress action label or null
let lastResult = null; // { tone, text, hints } of last action, displayed in dialog
let announced = 0;
let lastCheck = 0;
let dlg = null; // { back, body, prevFocus, message }

function paintChip() {
  const info = chipInfo(status);
  chip.dataset.tone = info.tone;
  chip.setAttribute('aria-label', t('ui.sync.ariaLabel', { label: info.label, title: info.title }).trim());
  chip.title = info.title || t('ui.sync.title');
  clear(chip);
  chip.append(icon('sync', 16), h('span', { class: 'sync-label' }, info.label));
}

function setStatus(st) {
  status = st;
  paintChip();
  if (shouldAnnounce(st, announced)) toast(t.n('ui.sync.announcement', st.behind));
  announced = st?.state === 'behind' ? st.behind : 0;
  renderDialog();
}

export async function check({ silent = true } = {}) {
  if (busy) return;
  lastCheck = Date.now();
  try {
    setStatus(await api.repoCheck());
  } catch (e) {
    if (!silent) toast(e.message, 'error');
  }
}

/** Reads local repository state only (no network): used when files change to update outgoing changes. */
export async function refreshLocal() {
  if (busy) return;
  try {
    // git remembers the last check on GitHub: known incoming commits remain, only local files change
    const st = await api.repo();
    if (status?.fetchError && !st.fetchError) st.fetchError = status.fetchError; // keep last fetch error until next check
    setStatus(st);
  } catch {
    /* server unreachable: already indicated by real-time status light */
  }
}

async function act(label, fn, describe) {
  if (busy) return;
  busy = label;
  lastResult = null;
  renderDialog();
  try {
    const r = await fn();
    lastResult = describe(r);
    if (r.status) setStatus(r.status);
  } catch (e) {
    lastResult = { tone: 'warn', text: e.message };
  } finally {
    busy = null;
    renderDialog();
  }
}

const doCheck = () =>
  act(
    t('ui.sync.checking'),
    async () => {
      lastCheck = Date.now();
      const st = await api.repoCheck();
      return { status: st };
    },
    (r) => (r.status.fetchError ? { tone: 'warn', text: r.status.fetchError.message } : null),
  );

const doPull = (setAside = false) =>
  act(
    t('ui.sync.pulling'),
    () => api.repoPull(setAside),
    (r) => {
      // same lines changed locally and on GitHub: offer to pull by setting changes aside
      if (!r.ok) return { tone: 'warn', text: r.message, detail: r.error?.detail, setAside: r.error?.kind === 'same-lines' };
      const hints = [];
      if (r.changed) {
        if (r.needsRestart) hints.push(t('ui.sync.restartNotice'));
        if (r.needsSetup) hints.push(t('ui.sync.setupNotice'));
        hints.push({ action: 'sync' });
      }
      return { tone: 'ok', text: r.message, hints };
    },
  );

const doPush = () =>
  act(
    t('ui.sync.pushing'),
    () => api.repoPush(dlg?.message?.value.trim()),
    (r) => (r.ok ? { tone: 'ok', text: r.message } : { tone: 'warn', text: r.message, detail: r.error?.detail }),
  );

const doSync = () =>
  act(
    t('ui.sync.connecting'),
    () => api.sync(false),
    (r) => ({ tone: r.ok ? 'ok' : 'warn', text: r.ok ? t('ui.sync.connected') : t('ui.sync.connectFailed'), detail: r.ok ? '' : r.output }),
  );

// ---------------------------------------------------------------- dialog
const section = (title, ...children) => h('section', { class: 'sync-sec' }, h('h3', null, title), ...children);

function commitList(items, mark) {
  return h('ul', { class: 'sync-list' }, items.map((c) => h('li', null, h('span', { class: 'sync-mark' }, mark), h('code', null, c.hash), h('span', { class: 'grow' }, c.subject), c.author ? h('span', { class: 'hint' }, c.author) : null)));
}

function render(st) {
  const kids = [];
  const tone = st ? chipInfo(st).tone : 'idle';
  const bannerKind = { ok: 'ok', warn: 'caution', info: '', bad: 'warn', idle: '' }[tone];
  kids.push(h('div', { class: `banner ${bannerKind}` }, icon(tone === 'ok' ? 'check' : tone === 'bad' ? 'warn' : 'sync', 18), h('div', null, st?.summary ?? t('ui.sync.inProgress'))));

  if (lastResult) {
    kids.push(
      h(
        'div',
        { class: `banner ${lastResult.tone === 'ok' ? 'ok' : 'warn'}`, role: 'status' },
        icon(lastResult.tone === 'ok' ? 'check' : 'warn', 18),
        h(
          'div',
          null,
          h('strong', null, lastResult.text),
          lastResult.detail ? h('pre', { class: 'sync-detail' }, lastResult.detail) : null,
          ...(lastResult.hints ?? []).map((x) => (typeof x === 'string' ? h('p', { class: 'hint' }, x) : h('p', null, h('button', { type: 'button', class: 'btn', disabled: Boolean(busy), onclick: doSync }, icon('link', 16), t('ui.sync.connectBtn'))))),
        ),
      ),
    );
  }

  if (st?.fetchError && !lastResult) kids.push(h('div', { class: 'banner caution' }, icon('warn', 18), h('div', null, st.fetchError.message)));

  if (st?.remoteUrl || st?.branch) {
    kids.push(
      h(
        'dl',
        { class: 'kv' },
        h('dt', null, t('ui.sync.repo')),
        h('dd', null, st.remoteUrl ?? '—'),
        h('dt', null, t('ui.sync.branch')),
        h('dd', null, st.upstream ? `${st.branch} ↔ ${st.upstream}` : (st.branch ?? '—')),
        h('dt', null, t('ui.sync.lastCheck')),
        h('dd', null, relativeTime(st.lastFetch)),
      ),
    );
  }

  if (st?.incoming?.length) {
    kids.push(section(t('ui.sync.incomingTitle', { n: st.behind }), commitList(st.incoming, '↓'), st.incomingFiles.length ? h('p', { class: 'hint' }, t.n('ui.sync.filesChanged', st.incomingFiles.length >= 40 ? '40+' : st.incomingFiles.length)) : null, st.needsSetup ? h('p', { class: 'hint' }, t('ui.sync.depsChangeNotice')) : null));
  }

  const pendingFiles = st?.changesTotal ?? 0;
  if (st?.outgoing?.length || pendingFiles) {
    const files = h(
      'ul',
      { class: 'sync-list' },
      (st.changes ?? []).map((f) => h('li', { class: st.blocked.includes(f.path) ? 'blocked' : '' }, h('span', { class: 'sync-mark' }, '●'), h('span', { class: 'grow' }, f.path), h('span', { class: 'badge' }, f.status), st.blocked.includes(f.path) ? h('span', { class: 'badge warn', title: st.blockedReasons?.[f.path] ?? '' }, t('ui.sync.blockedSecret')) : null)),
    );
    kids.push(
      section(
        t('ui.sync.toSend'),
        st.outgoing.length ? h('div', null, h('p', { class: 'hint' }, t.n('ui.sync.aheadNotice', st.ahead)), commitList(st.outgoing, '↑')) : null,
        pendingFiles ? h('div', null, h('p', { class: 'hint' }, t.n('ui.sync.pendingNotice', pendingFiles)), files, pendingFiles > st.changes.length ? h('p', { class: 'hint' }, t('ui.sync.moreFiles', { n: pendingFiles - st.changes.length })) : null) : null,
        st.blocked.length
          ? h('div', { class: 'hint' },
              h('p', null, t('ui.sync.blockedNotice')),
              h('ul', null, st.blocked.map((p) => h('li', null, h('code', null, p), ` — ${st.blockedReasons?.[p] ?? t('ui.sync.blockedSecret')}`)), st.blockedTotal > st.blocked.length ? h('li', null, t('ui.sync.moreFiles', { n: st.blockedTotal - st.blocked.length })) : null),
              h('p', null, t('ui.sync.blockedHelp')))
          : null,
      ),
    );
    if (pendingFiles && canPush(st)) {
      const msg = h('input', { type: 'text', maxlength: 200, placeholder: t('ui.sync.msgPlaceholder'), 'aria-label': t('ui.sync.msgAria'), disabled: Boolean(busy) });
      if (dlg?.message) msg.value = dlg.message.value;
      if (dlg) dlg.message = msg;
      kids.push(h('div', { class: 'field' }, h('label', null, t('ui.sync.msgLabel')), msg));
    }
  }

  if (st?.state === 'diverged') kids.push(h('p', { class: 'hint' }, t('ui.sync.divergedNotice')));

  const actions = [h('button', { type: 'button', class: 'btn', disabled: Boolean(busy), onclick: doCheck }, icon('refresh', 16), busy === t('ui.sync.checking') ? busy : t('ui.sync.checkNow'))];
  if (canPull(st)) actions.push(h('button', { type: 'button', class: 'btn primary', disabled: Boolean(busy), onclick: () => doPull() }, icon('down', 16), busy === t('ui.sync.pulling') ? busy : t.n('ui.sync.downloadUpdates', st.behind)));
  if (canPull(st) && lastResult?.setAside) actions.push(h('button', { type: 'button', class: 'btn', disabled: Boolean(busy), onclick: () => doPull(true) }, icon('down', 16), t('ui.sync.downloadSetAside')));
  if (canPush(st)) actions.push(h('button', { type: 'button', class: 'btn primary', disabled: Boolean(busy), onclick: doPush }, icon('up', 16), busy === t('ui.sync.pushing') ? busy : pendingFiles ? t('ui.sync.saveAndPush') : t('ui.sync.push')));
  actions.push(h('button', { type: 'button', class: 'btn ghost', onclick: closeDialog }, t('ui.common.close')));
  kids.push(h('div', { class: 'actions' }, actions));
  return kids;
}

function renderDialog() {
  if (!dlg) return;
  const typing = dlg.message && document.activeElement === dlg.message;
  const keepMessage = dlg.message?.value ?? '';
  dlg.message = null;
  clear(dlg.body);
  dlg.body.append(...render(status));
  if (dlg.message) {
    dlg.message.value = keepMessage;
    if (typing) dlg.message.focus();
  }
}

function onKey(e) {
  if (e.key === 'Escape') closeDialog();
}

function closeDialog() {
  if (!dlg) return;
  dlg.back.remove();
  document.removeEventListener('keydown', onKey);
  dlg.prevFocus?.focus?.();
  dlg = null;
}

function openDialog() {
  if (dlg) return;
  lastResult = null;
  const body = h('div', { class: 'sync-body' });
  const back = h(
    'div',
    { class: 'modal-back', onclick: (e) => e.target === back && closeDialog() },
    h('div', { class: 'modal wide', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'sync-title' }, h('h2', { id: 'sync-title' }, t('ui.sync.title')), body),
  );
  dlg = { back, body, prevFocus: document.activeElement, message: null };
  document.body.append(back);
  document.addEventListener('keydown', onKey);
  renderDialog();
  back.querySelector('.btn')?.focus();
  refreshLocal();
  if (!status || Date.now() - lastCheck > 30000) check({ silent: false });
}

export function startSync() {
  paintChip();
  chip.addEventListener('click', openDialog);
  api.repo().then(setStatus).catch(() => {});
  check();
  setInterval(() => {
    if (!document.hidden) check();
  }, CHECK_EVERY);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (Date.now() - lastCheck > MIN_GAP) check();
    else refreshLocal();
  });
}
