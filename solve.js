// Fast drop-in reimplementation of makefun-site 1.0.0.
//
// Written from scratch from the dialect's specification (front matter,
// Markdown subset, template dialect, slug rule, build report). It reads no
// clock, no environment, no randomness and no file: the output is a function
// of the input alone. No network, no WASM, no native code, no cache between
// cases — every call to run() builds from a fresh state.

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Code-unit order (never the locale's). */
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const hasOwn = (o, k) => Object.hasOwn(o, k);

/** The HTML escape table: & < > " ' and nothing else. */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `s` with the five HTML characters escaped. */
function esc(s) {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, each run
 * of characters other than a-z and 0-9 one "-", none at either end, at most
 * 64 characters (a "-" left at the cut dropped), "untitled" when empty.
 */
function slugify(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and recorded there): slug, slug-2, ... */
function uniqSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** The words of a body: its runs of characters other than whitespace. */
function countWords(text) {
  const m = text.match(/\S+/g);
  return m === null ? 0 : m.length;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

/** Days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysInMonth(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/**
 * A quoted or bare string value: quoted allows only \" and \\ escapes and no
 * other quote inside; bare is the rest of the line, never opening on " or [.
 */
function fmString(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += n;
        i++;
      } else if (c === '"') {
        return { error: 'a quoted string holds a stray quote' };
      } else {
        out += c;
      }
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why the source is refused. */
function fmValue(key, raw) {
  if (key === 'title' || key === 'summary') {
    const s = fmString(raw);
    return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
  }
  if (key === 'date') {
    const m = FM_DATE.exec(raw);
    const y = m ? Number(m[1]) : 0;
    const mo = m ? Number(m[2]) : 0;
    const d = m ? Number(m[3]) : 0;
    if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) {
      return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    }
    return { value: raw };
  }
  if (key === 'tags') {
    if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
    const inner = raw.slice(1, -1);
    if (inner.trim() === '') return { value: [] };
    const tags = inner.split(',').map((t) => t.trim());
    if (tags.some((t) => t === '' || !FM_TAG.test(t))) {
      return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
    }
    return { value: tags };
  }
  if (key === 'draft') {
    if (raw === 'true') return { value: true };
    if (raw === 'false') return { value: false };
    return { error: 'key "draft": true or false' };
  }
  if (key === 'layout') {
    return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
  }
  // slug
  return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
}

/**
 * A source's front matter and body ({ data, body }), or { error } with the
 * first reason it is refused, checked line by line. `text` has "\n" ends.
 */
function parseFM(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (/^[ \t]*$/.test(line) || line.startsWith('#')) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: lines.slice(close + 1).join('\n') };
}

// ---------------------------------------------------------------- Markdown

const MD_BLANK = /^[ \t]*$/;
const MD_FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const MD_FENCE_CLOSE = /^```[ \t]*$/;
const MD_HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const MD_HR = /^(?:---|\*\*\*)[ \t]*$/;
const MD_QUOTE = /^>/;
const MD_BULLET = /^[-*] (.*)$/;
const MD_ORDERED = /^(\d{1,9})\. (.*)$/;
const MD_CONTINUED = /^ {2,}\S/;

/** A heading line's depth and text, or null (heading text is never empty). */
function headingOf(line) {
  const m = MD_HEADING.exec(line);
  if (m === null || m[2] === '') return null;
  return { depth: m[1].length, text: m[2] };
}

/** Whether `line` ends a paragraph: blank, fence, heading or thematic break. */
function endsPara(line) {
  return MD_BLANK.test(line) || MD_FENCE_OPEN.test(line) || headingOf(line) !== null || MD_HR.test(line);
}

/** A line as rendered: spaces and tabs at either end dropped. */
const trimLine = (line) => line.replace(/^[ \t]+|[ \t]+$/g, '');

/**
 * `src`'s block tokens, in order. Token shapes:
 * { k: 'para', s }, { k: 'head', d, s }, { k: 'code', lang, lines },
 * { k: 'hr' }, { k: 'quote', lines }, { k: 'list', ord, start, items }.
 */
function lexMd(src) {
  const lines = src.split('\n');
  const tokens = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (MD_BLANK.test(line)) {
      i++;
      continue;
    }
    const fence = MD_FENCE_OPEN.exec(line);
    if (fence !== null) {
      const body = [];
      i++;
      while (i < lines.length && !MD_FENCE_CLOSE.test(lines[i])) body.push(lines[i++]);
      i++;
      tokens.push({ k: 'code', lang: fence[1], lines: body });
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      tokens.push({ k: 'head', d: heading.depth, s: heading.text });
      i++;
      continue;
    }
    if (MD_HR.test(line)) {
      tokens.push({ k: 'hr' });
      i++;
      continue;
    }
    if (MD_QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && MD_QUOTE.test(lines[i])) body.push(lines[i++].replace(/^> ?/, ''));
      tokens.push({ k: 'quote', lines: body.map(trimLine).filter((l) => l !== '') });
      continue;
    }
    const bullet = MD_BULLET.exec(line);
    const ordered = bullet === null ? MD_ORDERED.exec(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrd = ordered !== null;
      const marker = isOrd ? MD_ORDERED : MD_BULLET;
      const items = [];
      while (i < lines.length) {
        const m = marker.exec(lines[i]);
        if (m !== null) {
          items.push([trimLine(isOrd ? m[2] : m[1])]);
          i++;
        } else if (MD_CONTINUED.test(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else {
          break;
        }
      }
      tokens.push({
        k: 'list',
        ord: isOrd,
        start: isOrd ? Number(ordered[1]) : 1,
        items: items.map((parts) => parts.join('\n')),
      });
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < lines.length && !endsPara(lines[i])) body.push(trimLine(lines[i++]));
    tokens.push({ k: 'para', s: body.join('\n') });
  }
  return tokens;
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** First index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** First single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s` rendered inline; `link(target)` resolves a link's href. Plain text is
 * gathered into runs and escaped in one pass per run.
 */
function inlineMd(s, link) {
  const out = [];
  let lit = '';
  const flush = () => {
    if (lit !== '') {
      out.push(esc(lit));
      lit = '';
    }
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && ESCAPABLE.has(s[i + 1])) {
      flush();
      out.push(esc(s[i + 1]));
      i += 2;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        flush();
        out.push(`<code>${esc(s.slice(i + 1, j))}</code>`);
        i = j + 1;
      } else {
        lit += '`';
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          flush();
          out.push(`<strong>${inlineMd(s.slice(i + 2, j), link)}</strong>`);
          i = j + 2;
        } else {
          lit += '**';
          i += 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        flush();
        out.push(`<em>${inlineMd(s.slice(i + 1, j), link)}</em>`);
        i = j + 1;
      } else {
        lit += '*';
        i++;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        flush();
        out.push(`<a href="${esc(link(target))}">${inlineMd(s.slice(i + 1, k), link)}</a>`);
        i = m + 1;
        continue;
      }
      lit += '[';
      i++;
      continue;
    }
    lit += c;
    i++;
  }
  flush();
  return out.join('');
}

/**
 * `src` rendered: its HTML (each block followed by "\n"), its table of
 * contents (level 2 and 3 headings: level, id, html) and its excerpt (the
 * first paragraph's inline HTML, or "").
 */
function renderMd(src, link) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  for (const t of lexMd(src)) {
    if (t.k === 'head') {
      const id = uniqSlug(slugify(t.s), ids);
      const html = inlineMd(t.s, link);
      blocks.push(`<h${t.d} id="${id}">${html}</h${t.d}>`);
      if (t.d === 2 || t.d === 3) toc.push({ level: t.d, id, html });
    } else if (t.k === 'code') {
      const cls = t.lang === '' ? '' : ` class="language-${esc(t.lang)}"`;
      blocks.push(`<pre><code${cls}>${t.lines.map((l) => `${esc(l)}\n`).join('')}</code></pre>`);
    } else if (t.k === 'hr') {
      blocks.push('<hr>');
    } else if (t.k === 'quote') {
      blocks.push(
        t.lines.length === 0
          ? '<blockquote>\n</blockquote>'
          : `<blockquote>\n<p>${inlineMd(t.lines.join('\n'), link)}</p>\n</blockquote>`,
      );
    } else if (t.k === 'list') {
      const tag = t.ord ? 'ol' : 'ul';
      const open = t.ord && t.start !== 1 ? `<ol start="${t.start}">` : `<${tag}>`;
      blocks.push(`${open}\n${t.items.map((item) => `<li>${inlineMd(item, link)}</li>\n`).join('')}</${tag}>`);
    } else {
      const html = inlineMd(t.s, link);
      if (excerpt === null) excerpt = html;
      blocks.push(`<p>${html}</p>`);
    }
  }
  return { html: blocks.map((b) => `${b}\n`).join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- Templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const TPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TPL_IF = /^if (not )?(\S+)$/;
const TPL_INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathSegs(name, text) {
  if (!TPL_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/**
 * `src`'s tokens: text, {{ }}/{{{ }}} and {% %}; a {% %} tag alone on its
 * line takes the whole line with it, its newline included.
 */
function tokenizeTpl(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', s: text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathSegs(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone =
      /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', s: text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', s: text });
  return tokens;
}

/**
 * `src` parsed into its node tree (a TemplateError when it does not parse).
 * Node shapes: { k: 'text', s }, { k: 'var' | 'raw', path },
 * { k: 'for', name, path, body }, { k: 'if', not, path, then, els },
 * { k: 'inc', name }.
 */
function parseTpl(name, src) {
  const root = { k: 'root', body: [] };
  const stack = [root];
  let cur = root.body;
  for (const tok of tokenizeTpl(name, src)) {
    if (tok.t === 'text') {
      cur.push({ k: 'text', s: tok.s });
    } else if (tok.t === 'var' || tok.t === 'raw') {
      cur.push({ k: tok.t, path: tok.path });
    } else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = TPL_FOR.exec(tag)) !== null) {
        const node = { k: 'for', name: m[1], path: pathSegs(name, m[2]), body: [] };
        cur.push(node);
        stack.push(node);
        cur = node.body;
      } else if ((m = TPL_IF.exec(tag)) !== null) {
        const node = { k: 'if', not: m[1] !== undefined, path: pathSegs(name, m[2]), then: [], els: null };
        cur.push(node);
        stack.push(node);
        cur = node.then;
      } else if (tag === 'else') {
        if (top.k !== 'if' || top.els !== null) {
          throw new TemplateError(`template "${name}": an else outside an if`);
        }
        top.els = [];
        cur = top.els;
      } else if (tag === 'endfor' || tag === 'endif') {
        const want = tag === 'endfor' ? 'for' : 'if';
        if (top.k !== want) {
          throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        }
        stack.pop();
        const parent = stack[stack.length - 1];
        cur = parent.k === 'root' ? parent.body : parent.k === 'for' ? parent.body : (parent.els ?? parent.then);
      } else if ((m = TPL_INCLUDE.exec(tag)) !== null) {
        cur.push({ k: 'inc', name: m[1] });
      } else {
        throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
      }
    }
  }
  if (stack.length > 1) {
    throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].k} is not closed`);
  }
  return root.body;
}

/**
 * The value at `path` in the scope chain: its first name from the nearest
 * scope holding it, then own properties of the value so far.
 */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: string itself, a number's digits, true/false, an array's items joined by ", ", else "". */
function valText(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(valText).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function isTruthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered in `scope` ({ vars, parent }). `tpls` maps names to parsed
 * trees; `depth` is the include depth (top-level render is 0).
 */
function renderTpl(nodes, scope, tpls, depth) {
  const out = [];
  for (const n of nodes) {
    if (n.k === 'text') {
      out.push(n.s);
    } else if (n.k === 'var') {
      out.push(esc(valText(lookup(scope, n.path))));
    } else if (n.k === 'raw') {
      out.push(valText(lookup(scope, n.path)));
    } else if (n.k === 'if') {
      const branch = isTruthy(lookup(scope, n.path)) !== n.not ? n.then : n.els;
      if (branch !== null) out.push(renderTpl(branch, scope, tpls, depth));
    } else if (n.k === 'for') {
      const xs = lookup(scope, n.path);
      if (Array.isArray(xs)) {
        for (let k = 0; k < xs.length; k++) {
          // Element first, then loop: a loop variable named "loop" is
          // shadowed by the loop record, as the scope object is built.
          const vars = {};
          vars[n.name] = xs[k];
          vars.loop = { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length };
          out.push(renderTpl(n.body, { vars, parent: scope }, tpls, depth));
        }
      }
    } else if (n.k === 'inc') {
      const t = tpls.get(n.name);
      if (t !== undefined && depth < INCLUDE_DEPTH) out.push(renderTpl(t, scope, tpls, depth + 1));
    }
  }
  return out.join('');
}

// ---------------------------------------------------------------- the build

/** The top-level directories the generator writes itself. */
const RESERVED_DIRS = ['posts', 'tags', 'page'];

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` resolved from directory `dir`, or null when it climbs above the root. */
function resolveRel(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join('/');
}

/** A page's neighbour record as templates read it. */
function linkOf(s) {
  if (s === null) return null;
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
  };
}

/** One site's output tree: path -> text. */
export function run(input) {
  const report = [];
  const tpls = new Map();
  for (const name of Object.keys(input.templates).sort(cmp)) {
    try {
      tpls.set(name, parseTpl(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. Sources, in code-unit order of path; .md is a source, the rest static.
  const ordered = [...input.files].sort((x, y) => cmp(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of ordered) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter, in source order; refused and draft sources drop out.
  const kept = [];
  for (const s of sources) {
    const fm = parseFM(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    s.newer = null;
    s.older = null;
    const own = RESERVED_DIRS.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!tpls.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Permalinks: slug unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED_DIRS : []));
    return taken.get(dir);
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    s.slug = uniqSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown, links resolved to built pages and static files.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) {
        return target;
      }
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolveRel(dir, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMd(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections: posts newest first, equal dates by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => cmp(y.data.date, x.data.date) || cmp(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags: grouped by slug, named as first met in collection order.
  const bySlug = new Map();
  const ownTagNames = (s) => {
    const seen = new Set();
    return (s.data.tags ?? []).filter((name) => {
      const slug = slugify(name);
      if (seen.has(slug)) return false;
      seen.add(slug);
      return true;
    });
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTagNames(p)) {
      const slug = slugify(name);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTagNames(s).map(
        (name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] },
      );
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || cmp(x.slug, y.slug));

  // Cards and pages as templates read them.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(countWords(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer),
    older: linkOf(s.older),
    is_post: s.post,
  });

  // 7. Layouts: pages, index pages, tag pages, tags page, then statics.
  const output = {};
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const nodes = tpls.get(name);
    if (nodes === undefined) return null;
    return renderTpl(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, tpls, 0);
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pageCount = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pageCount; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: {
        number: k,
        total: pageCount,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pageCount ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: {
        name: t.name,
        slug: t.slug,
        url: t.url,
        count: t.posts.length,
        posts: t.posts.map((p) => cards.get(p)),
      },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every line reported above, sorted, then the counts.
  const lines = [...report, ...broken].sort(cmp);
  const pageTotal = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageTotal} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
