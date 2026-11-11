// Install from a GitHub link: preview, item selection, NVIDIA SkillSpector scan, assignment, confirmation.
// Also manages already installed items.
import { h, clear, icon } from '../dom.js';
import { api } from '../api.js';
import { store, catLabel, shortName } from '../store.js';
import { kindDot, riskBadge, toast } from '../ui.js';
import { approveItem, guarded, removeItem, updateItems } from '../actions.js';
import { t } from '../i18n.js';

const MAX_INSTALL = 50; // server limit for a single install
const MAX_SCAN = 20; // server limit for a single scan
const PAGE = 100; // items rendered per batch (a repository can contain hundreds of skills)
const MODE_LABEL = () => ({ block: t('ui.install.mode.block'), warn: t('ui.install.mode.warn'), off: t('ui.install.mode.off') });
const REC_LABEL = () => ({ SAFE: t('ui.install.rec.SAFE'), CAUTION: t('ui.install.rec.CAUTION'), DO_NOT_INSTALL: t('ui.install.rec.DO_NOT_INSTALL') });

export default function create(ctx) {
  const form = { source: '', ref: '', path: '' };
  let preview = null; // {source, items}
  let previewFor = null; // parameters used for the current preview
  let loading = false;
  let error = '';
  let picked = new Set();
  let assignMode = 'global';
  let agentsPicked = new Set();
  let cats = new Set();
  let force = false;
  let result = null; // {ok, output}
  let installing = false;
  let syncOut = null;
  let scanning = false;
  let filter = '';
  let shown = PAGE;
  let wholePackage = false; // install the entire package (repo or subfolder) instead of skill folders only
  let approvals = null; // Map "kind:name" -> {status, reason}, verified by server
  let approvalsFor = null;

  const wizard = h('div', { class: 'stack' });
  const installed = h('div');
  const el = h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, t('ui.install.title')), h('p', null, t('ui.install.intro')))),
    wizard,
    h('section', { class: 'sec' }, h('h2', null, t('ui.install.installedFromGithub')), installed));

  // ------------------------------------------------------------ passi
  async function doPreview(ev) {
    ev?.preventDefault();
    const source = form.source.trim();
    if (!source) {
      error = t('ui.install.enterLink');
      return render();
    }
    loading = true;
    error = '';
    result = null;
    syncOut = null;
    preview = null;
    render();
    try {
      const body = { source, ...(form.ref.trim() ? { ref: form.ref.trim() } : {}), ...(form.path.trim() ? { path: form.path.trim() } : {}) };
      preview = await api.preview(body);
      previewFor = body;
      // with large packages do not select anything by default: user searches and picks what they need
      picked = new Set(preview.items.length > MAX_SCAN ? [] : preview.items.filter((i) => i.validName && !collision(i) && i.risk?.risk !== 'high').map((i) => i.name));
      filter = '';
      shown = PAGE;
      wholePackage = false;
      assignMode = 'global';
      agentsPicked = new Set();
      cats = new Set();
      force = false;
    } catch (e) {
      error = e.message;
    }
    loading = false;
    render();
  }

  function collision(it) {
    const e = store.byId.get(`${it.kind}:${it.name}`);
    if (!e) return null;
    return e.origin === 'own' ? 'own' : 'external';
  }

  const policy = () => preview?.security ?? { mode: 'off', available: false };
  const blockedBySpector = (it) => policy().mode === 'block' && it.spector?.verdict === 'block';

  async function doScan() {
    const names = [...picked];
    scanning = true;
    render();
    try {
      const r = await api.scan({ ...previewFor, only: names, expectCommit: preview.source.commit });
      const byName = new Map(r.items.filter((i) => i.spector).map((i) => [`${i.kind}:${i.name}`, i.spector]));
      for (const it of preview.items) {
        const sp = byName.get(`${it.kind}:${it.name}`);
        if (sp) it.spector = sp;
      }
      if (r.security?.version) preview.security.version = r.security.version;
      const bad = preview.items.filter(blockedBySpector).filter((i) => picked.has(i.name));
      for (const it of bad) picked.delete(it.name);
      toast(bad.length ? t.n('ui.install.spectorRemoved', bad.length, { count: bad.length }) : t('ui.install.scanDone'), bad.length ? 'error' : 'info');
    } catch (e) {
      toast(e.message, 'error');
    }
    scanning = false;
    render();
  }

  async function doInstall() {
    installing = true;
    render();
    try {
      const chosen = preview.items.filter((i) => picked.has(i.name));
      const body = {
        ...previewFor,
        ...(wholePackage ? { package: true } : { only: [...new Set(chosen.map((i) => i.name))] }),
        to: assignMode === 'agents' && agentsPicked.size ? [...agentsPicked].map((a) => `agent:${a}`) : ['global'],
        category: [...cats],
        expectCommit: preview.source.commit,
        force,
      };
      result = await api.install(body);
      await ctx.refresh();
      if (result.ok) toast(t('ui.install.installedToast'));
      else toast(t('ui.install.installFailed'), 'error');
    } catch (e) {
      result = { ok: false, output: e.message };
      toast(e.message, 'error');
    }
    installing = false;
    render();
  }

  async function doSync() {
    const r = await guarded(() => api.sync(false));
    syncOut = r;
    if (r) toast(r.ok ? t('ui.install.connected') : t('ui.install.syncFailed'), r.ok ? 'info' : 'error');
    render();
  }

  // ------------------------------------------------------------ disegno
  function step(n, title, body, off = false) {
    return h('section', { class: `step ${off ? 'off' : ''}` }, h('div', { class: 'n' }, String(n)), h('div', null, h('h2', null, title), body));
  }

  function renderForm() {
    const source = h('input', { type: 'text', id: 'in-source', placeholder: 'https://github.com/example-owner/repo', value: form.source, autocomplete: 'off', spellcheck: 'false', oninput: (e) => (form.source = e.target.value) });
    const ref = h('input', { type: 'text', id: 'in-ref', placeholder: t('ui.install.versionPlaceholder'), value: form.ref, autocomplete: 'off', spellcheck: 'false', oninput: (e) => (form.ref = e.target.value) });
    const path = h('input', { type: 'text', id: 'in-path', placeholder: t('ui.install.subpathPlaceholder'), value: form.path, autocomplete: 'off', spellcheck: 'false', oninput: (e) => (form.path = e.target.value) });
    return h('form', { class: 'stack', onsubmit: doPreview },
      h('div', { class: 'field' }, h('label', { for: 'in-source' }, t('ui.install.githubLink')), h('div', { class: 'toolbar', style: { margin: 0 } }, h('div', { class: 'grow' }, source), h('button', { class: 'btn primary', type: 'submit', disabled: loading }, loading ? t('ui.install.loadingPreview') : t('ui.install.seeContents')))),
      h('details', null, h('summary', { class: 'hint', style: { cursor: 'pointer' } }, t('ui.install.optionsToggle')),
        h('div', { class: 'cols', style: { marginTop: '10px' } }, h('div', { class: 'field' }, h('label', { for: 'in-ref' }, t('ui.install.versionLabel')), ref), h('div', { class: 'field' }, h('label', { for: 'in-path' }, t('ui.install.subpathLabel')), path))),
      error ? h('div', { class: 'banner warn', role: 'alert' }, icon('warn'), h('div', null, error)) : null,
      h('p', { class: 'hint', style: { margin: 0 } }, t('ui.install.previewHint')));
  }

  function spectorLine(it) {
    const sp = it.spector;
    if (!sp) return null;
    if (!sp.ok) return h('div', { class: 'hint', style: { marginTop: '4px', color: 'var(--signal)' } }, t('ui.install.spectorFailed', { error: sp.error }));
    const tone = sp.verdict === 'block' ? 'high' : sp.verdict === 'warn' ? 'medium' : 'ok';
    const recLabel = REC_LABEL()[sp.recommendation] ?? sp.recommendation;
    return h('div', { style: { marginTop: '6px' } },
      h('span', { class: `badge ${tone}` }, icon('shield', 13), `SkillSpector: ${recLabel} · ${sp.score}/100`),
      sp.issues?.length
        ? h('ul', { class: 'hint spector-issues' }, sp.issues.slice(0, 4).map((i) => h('li', null, h('strong', null, i.severity), ` ${i.pattern}`, i.file ? h('code', null, ` ${i.file}${i.line ? `:${i.line}` : ''}`) : null)), sp.issueCount > 4 ? h('li', null, t('ui.install.spectorMoreIssues', { count: sp.issueCount - 4 })) : null)
        : null);
  }

  function matches(it) {
    const q = filter.trim().toLowerCase();
    return !q || it.name.toLowerCase().includes(q) || (it.description ?? '').toLowerCase().includes(q) || it.repoPath.toLowerCase().includes(q);
  }

  function renderItems() {
    const src = preview.source;
    const ghUrl = /github\.com/.test(src.url ?? '') ? String(src.url).replace(/\.git$/, '') : null;
    const visible = preview.items.filter(matches);
    const selectable = (it) => it.validName && collision(it) !== 'own' && !blockedBySpector(it);
    const many = preview.items.length > 12 && !wholePackage;
    const shared = preview.items.filter((i) => i.sharedFiles);
    const pkgBox = h('label', { class: 'check', style: { margin: '0 0 10px' } },
      h('input', { type: 'checkbox', checked: wholePackage, disabled: Boolean(result?.ok), onchange: (e) => {
        wholePackage = e.target.checked;
        if (wholePackage) picked = new Set(preview.items.filter((i) => i.validName).map((i) => i.name));
        render();
      } }),
      h('span', null, h('strong', null, t('ui.install.wholePackageTitle')),
        h('div', { class: 'hint' }, t('ui.install.wholePackageHint', { target: preview.source.subpath ? t('ui.install.subfolderContent') : t('ui.install.repoText') })),
        shared.length ? h('div', { class: 'hint', style: { color: 'var(--amber)' } }, t.n('ui.install.sharedNotice', shared.length, { names: shared.map((i) => i.name).slice(0, 5).join(', ') + (shared.length > 5 ? '…' : '') })) : null));
    const tools = many
      ? h('div', { class: 'toolbar', style: { margin: '0 0 10px' } },
          h('div', { class: 'grow' }, h('input', { type: 'search', id: 'in-filter', placeholder: t('ui.install.searchPlaceholder', { count: preview.items.length }), value: filter, autocomplete: 'off', 'aria-label': t('ui.install.filterAria'), oninput: (e) => ((filter = e.target.value), (shown = PAGE), render()) })),
          h('button', { class: 'btn small', type: 'button', disabled: Boolean(result?.ok), onclick: () => { for (const it of visible.filter(selectable)) picked.add(it.name); render(); } }, filter.trim() ? t('ui.install.selectFound', { count: visible.filter(selectable).length }) : t('ui.install.selectAll')),
          h('button', { class: 'btn small ghost', type: 'button', disabled: !picked.size || Boolean(result?.ok), onclick: () => ((picked = new Set()), render()) }, t('ui.install.selectNone')),
          h('span', { class: 'hint' }, t('ui.install.selectedCount', { count: picked.size })))
      : null;
    const rows = visible.slice(0, shown).map((it) => {
      const col = collision(it);
      const disabled = !it.validName || col === 'own' || Boolean(result?.ok) || wholePackage || (blockedBySpector(it) && !picked.has(it.name));
      const flags = (it.risk?.flags ?? []).filter((x) => x !== 'external');
      const cb = h('input', { type: 'checkbox', id: `pi-${it.kind}-${it.name}`, checked: picked.has(it.name), disabled, 'aria-label': t('ui.install.installItemAria', { name: it.name }), onchange: (e) => {
        e.target.checked ? picked.add(it.name) : picked.delete(it.name);
        render();
      } });
      return h('div', { class: 'preview-item' },
        cb,
        kindDot({ kind: it.kind, origin: 'external' }),
        h('div', null,
          h('label', { class: 'name', for: cb.id }, it.name, ' ', h('span', { class: 'hint', style: { fontFamily: 'var(--font-body)', fontWeight: '400', fontSize: '13px' } }, it.kind === 'agent' ? t('ui.install.agentKind') : t('ui.install.skillKind'))),
          it.description ? h('div', { class: 'hint', style: { marginTop: '2px' } }, it.description.length > 220 ? it.description.slice(0, 219) + '…' : it.description) : null,
          flags.length ? h('div', { class: 'hint', style: { marginTop: '4px' } }, t('ui.install.signalsFound', { flags: flags.join(', ') })) : null,
          spectorLine(it),
          h('div', { class: 'hint', style: { marginTop: '2px' } }, t('ui.install.inRepo', { path: it.repoPath })),
          !it.validName ? h('div', { class: 'hint', style: { color: 'var(--signal)' } }, t('ui.install.invalidName')) : null,
          result?.ok && picked.has(it.name) ? h('div', { class: 'hint', style: { color: 'var(--ok)' } }, t('ui.install.justInstalled')) : null,
          !(result?.ok && picked.has(it.name)) && col === 'own' ? h('div', { class: 'hint', style: { color: 'var(--signal)' } }, t('ui.install.existsOwn')) : null,
          !(result?.ok && picked.has(it.name)) && col === 'external' ? h('div', { class: 'hint', style: { color: 'var(--amber)' } }, t('ui.install.existsExternal')) : null),
        h('div', { class: 'side' }, riskBadge(it.risk?.risk, it.risk?.flags)));
    });
    return h('div', null,
      h('div', { class: 'hint', style: { marginBottom: '8px' } }, t('ui.install.fromCommit', { repo: src.repo, ref: src.ref ? ` @ ${src.ref}` : '' }), h('code', null, String(src.commit).slice(0, 7)), ghUrl ? [' · ', h('a', { href: ghUrl, target: '_blank', rel: 'noopener noreferrer' }, t('ui.install.openOnGithub'))] : null),
      pkgBox,
      tools,
      h('div', { class: 'rows' }, rows),
      !visible.length ? h('div', { class: 'empty' }, t('ui.install.noMatches')) : null,
      visible.length > shown ? h('div', { class: 'toolbar', style: { marginTop: '10px' } }, h('button', { class: 'btn small', type: 'button', onclick: () => ((shown += PAGE), render()) }, t('ui.install.showMore', { n: Math.min(PAGE, visible.length - shown) })), h('span', { class: 'hint' }, t('ui.install.showingOf', { shown, total: visible.length }))) : null);
  }

  function renderSecurity() {
    const pol = policy();
    const chosen = preview.items.filter((i) => picked.has(i.name));
    const toScan = chosen.filter((i) => !i.spector);
    const modeLabel = MODE_LABEL()[pol.mode] ?? pol.mode;
    const head = h('div', { class: 'hint' }, icon('shield', 15), ' NVIDIA SkillSpector: ', h('strong', null, modeLabel),
      pol.mode === 'off' ? t('ui.install.noAnalysisNotice') : pol.available ? `${pol.version ? t('ui.install.spektorVersion', { version: pol.version }) : ''}${pol.llm ? t('ui.install.spektorWithAi') : ''}` : t('ui.install.spectorNotInstalled'),
      ' — ', h('a', { href: '#/settings' }, t('ui.install.changeInSettings')));
    if (pol.mode !== 'off' && !pol.available) {
      return h('div', { class: 'stack' }, head, h('div', { class: `banner ${pol.mode === 'block' ? 'warn' : 'caution'}` }, icon('warn'), h('div', null,
        pol.mode === 'block' ? h('strong', null, t('ui.install.blockedNoScanner')) : h('strong', null, t('ui.install.skillsNotScanned')),
        t('ui.install.installWithSetup'))));
    }
    if (!pol.available) return head;
    const tooMany = chosen.length > MAX_SCAN;
    return h('div', { class: 'stack' }, head,
      h('div', { class: 'toolbar', style: { margin: 0 } },
        h('button', { class: 'btn', type: 'button', disabled: scanning || !chosen.length || tooMany || !toScan.length || Boolean(result), onclick: doScan }, icon('shield', 16),
          scanning ? t('ui.install.analyzing') : toScan.length < chosen.length && toScan.length ? t('ui.install.analyzeRemaining', { count: toScan.length }) : chosen.length && !toScan.length ? t('ui.install.alreadyAnalyzed') : t('ui.install.analyzeSelected')),
        h('span', { class: 'hint' }, tooMany ? t('ui.install.maxScanHint', { max: MAX_SCAN }) : t('ui.install.optionalScanHint'))));
  }

  function renderAssign() {
    const chosen = preview.items.filter((i) => picked.has(i.name));
    const hasSkill = chosen.some((i) => i.kind === 'skill');
    const agents = store.state.agents;
    const blocks = [];
    if (hasSkill) {
      const radio = (value, label, hint, disabled = false) => h('label', { class: 'check' }, h('input', { type: 'radio', name: 'assign', value, checked: assignMode === value, disabled, onchange: () => ((assignMode = value), render()) }), h('span', null, h('strong', null, label), h('div', { class: 'hint' }, hint)));
      blocks.push(h('div', { class: 'field' }, h('div', { class: 'label' }, t('ui.install.whereToAssign')),
        radio('global', t('ui.install.assignGlobal'), t('ui.install.assignGlobalHint')),
        radio('agents', t('ui.install.assignAgents'), agents.length ? t('ui.install.assignAgentsHint') : t('ui.install.noAgentsHint'), !agents.length)));
      if (assignMode === 'agents' && agents.length) {
        blocks.push(h('div', { class: 'chips', role: 'group', 'aria-label': t('ui.install.agentsGroup') }, agents.map((a) => h('button', { type: 'button', class: 'chip', 'aria-pressed': String(agentsPicked.has(a.name)), onclick: () => ((agentsPicked.has(a.name) ? agentsPicked.delete(a.name) : agentsPicked.add(a.name)), render()) }, a.name))));
      }
    }
    blocks.push(h('div', { class: 'field' }, h('div', { class: 'label' }, t('ui.install.categoriesLabel')), h('div', { class: 'chips', role: 'group', 'aria-label': t('ui.install.categoriesGroup') }, Object.entries(store.state.categories).map(([id, c]) => h('button', { type: 'button', class: 'chip', 'aria-pressed': String(cats.has(id)), onclick: () => ((cats.has(id) ? cats.delete(id) : cats.add(id)), render()) }, c.label))), h('div', { class: 'hint' }, cats.size ? '' : t('ui.install.categoriesHint'))));
    if (chosen.some((i) => collision(i) === 'external')) {
      blocks.push(h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: force, onchange: (e) => ((force = e.target.checked), render()) }), h('span', null, t('ui.install.replaceExisting'))));
    }
    return h('div', { class: 'stack' }, ...blocks);
  }

  function renderConfirm() {
    const chosen = preview.items.filter((i) => picked.has(i.name));
    const high = chosen.filter((i) => i.risk?.risk === 'high');
    const n = chosen.length;
    const pol = policy();
    const spectorBlocked = chosen.filter(blockedBySpector);
    const noScanner = pol.mode === 'block' && !pol.available;
    const blocked = (chosen.some((i) => collision(i) === 'external') && !force) || spectorBlocked.length > 0 || noScanner || n > MAX_INSTALL || !n;
    return h('div', { class: 'stack' },
      high.length ? h('div', { class: 'banner warn' }, icon('warn'), h('div', null, h('strong', null, t.n('ui.install.highRiskNotice', high.length, { names: high.map((i) => i.name).join(', ') })), t('ui.install.highRiskDisclaimer'))) : null,
      h('div', { class: 'toolbar', style: { margin: 0 } },
        h('button', { class: 'btn primary', type: 'button', disabled: !n || installing || blocked, onclick: doInstall }, icon('install', 16), installing ? t('ui.install.installing') : t.n('ui.install.installCount', n, { count: n })),
        h('span', { class: 'hint' }, pol.mode !== 'off' ? t('ui.install.policyHintOn') : t('ui.install.policyHintOff'))),
      chosen.some((i) => collision(i) === 'external') && !force ? h('div', { class: 'hint' }, t('ui.install.checkReplaceHint')) : null,
      spectorBlocked.length ? h('div', { class: 'hint', style: { color: 'var(--signal)' } }, t('ui.install.spectorBlocksHint', { names: spectorBlocked.map((i) => i.name).join(', ') })) : null,
      n > MAX_INSTALL ? h('div', { class: 'hint' }, t('ui.install.maxInstallLimit', { max: MAX_INSTALL, count: n })) : null);
  }

  function renderResult() {
    return h('div', { class: 'stack' },
      h('div', { class: `banner ${result.ok ? 'ok' : 'warn'}`, role: result.ok ? 'status' : 'alert' }, icon(result.ok ? 'check' : 'warn'), h('div', null, result.ok ? h('strong', null, t('ui.install.successTitle')) : h('strong', null, t('ui.install.failureNotice')), result.ok ? t('ui.install.successHint') : '')),
      result.output ? h('pre', { class: 'pre' }, result.output) : null,
      result.ok
        ? h('div', { class: 'toolbar', style: { margin: 0 } },
            h('button', { class: 'btn primary', type: 'button', onclick: doSync }, icon('refresh', 16), t('ui.install.syncWithClaude')),
            h('button', { class: 'btn', type: 'button', onclick: () => ctx.navigate('graph') }, t('ui.install.viewInGraph')),
            h('button', { class: 'btn ghost', type: 'button', onclick: () => ((preview = null), (result = null), (syncOut = null), (form.source = ''), render()) }, t('ui.install.installAnother')))
        : h('div', { class: 'toolbar', style: { margin: 0 } }, h('button', { class: 'btn', type: 'button', onclick: () => ((result = null), render()) }, t('ui.install.goBack'))),
      syncOut ? h('pre', { class: 'pre' }, syncOut.output) : null);
  }

  // approval status (server recomputes hashes): re-requested whenever catalog changes
  function loadApprovals() {
    const key = store.state?.fingerprint;
    if (!key || approvalsFor === key) return;
    approvalsFor = key;
    api.approvals().then((r) => {
      approvals = new Map(r.items.map((x) => [`${x.kind}:${x.name}`, x]));
      render();
    }, () => {});
  }

  const APPROVAL = () => ({
    approved: ['ok', t('ui.install.approval.approved')],
    'review-pending': ['medium', t('ui.install.approval.reviewPending')],
    'hash-mismatch': ['high', t('ui.install.approval.hashMismatch')],
    missing: ['high', t('ui.install.approval.missing')],
    unregistered: ['medium', t('ui.install.approval.unregistered')],
  });
  function approvalBadge(e) {
    const st = approvals?.get(e.id)?.status ?? e.approval;
    const [tone, label] = APPROVAL()[st] ?? [];
    return label ? h('span', { class: `badge ${tone}`, title: approvals?.get(e.id)?.reason ?? (st === 'unregistered' ? t('ui.install.approvalUnregHint') : '') }, icon('shield', 13), label) : null;
  }

  function renderInstalled() {
    clear(installed);
    const st = store.state;
    loadApprovals();
    const ext = [...st.skills, ...st.agents].filter((e) => e.origin === 'external').sort((a, b) => a.name.localeCompare(b.name));
    if (!ext.length) {
      installed.append(h('div', { class: 'empty' }, h('strong', null, t('ui.install.noExternalYet')), t('ui.install.noExternalHint')));
      return;
    }
    installed.append(h('div', { class: 'toolbar' }, h('button', { class: 'btn', type: 'button', onclick: () => updateItems([]) }, icon('refresh', 16), t('ui.install.updateAll')), h('span', { class: 'hint' }, t('ui.install.localChangesKept'))));
    const grid = h('div', { class: 'installed-grid' });
    for (const e of ext) {
      const lock = st.lock.find((x) => x.kind === e.kind && x.name === e.name);
      const src = lock?.source ?? e.source;
      grid.append(h('div', null,
        kindDot(e),
        h('div', null,
          h('div', { class: 'name', style: { font: '600 16px var(--font-display)' } }, e.name, ' ', riskBadge(e.risk, e.flags), ' ', approvalBadge(e)),
          h('div', { class: 'hint' }, src?.repo ? `${src.repo}${src.commit ? ` · ${String(src.commit).slice(0, 7)}` : ''}${e.package ? t('ui.install.packageTag', { name: e.package }) : ''}` : t('ui.install.unknownSource')),
          h('div', { class: 'hint' }, e.kind === 'agent' ? t('ui.install.agentKind') : e.scope === 'assigned' ? t('ui.install.assignedTo', { names: e.assignedTo.join(', ') }) : t('ui.install.generic'))),
        h('div', { class: 'side', style: { display: 'flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end' } },
          h('button', { class: 'btn small', type: 'button', onclick: () => ctx.select(e.id) }, t('ui.install.details')),
          ['review-pending', 'hash-mismatch'].includes(approvals?.get(e.id)?.status ?? e.approval)
            ? h('button', { class: 'btn small', type: 'button', title: t('ui.install.analyzeApproveTitle'), onclick: () => approveItem(e) }, icon('shield', 15), t('ui.install.analyzeAndApprove'))
            : null,
          h('button', { class: 'btn small', type: 'button', onclick: () => updateItems([e.name]) }, icon('refresh', 15), t('ui.install.update')),
          h('button', { class: 'btn small danger', type: 'button', 'aria-label': t('ui.install.removeAria', { name: e.name }), onclick: () => removeItem(e) }, icon('trash', 15)))));
    }
    installed.append(grid);
  }

  let rendering = false;
  function render() {
    if (!store.state || rendering) return;
    rendering = true;
    try {
      draw();
    } catch (e) {
      console.error(e);
      clear(wizard);
      wizard.append(h('div', { class: 'banner warn', role: 'alert' }, icon('warn'), h('div', null, t('ui.install.drawError'), e.message)));
    } finally {
      rendering = false;
    }
  }

  function draw() {
    const active = document.activeElement;
    const activeId = active && el.contains(active) ? active.id : null;
    const selStart = active?.selectionStart;
    clear(wizard);
    const steps = [step(1, t('ui.install.step1'), renderForm())];
    if (preview) {
      steps.push(step(2, t('ui.install.step2'), renderItems()));
      steps.push(step(3, t('ui.install.step3'), renderSecurity()));
      steps.push(step(4, t('ui.install.step4'), result ? renderResult() : h('div', { class: 'stack' }, renderAssign(), renderConfirm())));
    }
    wizard.append(...steps);
    renderInstalled();
    if (activeId) {
      const n = document.getElementById(activeId);
      if (n) {
        n.focus();
        if (selStart != null) n.setSelectionRange?.(selStart, selStart);
      }
    }
  }

  return {
    el,
    update() {
      render();
    },
    destroy() {},
  };
}
