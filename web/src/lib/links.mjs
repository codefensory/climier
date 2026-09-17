/**
 * links.mjs — markdown link layer for the climier docs site.
 *
 * `linkifyMarkdown(body, manifest)` converts inline-code repo path references
 * (`` `docs/x.md` ``, `` `.adrs/021-x.md#anchor` ``) into site links whose text keeps
 * the code formatting: `` [`docs/x.md`](/x) ``. Everything else in the corpus passes
 * through byte-identical.
 *
 * The function is dependency-free, pure and deterministic: it receives the content
 * manifest as an argument (only `manifest.byPath(path) -> page|null` is consulted)
 * and never touches the filesystem. It is idempotent — `f(f(x)) === f(x)` — because
 * the span produced by a hit lives inside a new markdown link, and inline links are
 * never re-processed.
 *
 * Block-level rules:
 *  - fenced code blocks (``` or ~~~, with or without info strings, closing fences
 *    must use the same character and be at least as long as the opening one) are
 *    never entered;
 *  - indented (4-space) code blocks are never entered; as a one-sided-safe
 *    approximation, a 4-space-indented line is only treated as a lazy paragraph
 *    continuation (and therefore linkified) when the previous line was paragraph-ish
 *    inline content and the line itself does not look like a fence opener;
 *  - reference definitions (`[id]: url`), HTML block lines and autolinks are skipped.
 *
 * Inline rules:
 *  - only backtick code spans (including double-backtick spans) are considered, and
 *    only when their entire content resolves: optional leading `./` stripped, optional
 *    trailing `#anchor` split off, remainder looked up via `byPath`. Resolution trims
 *    surrounding whitespace, matching how CommonMark renders such spans;
 *  - on a miss the span stays byte-identical (unknown path, anchor over unknown base,
 *    case-sensitive `.md`, empty path);
 *  - existing markdown links `[text](url)` (including their inner code spans), images
 *    `![alt](url)` and reference links `[text][id]` are opaque — nothing inside them
 *    is touched. This is what makes the transform idempotent.
 */

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const INDENTED_RE = /^ {4,}/;
const INDENTED_FENCE_RE = /^ {4,}(`{3,}|~{3,})/;
const REF_DEF_RE = /^ {0,3}\[[^\]\n]*\]:/;
const HTML_BLOCK_RE = /^ {0,3}<[a-zA-Z/!?]/;
const ATX_HEADING_RE = /^ {0,3}#{1,6}(\s|$)/;
const THEMATIC_BREAK_RE = /^ {0,3}([-*_])( *\1){2,}\s*$/;
const TABLE_ROW_RE = /^ {0,3}\|/;
const LIST_ITEM_TEXT_RE = /^ {0,3}(?:[-+*]|\d{1,9}[.)])\s+\S/;
const BLOCKQUOTE_RE = /^ {0,3}>/;
const AUTOLINK_URI_RE = /^<[a-zA-Z][a-zA-Z0-9+.-]*:[^ \t<>]*>/;
const AUTOLINK_EMAIL_RE = /^<[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}>/;

/** Length of the backtick run starting at `i`. */
function runLength(line, i) {
  let j = i;
  while (j < line.length && line[j] === '`') j += 1;
  return j - i;
}

/** Index of the next run of exactly `n` backticks at/after `from`, or -1. */
function findClosingRun(line, from, n) {
  let i = from;
  while (i < line.length) {
    if (line[i] === '`') {
      const len = runLength(line, i);
      if (len === n) return i;
      i += len;
    } else {
      i += 1;
    }
  }
  return -1;
}

/**
 * Resolve one code span's content against the manifest.
 * Returns the replacement (code-formatted link text) or the untouched raw span.
 */
function linkifiedSpan(content, run, raw, byPath) {
  const trimmed = content.trim();
  const hash = trimmed.indexOf('#');
  const anchor = hash === -1 ? '' : trimmed.slice(hash);
  const path = (hash === -1 ? trimmed : trimmed.slice(0, hash)).replace(/^\.\//, '');
  if (path === '' || !byPath) return raw;
  const page = byPath(path);
  const slug = page && typeof page.slug === 'string' ? page.slug : null;
  if (!slug) return raw;
  return `[${run}${content}${run}](${slug}${anchor})`;
}

/**
 * End index (exclusive) of the inline construct starting at the `[` at `start`:
 * `[text](dest)`, `![alt](dest)`, `[text][label]` — or -1 when there is none.
 * Code spans inside the text are skipped so their brackets stay invisible to the
 * bracket counter.
 */
function inlineConstructEnd(line, start) {
  let depth = 1;
  let i = start + 1;
  while (i < line.length) {
    const c = line[i];
    if (c === '\\') {
      i += 2;
    } else if (c === '`') {
      const run = runLength(line, i);
      const close = findClosingRun(line, i + run, run);
      i = close === -1 ? i + run : close + run;
    } else if (c === '[') {
      depth += 1;
      i += 1;
    } else if (c === ']') {
      depth -= 1;
      if (depth === 0) {
        if (line[i + 1] === '(') return parenEnd(line, i + 1);
        if (line[i + 1] === '[') return labelEnd(line, i + 1);
        return -1;
      }
      i += 1;
    } else {
      i += 1;
    }
  }
  return -1;
}

/** End index of `(...)` starting at the `(` at `start`, or -1 when unbalanced. */
function parenEnd(line, start) {
  let depth = 1;
  let i = start + 1;
  while (i < line.length) {
    const c = line[i];
    if (c === '\\') {
      i += 2;
    } else if (c === '(') {
      depth += 1;
      i += 1;
    } else if (c === ')') {
      depth -= 1;
      if (depth === 0) return i + 1;
      i += 1;
    } else {
      i += 1;
    }
  }
  return -1;
}

/** End index of `[...]` starting at the `[` at `start`, or -1 when unclosed. */
function labelEnd(line, start) {
  let depth = 1;
  let i = start + 1;
  while (i < line.length) {
    const c = line[i];
    if (c === '\\') {
      i += 2;
    } else if (c === '[') {
      depth += 1;
      i += 1;
    } else if (c === ']') {
      depth -= 1;
      if (depth === 0) return i + 1;
      i += 1;
    } else {
      i += 1;
    }
  }
  return -1;
}

/** Linkify one physical line's inline content. */
function processInline(line, byPath) {
  let out = '';
  let i = 0;
  const n = line.length;
  while (i < n) {
    const c = line[i];
    if (c === '\\') {
      const step = i + 1 < n ? 2 : 1;
      out += line.slice(i, i + step);
      i += step;
    } else if (c === '`') {
      const run = runLength(line, i);
      const close = findClosingRun(line, i + run, run);
      if (close === -1) {
        out += line.slice(i, i + run);
        i += run;
      } else {
        const content = line.slice(i + run, close);
        out += linkifiedSpan(content, '`'.repeat(run), line.slice(i, close + run), byPath);
        i = close + run;
      }
    } else if (c === '[' || (c === '!' && line[i + 1] === '[')) {
      const end = inlineConstructEnd(line, c === '[' ? i : i + 1);
      if (end !== -1) {
        out += line.slice(i, end);
        i = end;
      } else {
        out += c;
        i += 1;
      }
    } else if (c === '<') {
      const uri = AUTOLINK_URI_RE.exec(line.slice(i));
      const email = uri ? null : AUTOLINK_EMAIL_RE.exec(line.slice(i));
      const match = uri || email;
      if (match) {
        out += match[0];
        i += match[0].length;
      } else {
        out += c;
        i += 1;
      }
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/**
 * Would a non-indented line, once its inline content is linkified, still allow a
 * following 4-space-indented line to be a lazy paragraph continuation? False for
 * block starts that end a paragraph (headings, thematic breaks, table rows).
 */
function paragraphish(line) {
  if (ATX_HEADING_RE.test(line)) return false;
  if (THEMATIC_BREAK_RE.test(line)) return false;
  if (TABLE_ROW_RE.test(line)) return false;
  return true;
}

/**
 * Convert inline-code repo path references in `body` into site links using
 * `manifest.byPath`. String in, string out; idempotent.
 */
export function linkifyMarkdown(body, manifest) {
  if (typeof body !== 'string') {
    throw new TypeError('linkifyMarkdown: expected a string body');
  }
  const byPath = manifest && typeof manifest.byPath === 'function' ? manifest.byPath.bind(manifest) : null;
  if (body === '') return '';

  const out = [];
  let fence = null; // { char, len } while inside a fenced code block
  let prevInline = false; // previous line was paragraph-ish inline content
  for (const line of body.split('\n')) {
    if (fence !== null) {
      out.push(line);
      if (new RegExp(`^ {0,3}[${fence.char}]{${fence.len},}\\s*$`).test(line)) {
        fence = null;
        prevInline = false;
      }
      continue;
    }
    const open = FENCE_OPEN_RE.exec(line);
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      out.push(line);
      fence = { char: open[1][0], len: open[1].length };
      prevInline = false;
      continue;
    }
    if (INDENTED_RE.test(line)) {
      // Indented code block — unless this line is a lazy continuation of the
      // previous paragraph and cannot itself open a nested fence.
      if (prevInline && !INDENTED_FENCE_RE.test(line)) {
        out.push(processInline(line, byPath));
        prevInline = true;
      } else {
        out.push(line);
        prevInline = false;
      }
      continue;
    }
    if (
      line.trim() === '' ||
      REF_DEF_RE.test(line) ||
      HTML_BLOCK_RE.test(line)
    ) {
      out.push(line);
      prevInline = false;
      continue;
    }
    out.push(processInline(line, byPath));
    prevInline = paragraphish(line);
  }
  return out.join('\n');
}
