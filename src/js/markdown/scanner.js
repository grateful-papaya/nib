// scanner.js
//
// Scan once per document, assemble per selection.
//
// All document-derived analysis (tree walks, regex passes, widget
// construction) happens exactly once per (doc, syntax-tree) pair and is cached
// as prebuilt decoration Ranges. A selection change only re-assembles the final
// set from that cache. Each cached item is one of:
//
//   always      shown regardless of the selection (list indents, computed
//               markers, blockquote bars, image widgets)
//   lineItems   { ln, off } — `off` is emitted unless the selection touches
//               line `ln` (heading "#", HR, quote marks)
//   rangeItems  { tFrom, tTo, on, off } — `off` (rendered) is emitted unless
//               the selection touches [tFrom, tTo], else `on` (editing)
//
// assemble() computes a signature — first/last selected line plus a
// touched-bitmap over rangeItems — and returns null when it matches the
// previous one, so a drag that doesn't change any reveal state costs a few
// integer comparisons and zero DOM work.
//
// The glyph table, the ordered-list numbering and the small scan helpers live
// here rather than in modules of their own: this file is their main consumer
// (math-field.js reuses three helpers), and nothing here imports CodeMirror at
// module scope, so the pure parts stay directly testable under node.

// ── Shared scan helpers (also used by math-field.js) ──────────────────────

// Immutable "no decorations" sentinel. Consumers only read it, so one frozen
// instance saves an allocation per scanned item.
export const EMPTY = Object.freeze([]);

export function sameBits(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Sequential line walk. doc.line(n) is a fresh O(log n) descent per call and
// the scans touch every line, so iterLines streams them in one pass instead.
// Line breaks in a Text are always "\n", so the running offset is exact. Falls
// back to the indexed API if the bundle predates iterLines.
export function eachLine(doc, fn) {
  if (typeof doc.iterLines === "function") {
    let from = 0;
    for (const text of doc.iterLines()) {
      fn(text, from);
      from += text.length + 1;
    }
    return;
  }
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    fn(line.text, line.from);
  }
}

// ── Glyph substitution table ──────────────────────────────────────────────

const GLYPHS = [
  ["-->", "\u27f6"],
  ["<--", "\u27f5"],
  ["==>", "\u27f9"],
  ["<==", "\u27f8"],
  ["->", "\u2192"],
  ["<-", "\u2190"],
  ["=>", "\u21d2"],
  ["<=", "\u21d0"],
  ["=<", "\u2264"],
  [">=", "\u2265"],
  ["!=", "\u2260"],
];

const GLYPH_MAP = new Map(GLYPHS);
const GLYPH_RE = new RegExp(
  GLYPHS.map(([s]) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
  "g",
);

// Bidirectional arrows: "<" + a run of "-" (or "=") + ">".
//   run 1..2   one glyph   (<->, <--> -> arrow ; <=>, <==> -> double arrow)
//   run >= 3   only the two ends convert and the middle dashes stay raw text.
//              No single glyph is wide enough for 3+, and splitting the ends
//              keeps the reveal symmetric.
const BIARROW_RE = /<(-+|=+)>/g;
const biSingle = (dash, n) =>
  dash ? (n === 1 ? "\u2194" : "\u27f7") : n === 1 ? "\u21d4" : "\u27fa";
const biLeft = (dash) => (dash ? "\u2190" : "\u21d0");
const biRight = (dash) => (dash ? "\u2192" : "\u21d2");

// ── Line-shape regexes ────────────────────────────────────────────────────

// Any "N. " / "N) " / "- " / "* " / "+ " marker at the start of a line.
const LIST_LINE_RE = /^\s*(?:[-*+]|\d+[.)])\s/;
const TASK_LINE_RE = /^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]/;
const ORDERED_MARK_RE = /^(\d+)([.)])$/;

// Nodes an inline mark can be wrapped by; used to resolve the OUTERMOST one.
const WRAP = new Set([
  "Emphasis",
  "StrongEmphasis",
  "Strikethrough",
  "InlineCode",
  "Link",
  "Image",
]);

const INLINE_MARKS = new Set([
  "EmphasisMark",
  "StrikethroughMark",
  "CodeMark",
  "LinkMark",
  "URL",
]);

// ── Hierarchical ordered-list labels ──────────────────────────────────────
// Pure (a Text + a SyntaxTree in, plain objects out), so the numbering rules
// are unit-testable on their own.
//
// Walks the tree with a stack of list frames and returns one computed label per
// ordered ListMark: top level -> "N." (or "N)"), ordered nested in ordered ->
// dotted paths "N.M", "N.M.K".
//
//   - A BulletList BREAKS the dotted chain: an ordered list nested under a
//     bullet list numbers independently from "1.", like CommonMark renderers,
//     instead of inheriting the outer ordered ancestors' path.
//   - The first item's literal seeds the counter, so "5. a / 6. b" renders
//     5., 6. (CommonMark honors the start number; later items are renumbered).
//   - The lazy-continuation restart (a flush-left paragraph folded into the
//     list) restarts from the marker's own literal rather than forcing 1.
export function computeOrderedLabels(doc, tree) {
  const out = [];
  const frames = []; // { ol: true, count: number|null } | { ol: false }

  tree.iterate({
    enter(node) {
      const name = node.name;
      if (name === "OrderedList") {
        frames.push({ ol: true, count: null });
        return;
      }
      if (name === "BulletList") {
        frames.push({ ol: false });
        return;
      }
      if (name !== "ListMark" || frames.length === 0) return;

      const top = frames[frames.length - 1];
      if (!top.ol) return; // bullet marker: handled by the main scan
      const m = ORDERED_MARK_RE.exec(doc.sliceString(node.from, node.to));
      if (!m) return;

      // Restart top-level numbering after a flush-left, blank-line-less
      // paragraph that CommonMark folds into the list as lazy continuation
      // ("1.…5." + "asdf" + "1." parses as ONE list, so the last marker would
      // otherwise continue as "6."). Nested markers are always indented, so
      // they never reset.
      const markLine = doc.lineAt(node.from);
      if (frames.length === 1 && markLine.number > 1) {
        const prev = doc.line(markLine.number - 1).text;
        if (!/^\s*$/.test(prev) && !LIST_LINE_RE.test(prev) && !/^\s/.test(prev))
          top.count = null; // reseed from this marker's literal below
      }

      top.count = top.count == null ? parseInt(m[1], 10) : top.count + 1;

      // Label = the trailing run of ordered frames, ended by the marker's own
      // delimiter: "2." / "2)" at the top level, "2.2." when nested.
      let i = frames.length;
      while (i > 0 && frames[i - 1].ol) i--;
      let label = "";
      for (let j = i; j < frames.length; j++)
        label += (j > i ? "." : "") + frames[j].count;
      out.push({ from: node.from, to: node.to, label: label + m[2] });
    },
    leave(node) {
      if (node.name === "OrderedList" || node.name === "BulletList")
        frames.pop();
    },
  });

  return out;
}

// ── Scanner ───────────────────────────────────────────────────────────────

export function createScanner({ Decoration, deco, widgets, isReadMode }) {
  const {
    hideDeco,
    emphMarkDeco,
    notLinkDeco,
    markerDeco,
    glyphDeco,
    quoteLineDeco,
    hrLineDeco,
    listLineDeco,
    fenceLineDeco,
    codeLineDeco,
    codeFirstDeco,
    codeLastDeco,
    codeSoloDeco,
    codeLineRenderedDeco,
    codeFirstPadDeco,
    codeLastPadDeco,
    codeSoloPadDeco,
  } = deco;
  const { LangLabelWidget, CheckboxWidget, ImageWidget } = widgets;

  // First URL child of a Link/Image node, or "".
  const childUrl = (node, doc) => {
    const c = node.node.cursor();
    if (c.firstChild()) {
      do {
        if (c.name === "URL") return doc.sliceString(c.from, c.to);
      } while (c.nextSibling());
    }
    return "";
  };

  // ── Fenced code ────────────────────────────────────────────────────────
  // Both variants are prebuilt: `on` (selection touches the block → raw fences
  // visible, compact padding) and `off` (rendered → fences collapsed, label
  // widget, padded background).
  function scanFence(node, doc, tree, codeLines, rangeItems) {
    const firstLn = doc.lineAt(node.from).number;
    const lastLn = doc.lineAt(node.to).number;
    for (let ln = firstLn; ln <= lastLn; ln++) codeLines.add(doc.line(ln).from);

    const codeText =
      lastLn - firstLn >= 2
        ? doc.sliceString(doc.line(firstLn + 1).from, doc.line(lastLn - 1).to)
        : "";

    // Language label (CodeInfo after the opening ```) plus the mark ranges to
    // hide in rendered mode, gathered in one child pass.
    let lang = "";
    const markHides = [];
    tree.iterate({
      from: node.from,
      to: node.to,
      enter(child) {
        if (child.name === "CodeInfo") {
          lang = doc.sliceString(child.from, child.to);
          markHides.push(hideDeco.range(child.from, child.to));
        } else if (child.name === "CodeMark" && child.from < child.to) {
          markHides.push(hideDeco.range(child.from, child.to));
        }
      },
    });

    const background = (editing) => {
      const out = [];
      const bgFirst = editing ? firstLn : firstLn + 1;
      const bgLast = editing ? lastLn : lastLn - 1;
      const firstD = editing ? codeFirstDeco : codeFirstPadDeco;
      const lastD = editing ? codeLastDeco : codeLastPadDeco;
      const soloD = editing ? codeSoloDeco : codeSoloPadDeco;
      const midD = editing ? codeLineDeco : codeLineRenderedDeco;
      for (let ln = bgFirst; ln <= bgLast; ln++) {
        const d =
          bgFirst === bgLast
            ? soloD
            : ln === bgFirst
              ? firstD
              : ln === bgLast
                ? lastD
                : midD;
        out.push(d.range(doc.line(ln).from));
      }
      return out;
    };

    const on = background(true);
    const off = background(false);

    // Language/copy button anchored on the OPENING FENCE line. That line is
    // height-collapsed in rendered mode but it is NOT a scroll container (the
    // code-line classes go to content lines only), so an absolutely positioned
    // label there never moves when the block pans. It must be an INLINE widget
    // — plugins cannot provide block widgets.
    off.push(
      Decoration.widget({
        widget: new LangLabelWidget(lang, codeText),
        side: -1,
      }).range(doc.line(firstLn).from),
    );
    off.push(fenceLineDeco.range(doc.line(firstLn).from));
    if (lastLn !== firstLn) off.push(fenceLineDeco.range(doc.line(lastLn).from));
    for (const h of markHides) off.push(h);

    rangeItems.push({ tFrom: node.from, tTo: node.to, on, off });
  }

  // ── Inline marks: hide when not editing the enclosing node ─────────────
  function scanInlineMark(node, doc, always, lineItems, rangeItems) {
    if (node.from >= node.to) return;
    const name = node.name;

    // A Link only COUNTS as a link when it carries an inline URL: [text](url).
    // The parser also emits Link for bare "[0,250]" (shortcut reference) and
    // "[text][ref]" — for those, keep the bracket LinkMarks visible and lay
    // cm-md-not-link over the whole node once to cancel the highlighter's
    // blue/underline/pointer. Plain text in, plain text out.
    if (name === "LinkMark" || name === "URL") {
      let enc = node.node.parent;
      while (enc && enc.name !== "Link" && enc.name !== "Image") enc = enc.parent;
      if (enc && enc.name === "Link" && !childUrl(enc, doc)) {
        if (node.from === enc.from)
          always.push(notLinkDeco.range(enc.from, enc.to));
        return;
      }
    }

    // Resolve to the OUTERMOST emphasis/code/link node, not the direct parent:
    // "***x***" nests Emphasis > StrongEmphasis, and the inner **'s parent
    // excludes the outer *, so a caret at the very end would reveal only half.
    let outer = node.node.parent;
    while (outer && outer.parent && WRAP.has(outer.parent.name))
      outer = outer.parent;

    const on =
      name === "EmphasisMark" ? [emphMarkDeco.range(node.from, node.to)] : EMPTY;
    const off = [hideDeco.range(node.from, node.to)];
    if (outer) rangeItems.push({ tFrom: outer.from, tTo: outer.to, on, off });
    // No wrapping node (shouldn't happen in practice): per-line reveal.
    else lineItems.push({ ln: doc.lineAt(node.from).number, off });
  }

  // ── Arrow / operator glyphs on one line ────────────────────────────────
  // The exact match range doubles as the reveal range: the caret touching it
  // shows the raw text. Inline code is skipped via the syntax tree.
  function scanGlyphs(text, lineFrom, inInlineCode, rangeItems) {
    // Ranges claimed by a bidirectional arrow, so the unidirectional pass
    // below won't re-match pieces of them. Allocated only if one is found.
    let consumed = null;

    BIARROW_RE.lastIndex = 0;
    let bm;
    while ((bm = BIARROW_RE.exec(text)) !== null) {
      const from = lineFrom + bm.index;
      const to = from + bm[0].length;
      (consumed || (consumed = [])).push(from, to); // claim even if skipped
      if (inInlineCode(from)) continue;
      const dash = bm[1][0] === "-";
      const n = bm[1].length;
      const off =
        n <= 2
          ? [glyphDeco(biSingle(dash, n)).range(from, to)]
          : [
              glyphDeco(biLeft(dash)).range(from, from + 2),
              glyphDeco(biRight(dash)).range(to - 2, to),
            ];
      rangeItems.push({ tFrom: from, tTo: to, on: EMPTY, off });
    }

    GLYPH_RE.lastIndex = 0;
    let m;
    while ((m = GLYPH_RE.exec(text)) !== null) {
      const from = lineFrom + m.index;
      const to = from + m[0].length;
      if (consumed) {
        let overlaps = false;
        for (let i = 0; i < consumed.length; i += 2)
          if (from < consumed[i + 1] && to > consumed[i]) {
            overlaps = true;
            break;
          }
        if (overlaps) continue;
      }
      if (inInlineCode(from)) continue;
      const glyph = GLYPH_MAP.get(m[0]);
      if (!glyph) continue;
      rangeItems.push({
        tFrom: from,
        tTo: to,
        on: EMPTY,
        off: [glyphDeco(glyph).range(from, to)],
      });
    }
  }

  // ── Document scan ──────────────────────────────────────────────────────
  function scanDoc(state, tree) {
    const doc = state.doc;
    const always = [];
    const lineItems = [];
    const rangeItems = [];
    const codeLines = new Set(); // line.from of EVERY fenced-code line
    const quotedLines = new Set();

    // Ordered-list numbering is always rendered: the number is derived, not
    // literal content the user edits, so revealing the raw value ("6.") on the
    // active line would make the marker flip between "1.2.5" and "6." as the
    // caret moves.
    for (const { from, to, label } of computeOrderedLabels(doc, tree))
      always.push(markerDeco(label).range(from, to));

    tree.iterate({
      from: 0,
      to: doc.length,
      enter(node) {
        const name = node.name;

        // Headings: hide the "#… " marker when not editing the line.
        if (name.startsWith("ATXHeading")) {
          const line = doc.lineAt(node.from);
          if (/^#{1,6}\s*$/.test(line.text)) return; // empty heading keeps "#"
          const m = /^#{1,6}\s*/.exec(line.text);
          if (m)
            lineItems.push({
              ln: line.number,
              off: [hideDeco.range(line.from, line.from + m[0].length)],
            });
          return; // descend: inline emphasis inside the heading
        }

        if (name === "HorizontalRule") {
          const line = doc.lineAt(node.from);
          const off = [hrLineDeco.range(line.from)];
          if (line.from < line.to) off.push(hideDeco.range(line.from, line.to));
          lineItems.push({ ln: line.number, off });
          return;
        }

        if (name === "FencedCode") {
          scanFence(node, doc, tree, codeLines, rangeItems);
          return false;
        }

        // Blockquote: one bar per nesting level plus indentation. Depth comes
        // from the leading ">" run in each line's text, so "> > x" draws two
        // stacked bars. Always rendered; the dedupe Set keeps a line from being
        // processed twice when an outer and a nested Blockquote both cover it.
        if (name === "Blockquote") {
          const firstLn = doc.lineAt(node.from).number;
          const lastLn = doc.lineAt(node.to).number;
          for (let ln = firstLn; ln <= lastLn; ln++) {
            const line = doc.line(ln);
            if (quotedLines.has(line.from)) continue;
            quotedLines.add(line.from);
            const m = /^[ \t]*((?:>[ \t]?)+)/.exec(line.text);
            const depth = Math.max(1, m ? (m[1].match(/>/g) || []).length : 1);
            always.push(
              quoteLineDeco(depth, ln === firstLn, ln === lastLn).range(
                line.from,
              ),
            );
          }
          return; // QuoteMark children are hidden by the branch below
        }

        // Numbering (incl. nesting) is computed up front; descend so inline
        // marks inside list items are still handled.
        if (name === "OrderedList") return;

        if (name === "ListMark") {
          const txt = doc.sliceString(node.from, node.to);
          const markLine = doc.lineAt(node.from);
          if (!LIST_LINE_RE.test(markLine.text)) return;

          // Task item ("- [ ] …"): the checkbox stands in for the marker. Hide
          // the raw "- " while the checkbox shows, and reveal it — together
          // with the raw "[ ]" — only when the caret touches the "[ ]" range.
          // Ordered task markers ("1. [ ]") keep their computed number, so only
          // unordered "-/*/+" are hidden.
          if (TASK_LINE_RE.test(markLine.text)) {
            if ("-*+".includes(txt)) {
              const rel = markLine.text.indexOf("[", node.to - markLine.from);
              if (rel >= 0) {
                const boxFrom = markLine.from + rel;
                rangeItems.push({
                  tFrom: boxFrom,
                  tTo: boxFrom + 3, // "[ ]" is 3 chars
                  on: EMPTY,
                  off: [hideDeco.range(node.from, boxFrom)],
                });
              }
            }
            return;
          }

          if (!"-*+".includes(txt)) return; // ordered → numbering pass
          always.push(markerDeco("\u2022").range(node.from, node.to));
          return;
        }

        if (name === "TaskMarker") {
          const checked = /[xX]/.test(doc.sliceString(node.from, node.to));
          rangeItems.push({
            tFrom: node.from,
            tTo: node.to,
            on: EMPTY, // caret on the marker → raw "[ ]"
            off: [
              Decoration.replace({
                widget: new CheckboxWidget(checked),
              }).range(node.from, node.to),
            ],
          });
          return;
        }

        if (name === "QuoteMark") {
          if (node.from < node.to)
            lineItems.push({
              ln: doc.lineAt(node.from).number,
              off: [hideDeco.range(node.from, node.to)],
            });
          return;
        }

        // Inline image: the picture is ALWAYS shown, as a widget right after
        // the syntax (a block box on its own line below the source). The raw
        // "![]()" is hidden only while the caret is away; touching it reveals
        // the source directly above the still-visible image.
        if (name === "Image") {
          const url = childUrl(node, doc);
          if (!url) return false;
          const am = /^!\[([^\]]*)\]/.exec(doc.sliceString(node.from, node.to));
          let alt = am ? am[1] : "";
          // Optional stored size, Obsidian style: "![alt|WIDTH](src)".
          let width = null;
          const pipe = alt.lastIndexOf("|");
          if (pipe >= 0 && /^\d+$/.test(alt.slice(pipe + 1).trim())) {
            width = parseInt(alt.slice(pipe + 1), 10);
            alt = alt.slice(0, pipe);
          }
          always.push(
            Decoration.widget({
              widget: new ImageWidget(url, alt, width),
              side: 1,
            }).range(node.to),
          );
          rangeItems.push({
            tFrom: node.from,
            tTo: node.to,
            on: EMPTY,
            off: [hideDeco.range(node.from, node.to)],
          });
          return false;
        }

        if (INLINE_MARKS.has(name))
          scanInlineMark(node, doc, always, lineItems, rangeItems);
      },
    });

    // ── One pass over the line text ────────────────────────────────────
    // List indentation is driven by TEXT, not by the parser: a ListMark is
    // only emitted once an item has content, so a freshly typed "1. " would
    // not indent. A bare "1" (no trailing space) doesn't match, so lazy
    // continuation lines stay flush. Fenced-code lines are excluded from both
    // the indent and the glyph substitution.
    const inInlineCode = (pos) => {
      let n = tree.resolveInner(pos, 1);
      while (n) {
        if (n.name === "InlineCode" || n.name === "CodeText") return true;
        n = n.parent;
      }
      return false;
    };

    eachLine(doc, (text, from) => {
      if (codeLines.has(from)) return;
      if (LIST_LINE_RE.test(text)) always.push(listLineDeco.range(from));
      scanGlyphs(text, from, inInlineCode, rangeItems);
    });

    return { always, lineItems, rangeItems };
  }

  // ── Selection assembly ─────────────────────────────────────────────────
  // Returns null when the reveal state is identical to prevSig, else
  // { deco, sig }. Used both for normal selection changes and live mid-drag:
  // reveal exactly what the selection touches, re-render exactly what it
  // doesn't, the moment it doesn't.
  function assemble(scan, state, prevSig) {
    const sel = state.selection.main;
    // In read mode no line counts as "the caret's line" and no range counts as
    // touched, so lineItems all emit `off` and every rangeItem stays rendered.
    // -1 can never equal a real line number, so the signature stays stable
    // across selection moves and toggling the mode always invalidates it.
    const readMode = isReadMode(state);
    const aLine = readMode ? -1 : state.doc.lineAt(sel.from).number;
    const bLine = readMode ? -1 : state.doc.lineAt(sel.to).number;

    const items = scan.rangeItems;
    const bits = new Uint8Array(items.length);
    if (!readMode)
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (sel.from <= it.tTo && sel.to >= it.tFrom) bits[i] = 1;
      }

    if (
      prevSig &&
      prevSig.aLine === aLine &&
      prevSig.bLine === bLine &&
      sameBits(prevSig.bits, bits)
    )
      return null;

    const decos = scan.always.slice();
    for (const li of scan.lineItems)
      if (li.ln < aLine || li.ln > bLine) for (const r of li.off) decos.push(r);
    for (let i = 0; i < items.length; i++) {
      const src = bits[i] ? items[i].on : items[i].off;
      for (const r of src) decos.push(r);
    }

    return { deco: Decoration.set(decos, true), sig: { aLine, bLine, bits } };
  }

  return { scanDoc, assemble };
}
