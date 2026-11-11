// Pure sync logic (DOM-free): top button state and available actions.
// Kept in a separate file so it can be tested from the terminal alongside other tests.
import { t } from './i18n.js';

/** { tone, label, title } for the top button. tone: idle | ok | warn | info | bad */
export function chipInfo(st) {
  if (!st) return { tone: 'idle', label: 'GitHub', title: t('ui.sync.chipCheckingTitle') };
  const title = st.summary || '';
  if (st.state === 'diverged') return { tone: 'bad', label: t('ui.sync.chipDiverged'), title };
  if (st.state === 'behind') return { tone: 'warn', label: t('ui.sync.chipBehind', { count: st.behind }), title };
  if (['ahead', 'synced'].includes(st.state) && (st.ahead > 0 || st.changesTotal > 0)) return { tone: 'info', label: t('ui.sync.chipToSend'), title };
  if (st.fetchError) return { tone: 'idle', label: t('ui.sync.chipUnchecked'), title: `${st.fetchError.message} ${title}`.trim() };
  if (st.state === 'synced') return { tone: 'ok', label: t('ui.sync.chipUpdated'), title };
  return { tone: 'idle', label: t('ui.sync.chipNotConnected'), title };
}

export const canPull = (st) => Boolean(st) && st.state === 'behind' && !st.conflicts;

/** Push is allowed when there are changes to send, repo is not behind, and no secrets are detected. */
export const canPush = (st) => Boolean(st) && ['ahead', 'synced'].includes(st.state) && (st.ahead > 0 || st.changesTotal > 0) && !(st.blocked?.length > 0) && !st.conflicts;

/** "just now", "5m ago", "3h ago", "2 days ago" */
export function relativeTime(iso, now = Date.now()) {
  if (!iso) return t('ui.sync.timeNever');
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return '—';
  const s = Math.max(0, Math.round((now - parsed) / 1000));
  if (s < 45) return t('ui.sync.timeNow');
  const m = Math.round(s / 60);
  if (m < 60) return t('ui.sync.timeMinAgo', { m });
  const hr = Math.round(m / 60);
  if (hr < 24) return t('ui.sync.timeHoursAgo', { hr });
  const d = Math.round(hr / 24);
  return t.n('ui.sync.timeDaysAgo', d, { count: d });
}

/** Should notify with an alert? Only when incoming updates have increased compared to last announcement. */
export const shouldAnnounce = (st, announced) => Boolean(st) && st.state === 'behind' && st.behind > announced;
