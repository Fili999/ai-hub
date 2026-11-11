// Create: step-by-step wizard to author a skill or agent without starting from an empty file.
// The form fields produce the Markdown file (generated and validated by the server); select folder and save.
import { h, clear, icon, debounce } from '../dom.js';
import { api } from '../api.js';
import { store } from '../store.js';
import { confirmDialog, toast } from '../ui.js';
import { t } from '../i18n.js';
import { LAST_STEP, STEP_LABELS, canCreate, combinedLength, descriptionTone, emptyDraft, fmtInt, hasContent, restoreDraft, slugify, stepOfField, stepStatus, switchKind, toPayload } from '../create-model.js';
import { checkList, counterFor, createBoard, fieldBox, nextId, textArea, tokenField } from '../create-fields.js';

const STORE_KEY = 'hub-create-draft';
const PREVIEW_LINES = 220;
// draft survives view switching (module variable) and, when browser allows, page reload
const memory = { draft: null, step: 0, tried: false };

function readSaved() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    const draft = restoreDraft(data);
    return draft && hasContent(draft) ? { draft, step: Number.isInteger(data._step) ? Math.min(Math.max(data._step, 0), LAST_STEP - 1) : 1 } : null;
  } catch {
    return null;
  }
}
function writeSaved(draft, step) {
  try {
    if (!hasContent(draft)) localStorage.removeItem(STORE_KEY);
    else localStorage.setItem(STORE_KEY, JSON.stringify({ ...draft, _step: step }));
    return true;
  } catch {
    return false; // private browsing mode or draft too large: in-memory copy remains while tab is open
  }
}
const clearSaved = () => {
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    /* nothing to clear */
  }
};

/** Like append(), but skips empty values (native append() turns null into string "null"). */
const put = (el, ...kids) => {
  for (const k of kids.flat(Infinity)) if (k !== null && k !== undefined && k !== false) el.append(k);
  return el;
};

export default function create(ctx) {
  let restored = false;
  if (!memory.draft && !memory.tried) {
    memory.tried = true;
    const saved = readSaved();
    if (saved) {
      memory.draft = saved.draft;
      memory.step = saved.step;
      restored = true;
    }
  }
  let d = memory.draft ?? emptyDraft('skill');
  let step = memory.draft ? memory.step : 0;
  if (!memory.draft) d.kind = null;
  let options = null;
  let preview = null;
  let pending = false;
  let previewError = '';
  let seq = 0;
  let creating = false;
  let result = null;
  let savedOk = true;
  let lastFp = store.state?.fingerprint;
  let optionsKey = '';
  let saveRefs = null;
  let saveReady = false; // Save step only renders with a fresh preview

  const board = createBoard();
  const body = h('div', { class: 'wizard-main' });
  const aside = h('aside', { class: 'wizard-side', 'aria-label': t('ui.create.previewAria') });
  const stepsNav = h('nav', { class: 'steps', 'aria-label': t('ui.create.stepPillsAria') });
  const notice = h('div', { class: 'wizard-notice' });
  const wizard = h('div', { class: 'wizard' }, body, aside);
  const el = h('div', { class: 'page wide create' }, h('div', { class: 'page-head' }, h('div', null, h('h1', null, t('ui.create.title')), h('p', null, t('ui.create.intro')))), notice, stepsNav, wizard);

  // ------------------------------------------------------------ state and preview
  const persist = debounce(() => {
    if (result) return;
    savedOk = writeSaved(d, step);
    paintNotice();
  }, 500);
  const remember = () => {
    if (result) return;
    memory.draft = d.kind ? d : null;
    memory.step = step;
    persist();
  };

  async function runPreview() {
    if (!d.kind) return;
    const mine = ++seq;
    pending = true;
    paintAside();
    try {
      const r = await api.createPreview(toPayload(d));
      if (mine !== seq) return;
      preview = r;
      previewError = '';
    } catch (e) {
      if (mine !== seq) return;
      previewError = e.message;
    }
    pending = false;
    saveReady = true;
    afterPreview();
  }
  const schedulePreview = debounce(runPreview, 450);

  /** Invoked by each field when anything changes. */
  function changed(field) {
    if (field) board.touch(field);
    pending = true;
    remember();
    paintAside();
    paintSteps();
    paintSave();
    schedulePreview();
  }

  function afterPreview() {
    if (step === LAST_STEP && !saveRefs) renderStep();
    board.setIssues(preview?.issues ?? []);
    paintSteps();
    paintAside();
    paintSuggestion();
    paintSave();
  }

  async function loadOptions() {
    try {
      options = await api.createOptions();
      optionsKey = JSON.stringify([options.agents.map((a) => a.id), options.skills.map((s) => s.id)]);
    } catch (e) {
      options = null;
      toast(e.message, 'error');
    }
    if (d.kind && step > 0 && step < LAST_STEP) renderStep();
  }

  // ------------------------------------------------------------ navigazione
  function go(n) {
    if (n !== 0 && !d.kind) return;
    const leaving = step;
    step = Math.min(Math.max(n, 0), LAST_STEP);
    memory.step = step;
    if (leaving !== step) for (const f of board.slots.keys()) if (stepOfField(f) === leaving) board.touched.add(f);
    board.showAll = step === LAST_STEP;
    if (step === LAST_STEP) saveReady = false;
    renderStep();
    remember();
    el.scrollIntoView?.({ block: 'start' });
    document.getElementById('view')?.scrollTo?.({ top: 0 });
    if (step === LAST_STEP || !preview) runPreview();
  }

  function paintSteps() {
    clear(stepsNav);
    if (result) return;
    const status = stepStatus(preview?.issues);
    STEP_LABELS.forEach((key, i) => {
      const label = t(key);
      const st = status[i];
      const seen = d.kind && (i < step || step === LAST_STEP);
      const bad = seen && st.errors > 0;
      const warn = seen && !bad && st.warns > 0;
      const toFixLabel = t.n('ui.create.toFix', st.errors, { n: st.errors });
      const warnLabel = t.n('ui.create.warnCount', st.warns, { n: st.warns });
      stepsNav.append(
        h(
          'button',
          { type: 'button', class: `step-pill ${i === step ? 'on' : ''} ${bad ? 'has-error' : ''} ${warn ? 'has-warn' : ''}`, 'aria-current': i === step ? 'step' : undefined, disabled: i > 0 && !d.kind, onclick: () => go(i) },
          h('span', { class: 'n' }, String(i + 1)),
          h('span', { class: 'lbl' }, label),
          bad ? h('span', { class: 'dot', title: toFixLabel, role: 'img', 'aria-label': toFixLabel }) : warn ? h('span', { class: 'dot', title: warnLabel, role: 'img', 'aria-label': warnLabel }) : null,
        ),
      );
    });
  }

  function paintNotice() {
    clear(notice);
    if (restored && d.kind && !result) {
      notice.append(
        h(
          'div',
          { class: 'banner' },
          icon('info', 18),
          h('div', { class: 'grow' }, t('ui.create.resumedDraft')),
          h('button', { type: 'button', class: 'btn small', onclick: () => startOver(true) }, t('ui.create.startOver')),
        ),
      );
    }
    if (!savedOk && d.kind && !result) notice.append(h('div', { class: 'banner caution' }, icon('warn', 18), h('div', null, t('ui.create.browserCannotSaveDraft'))));
    if (d.kind && d.markdown !== null && step < LAST_STEP && !result) {
      notice.append(
        h(
          'div',
          { class: 'banner caution' },
          icon('edit', 18),
          h('div', { class: 'grow' }, t('ui.create.fileModifiedNotice')),
          h('button', { type: 'button', class: 'btn small', onclick: () => regenerate() }, t('ui.create.regenerateFromFields')),
        ),
      );
    }
  }

  async function startOver(ask = false) {
    if (ask && hasContent(d)) {
      const ok = await confirmDialog({ title: t('ui.create.startOverConfirmTitle'), body: h('p', null, t('ui.create.startOverConfirmBody')), confirmLabel: t('ui.create.startOverConfirmBtn'), danger: true });
      if (!ok) return;
    }
    d = emptyDraft('skill');
    d.kind = null;
    memory.draft = null;
    memory.step = 0;
    clearSaved();
    restored = false;
    preview = null;
    result = null;
    board.touched.clear();
    board.showAll = false;
    board.byField = new Map();
    step = 0;
    renderStep();
    paintNotice();
  }

  function regenerate() {
    d.markdown = null;
    remember();
    paintNotice();
    runPreview();
    if (step === LAST_STEP) renderStep();
  }

  // ------------------------------------------------------------ costruzione dei passi
  function renderStep() {
    board.reset();
    clear(body);
    paintSteps();
    paintNotice();
    wizard.classList.toggle('single', step === 0 || step === LAST_STEP || Boolean(result));
    if (result) return renderResult();
    if (step === 0) body.append(stepType());
    else if (step === 1) body.append(stepIdentity());
    else if (step === 2) body.append(stepContent());
    else if (step === 3) body.append(stepSettings());
    else body.append(stepSave());
    if (step > 0 && step < LAST_STEP) body.append(navButtons());
    paintAside();
    if (preview) board.setIssues(preview.issues);
  }

  const navButtons = () =>
    h(
      'div',
      { class: 'wizard-nav' },
      h('button', { type: 'button', class: 'btn', onclick: () => go(step - 1) }, t('ui.create.back')),
      h('span', { class: 'grow' }),
      h('button', { type: 'button', class: 'btn primary', onclick: () => go(step + 1) }, step === LAST_STEP - 1 ? t('ui.create.chooseWhereToSave') : t('ui.create.next')),
    );

  const section = (title, intro, ...kids) => h('section', { class: 'form-sec' }, h('h2', null, title), intro ? h('p', { class: 'hint' }, intro) : null, ...kids);

  const text = (label, field, { rows = 3, hint, placeholder, required = false, mono = false, counter = true } = {}) => {
    const id = nextId(field);
    const ta = textArea({
      id,
      value: d[field],
      rows,
      placeholder,
      mono,
      describedBy: hint ? `${id}-hint` : undefined,
      onInput: (v) => {
        d[field] = v;
        changed(field);
      },
    });
    return fieldBox(board, { id, label, hint, field, control: ta, required, foot: counter ? counterFor(ta) : null });
  };

  // ---- step 1: skill or agent
  function stepType() {
    const card = (kind, title, what, example) =>
      h(
        'button',
        { type: 'button', class: `kind-card ${kind} ${d.kind === kind ? 'on' : ''}`, 'aria-pressed': String(d.kind === kind), onclick: () => choose(kind) },
        h('span', { class: `shape ${kind}`, 'aria-hidden': 'true' }),
        h('strong', null, title),
        h('span', { class: 'what' }, what),
        h('span', { class: 'hint' }, example),
      );
    return h(
      'div',
      { class: 'stack' },
      section(t('ui.create.typeTitle'), t('ui.create.typeIntro')),
      h(
        'div',
        { class: 'kind-cards' },
        card('skill', t('ui.create.aSkill'), t('ui.create.skillWhat'), t('ui.create.skillExample')),
        card('agent', t('ui.create.anAgent'), t('ui.create.agentWhat'), t('ui.create.agentExample')),
      ),
      d.kind ? h('p', null, h('button', { type: 'button', class: 'btn primary', onclick: () => go(1) }, t('ui.create.continue'))) : null,
    );
  }

  function choose(kind) {
    d = switchKind(d, kind);
    memory.draft = d;
    preview = null;
    remember();
    runPreview();
    go(1);
  }

  // ---- step 2: identity
  function stepIdentity() {
    const nameId = nextId('name');
    const nameIn = h('input', { type: 'text', id: nameId, class: 'mono', value: d.name, placeholder: d.kind === 'skill' ? 'reel-editing' : 'social-manager', autocomplete: 'off', spellcheck: 'false', maxlength: 64, 'aria-describedby': `${nameId}-hint` });
    const titleId = nextId('title');
    const titleIn = h('input', { type: 'text', id: titleId, value: d.title, placeholder: d.kind === 'skill' ? 'Reel editing' : 'Channel social manager', autocomplete: 'off', maxlength: 160 });
    titleIn.addEventListener('input', () => {
      d.title = titleIn.value;
      if (!d.nameTouched) {
        d.name = slugify(titleIn.value);
        nameIn.value = d.name;
        board.touch('name');
      }
      changed('title');
    });
    nameIn.addEventListener('input', () => {
      const fixed = nameIn.value.toLowerCase().replace(/\s+/g, '-');
      if (fixed !== nameIn.value) nameIn.value = fixed;
      d.name = fixed;
      d.nameTouched = fixed !== '';
      changed('name');
    });

    const descId = nextId('description');
    const descCounter = h('span', { class: 'counter' });
    const paintDesc = () => {
      const tDesc = descriptionTone(combinedLength(d));
      descCounter.textContent = tDesc.text;
      descCounter.dataset.tone = tDesc.tone;
    };
    const desc = textArea({
      id: descId,
      value: d.description,
      rows: 3,
      placeholder: t(d.kind === 'skill' ? 'ui.create.descPlaceholder.skill' : 'ui.create.descPlaceholder.agent'),
      describedBy: `${descId}-hint`,
      onInput: (v) => {
        d.description = v;
        paintDesc();
        changed('description');
      },
    });
    const enId = nextId('descen');
    const en = textArea({
      id: enId,
      value: d.descriptionEn,
      rows: 2,
      placeholder: 'Edits a vertical reel from raw clips. Use it when I need a short vertical video.',
      describedBy: `${enId}-hint`,
      onInput: (v) => {
        d.descriptionEn = v;
        paintDesc();
        changed('description');
      },
    });
    paintDesc();

    return h(
      'div',
      { class: 'stack' },
      section(d.kind === 'agent' ? t('ui.create.identityTitleAgent') : t('ui.create.identityTitleSkill'), null),
      fieldBox(board, { id: titleId, label: t('ui.create.titleLabel'), hint: t('ui.create.titleHint'), field: 'title', control: titleIn }),
      fieldBox(board, { id: nameId, label: t('ui.create.nameLabel'), hint: d.kind === 'agent' ? t('ui.create.nameHintAgent') : t('ui.create.nameHintSkill'), field: 'name', control: nameIn, required: true }),
      text(t('ui.create.goalLabel'), 'goal', { rows: 3, hint: d.kind === 'skill' ? t('ui.create.goalHintSkill') : t('ui.create.goalHintAgent'), placeholder: d.kind === 'skill' ? t('ui.create.goalPlaceholderSkill') : t('ui.create.goalPlaceholderAgent') }),
      d.kind === 'agent' ? text(t('ui.create.roleLabel'), 'role', { rows: 3, hint: t('ui.create.roleHint'), placeholder: t('ui.create.rolePlaceholder') }) : null,
      fieldBox(board, { id: descId, label: t('ui.create.descLabel'), hint: d.kind === 'agent' ? t('ui.create.descHintAgent') : t('ui.create.descHintSkill'), field: 'description', control: desc, required: true, foot: descCounter }),
      fieldBox(board, { id: enId, label: t('ui.create.descEnLabel'), hint: t('ui.create.descEnHint'), control: en }),
    );
  }

  // ---- step 3: content
  function stepContent() {
    const bigHint = h('div', { class: 'banner' }, icon('info', 18), h('div', null, h('strong', null, t('ui.create.bigHintTitle')), t('ui.create.bigHintBody')));
    const fields =
      d.kind === 'skill'
        ? [
            text(t('ui.create.whenToUseLabel'), 'whenToUse', { rows: 4, hint: t('ui.create.whenToUseHint'), placeholder: 'When editing a reel from raw clips\nWhen requested to make a vertical video under 60 seconds\nDo not use for long-form YouTube videos' }),
            text(t('ui.create.procedureLabel'), 'procedure', { rows: 8, hint: t('ui.create.procedureHint'), placeholder: 'Review clips and audio\nTrim pauses and dead air\nAdd subtitles\nExport at 1080x1920' }),
            text(t('ui.create.outputLabel'), 'output', { rows: 3, hint: t('ui.create.outputHint'), placeholder: 'A vertical 1080x1920 mp4 file and a list of edits performed' }),
            text(t('ui.create.cautionsLabel'), 'cautions', { rows: 3, hint: t('ui.create.cautionsHint'), placeholder: 'Do not publish anything without confirmation\nDo not delete original clips' }),
          ]
        : [
            text(t('ui.create.howItWorksLabel'), 'howItWorks', { rows: 10, hint: t('ui.create.howItWorksHint'), placeholder: t('ui.create.howItWorksPlaceholder') }),
            text(t('ui.create.limitsLabel'), 'limits', { rows: 4, hint: t('ui.create.limitsHint'), placeholder: 'Do not publish, send, or delete anything without explicit confirmation\nDo not fabricate statistics: state clearly if data is missing' }),
          ];
    const extra = h('div', { class: 'extras' });
    const paintExtra = () => {
      clear(extra);
      d.sections.forEach((s, i) => {
        const tId = nextId('sec-t');
        const bId = nextId('sec-b');
        const tInput = h('input', { type: 'text', id: tId, value: s.title, placeholder: t('ui.create.sectionTitlePlaceholder'), maxlength: 120, 'aria-label': t('ui.create.sectionTitleAria', { n: i + 1 }) });
        tInput.addEventListener('input', () => {
          s.title = tInput.value;
          changed();
        });
        const b = textArea({
          id: bId,
          value: s.body,
          rows: 5,
          placeholder: t('ui.create.sectionBodyPlaceholder'),
          onInput: (v) => {
            s.body = v;
            changed();
          },
        });
        b.setAttribute('aria-label', t('ui.create.sectionBodyAria', { n: i + 1 }));
        extra.append(
          h(
            'div',
            { class: 'extra' },
            h('div', { class: 'extra-head' }, tInput, h('button', { type: 'button', class: 'btn ghost small', 'aria-label': t('ui.create.removeSectionAria', { n: i + 1 }), onclick: () => ((d.sections = d.sections.filter((x) => x !== s)), paintExtra(), changed()) }, icon('trash', 16), t('ui.create.removeSection'))),
            b,
            h('div', { class: 'field-foot' }, counterFor(b)),
          ),
        );
      });
    };
    paintExtra();
    return h(
      'div',
      { class: 'stack' },
      section(d.kind === 'skill' ? t('ui.create.contentTitleSkill') : t('ui.create.contentTitleAgent'), null),
      bigHint,
      ...fields,
      section(t('ui.create.otherSectionsTitle'), t('ui.create.otherSectionsHint'), extra, h('p', null, h('button', { type: 'button', class: 'btn', onclick: () => ((d.sections = [...d.sections, { title: '', body: '' }]), paintExtra(), changed(), extra.querySelector('.extra:last-child input')?.focus()) }, icon('plus', 16), t('ui.create.addSection')))),
    );
  }

  // ---- step 4: settings
  const toggleIn = (list, v, on) => (on ? [...new Set([...list, v])] : list.filter((x) => x !== v));
  const catHint = h('div', { class: 'suggest' });

  function stepSettings() {
    if (!options) return h('p', { class: 'hint' }, t('ui.create.loadingChoices'));
    const parts = [];

    // modello ed effort
    const known = new Set(options.models.map((m) => m.id));
    const customModel = d.model && !known.has(d.model);
    const modelId = nextId('model');
    const modelSel = h('select', { id: modelId }, options.models.map((m) => h('option', { value: m.id }, m.label)), h('option', { value: '__custom' }, t('ui.create.otherModel')));
    modelSel.value = customModel ? '__custom' : d.model;
    const customIn = h('input', { type: 'text', class: 'mono', placeholder: 'claude-sonnet-5-5', value: customModel ? d.model : '', autocomplete: 'off', spellcheck: 'false', 'aria-label': t('ui.create.fullModelIdAria'), hidden: !customModel });
    const modelHint = h('p', { class: 'hint' });
    const paintModel = () => {
      customIn.hidden = modelSel.value !== '__custom';
      modelHint.textContent = modelSel.value === '__custom' ? t('ui.create.customModelHint') : (options.models.find((m) => m.id === modelSel.value)?.hint ?? '');
    };
    modelSel.addEventListener('change', () => {
      d.model = modelSel.value === '__custom' ? customIn.value.trim() : modelSel.value;
      paintModel();
      changed('model');
      if (modelSel.value === '__custom') customIn.focus();
    });
    customIn.addEventListener('input', () => {
      d.model = customIn.value.trim();
      changed('model');
    });
    const effId = nextId('effort');
    const effSel = h('select', { id: effId }, options.efforts.map((m) => h('option', { value: m.id }, m.label)));
    effSel.value = d.effort;
    const effHint = h('p', { class: 'hint' });
    const paintEffort = () => (effHint.textContent = options.efforts.find((m) => m.id === effSel.value)?.hint ?? '');
    effSel.addEventListener('change', () => {
      d.effort = effSel.value;
      paintEffort();
      changed('effort');
    });
    paintModel();
    paintEffort();
    // a selector "same as session / list / custom ID" for the other AI systems (Codex, Antigravity CLI, OpenCode)
    const toolPicker = (tool, kind) => {
      const list = kind === 'model' ? tool.models : tool.efforts;
      const store = kind === 'model' ? d.toolModels : d.toolEfforts;
      const cur = store[tool.id] ?? '';
      const custom = cur && !list.includes(cur);
      const id = nextId(`${kind}-${tool.id}`);
      const sel = h('select', { id }, h('option', { value: '' }, t('ui.create.session')), list.map((x) => h('option', { value: x }, x)), kind === 'model' ? h('option', { value: '__custom' }, t('ui.create.customId')) : null);
      sel.value = custom ? '__custom' : cur;
      // only model has "Custom: enter ID"; an unlisted effort remains valid but is configured via providers.json
      const input = kind === 'model' ? h('input', { type: 'text', class: 'mono', placeholder: tool.id === 'opencode' ? 'ollama/qwen3:30b' : 'model-id', value: custom ? cur : '', autocomplete: 'off', spellcheck: 'false', 'aria-label': t('ui.create.customIdLabel', { tool: tool.name }), hidden: !custom }) : null;
      if (!input && custom) sel.append(h('option', { value: cur }, cur));
      if (!input) sel.value = cur;
      const set = (v) => {
        if (v) store[tool.id] = v;
        else delete store[tool.id];
        changed(kind === 'model' ? 'toolModels' : 'toolEfforts');
      };
      sel.addEventListener('change', () => {
        if (input) input.hidden = sel.value !== '__custom';
        set(sel.value === '__custom' ? (input?.value.trim() ?? '') : sel.value);
        if (sel.value === '__custom') input?.focus();
      });
      input?.addEventListener('input', () => set(input.value.trim()));
      return fieldBox(board, { id, label: t(kind === 'model' ? 'ui.create.toolModel' : 'ui.create.toolEffort', { tool: tool.name }), field: kind === 'model' ? 'toolModels' : 'toolEfforts', control: h('div', { class: 'stack tight' }, sel, input) });
    };
    const tierSelect = (field, values) => {
      const id = nextId(field);
      const sel = h('select', { id }, h('option', { value: '' }, t('ui.create.session')), values.map((v) => h('option', { value: v }, t(`ui.create.${field}.${v}`))));
      sel.value = d[field];
      sel.addEventListener('change', () => {
        d[field] = sel.value;
        changed(field);
      });
      return fieldBox(board, { id, label: t(`ui.create.${field}`), field, control: sel, hint: t(`ui.create.${field}.hint`) });
    };
    const tools = options.tools ?? [];
    const claudeOn = tools.some((x) => x.id === 'claude');
    const others = tools.filter((x) => x.id !== 'claude');
    if (d.kind === 'agent') {
      parts.push(section(t('ui.create.portable'), t('ui.create.portable.hint'), h('div', { class: 'cols' }, tierSelect('modelTier', options.modelTiers ?? []), tierSelect('effortTier', options.effortTiers ?? []))));
      for (const tool of others) {
        parts.push(section(tool.name, t('ui.create.tool.hint', { tool: tool.name }), h('div', { class: 'cols' }, toolPicker(tool, 'model'), tool.efforts.length ? toolPicker(tool, 'effort') : h('p', { class: 'hint' }, t('ui.create.noEffort', { tool: tool.name })))));
      }
    } else if (others.length) {
      parts.push(h('p', { class: 'hint' }, t('ui.create.skillOtherTools', { tools: others.map((x) => x.name).join(', ') })));
    }
    if (claudeOn || !tools.length) parts.push(
      section(
        tools.length ? t('ui.create.claudeCodeHeader') : (d.kind === 'agent' ? t('ui.create.modelAndEffortAgentTitle') : t('ui.create.modelAndEffortSkillTitle')),
        d.kind === 'agent' ? t('ui.create.modelAndEffortAgentHint') : t('ui.create.modelAndEffortSkillHint'),
        h(
          'div',
          { class: 'cols' },
          fieldBox(board, { id: modelId, label: t('ui.create.modelLabel'), hint: t('ui.create.modelHint'), field: 'model', control: h('div', { class: 'stack tight' }, modelSel, customIn, modelHint) }),
          fieldBox(board, { id: effId, label: t('ui.create.effortLabel'), field: 'effort', control: h('div', { class: 'stack tight' }, effSel, effHint), hint: t('ui.create.effortHint') }),
        ),
      ),
    );

    // strumenti
    const common = options.toolGroups.flatMap((g) => g.tools.map((t) => t.name));
    const toolsBox = h('div', { class: 'stack tight' });
    const paintTools = () => {
      clear(toolsBox);
      const picked = new Set(d.tools);
      const customTools = d.tools.filter((t) => !common.includes(t));
      const off = d.kind === 'agent' && d.toolsMode === 'all';
      const same = (a) => a.length === picked.size && a.every((x) => picked.has(x)) && !customTools.length;
      const presetBtn = (label, tools) => h('button', { type: 'button', class: 'chip', 'aria-pressed': String(!off && same(tools)), disabled: off, onclick: () => ((d.tools = [...tools]), paintTools(), changed('tools')) }, label);
      put(
        toolsBox,
        d.kind === 'agent'
          ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: off, onchange: (e) => ((d.toolsMode = e.target.checked ? 'all' : 'list'), paintTools(), changed('tools')) }), h('span', null, t('ui.create.leaveAllTools'), h('em', { class: 'hint' }, t('ui.create.leaveAllToolsWarn'))))
          : null,
        h('div', { class: 'chips', role: 'group', 'aria-label': t('ui.create.quickPicks') }, [...options.toolPresets.map((p) => presetBtn(p.label, p.tools)), presetBtn(t('ui.create.none'), [])]),
        h(
          'fieldset',
          { class: 'tool-groups', disabled: off },
          h('legend', { class: 'sr-only' }, t('ui.create.toolsLegend')),
          options.toolGroups.map((g) =>
            h(
              'div',
              { class: 'tool-group' },
              h('strong', null, g.label),
              g.tools.map((tItem) => {
                const cb = h('input', { type: 'checkbox', checked: picked.has(tItem.name) });
                cb.addEventListener('change', () => {
                  d.tools = toggleIn(d.tools, tItem.name, cb.checked);
                  paintTools();
                  changed('tools');
                });
                return h('label', { class: 'check' }, cb, h('code', null, tItem.name), h('span', { class: 'hint' }, tItem.hint));
              }),
            ),
          ),
        ),
        h(
          'div',
          { class: 'field' },
          h('label', { for: 'tools-extra' }, t('ui.create.otherToolsLabel')),
          h('p', { class: 'hint' }, t('ui.create.otherToolsHint')),
          tokenField({
            id: 'tools-extra',
            values: customTools,
            label: t('ui.create.otherToolsLabel'),
            placeholder: t('ui.create.typeAndEnter'),
            onChange: (list) => {
              d.tools = [...d.tools.filter((t) => common.includes(t)), ...list];
              changed('tools');
            },
          }),
        ),
      );
    };
    paintTools();
    parts.push(
      section(
        d.kind === 'agent' ? t('ui.create.toolsAgentTitle') : t('ui.create.toolsSkillTitle'),
        d.kind === 'agent' ? t('ui.create.toolsAgentHint') : t('ui.create.toolsSkillHint'),
        fieldBox(board, { id: 'tools-extra', label: '', field: 'tools', control: toolsBox }),
      ),
    );

    // categorie
    const catBox = h('div', { class: 'chips', role: 'group', 'aria-label': t('ui.create.categoryTitle') });
    const paintCats = () => {
      clear(catBox);
      for (const c of options.categories) catBox.append(h('button', { type: 'button', class: 'chip', 'aria-pressed': String(d.categories.includes(c.id)), onclick: () => ((d.categories = toggleIn(d.categories, c.id, !d.categories.includes(c.id))), paintCats(), changed('categories')) }, c.label));
    };
    paintCats();
    parts.push(
      section(
        t('ui.create.categoryTitle'),
        t('ui.create.categoryHint'),
        fieldBox(board, { id: nextId('cat'), label: '', field: 'categories', control: h('div', { class: 'stack tight' }, catBox, catHint) }),
      ),
    );

    // requirements and relations (skills only)
    if (d.kind === 'skill') {
      const names = [...options.skills.map((s) => s.name), ...options.agents.map((a) => `agent:${a.name}`)];
      const tok = (field, label, hint, values, placeholder, suggestions = []) => {
        const id = nextId(field);
        return fieldBox(board, {
          id,
          label,
          hint,
          field,
          control: tokenField({
            id,
            values,
            label,
            placeholder,
            suggestions,
            onChange: (list) => {
              d[field] = list;
              changed(field);
            },
          }),
        });
      };
      parts.push(
        section(
          t('ui.create.whatItNeeds'),
          t('ui.create.whatItNeedsHint'),
          h(
            'div',
            { class: 'cols' },
            tok('requiresCommands', t('ui.create.reqCommands'), t('ui.create.reqCommandsHint'), d.requiresCommands, 'ffmpeg'),
            tok('requiresMcp', t('ui.create.reqMcp'), t('ui.create.reqMcpHint'), d.requiresMcp, 'gmail'),
          ),
          h('div', { class: 'cols' }, tok('depends', t('ui.create.dependsOn'), t('ui.create.dependsOnHint'), d.depends, 'skill-name', names), tok('conflicts', t('ui.create.conflictsWith'), t('ui.create.conflictsWithHint'), d.conflicts, 'skill-name', names)),
        ),
      );
    }

    // connections
    if (d.kind === 'skill') {
      parts.push(
        section(
          t('ui.create.assignedAgentTitle'),
          t('ui.create.assignedAgentHint'),
          fieldBox(board, {
            id: nextId('agents'),
            label: '',
            field: 'agents',
            control: checkList({
              items: options.agents,
              picked: new Set(d.agents),
              label: t('ui.graph.agents'),
              emptyText: t('ui.create.agentsEmptyText'),
              onChange: (list) => {
                d.agents = list;
                changed('agents');
              },
            }),
          }),
        ),
      );
    } else {
      const modeRadio = (value, title, textHint) =>
        h(
          'label',
          { class: 'radio-row' },
          h('input', { type: 'radio', name: 'skills-mode', checked: d.skillsMode === value, onchange: () => ((d.skillsMode = value), changed('skills')) }),
          h('span', null, h('strong', null, title), h('span', { class: 'hint' }, textHint)),
        );
      parts.push(
        section(
          t('ui.create.agentSkillsTitle'),
          t('ui.create.agentSkillsHint'),
          fieldBox(board, {
            id: nextId('skills'),
            label: '',
            field: 'skills',
            control: h(
              'div',
              { class: 'stack tight' },
              checkList({
                items: options.skills,
                picked: new Set(d.skills),
                label: t('ui.graph.skills'),
                emptyText: t('ui.create.skillsEmptyText'),
                onChange: (list) => {
                  d.skills = list;
                  changed('skills');
                },
              }),
              h('div', { class: 'radios', role: 'radiogroup', 'aria-label': t('ui.create.linkModeAria') }, modeRadio('link', t('ui.create.linkModeLink'), t('ui.create.linkModeLinkHint')), modeRadio('frontmatter', t('ui.create.linkModeFrontmatter'), t('ui.create.linkModeFrontmatterHint'))),
            ),
          }),
        ),
      );
    }
    paintSuggestion();
    return h('div', { class: 'stack' }, ...parts);
  }

  function paintSuggestion() {
    clear(catHint);
    const pl = preview?.placement;
    if (!pl?.categoriesInferred || d.categories.length || !options) return;
    const label = (id) => options.categories.find((c) => c.id === id)?.label ?? id;
    catHint.append(h('span', { class: 'hint' }, t('ui.create.suggestionPrefix')), ...pl.categoriesUsed.map((c) => h('span', { class: 'chip' }, label(c))), h('button', { type: 'button', class: 'btn small', onclick: () => ((d.categories = [...pl.categoriesUsed]), renderStep(), changed('categories')) }, t('ui.create.useThisSuggestion')));
  }

  // ---- step 5: save
  function stepSave() {
    saveRefs = null;
    if (!preview || !saveReady) return h('p', { class: 'hint' }, previewError || t('ui.create.preparingFile'));
    const refs = { options: h('div', { class: 'folder-opts', role: 'radiogroup', 'aria-label': t('ui.create.folderGroupAria') }), where: h('p', { class: 'where' }), issues: h('div', { class: 'stack tight' }), count: h('span', { class: 'counter' }), create: null, editBtn: null };
    saveRefs = refs;

    // folder: the list is built once (the choices don't change while drafting the file)
    const pl = preview.placement;
    const radios = [];
    const customId = nextId('folder');
    const customIn = h('input', { type: 'text', id: customId, class: 'mono', placeholder: d.kind === 'skill' ? 'video/youtube' : 'social', autocomplete: 'off', spellcheck: 'false', 'aria-label': t('ui.create.customFolderAria'), value: d.folder !== null && !pl.options.some((o) => o.folder === d.folder) ? d.folder : '' });
    let custom = d.folder !== null && !pl.options.some((o) => o.folder === d.folder);
    const syncRadios = () => {
      const chosen = preview?.placement?.chosen?.folder;
      radios.forEach(({ input, opt }) => (input.checked = !custom && opt.folder === chosen));
      customRadio.checked = custom;
    };
    for (const opt of pl.options) {
      const input = h('input', { type: 'radio', name: 'folder', checked: !custom && opt.folder === pl.chosen.folder });
      input.addEventListener('change', () => {
        custom = false;
        d.folder = opt.recommended ? null : opt.folder;
        remember();
        runPreview();
      });
      radios.push({ input, opt });
      refs.options.append(
        h(
          'label',
          { class: `folder-opt ${opt.recommended ? 'rec' : ''}` },
          input,
          icon('folder', 16),
          h('span', { class: 'folder-text' }, h('span', { class: 'folder-line' }, h('code', null, `${opt.path}/`), opt.recommended ? h('span', { class: 'badge ok' }, t('ui.create.folderRec')) : null, !opt.exists ? h('span', { class: 'badge' }, t('ui.create.folderNew')) : h('span', { class: 'badge' }, opt.count ? t.n('ui.create.folderItemCount', opt.count, { count: opt.count }) : t('ui.create.folderEmpty'))), h('span', { class: 'hint' }, opt.why)),
        ),
      );
    }
    const customRadio = h('input', { type: 'radio', name: 'folder', checked: custom });
    customRadio.addEventListener('change', () => {
      custom = true;
      customIn.focus();
      applyCustom();
    });
    const applyCustom = () => {
      const v = customIn.value.trim();
      if (!v) return; // until text is entered, keep previous choice
      d.folder = v;
      remember();
      runPreview();
    };
    customIn.addEventListener('focus', () => {
      if (!custom) {
        custom = true;
        syncRadios();
      }
    });
    customIn.addEventListener('input', debounce(applyCustom, 200));
    refs.options.append(h('label', { class: 'folder-opt' }, customRadio, icon('folder', 16), h('span', { class: 'folder-text' }, h('span', { class: 'folder-line' }, h('code', null, `${pl.options.find((o) => o.folder === '')?.path ?? ''}/`), customIn), h('span', { class: 'hint' }, t('ui.create.customFolderHint')))));
    refs.syncRadios = syncRadios;

    // file content
    const ta = h('textarea', { class: 'md-editor mono', rows: 18, spellcheck: 'false', 'aria-label': t('ui.create.fullFileAria'), readonly: d.markdown === null });
    ta.value = d.markdown ?? preview.markdown;
    const fit = () => {
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(Math.max(ta.scrollHeight + 2, 280), Math.round(window.innerHeight * 0.75))}px`;
    };
    ta.addEventListener('input', () => {
      d.markdown = ta.value;
      fit();
      remember();
      pending = true;
      schedulePreview();
      paintSave();
    });
    refs.editor = ta;
    refs.fit = fit;
    refs.editBtn = h('button', { type: 'button', class: 'btn', onclick: toggleEdit });
    refs.create = h('button', { type: 'button', class: 'btn primary', onclick: doCreate });
    requestAnimationFrame(fit);

    return h(
      'div',
      { class: 'stack' },
      section(t('ui.create.whereToSave'), d.kind === 'agent' ? t('ui.create.whereToSaveHintAgent') : t('ui.create.whereToSaveHintSkill'), refs.options, refs.where),
      section(t('ui.create.finalCheck'), null, refs.issues),
      section(t('ui.create.theFile'), t('ui.create.theFileHint'), h('div', { class: 'md-tools' }, refs.editBtn, h('span', { class: 'grow' }), refs.count), ta),
      h('div', { class: 'wizard-nav' }, h('button', { type: 'button', class: 'btn', onclick: () => go(LAST_STEP - 1) }, t('ui.create.back')), h('span', { class: 'grow' }), refs.create),
    );
  }

  async function toggleEdit() {
    if (d.markdown === null) {
      d.markdown = preview?.markdown ?? '';
      saveRefs.editor.readOnly = false;
      saveRefs.editor.focus();
      remember();
    } else {
      if (d.markdown !== preview?.generated) {
        const ok = await confirmDialog({ title: t('ui.create.revertConfirmTitle'), body: h('p', null, t('ui.create.revertConfirmBody')), confirmLabel: t('ui.create.revertConfirmBtn'), danger: true });
        if (!ok) return;
      }
      regenerate();
      return;
    }
    paintSave();
  }

  function paintSave() {
    const r = saveRefs;
    if (!r || step !== LAST_STEP || !preview) return;
    const issues = preview.issues;
    const chosen = preview.placement.chosen;
    r.syncRadios?.();
    clear(r.where);
    put(r.where, icon('file', 16), h('span', null, t('ui.create.willBeCreatedIn')), h('code', null, chosen.fileRel), chosen.isNew ? h('span', { class: 'badge' }, t('ui.create.newFolderBadge')) : null);
    clear(r.issues);
    if (!issues.length) r.issues.append(h('div', { class: 'banner ok' }, icon('check', 18), h('div', null, t('ui.create.allInOrder'))));
    for (const i of issues) {
      const go1 = stepOfField(i.field);
      r.issues.append(h('div', { class: `banner ${i.level === 'error' ? 'warn' : i.level === 'warn' ? 'caution' : ''}` }, icon(i.level === 'info' ? 'info' : 'warn', 18), h('div', { class: 'grow' }, i.message), go1 < LAST_STEP ? h('button', { type: 'button', class: 'btn small', onclick: () => go(go1) }, t('ui.create.goToField')) : null));
    }
    if (d.markdown === null && !r.editor.matches(':focus')) {
      r.editor.value = preview.markdown;
      r.fit();
    }
    r.editor.readOnly = d.markdown === null;
    r.editBtn.replaceChildren(icon(d.markdown === null ? 'edit' : 'refresh', 16), d.markdown === null ? t('ui.create.editByHand') : t('ui.create.revertToGenerated'));
    r.count.textContent = `${fmtInt(preview.lines)} ${t('ui.create.lines')} · ${preview.bytes < 1024 ? `${preview.bytes} B` : `${(preview.bytes / 1024).toFixed(preview.bytes < 10240 ? 1 : 0)} KB`}${pending ? t('ui.create.checkingSuffix') : ''}`;
    const ok = canCreate(preview, pending);
    r.create.disabled = !ok || creating;
    const createBtnText = creating ? t('ui.create.creating') : (d.kind === 'agent' ? t('ui.create.createBtnAgent') : t('ui.create.createBtnSkill'));
    r.create.replaceChildren(icon('create', 16), createBtnText);
    r.create.title = ok ? '' : pending ? t('ui.create.checkingHint') : t('ui.create.fixErrorsHint');
  }

  async function doCreate() {
    if (creating || !canCreate(preview, pending)) return;
    creating = true;
    paintSave();
    try {
      const r = await api.create(toPayload(d));
      result = r;
      memory.draft = null;
      clearSaved();
      restored = false;
      d = emptyDraft('skill');
      d.kind = null;
      preview = null;
      await ctx.refresh();
      renderStep();
    } catch (e) {
      toast(e.message, 'error');
      runPreview(); // show conflicts if name taken or file created in the meantime
    }
    creating = false;
    paintSave();
  }

  // ---- finish: summary and result
  function renderResult() {
    const r = result;
    const entry = store.byId.get(r.id);
    const kind = r.kind;
    const syncBtn = h('button', { type: 'button', class: 'btn', onclick: doSync }, icon('link', 16), t('ui.create.connectClaudeCode'));
    async function doSync() {
      syncBtn.disabled = true;
      try {
        const out = await api.sync(false);
        toast(out.ok ? t('ui.create.connectSuccess') : t('ui.create.connectFailed'), out.ok ? 'info' : 'error');
      } catch (e) {
        toast(e.message, 'error');
      }
      syncBtn.disabled = false;
    }
    const createdText = kind === 'agent' ? t('ui.create.createdAgent', { name: r.name }) : t('ui.create.createdSkill', { name: r.name });
    body.append(
      h(
        'div',
        { class: 'stack result' },
        h('div', { class: 'banner ok' }, icon('check', 18), h('div', null, h('strong', null, createdText), h('p', { class: 'hint' }, t('ui.create.savedIn'), h('code', null, r.file)))),
        h('dl', { class: 'kv' }, h('dt', null, t('ui.create.size')), h('dd', null, `${fmtInt(r.lines)} ${t('ui.create.lines')}`), h('dt', null, t('ui.create.connections')), h('dd', null, r.links.length ? r.links.map((l) => `${l.from.replace(/^\w+:/, '')} → ${l.to.replace(/^\w+:/, '')}`).join(', ') : t('ui.create.noneConnections')), h('dt', null, t('ui.create.estimatedRisk')), h('dd', null, r.risk === 'low' ? t('ui.create.riskLow') : r.risk === 'medium' ? t('ui.create.riskMedium') : t('ui.create.riskHigh'))),
        ...r.warnings.map((w) => h('div', { class: 'banner caution' }, icon('warn', 18), h('div', null, w))),
        h('p', { class: 'hint' }, kind === 'agent' ? t('ui.create.syncNoticeAgent') : t('ui.create.syncNoticeSkill')),
        h(
          'div',
          { class: 'actions-row' },
          entry ? h('button', { type: 'button', class: 'btn primary', onclick: () => ctx.select(r.id) }, t('ui.create.openInCatalog')) : null,
          syncBtn,
          h('button', { type: 'button', class: 'btn', onclick: () => ctx.navigate('tree') }, icon('folder', 16), t('ui.create.viewInFolders')),
          h('button', { type: 'button', class: 'btn', onclick: () => anotherOne() }, icon('plus', 16), t('ui.create.createAnother')),
        ),
      ),
    );
    clear(aside);
    aside.hidden = true;
  }

  function anotherOne() {
    result = null;
    d = emptyDraft('skill');
    d.kind = null;
    preview = null;
    board.touched.clear();
    board.showAll = false;
    step = 0;
    memory.step = 0;
    renderStep();
  }

  // ------------------------------------------------------------ side preview
  function paintAside() {
    if (result) return;
    aside.hidden = step === 0 || step === LAST_STEP || !d.kind;
    clear(aside);
    if (aside.hidden) return;
    const lines = (preview?.markdown ?? '').split('\n');
    const shown = lines.slice(0, PREVIEW_LINES).join('\n');
    const issues = preview?.issues ?? [];
    const errors = issues.filter((i) => i.level === 'error' && (board.showAll || board.touched.has(i.field))).length; // newly opened form should not appear full of errors
    put(
      aside,
      h('div', { class: 'side-head' }, h('h2', null, t('ui.create.resultingFile')), h('span', { class: 'live-dot', 'data-busy': String(pending), title: pending ? t('ui.create.updatingPreview') : t('ui.create.previewUpdated') })),
      preview ? h('p', { class: 'where small' }, icon('file', 14), h('code', null, preview.placement.chosen.fileRel)) : null,
      previewError ? h('div', { class: 'banner warn' }, icon('warn', 16), h('div', null, previewError)) : null,
      h('pre', { class: 'pre side-pre', tabindex: '0', 'aria-label': t('ui.create.previewAria') }, shown || t('ui.create.fillFieldsHint')),
      lines.length > PREVIEW_LINES ? h('p', { class: 'hint' }, t('ui.create.moreLines', { count: fmtInt(lines.length - PREVIEW_LINES) })) : null,
      preview ? h('p', { class: 'hint' }, `${fmtInt(preview.lines)} ${t('ui.create.lines')} · ${errors ? t.n('ui.create.toFix', errors, { n: errors }) : t('ui.create.noErrors')}`) : null,
    );
  }

  // ------------------------------------------------------------ avvio
  renderStep();
  loadOptions();
  if (d.kind) runPreview();
  return {
    el,
    update() {
      const fp = store.state?.fingerprint;
      if (fp === lastFp) return;
      lastFp = fp;
      if (result) return;
      api
        .createOptions()
        .then((o) => {
          const key = JSON.stringify([o.agents.map((a) => a.id), o.skills.map((s) => s.id)]);
          options = o;
          if (key !== optionsKey) {
            optionsKey = key;
            if (step === 3) renderStep();
          }
          if (d.kind) schedulePreview();
        })
        .catch(() => {});
    },
    destroy() {
      seq++;
      if (result) return;
      remember();
      if (d.kind) writeSaved(d, step);
    },
  };
}
