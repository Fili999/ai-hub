// registry.json = user choices (agent→skill links, categories, overrides).
// manifest.lock.json = provenance of items installed from GitHub (written only by the installer).
import path from 'node:path';
import { readJson, writeJson } from './util.mjs';

const registryFile = (root) => path.join(root, 'registry.json');
const lockFile = (root) => path.join(root, 'manifest.lock.json');

export function loadRegistry(root) {
  const r = readJson(registryFile(root), {});
  return { version: 1, overrides: r.overrides ?? {}, links: r.links ?? [] };
}

export function saveRegistry(root, reg) {
  reg.links.sort((a, b) => (a.from + a.to).localeCompare(b.from + b.to));
  writeJson(registryFile(root), { version: 1, overrides: reg.overrides, links: reg.links });
}

export function addLink(reg, from, to) {
  if (reg.links.some((l) => l.from === from && l.to === to)) return false;
  reg.links.push({ from, to });
  return true;
}

export function removeLink(reg, from, to) {
  const before = reg.links.length;
  reg.links = reg.links.filter((l) => !(l.from === from && l.to === to));
  return reg.links.length !== before;
}

export function setCategories(reg, id, categories) {
  const ov = { ...(reg.overrides[id] ?? {}) };
  if (categories.length) ov.categories = categories;
  else delete ov.categories;
  if (Object.keys(ov).length) reg.overrides[id] = ov;
  else delete reg.overrides[id];
}

/** Additional capabilities for an item (e.g. an external skill that doesn't declare them): empty list = removes override. */
export function setCapabilities(reg, id, capabilities) {
  const ov = { ...(reg.overrides[id] ?? {}) };
  if (capabilities.length) ov.capabilities = capabilities;
  else delete ov.capabilities;
  if (Object.keys(ov).length) reg.overrides[id] = ov;
  else delete reg.overrides[id];
}

/** Removes all references to an item (when it is deleted). */
export function dropRefs(reg, id) {
  reg.links = reg.links.filter((l) => l.from !== id && l.to !== id);
  delete reg.overrides[id];
}

// Version 2: entries can also have `package` and `approval` (scripts/lib/approval.mjs). Version 1 locks
// are also supported (without those fields: items show as "review pending"); unknown fields are preserved.
export function loadLock(root) {
  const l = readJson(lockFile(root), {});
  return { version: 2, entries: l.entries ?? [] };
}

export function saveLock(root, lock) {
  lock.entries.sort((a, b) => `${a.kind}:${a.name}`.localeCompare(`${b.kind}:${b.name}`));
  writeJson(lockFile(root), { version: 2, entries: lock.entries });
}
