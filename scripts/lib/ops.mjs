// Hub operations shared by CLI and UI: links and categories.
import path from 'node:path';
import { readJson, writeJson } from './util.mjs';
import { ensureIndex, scanHub, writeIndex } from './scan.mjs';
import { refreshGuideSafe } from './guide.mjs';
import { addLink, loadRegistry, removeLink, saveRegistry, setCapabilities, setCategories } from './registry.mjs';
import { KEBAB_RE } from './schema.mjs';
import { dropCategoryFromTeams } from './teams.mjs';
import { tFor } from './i18n.mjs';

export class HubError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const withKind = (ref, kind) => (/^(skill|agent):/.test(ref) ? ref : `${kind}:${ref}`);

function lookup(root) {
  const index = ensureIndex(root);
  return { index, byId: new Map([...index.skills, ...index.agents].map((e) => [e.id, e])) };
}

function must(byId, id, t = tFor()) {
  if (!byId.has(id)) throw new HubError(t('ops.itemNotFound', { id }), 404);
  return id;
}

function commit(root, reg) {
  saveRegistry(root, reg);
  const index = writeIndex(root, scanHub(root));
  refreshGuideSafe(root);
  return index;
}

export function linkAdd(root, agentRef, skillRef) {
  const t = tFor(root);
  const { byId } = lookup(root);
  const from = must(byId, withKind(agentRef, 'agent'), t);
  const to = must(byId, withKind(skillRef, 'skill'), t);
  if (!from.startsWith('agent:') || !to.startsWith('skill:')) throw new HubError(t('ops.linkAgentToSkill'));
  const reg = loadRegistry(root);
  const changed = addLink(reg, from, to);
  commit(root, reg);
  return { from, to, changed, message: changed ? `${from} → ${to}` : t('ops.alreadyLinked', { from, to }) };
}

export function linkRemove(root, agentRef, skillRef) {
  const t = tFor(root);
  const { byId } = lookup(root);
  const from = must(byId, withKind(agentRef, 'agent'), t);
  const to = must(byId, withKind(skillRef, 'skill'), t);
  const reg = loadRegistry(root);
  const changed = removeLink(reg, from, to);
  commit(root, reg);
  return {
    from,
    to,
    changed,
    message: changed
      ? t('ops.unlinked', { from, to })
      : t('ops.noLinkBetween', { from, to }),
  };
}

export function categorize(root, ref, categories) {
  const t = tFor(root);
  const { byId } = lookup(root);
  const id = must(byId, /^(skill|agent):/.test(ref) ? ref : `skill:${ref}`, t);
  const valid = Object.keys(readJson(path.join(root, 'hub.config.json'), { categories: {} }).categories);
  const unknown = categories.filter((c) => !valid.includes(c));
  if (unknown.length) throw new HubError(t('ops.unknownCategories', { unknown: unknown.join(', '), valid: valid.join(', ') }));
  const reg = loadRegistry(root);
  setCategories(reg, id, categories);
  commit(root, reg);
  return { id, categories, message: t('ops.categorized', { id, list: categories.join(', ') || t('ops.categoriesAuto') }) };
}

/** Manually configured capabilities (registry.json): used by route.mjs to route to external skills that don't declare them. */
export function setItemCapabilities(root, ref, capabilities) {
  const t = tFor(root);
  const { byId } = lookup(root);
  const id = must(byId, /^(skill|agent):/.test(ref) ? ref : `skill:${ref}`, t);
  const bad = capabilities.filter((c) => !KEBAB_RE.test(c));
  if (bad.length) throw new HubError(t('ops.invalidCapabilities', { bad: bad.join(', ') }));
  const reg = loadRegistry(root);
  setCapabilities(reg, id, [...new Set(capabilities)]);
  commit(root, reg);
  return { id, capabilities, message: t('ops.capabilitiesSet', { id, list: capabilities.join(', ') || t('ops.capabilitiesNone') }) };
}

// ---------- categories (hub.config.json): add, update, remove

const CATEGORY_ID_RE = /^[a-z0-9][a-z0-9-]{0,29}$/;
const configFile = (root) => path.join(root, 'hub.config.json');

function cleanKeywords(keywords, t = tFor()) {
  const list = Array.isArray(keywords) ? keywords : String(keywords ?? '').split(',');
  const out = [...new Set(list.map((k) => String(k).trim().toLowerCase()).filter(Boolean))];
  if (out.length > 60) throw new HubError(t('ops.tooManyKeywords'));
  if (out.some((k) => k.length > 40)) throw new HubError(t('ops.keywordTooLong'));
  return out;
}

function cleanLabel(label, t = tFor()) {
  const s = String(label ?? '').replace(/\s+/g, ' ').trim();
  if (!s) throw new HubError(t('ops.categoryNameRequired'));
  if (s.length > 50) throw new HubError(t('ops.categoryNameTooLong'));
  return s;
}

function saveConfig(root, config) {
  writeJson(configFile(root), config);
  writeIndex(root, scanHub(root));
  refreshGuideSafe(root);
}

/** New category: id (lowercase and dashes), label and keywords for recognition in user requests. */
export function addCategory(root, { id, label, keywords = [] } = {}) {
  const t = tFor(root);
  const cid = String(id ?? '');
  if (!CATEGORY_ID_RE.test(cid)) throw new HubError(t('ops.invalidCategoryId'));
  const config = readJson(configFile(root), { categories: {} });
  config.categories ??= {};
  if (config.categories[cid]) throw new HubError(t('ops.categoryAlreadyExists', { id: cid }), 409);
  config.categories[cid] = { label: cleanLabel(label, t), keywords: cleanKeywords(keywords, t) };
  saveConfig(root, config);
  return { id: cid, message: t('ops.categoryAdded', { label: config.categories[cid].label }) };
}

/** Updates name and/or keywords of a category (the id remains fixed: written in skills). */
export function updateCategory(root, id, { label, keywords } = {}) {
  const t = tFor(root);
  const config = readJson(configFile(root), { categories: {} });
  const c = config.categories?.[id];
  if (!c) throw new HubError(t('ops.categoryNotFound', { id: String(id).slice(0, 30) }), 404);
  if (label !== undefined) c.label = cleanLabel(label, t);
  if (keywords !== undefined) c.keywords = cleanKeywords(keywords, t);
  saveConfig(root, config);
  return { id, message: t('ops.categoryUpdated', { label: c.label }) };
}

/**
 * Removes a category: from config, from category overrides in registry.json, and from teams.
 * Skills declaring it in their frontmatter keep it (inventory reports it as unknown).
 */
export function removeCategory(root, id) {
  const t = tFor(root);
  const config = readJson(configFile(root), { categories: {} });
  if (!config.categories?.[id]) throw new HubError(t('ops.categoryNotFound', { id: String(id).slice(0, 30) }), 404);
  delete config.categories[id];
  const reg = loadRegistry(root);
  let items = 0;
  for (const [key, ov] of Object.entries(reg.overrides)) {
    if (Array.isArray(ov.categories) && ov.categories.includes(id)) {
      setCategories(reg, key, ov.categories.filter((c) => c !== id));
      items++;
    }
  }
  saveRegistry(root, reg);
  const teams = dropCategoryFromTeams(root, id);
  saveConfig(root, config);
  return { id, items, teams, message: t('ops.categoryRemoved', { id, items, teams }) };
}
