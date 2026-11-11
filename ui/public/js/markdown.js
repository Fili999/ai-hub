// Lightweight Markdown renderer for guide. Builds DOM nodes (never HTML strings) and remains safe with untrusted text.
// Supports: headings, paragraphs, lists (including ordered), tables, code blocks, blockquotes, horizontal rules, **bold**, *italic*, `code`, [link](url).
import { h } from './dom.js';

export const slug = (t) =>
  String(t)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const SAFE_URL = /^(https?:\/\/|#|\/(?!\/)|mailto:)/i;

/** Text → token list {t:'text'|'code'|'strong'|'em'|'link', text, href?} */
export function parseInline(src) {
  const out = [];
  let i = 0;
  let buf = '';
  const flush = () => {
    if (buf) out.push({ t: 'text', text: buf });
    buf = '';
  };
  while (i < src.length) {
    const rest = src.slice(i);
    let m;
    if (src[i] === '\\' && i + 1 < src.length && /[\\`*_{}\[\]()#+\-.!|<>]/.test(src[i + 1])) {
      buf += src[i + 1];
      i += 2;
    } else if (src[i] === '`' && (m = /^`([^`\n]+)`/.exec(rest))) {
      flush();
      out.push({ t: 'code', text: m[1] });
      i += m[0].length;
    } else if ((m = /^\*\*([^*\n]+?)\*\*/.exec(rest))) {
      flush();
      out.push({ t: 'strong', children: parseInline(m[1]) });
      i += m[0].length;
    } else if ((m = /^\*([^*\n]+?)\*/.exec(rest)) || (m = /^_([^_\n]+?)_(?![\w])/.exec(rest))) {
      flush();
      out.push({ t: 'em', children: parseInline(m[1]) });
      i += m[0].length;
    } else if ((m = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(rest))) {
      flush();
      out.push(SAFE_URL.test(m[2]) ? { t: 'link', href: m[2], children: parseInline(m[1]) } : { t: 'text', text: m[1] });
      i += m[0].length;
    } else if ((m = /^<(https?:\/\/[^>\s]+)>/.exec(rest))) {
      flush();
      out.push({ t: 'link', href: m[1], children: [{ t: 'text', text: m[1] }] });
      i += m[0].length;
    } else {
      buf += src[i++];
    }
  }
  flush();
  return out;
}

export function splitCells(line) {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = [];
  let cur = '';
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '\\' && t[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (t[i] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += t[i];
  }
  cells.push(cur.trim());
  return cells;
}

const isRule = (l) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(l);

/** Text → blocks {type, ...} */
export function parseMarkdown(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (/^\s*<!--/.test(line)) {
      while (i < lines.length && !/-->/.test(lines[i])) i++;
      i++;
      continue;
    }
    let m;
    if ((m = /^(```+)\s*([\w-]*)\s*$/.exec(line))) {
      const body = [];
      i++;
      while (i < lines.length && !lines[i].startsWith(m[1])) body.push(lines[i++]);
      i++;
      blocks.push({ type: 'code', lang: m[2], text: body.join('\n') });
    } else if ((m = /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line))) {
      blocks.push({ type: 'h', level: m[1].length, text: m[2], id: slug(m[2]) });
      i++;
    } else if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      blocks.push({ type: 'hr' });
      i++;
    } else if (line.includes('|') && i + 1 < lines.length && isRule(lines[i + 1])) {
      const head = splitCells(line);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitCells(lines[i++]));
      blocks.push({ type: 'table', head, rows });
    } else if (/^\s*>\s?/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      blocks.push({ type: 'quote', text: body.join(' ') });
    } else if (/^\s*[-*]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const re = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*]\s+/;
      const items = [];
      while (i < lines.length && re.test(lines[i])) {
        let item = lines[i++].replace(re, '');
        while (i < lines.length && lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && !re.test(lines[i])) item += ' ' + lines[i++].trim();
        items.push(item);
      }
      blocks.push({ type: ordered ? 'ol' : 'ul', items });
    } else {
      const body = [line.trim()];
      i++;
      while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*[-*]\s+|\s*\d+[.)]\s+|\s*>)/.test(lines[i]) && !(lines[i].includes('|') && isRule(lines[i + 1] ?? ''))) body.push(lines[i++].trim());
      blocks.push({ type: 'p', text: body.join(' ') });
    }
  }
  return blocks;
}

function inline(nodes) {
  return nodes.map((n) => {
    if (n.t === 'text') return n.text;
    if (n.t === 'code') return h('code', null, n.text);
    if (n.t === 'strong') return h('strong', null, inline(n.children));
    if (n.t === 'em') return h('em', null, inline(n.children));
    return h('a', { href: n.href, ...(n.href.startsWith('#') ? {} : { target: '_blank', rel: 'noopener noreferrer' }) }, inline(n.children));
  });
}

export const renderInline = (text) => inline(parseInline(text));

export function renderMarkdown(text) {
  const frag = document.createDocumentFragment();
  for (const b of parseMarkdown(text)) {
    if (b.type === 'h') frag.append(h(`h${Math.min(b.level + 0, 4)}`, { id: b.id }, renderInline(b.text)));
    else if (b.type === 'p') frag.append(h('p', null, renderInline(b.text)));
    else if (b.type === 'ul' || b.type === 'ol') frag.append(h(b.type, null, b.items.map((it) => h('li', null, renderInline(it)))));
    else if (b.type === 'code') frag.append(h('pre', null, h('code', null, b.text)));
    else if (b.type === 'quote') frag.append(h('blockquote', null, renderInline(b.text)));
    else if (b.type === 'hr') frag.append(h('hr'));
    else if (b.type === 'table') {
      frag.append(
        h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, b.head.map((c) => h('th', null, renderInline(c))))), h('tbody', null, b.rows.map((r) => h('tr', null, r.map((c) => h('td', null, renderInline(c)))))))),
      );
    }
  }
  return frag;
}

/** Table of contents: level 2 and 3 headings. */
export const outline = (text) => parseMarkdown(text).filter((b) => b.type === 'h' && b.level >= 2 && b.level <= 3).map((b) => ({ level: b.level, text: b.text.replace(/[`*_]/g, ''), id: b.id }));
