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
const ESC_RE = /[&<>"']/g;

/**
 * `s` with the five HTML characters escaped. One regex scan, literal runs
 * copied with slice — no per-match callback. (Never re-entered: esc calls
 * nothing that calls esc, so the shared regex's lastIndex is safe.)
 */
function esc(s) {
  ESC_RE.lastIndex = 0;
  let m;
  let out = '';
  let last = 0;
  while ((m = ESC_RE.exec(s)) !== null) {
    out += s.slice(last, m.index) + ESCAPES[m[0]];
    last = m.index + 1;
  }
  return last === 0 ? s : out + s.slice(last);
}

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, each run
 * of characters other than a-z and 0-9 one "-", none at either end, at most
 * 64 characters (a "-" left at the cut dropped), "untitled" when empty.
 * For pure-ASCII input NFKD is the identity and there is no combining mark,
 * so the normalize step is skipped — the result is exactly the same.
 */
function slugify(text) {
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) {
      ascii = false;
      break;
    }
  }
  const plain = ascii ? text : text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
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

/** Whether code unit `c` is whitespace in the sense of /\s/ (no /u flag). */
function isSpace(c) {
  if (c < 128) return c === 32 || (c >= 9 && c <= 13);
  return (
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

/** The words of one line: its runs of characters other than whitespace. */
function lineWords(line) {
  let n = 0;
  let inWord = false;
  for (let j = 0; j < line.length; j++) {
    if (isSpace(line.charCodeAt(j))) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
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
 * A source's front matter ({ data, bodyFrom }) — `bodyFrom` is the index of
 * the first body line in `lines` — or { error } with the first reason it is
 * refused, checked line by line. `lines` is the source split on "\n".
 */
function parseFM(lines) {
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
  return { data, bodyFrom: close + 1 };
}

// ---------------------------------------------------------------- Markdown

/** Whether `line` is empty or only spaces/tabs. */
function isBlank(line) {
  for (let j = 0; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `c` may appear in a fence's language tag. */
function isLangChar(c) {
  return (
    (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45
  );
}

/** A fence-opening line's language, or null (``` + [A-Za-z0-9_+-]* + spaces/tabs). */
function fenceOpen(line) {
  if (!line.startsWith('```')) return null;
  let j = 3;
  while (j < line.length && isLangChar(line.charCodeAt(j))) j++;
  const lang = line.slice(3, j);
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return null;
    j++;
  }
  return lang;
}

/** Whether `line` closes a fence (``` + spaces/tabs only). */
function fenceClose(line) {
  if (!line.startsWith('```')) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's depth and text, or null (heading text is never empty). */
function headingOf(line) {
  let d = 0;
  while (d < 6 && line.charCodeAt(d) === 35) d++;
  if (d === 0) return null;
  const c = line.charCodeAt(d);
  if (c !== 32 && c !== 9) return null;
  let s = d;
  while (s < line.length && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  let e = line.length;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e === s) return null;
  return { depth: d, text: line.slice(s, e) };
}

/** Whether `line` is a thematic break (--- or *** + spaces/tabs only). */
function isHr(line) {
  if (line.length < 3) return false;
  const c = line.charCodeAt(0);
  if (c !== 45 && c !== 42) return false;
  if (!line.startsWith(c === 45 ? '---' : '***')) return false;
  for (let j = 3; j < line.length; j++) {
    const cc = line.charCodeAt(j);
    if (cc !== 32 && cc !== 9) return false;
  }
  return true;
}

/** A bullet line's item text, or null (- or * + exactly one space). */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered-list line's number and item text, or null (1-9 digits + ". "). */
function orderedOf(line) {
  let j = 0;
  while (j < 9 && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
  if (j === 0 || line.charCodeAt(j) !== 46 || line.charCodeAt(j + 1) !== 32) return null;
  return { num: line.slice(0, j), text: line.slice(j + 2) };
}

/** Whether `line` continues a list item (>= 2 spaces, then a non-whitespace char). */
function isContinued(line) {
  let j = 0;
  while (line.charCodeAt(j) === 32) j++;
  if (j < 2) return false;
  const c = line.charCodeAt(j);
  return c !== 9 && c !== 11 && c !== 12 && c !== 13 && !Number.isNaN(c);
}

/** Whether `line` ends a paragraph: blank, fence, heading or thematic break. */
function endsPara(line) {
  return isBlank(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHr(line);
}

/** A line as rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/**
 * The body lines `lines[from..]` rendered in a single pass: its HTML (each
 * block followed by "\n"), its table of contents (level 2 and 3 headings:
 * level, id, html), its excerpt (the first paragraph's inline HTML, or "")
 * and its word count (runs of non-whitespace in the raw body lines — counted
 * here, in the render pass, instead of a second scan later). No token
 * objects are built; blocks render straight into the output array.
 */
function renderMd(lines, from, link) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let words = 0;
  for (let li = from; li < lines.length; li++) words += lineWords(lines[li]);
  const n = lines.length;
  let i = from;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const fenceLang = fenceOpen(line);
    if (fenceLang !== null) {
      const cls = fenceLang === '' ? '' : ` class="language-${esc(fenceLang)}"`;
      const cl = [];
      i++;
      while (i < n && !fenceClose(lines[i])) cl.push(`${esc(lines[i++])}\n`);
      i++;
      blocks.push(`<pre><code${cls}>${cl.join('')}</code></pre>\n`);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqSlug(slugify(heading.text), ids);
      const html = inlineMd(heading.text, link);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) {
      blocks.push('<hr>\n');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        body.push(lines[i].charCodeAt(1) === 32 ? lines[i].slice(2) : lines[i].slice(1));
        i++;
      }
      const q = body.map(trimLine).filter((l) => l !== '');
      blocks.push(
        q.length === 0
          ? '<blockquote>\n</blockquote>\n'
          : `<blockquote>\n<p>${inlineMd(q.join('\n'), link)}</p>\n</blockquote>\n`,
      );
      continue;
    }
    const bullet = bulletOf(line);
    const ordered = bullet === null ? orderedOf(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrd = ordered !== null;
      const start = isOrd ? Number(ordered.num) : 1;
      const items = [];
      while (i < n) {
        const cur = lines[i];
        if (isOrd) {
          const m = orderedOf(cur);
          if (m !== null) {
            items.push([trimLine(m.text)]);
            i++;
            continue;
          }
        } else {
          const m = bulletOf(cur);
          if (m !== null) {
            items.push([trimLine(m)]);
            i++;
            continue;
          }
        }
        if (isContinued(cur)) {
          items[items.length - 1].push(trimLine(cur));
          i++;
        } else {
          break;
        }
      }
      const tag = isOrd ? 'ol' : 'ul';
      const open = isOrd && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let listHtml = `${open}\n`;
      for (const parts of items) listHtml += `<li>${inlineMd(parts.join('\n'), link)}</li>\n`;
      blocks.push(`${listHtml}</${tag}>\n`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsPara(lines[i])) body.push(trimLine(lines[i++]));
    const html = inlineMd(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>\n`);
  }
  return { html: blocks.join(''), toc, excerpt: excerpt ?? '', words };
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

/** First index from `from` where `s` holds one of \ ` * [ , or -1. */
const INLINE_SPECIALS = ['\\', '`', '*', '['];
function nextSpecial(s, from) {
  let j = -1;
  for (const sp of INLINE_SPECIALS) {
    const k = s.indexOf(sp, from);
    if (k !== -1 && (j === -1 || k < j)) j = k;
  }
  return j;
}

/**
 * `s` rendered inline; `link(target)` resolves a link's href. Literal runs
 * between the special characters are copied whole and escaped in one pass.
 */
function inlineMd(s, link) {
  const out = [];
  let i = 0;
  while (true) {
    const j = nextSpecial(s, i);
    if (j === -1) {
      if (i < s.length) out.push(esc(s.slice(i)));
      break;
    }
    if (j > i) out.push(esc(s.slice(i, j)));
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      // Of the escapable characters only '>' is one of the five escaped.
      out.push(s[j + 1] === '>' ? '&gt;' : s[j + 1]);
      i = j + 2;
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        out.push(`<code>${esc(s.slice(j + 1, k))}</code>`);
        i = k + 1;
      } else {
        out.push('`');
        i = j + 1;
      }
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          out.push(`<strong>${inlineMd(s.slice(j + 2, k), link)}</strong>`);
          i = k + 2;
        } else {
          out.push('**');
          i = j + 2;
        }
        continue;
      }
      const k = findSingleStar(s, j + 1);
      if (k > j + 1) {
        out.push(`<em>${inlineMd(s.slice(j + 1, k), link)}</em>`);
        i = k + 1;
      } else {
        out.push('*');
        i = j + 1;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', j + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        out.push(`<a href="${esc(link(target))}">${inlineMd(s.slice(j + 1, k), link)}</a>`);
        i = m + 1;
        continue;
      }
      out.push('[');
      i = j + 1;
      continue;
    }
    // A backslash before a non-escapable character is itself literal.
    out.push('\\');
    i = j + 1;
  }
  return out.join('');
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

/** Whether `target` opens with a scheme ([A-Za-z][A-Za-z0-9+.-]*:). */
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let j = 1; j < target.length; j++) {
    const c = target.charCodeAt(j);
    if (c === 58) return true;
    if (
      !((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)
    ) {
      return false;
    }
  }
  return false;
}
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
    const lines = s.text.split('\n');
    const fm = parseFM(lines);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.lines = lines;
    s.bodyFrom = fm.bodyFrom;
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
  // Resolved link targets, per source directory: target -> URL, or null
  // when broken. The broken-link report is still recorded per (source,
  // target) — the cache only skips re-resolving, never re-reporting.
  const linkCache = new Map();
  for (const s of kept) {
    const dir = dirOf(s.path);
    let byDir = linkCache.get(dir);
    if (byDir === undefined) {
      byDir = new Map();
      linkCache.set(dir, byDir);
    }
    const link = (target) => {
      if (hasScheme(target) || target.startsWith('/') || target.startsWith('#')) {
        return target;
      }
      let url = byDir.get(target);
      if (url === undefined) {
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolveRel(dir, rel);
        if (path !== null && bySource.has(path)) url = `${bySource.get(path).url}${frag}`;
        else if (path !== null && staticPaths.has(path)) url = `${base}/${path}${frag}`;
        else url = null;
        byDir.set(target, url);
      }
      if (url === null) {
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      }
      return url;
    };
    const md = renderMd(s.lines, s.bodyFrom, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = md.words;
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
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
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
