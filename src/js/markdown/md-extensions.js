// md-extensions.js
//
// Every lezer/markdown grammar extension Nib adds on top of GFM:
//
//   backtickOnlyFence  fenced code that ignores "~~~"
//   smartTable         pipe-aware table parser that tolerates image widths
//   highlight          ==marked text==
//   footnotes          [^label] references and [^label]: definitions
//
// All of them are pure extension descriptors — they operate on the parse
// context handed in at parse time and depend on nothing from the CodeMirror
// bundle, so no factory is needed. The nodes they define carry no highlight
// style: scanner.js decorates them by node name, the same way it handles the
// built-in marks. Consumed by getMarkdownExtensions() in markdown-preview.js.

export const backtickOnlyFence = {
  parseBlock: [
    {
      name: "FencedCode",
      parse(cx, line) {
        if (line.next != 96) return false; // 96 = '`' ; ignore '~' (126)
        let pos = line.pos + 1;
        while (pos < line.text.length && line.text.charCodeAt(pos) == 96) pos++;
        const len = pos - line.pos;
        if (len < 3) return false;
        for (let i = pos; i < line.text.length; i++)
          if (line.text.charCodeAt(i) == 96) return false; // no ` in info
        const from = cx.lineStart + line.pos;
        const marks = [cx.elt("CodeMark", from, from + len)];
        const infoFrom = line.skipSpace(pos);
        const infoTo = line.text.length;
        if (infoFrom < infoTo)
          marks.push(
            cx.elt("CodeInfo", cx.lineStart + infoFrom, cx.lineStart + infoTo),
          );
        for (
          let first = true;
          cx.nextLine() && line.depth >= cx.stack.length;
          first = false
        ) {
          let i = line.pos;
          if (line.indent - line.baseIndent < 4)
            while (i < line.text.length && line.text.charCodeAt(i) == 96) i++;
          if (i - line.pos >= len && line.skipSpace(i) == line.text.length) {
            marks.push(
              cx.elt("CodeMark", cx.lineStart + line.pos, cx.lineStart + i),
            );
            cx.nextLine();
            break;
          } else {
            const ts = cx.lineStart + line.basePos;
            const te = cx.lineStart + line.text.length;
            if (ts < te) marks.push(cx.elt("CodeText", ts, te));
          }
        }
        cx.addElement(cx.elt("FencedCode", from, cx.prevLineEnd(), marks));
        return true;
      },
      before: "FencedCode",
    },
  ],
  remove: ["FencedCode"],
};

// Pipe-aware GFM table parser. The stock parser treats ANY line with a "|"
// as a possible table header/row — including an image line that carries our
// resize width, "![alt|300](src)". With no blank line between that image and
// a table below, the parser glues them into one malformed table and the real
// table never forms (so it renders as raw text). This is a faithful clone of
// @lezer/markdown's Table extension with one change: "|" inside an image's
// "![ … ]" alt span is ignored when deciding whether a line is table-ish.
export const TABLE_DELIM_RE = /^\|?(\s*:?-+:?\s*\|)+(\s*:?-+:?\s*)?$/;
export const hasTablePipe = (str, start) => {
  for (let i = start; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    if (ch === 92 /* \ */) {
      i++;
      continue;
    }
    if (ch === 33 /* ! */ && str[i + 1] === "[") {
      let j = i + 2,
        depth = 1;
      while (j < str.length && depth > 0) {
        if (str.charCodeAt(j) === 92) {
          j += 2;
          continue;
        }
        if (str[j] === "[") depth++;
        else if (str[j] === "]") {
          depth--;
          if (depth === 0) break;
        }
        j++;
      }
      if (j < str.length && str[j] === "]" && str[j + 1] === "(") {
        i = j; // skip the alt span; its pipes don't count
        continue;
      }
    }
    if (ch === 124 /* | */) return true;
  }
  return false;
};
export const parseTableRow = (cx, line, startI, elts, offset) => {
  let count = 0,
    first = true,
    cellStart = -1,
    cellEnd = -1,
    esc = false;
  const parseCell = () =>
    elts.push(
      cx.elt(
        "TableCell",
        offset + cellStart,
        offset + cellEnd,
        cx.parser.parseInline(
          line.slice(cellStart, cellEnd),
          offset + cellStart,
        ),
      ),
    );
  for (let i = startI; i < line.length; i++) {
    const next = line.charCodeAt(i);
    if (next === 124 && !esc) {
      if (!first || cellStart > -1) count++;
      first = false;
      if (elts) {
        if (cellStart > -1) parseCell();
        elts.push(cx.elt("TableDelimiter", i + offset, i + offset + 1));
      }
      cellStart = cellEnd = -1;
    } else if (esc || (next !== 32 && next !== 9)) {
      if (cellStart < 0) cellStart = i;
      cellEnd = i + 1;
    }
    esc = !esc && next === 92;
  }
  if (cellStart > -1) {
    count++;
    if (elts) parseCell();
  }
  return count;
};
export class SmartTableParser {
  constructor() {
    this.rows = null;
  }
  nextLine(cx, line, leaf) {
    if (this.rows == null) {
      this.rows = false;
      let lineText;
      if (
        (line.next === 45 || line.next === 58 || line.next === 124) &&
        TABLE_DELIM_RE.test((lineText = line.text.slice(line.pos)))
      ) {
        const firstRow = [];
        const firstCount = parseTableRow(
          cx,
          leaf.content,
          0,
          firstRow,
          leaf.start,
        );
        if (firstCount === parseTableRow(cx, lineText, 0))
          this.rows = [
            cx.elt(
              "TableHeader",
              leaf.start,
              leaf.start + leaf.content.length,
              firstRow,
            ),
            cx.elt(
              "TableDelimiter",
              cx.lineStart + line.pos,
              cx.lineStart + line.text.length,
            ),
          ];
      }
    } else if (this.rows) {
      const content = [];
      parseTableRow(cx, line.text, line.pos, content, cx.lineStart);
      this.rows.push(
        cx.elt(
          "TableRow",
          cx.lineStart + line.pos,
          cx.lineStart + line.text.length,
          content,
        ),
      );
    }
    return false;
  }
  finish(cx, leaf) {
    if (!this.rows) return false;
    cx.addLeafElement(
      leaf,
      cx.elt("Table", leaf.start, leaf.start + leaf.content.length, this.rows),
    );
    return true;
  }
}
export const smartTable = {
  parseBlock: [
    {
      name: "Table",
      leaf: (_, leaf) =>
        hasTablePipe(leaf.content, 0) ? new SmartTableParser() : null,
      endLeaf(cx, line, leaf) {
        if (
          leaf.parsers.some((p) => p instanceof SmartTableParser) ||
          !hasTablePipe(line.text, line.basePos)
        )
          return false;
        const next = cx.peekLine();
        return (
          TABLE_DELIM_RE.test(next) &&
          parseTableRow(cx, line.text, line.basePos) ===
            parseTableRow(cx, next, line.basePos)
        );
      },
      before: "SetextHeading",
    },
  ],
  remove: ["Table"],
};

// ── Highlight: ==marked text== ────────────────────────────────────────────
// Modeled on @lezer/markdown's own Strikethrough: a two-character delimiter
// resolved by the shared emphasis machinery, so nesting, escaping and
// "can this open/close here" all behave exactly like ** and ~~ do.
//
// The flanking rules are what keep prose safe: "a == b" has whitespace on both
// sides, so the run can neither open nor close and stays literal text. Only a
// delimiter tight against the marked text ("==like this==") forms a node.
const PUNCTUATION =
  /[!"#$%&'()*+,\-.\/:;<=>?@\[\\\]^_`{|}~\xA1\u2010-\u2027\u2030-\u205E]/;

const HighlightDelim = { resolve: "Highlight", mark: "HighlightMark" };

export const highlight = {
  defineNodes: ["Highlight", "HighlightMark"],
  parseInline: [
    {
      name: "Highlight",
      parse(cx, next, pos) {
        // Exactly two "=" — a third means something else entirely (a setext
        // rule, or the "==>" arrow glyph), so leave those alone.
        if (next != 61 /* = */ || cx.char(pos + 1) != 61 || cx.char(pos + 2) == 61)
          return -1;
        const before = cx.slice(pos - 1, pos);
        const after = cx.slice(pos + 2, pos + 3);
        const spaceBefore = /\s|^$/.test(before);
        const spaceAfter = /\s|^$/.test(after);
        const punctBefore = PUNCTUATION.test(before);
        const punctAfter = PUNCTUATION.test(after);
        return cx.addDelimiter(
          HighlightDelim,
          pos,
          pos + 2,
          !spaceAfter && (!punctAfter || spaceBefore || punctBefore), // can open
          !spaceBefore && (!punctBefore || spaceAfter || punctAfter), // can close
        );
      },
      after: "Emphasis",
    },
  ],
};

// ── Footnotes: [^label] and [^label]: … ───────────────────────────────────
// Only the REFERENCE is a grammar extension. It has to run before the built-in
// link parser, which would otherwise swallow "[^1]" as a shortcut reference
// link. A definition is just a line that begins with a reference followed by
// ":", so it needs no block parser: scanner.js recognizes the line shape and
// styles it in place, which is also what keeps definitions where the author
// wrote them rather than relocating them to the bottom of the document.
//
// The label is taken literally (no nested brackets, no line breaks), matching
// GFM. An empty "[^]" is not a footnote.
export const footnotes = {
  defineNodes: ["FootnoteRef", "FootnoteMark", "FootnoteLabel"],
  parseInline: [
    {
      name: "FootnoteRef",
      parse(cx, next, pos) {
        if (next != 91 /* [ */ || cx.char(pos + 1) != 94 /* ^ */) return -1;
        let i = pos + 2;
        for (; i < cx.end; i++) {
          const ch = cx.char(i);
          if (ch == 93 /* ] */) break;
          if (ch == 91 /* [ */ || ch == 10 /* \n */) return -1;
        }
        if (i >= cx.end || i == pos + 2) return -1; // unterminated or empty
        return cx.addElement(
          cx.elt("FootnoteRef", pos, i + 1, [
            cx.elt("FootnoteMark", pos, pos + 2),
            cx.elt("FootnoteLabel", pos + 2, i),
            cx.elt("FootnoteMark", i, i + 1),
          ]),
        );
      },
      before: "Link",
    },
  ],
};
