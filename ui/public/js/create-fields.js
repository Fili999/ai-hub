// Form components for Create tab: labeled field with notices, autosizing textarea, chip list, pick list.
import { h, clear, icon } from './dom.js';
import { kindDot } from './ui.js';
import { splitList, statsLabel } from './create-model.js';
import { t } from './i18n.js';

let uid = 0;
export const nextId = (prefix = 'f') => `${prefix}-${++uid}`;

/** Textarea that grows as you type (up to ~70% of window height, then scrolls). */
export function textArea({ id, value = '', rows = 3, placeholder = '', mono = false, onInput, describedBy }) {
  const ta = h('textarea', { id, rows, placeholder, spellcheck: mono ? 'false' : 'true', class: mono ? 'mono' : '', 'aria-describedby': describedBy });
  ta.value = value;
  const fit = () => {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight + 2, Math.round(window.innerHeight * 0.7))}px`;
  };
  ta.addEventListener('input', () => {
    fit();
    onInput?.(ta.value, ta);
  });
  requestAnimationFrame(fit);
  return ta;
}

/**
 * Server notices under fields. A notice appears only after touching the field
 * (or trying to save): an empty form should not immediately display errors.
 */
export function createBoard() {
  const board = {
    slots: new Map(),
    touched: new Set(),
    showAll: false,
    byField: new Map(),
    reset() {
      board.slots.clear();
    },
    touch(field) {
      if (!field || board.touched.has(field)) return;
      board.touched.add(field);
      board.paintField(field);
    },
    paintField(field) {
      const el = board.slots.get(field);
      if (!el) return;
      clear(el);
      if (!board.showAll && !board.touched.has(field)) return;
      for (const i of board.byField.get(field) ?? []) el.append(h('p', { class: `issue ${i.level}`, role: i.level === 'error' ? 'alert' : undefined }, icon(i.level === 'info' ? 'info' : 'warn', 15), h('span', null, i.message)));
    },
    paint() {
      for (const f of board.slots.keys()) board.paintField(f);
    },
    setIssues(issues = []) {
      board.byField = new Map();
      for (const i of issues) board.byField.set(i.field, [...(board.byField.get(i.field) ?? []), i]);
      board.paint();
    },
  };
  return board;
}

/** Form field: label, hint, control, footer row (counters), and server notices. */
export function fieldBox(board, { id, label, hint, field, control, foot, required = false }) {
  const issues = h('div', { class: 'issues', 'aria-live': 'polite' });
  if (field) board.slots.set(field, issues);
  const box = h('div', { class: 'field' }, label ? h('label', { for: id }, label, required ? h('span', { class: 'req', title: t('ui.create.required') }, ' *') : null) : null, hint ? h('p', { class: 'hint', id: `${id}-hint` }, hint) : null, control, foot ? h('div', { class: 'field-foot' }, foot) : null, issues);
  box.addEventListener('focusout', () => board.touch(field));
  board.paintField(field);
  return box;
}

/** "lines · words · characters" counter that updates automatically with text. */
export function counterFor(ta) {
  const out = h('span', { class: 'counter' }, statsLabel(ta.value));
  ta.addEventListener('input', () => (out.textContent = statsLabel(ta.value)));
  return out;
}

/** Chip list: type and press Enter or comma to add, × to remove. */
export function tokenField({ id, values = [], onChange, placeholder = '', suggestions = [], label }) {
  let list = [...values];
  const dl = suggestions.length ? h('datalist', { id: `${id}-dl` }, suggestions.map((s) => h('option', { value: s }))) : null;
  const input = h('input', { type: 'text', id, placeholder, autocomplete: 'off', spellcheck: 'false', 'aria-label': label, list: dl ? `${id}-dl` : undefined });
  const chips = h('span', { class: 'chips' });
  const emit = () => onChange([...list]);
  function paint() {
    clear(chips);
    for (const v of list) {
      chips.append(
        h(
          'span',
          { class: 'chip tok' },
          h('code', null, v),
          h(
            'button',
            {
              type: 'button',
              'aria-label': t('ui.create.removeToken', { value: v }),
              onclick: () => {
                list = list.filter((x) => x !== v);
                paint();
                emit();
              },
            },
            icon('close', 12),
          ),
        ),
      );
    }
  }
  function add(text) {
    const items = splitList(text).filter((x) => !list.includes(x));
    input.value = '';
    if (!items.length) return;
    list.push(...items);
    paint();
    emit();
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add(input.value);
    } else if (e.key === 'Backspace' && !input.value && list.length) {
      list.pop();
      paint();
      emit();
    }
  });
  input.addEventListener('input', (e) => {
    // selected from suggestion: add immediately
    if (suggestions.includes(input.value) && (e.inputType === 'insertReplacementText' || e.inputType === undefined)) add(input.value);
  });
  input.addEventListener('blur', () => add(input.value));
  paint();
  return h('div', { class: 'tokens' }, chips, input, dl);
}

/** Checkbox list (with search filter when long). picked is a Set of names. */
export function checkList({ items, picked, onChange, label, emptyText }) {
  const filter = items.length > 8 ? h('input', { type: 'search', placeholder: t('ui.create.filterList'), 'aria-label': t('ui.create.filterLabel', { label }) }) : null;
  const box = h('div', { class: 'pick-list', role: 'group', 'aria-label': label });
  function paint() {
    clear(box);
    const q = (filter?.value ?? '').trim().toLowerCase();
    const shown = items.filter((i) => !q || picked.has(i.name) || i.name.toLowerCase().includes(q) || i.description.toLowerCase().includes(q));
    if (!shown.length) box.append(h('p', { class: 'hint' }, items.length ? t('ui.create.noResults') : emptyText));
    for (const i of shown) {
      const cb = h('input', { type: 'checkbox', checked: picked.has(i.name) });
      cb.addEventListener('change', () => {
        if (cb.checked) picked.add(i.name);
        else picked.delete(i.name);
        onChange([...picked]);
      });
      box.append(
        h(
          'label',
          { class: 'pick' },
          cb,
          kindDot({ kind: i.id.startsWith('agent:') ? 'agent' : 'skill', origin: i.origin }),
          h('span', { class: 'pick-text' }, h('strong', null, i.name), h('span', { class: 'hint' }, i.description || t('ui.create.noDesc'))),
          i.origin === 'external' ? h('span', { class: 'badge' }, t('ui.create.fromGithub')) : null,
        ),
      );
    }
  }
  filter?.addEventListener('input', paint);
  paint();
  return h('div', { class: 'pick-wrap' }, filter, box);
}
