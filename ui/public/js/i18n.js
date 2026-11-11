// Interface messages: the server puts them in the page (<script type="application/json" id="i18n">) in the hub language,
// with English filling any gap. t('ui.key', {name}) returns the text; an unknown key returns the key itself.
let data = {};
if (typeof document !== 'undefined') {
  try {
    data = JSON.parse(document.getElementById('i18n')?.textContent ?? '{}');
  } catch {
    data = {};
  }
} else if (typeof process !== 'undefined') {
  try {
    const { readFileSync } = await import('node:fs');
    const { resolve, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'i18n');
    const l = process.env.AI_HUB_LANG || 'en';
    const en = JSON.parse(readFileSync(resolve(dir, 'en.json'), 'utf8'));
    const own = l === 'en' ? en : JSON.parse(readFileSync(resolve(dir, `${l}.json`), 'utf8'));
    const ui = Object.fromEntries(Object.entries({ ...en, ...own }).filter(([k]) => k.startsWith('ui.')));
    data = { lang: l, messages: ui };
  } catch {}
}
const msgs = data.messages ?? {};
export const lang = data.lang ?? 'en';
const fill = (text, vars) => String(text).replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined ? m : String(vars[k])));
export const t = (key, vars = {}) => fill(msgs[key] ?? key, vars);
/** Plural: "<key>.one" when n is 1, otherwise "<key>.other". */
t.n = (key, n, vars = {}) => t(`${key}.${n === 1 ? 'one' : 'other'}`, { n, ...vars });
