// Lightweight tokenization for catalog and search.

const STOP = new Set(
  (
    'the an of to and or for with on at by is are be this that it as from when use used using your you'
  ).split(' '),
);

export const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

export const tokens = (s) =>
  norm(s)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t));

// Different words with the same first 5 letters: [prefix, root] to avoid confusing them.
// Candidates to evaluate are listed by "npm run search -- --collisions".
export const SPLIT = [
  ['instag', 'instag'],
  ['content', 'conten'],
  ['context', 'contes'],
  ['consequ', 'conseq'],
  ['proced', 'proced'],
];

/** Stemming: first 5 letters. */
export const stem = (t) => {
  if (t.length <= 5) return t;
  const hit = SPLIT.find(([p]) => t.startsWith(p));
  return hit ? hit[1] : t.slice(0, 5);
};

/**
 * Roots shared by words that differ already within the first 7 letters: possible search collisions.
 * @param {string[]} texts catalog descriptions
 * @returns {{stem: string, words: string[]}[]}
 */
export function stemCollisions(texts) {
  const by = new Map();
  for (const w of texts.flatMap(tokens)) {
    const s = stem(w);
    if (!by.has(s)) by.set(s, new Set());
    by.get(s).add(w);
  }
  return [...by]
    .filter(([, ws]) => new Set([...ws].map((w) => w.slice(0, 7))).size > 1)
    .map(([s, ws]) => ({ stem: s, words: [...ws].sort() }))
    .sort((a, b) => a.stem.localeCompare(b.stem));
}

export const stems = (s) => tokens(s).map(stem);

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Map stem -> Set(synonym stems) from config synonym groups. */
export function buildSynonymMap(groups = []) {
  const map = new Map();
  for (const g of groups) {
    const st = [...new Set(g.map((w) => stem(norm(w))))];
    for (const s of st) {
      const set = map.get(s) ?? new Set();
      for (const o of st) if (o !== s) set.add(o);
      map.set(s, set);
    }
  }
  return map;
}
