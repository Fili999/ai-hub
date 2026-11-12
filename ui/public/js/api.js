// Local API client. Session token arrives in page meta tag and accompanies every request.
const token = document.querySelector('meta[name="hub-token"]')?.content ?? '';

async function call(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { 'X-Hub-Token': token, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
  } catch {
    throw new Error('Local server is not responding. Is it running (npm start)?');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON response */
  }
  if (!res.ok) throw new Error(data?.error ?? `Error ${res.status}`);
  return data;
}

export const api = {
  state: () => call('GET', '/api/state'),
  tree: () => call('GET', '/api/tree'),
  search: (q, extra = {}) => call('GET', `/api/search?${new URLSearchParams({ q, ...extra })}`),
  updateStatus: () => call('GET', '/api/update'),
  updateCheck: () => call('POST', '/api/update/check', {}),
  updateApply: () => call('POST', '/api/update/apply', { confirm: true }),
  guide: (refresh = false) => call('GET', `/api/guide?${new URLSearchParams(refresh ? { refresh: '1' } : {})}`),
  system: (refresh = false) => call('GET', `/api/system${refresh ? '?refresh=1' : ''}`),
  machine: () => call('GET', '/api/system?only=machine'),
  doctor: () => call('GET', '/api/doctor'),
  usage: (refresh = false) => call('GET', `/api/usage${refresh ? '?refresh=1' : ''}`),
  link: (agent, skill) => call('POST', '/api/link', { agent, skill }),
  unlink: (agent, skill) => call('POST', '/api/unlink', { agent, skill }),
  categorize: (id, categories) => call('POST', '/api/categorize', { id, categories }),
  teams: () => call('GET', '/api/teams'),
  saveTeam: (team, create = false) => call('POST', '/api/teams/save', { team, create }),
  deleteTeam: (id) => call('POST', '/api/teams/delete', { id }),
  suggestTeam: (draft) => call('POST', '/api/teams/suggest', { draft }),
  category: (body) => call('POST', '/api/categories', body),
  preview: (body) => call('POST', '/api/install/preview', body),
  scan: (body) => call('POST', '/api/install/scan', body), // SkillSpector analysis on selected items (does not write)
  install: (body) => call('POST', '/api/install', body),
  update: (names = []) => call('POST', '/api/update', { names }),
  remove: (kind, name) => call('POST', '/api/remove', { kind, name }),
  approvals: () => call('GET', '/api/approvals'), // verified approval status (hash) on this computer
  approve: (kind, name) => call('POST', '/api/approve', { kind, name }), // analyzes with SkillSpector and approves
  sync: (instructions = false) => call('POST', '/api/sync', { instructions }),
  createOptions: () => call('GET', '/api/create/options'),
  createPreview: (draft) => call('POST', '/api/create/preview', draft), // writes nothing
  create: (draft) => call('POST', '/api/create', draft), // writes new file, never overwrites
  settings: () => call('GET', '/api/settings'),
  saveSettings: (values) => call('POST', '/api/settings', { values }),
  repo: () => call('GET', '/api/repo'),
  repoCheck: () => call('POST', '/api/repo/check', {}),
  repoPull: (setAside = false) => call('POST', '/api/repo/pull', setAside ? { setAside: true } : {}),
  // push requires explicit confirmation: server rejects requests without "confirm: true"
  repoPush: (message) => call('POST', '/api/repo/push', { confirm: true, ...(message ? { message } : {}) }),
};

/** Real-time events: calls onChange when hub files change. Auto-reconnects. */
export function listen(onChange, onStatus = () => {}) {
  const es = new EventSource(`/api/events?t=${encodeURIComponent(token)}`);
  es.addEventListener('hello', () => onStatus(true));
  es.addEventListener('change', () => onChange());
  es.onerror = () => onStatus(false);
  return () => es.close();
}
