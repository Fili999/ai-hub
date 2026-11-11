// Catalog search engine (used by route/search and the UI).
import { buildSynonymMap, norm, stem, stems, tokens } from './text.mjs';

export const catsOf = (e) => (e.categories.length ? e.categories : e.inferredCategories);

export function filterPool(index, { kind, category } = {}) {
  // workflows are only searched if requested: default search stays on skills and agents ('any' = all combined)
  let pool = kind === 'workflow' ? [...(index.workflows ?? [])] : kind === 'any' ? [...index.skills, ...index.agents, ...(index.workflows ?? [])] : [...index.skills, ...index.agents];
  if (kind && kind !== 'any') pool = pool.filter((e) => e.kind === kind);
  if (category) pool = pool.filter((e) => e.categories.includes(category) || e.inferredCategories.includes(category));
  return pool;
}

/** @returns {{e: object, score: number, matched: string[]}[]} sorted by score descending */
export function searchIndex(index, config, query, { kind, category, limit = 8 } = {}) {
  const pool = filterPool(index, { kind, category });
  const syn = buildSynonymMap(config.synonymGroups);
  const qStems = [...new Set(stems(query))];
  if (!qStems.length) return [];

  const terms = new Map(); // stem -> weight
  for (const q of qStems) {
    terms.set(q, Math.max(terms.get(q) ?? 0, 1));
    for (const s of syn.get(q) ?? []) terms.set(s, Math.max(terms.get(s) ?? 0, 0.6));
  }

  const docs = pool.map((e) => ({
    e,
    name: new Set(stems(`${e.name} ${(e.capabilities ?? []).join(' ')}`)),
    title: new Set(stems(e.name)),
    desc: new Set(stems(e.description)),
    cat: new Set(stems([...e.categories, ...e.categories.map((c) => config.categories?.[c]?.label ?? '')].join(' '))),
    infer: new Set(stems(e.inferredCategories.join(' '))),
  }));
  const df = new Map();
  for (const d of docs) for (const s of new Set([...d.name, ...d.desc, ...d.cat])) df.set(s, (df.get(s) ?? 0) + 1);
  const idf = (s) => Math.log(1 + docs.length / (1 + (df.get(s) ?? 0)));

  // categories "evoked" by the query via their keywords
  const evoked = Object.entries(config.categories ?? {})
    .filter(([, c]) => (c.keywords ?? []).some((k) => qStems.includes(stem(tokens(k)[0] ?? ''))))
    .map(([id]) => id);
  const phrase = norm(query);

  const results = [];
  for (const d of docs) {
    let score = 0;
    const matched = [];
    for (const [s, w] of terms) {
      const part = (d.name.has(s) ? 3 : 0) + (d.cat.has(s) ? 2 : 0) + (d.infer.has(s) ? 1 : 0) + (d.desc.has(s) ? 1 : 0);
      if (part) {
        score += w * idf(s) * part;
        matched.push(s);
      }
    }
    // query mentions the item's scope: a word from its title or an evoked category it belongs to
    const inScope = matched.some((s) => d.title.has(s)) || evoked.some((c) => d.e.categories.includes(c));
    for (const c of evoked) {
      if (d.e.categories.includes(c)) score += 2;
      else if (d.e.inferredCategories.includes(c)) score += 1;
    }
    if (qStems.length > 1 && norm(d.e.description).includes(phrase)) score += 2;
    if (score > 0) results.push({ e: d.e, score: Math.round(score * 100) / 100, matched, inScope });
  }
  results.sort((a, b) => b.score - a.score || a.e.name.localeCompare(b.e.name));
  return results.slice(0, limit);
}
