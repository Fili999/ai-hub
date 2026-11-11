// Languages: every message lives in i18n/<lang>.json (flat keys). English is the default and the fallback.
// The language comes from AI_HUB_LANG, then settings.json (interface.language), then English.
// This module reads settings.json directly (not through settings.mjs) so that any module can use it without cycles.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LANGUAGES = { en: 'English' };
export const DEFAULT_LANGUAGE = 'en';
const I18N_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'i18n');
const cache = new Map();

/** Messages of one language ({} if the file is missing or unreadable). */
export function messages(lang) {
  if (!cache.has(lang)) {
    let data = {};
    try {
      data = JSON.parse(fs.readFileSync(path.join(I18N_DIR, `${lang}.json`), 'utf8'));
    } catch {
      /* missing file: English fallback */
    }
    cache.set(lang, data && typeof data === 'object' ? data : {});
  }
  return cache.get(lang);
}

const valid = (l) => Object.prototype.hasOwnProperty.call(LANGUAGES, l);

/** The language to use for this hub. */
export function hubLanguage(root, env = process.env) {
  if (valid(env.AI_HUB_LANG)) return env.AI_HUB_LANG;
  if (root) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'));
      if (valid(s?.interface?.language)) return s.interface.language;
    } catch {
      /* no settings yet */
    }
  }
  return DEFAULT_LANGUAGE;
}

const fill = (text, vars) => String(text).replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined ? m : String(vars[k])));

/** A translate function for one language: t('key', {name: 'x'}); the key itself if no language has it. */
export function translator(lang) {
  const own = messages(lang);
  const en = messages(DEFAULT_LANGUAGE);
  const t = (key, vars = {}) => fill(own[key] ?? en[key] ?? key, vars);
  /** Plural: uses "<key>.one" when n is 1, otherwise "<key>.other". */
  t.n = (key, n, vars = {}) => t(`${key}.${n === 1 ? 'one' : 'other'}`, { n, ...vars });
  t.lang = lang;
  return t;
}

const defaultRoot = () => (process.env.AI_HUB_ROOT ? path.resolve(process.env.AI_HUB_ROOT) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));

/** Shortcut: the translate function for the hub at root. */
export function tFor(root = defaultRoot(), env = process.env) {
  const getLang = () => hubLanguage(root, env);
  const t = (key, vars = {}) => {
    const lang = getLang();
    const own = messages(lang);
    const en = messages(DEFAULT_LANGUAGE);
    return fill(own[key] ?? en[key] ?? key, vars);
  };
  t.n = (key, n, vars = {}) => t(`${key}.${n === 1 ? 'one' : 'other'}`, { n, ...vars });
  Object.defineProperty(t, 'lang', { get: getLang });
  return t;
}
