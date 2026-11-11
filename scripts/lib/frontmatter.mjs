// YAML frontmatter parser (sufficient subset for SKILL.md and Claude Code agents).
// Supports: scalars, quoted strings, inline lists [a, b], dash lists,
// > and | blocks. Nested keys are ignored: the hub only uses flat keys.

function unquote(v) {
  const s = v.trim();
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    return s.slice(1, -1).replace(/\\(["\\nt])/g, (_, c) => ({ n: '\n', t: '\t' })[c] ?? c);
  }
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

function stripComment(v) {
  if (/^["']/.test(v.trim())) return v;
  return v.replace(/\s+#.*$/, '');
}

/** Splits a string on separators that lie outside quotes and brackets. */
export function splitTop(str, isSep) {
  const out = [];
  let cur = '';
  let depth = 0;
  let quote = null;
  for (const ch of String(str)) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    if (depth === 0 && isSep(ch)) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.map(unquote).filter(Boolean);
}

/** Converts a frontmatter value to a list (accepts list, "a, b" or "a b"). */
export function toList(value) {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return splitTop(value, (ch) => ch === ',' || /\s/.test(ch));
}

function parseYaml(raw) {
  const lines = raw.split('\n');
  const out = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (!m) {
      i++;
      continue;
    }
    const key = m[1];
    const val = m[2].trim();
    i++;
    if (/^[>|][+-]?$/.test(val)) {
      const folded = val[0] === '>';
      const block = [];
      while (i < lines.length && (/^\s/.test(lines[i]) || lines[i].trim() === '')) block.push(lines[i++]);
      const indent = Math.min(
        ...block.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length),
        Infinity,
      );
      const cut = block.map((l) => (Number.isFinite(indent) ? l.slice(indent) : l));
      const joined = cut.join('\n');
      out[key] = (
        folded
          ? joined
              .split(/\n{2,}/)
              .map((p) => p.replace(/\n/g, ' '))
              .join('\n')
          : joined
      ).trim();
    } else if (val === '') {
      const items = [];
      while (i < lines.length && /^\s*-\s+/.test(lines[i])) {
        items.push(unquote(stripComment(lines[i].replace(/^\s*-\s+/, ''))));
        i++;
      }
      out[key] = items.length ? items : '';
    } else if (val.startsWith('[')) {
      let buf = val;
      while (!buf.includes(']') && i < lines.length) buf += ' ' + lines[i++].trim();
      const inner = buf.slice(1, buf.lastIndexOf(']') === -1 ? undefined : buf.lastIndexOf(']'));
      out[key] = splitTop(inner, (ch) => ch === ',');
    } else {
      out[key] = unquote(stripComment(val));
    }
  }
  return out;
}

/** @returns {{data: object, body: string, error?: string}} */
export function parseFrontmatter(text) {
  const t = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const m = t.match(/^---\n([\s\S]*?)(?:\n|^)---[ \t]*(?:\n|$)/);
  if (!m) return { data: {}, body: t, error: 'missing or unclosed frontmatter' };
  return { data: parseYaml(m[1]), body: t.slice(m[0].length) };
}
