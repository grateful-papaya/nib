// smart-table.js
//
// Markdown block-parser extensions for the live preview: a backtick-only fenced
// code variant and a pipe-aware GFM table parser. Both are pure lezer/markdown
// extension descriptors — they operate on the parse context passed in at parse
// time and depend on nothing from the CodeMirror bundle, so no factory is
// needed. Consumed by getMarkdownExtensions() in markdown-preview.js.

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
