// markdown-preview.js
//
// Orchestrator for the Obsidian-style markdown live preview. The widget
// classes, decorations, glyph data, image resolver, keymaps, and table/fence
// block parsers live in ./markdown/*; this file wires them together into the
// CodeMirror extension array. Everything is assembled inside
// getMarkdownExtensions() because the widgets/decorations/keymaps close over
// the dynamically-imported CodeMirror bundle and are therefore built via
// factories that receive those symbols as arguments.
//
// ── Architecture: scan once per doc, assemble per selection ────────────────
// The old plugin re-ran every tree walk and regex scan on EVERY selection
// change (i.e. every mousemove of a drag). Now all document-derived analysis
// happens exactly once per (doc, syntax-tree) pair and is cached as prebuilt
// decoration Ranges; a selection change only re-assembles the final set from
// the cache — no parsing, no regexes, no widget construction. Each cached
// item is one of:
//
//   always     shown regardless of the selection (list indents, computed
//              ordered/bullet marker widgets, blockquote bars, image widgets)
//   lineItems  { ln, off } — `off` is emitted unless the selection touches
//              line `ln` (heading "#" hides, HR, quote-mark hides)
//   rangeItems { tFrom, tTo, on, off } — `off` (rendered) is emitted unless
//              the selection touches [tFrom, tTo], else `on` (editing).
//              Fences prebuild BOTH variants; marks/glyphs/checkboxes/images
//              prebuild their hide/replace ranges.
//
// Assembly computes a signature — (first selected line, last selected line,
// touched-bitmap over rangeItems) — and if it matches the previous one the
// old decoration set is kept untouched. Dragging within the same reveal
// state therefore costs a few integer comparisons and zero DOM work. During
// a pointer drag, assembly runs LIVE in both directions: content the
// selection sweeps unrenders immediately, and content the selection leaves
// re-renders immediately — no freeze, no latch, no hysteresis. The post-drag
// "reveal.sync" nudge still runs any rescan deferred during the drag
// (incremental parse progression). The math StateField uses the same
// scan/assemble split with a per-doc WeakMap cache and reassembles live
// during drags through its default path.

import { createImageResolver } from "./markdown/image-resolver.js";
import { createWidgets } from "./markdown/widgets.js";
import { createDecorations } from "./markdown/decorations.js";
import { createKeymaps } from "./markdown/keymaps.js";
import {
  GLYPH_RE,
  GLYPH_MAP,
  BIARROW_RE,
  biSingle,
  biLeft,
  biRight,
} from "./markdown/glyphs.js";
import { backtickOnlyFence, smartTable } from "./markdown/smart-table.js";
import { createHBar } from "./markdown/hscrollbar.js";

// Any "N. " / "N) " / "- " / "* " / "+ " marker at the start of a line.
const LIST_LINE_RE = /^\s*(?:[-*+]|\d+[.)])\s/;
const TASK_LINE_RE = /^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]/;

const EMPTY = [];

const sameBits = (a, b) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

// ── Hierarchical ordered-list labels (pure, exported for tests) ────────────
// Walks the tree with a stack of list frames and returns one computed label
// per ordered ListMark: top level → "N." (or "N)" for paren markers), nested
// ordered-in-ordered → dotted paths "N.M", "N.M.K". Improvements over the old
// single-counter stack:
//   • A BulletList BREAKS the dotted chain: an ordered list nested under a
//     bullet list numbers independently from "1." (like Obsidian/CommonMark
//     renderers) instead of inheriting the outer ordered ancestors' path.
//   • The first item's literal number seeds the counter, so "5. a / 6. b"
//     renders 5., 6. (CommonMark honors the start number; later items are
//     still renumbered sequentially).
//   • "N)" markers are supported and keep their ")" at the top level.
//   • The lazy-continuation restart (a flush-left paragraph folded into the
//     list) now restarts from the marker's own literal number instead of
//     forcing 1 — matching what a fresh list after the paragraph would show.
export function computeOrderedLabels(doc, tree) {
  const out = [];
  const frames = []; // { ol:true, count:number|null } | { ol:false }
  tree.iterate({
    enter(n) {
      const name = n.name;
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
      if (!top.ol) return; // bullet marker — handled by the main walk
      const m = /^(\d+)([.)])$/.exec(doc.sliceString(n.from, n.to));
      if (!m) return;

      // Restart top-level numbering after a flush-left, blank-line-less
      // paragraph that CommonMark folds into the list as lazy continuation
      // ("1.…5." + "asdf" + "1." parses as ONE list, so the last marker would
      // otherwise continue as "6."). Only applies at the top level; nested
      // markers are always indented, so they never reset.
      const markLine = doc.lineAt(n.from);
      if (frames.length === 1 && markLine.number > 1) {
        const prev = doc.line(markLine.number - 1).text;
        if (
          !/^\s*$/.test(prev) &&
          !LIST_LINE_RE.test(prev) &&
          !/^\s/.test(prev)
        )
          top.count = null; // reseed from this marker's literal below
      }

      top.count = top.count == null ? parseInt(m[1], 10) : top.count + 1;

      // Label = the trailing run of ordered frames (a bullet frame in between
      // cuts the chain, so OL > UL > OL numbers the inner list on its own).
      let i = frames.length;
      while (i > 0 && frames[i - 1].ol) i--;
      const path = [];
      for (let j = i; j < frames.length; j++) path.push(frames[j].count);
      // Every label ends with the marker's own delimiter: "2." / "2)" at the
      // top level, "2.2." (or "2.2)") when nested.
      const label = path.join(".") + m[2];
      out.push({ from: n.from, to: n.to, label });
    },
    leave(n) {
      if (n.name === "OrderedList" || n.name === "BulletList") frames.pop();
    },
  });
  return out;
}

export async function getMarkdownExtensions() {
  const cm = await import("./libs/codemirror.js");
  const { markdown, markdownLanguage } = cm;
  const { HighlightStyle, syntaxHighlighting, syntaxTree } = cm;
  const { tags: t } = cm;
  const { Decoration, ViewPlugin, EditorView, keymap, Prec } = cm;
  const { StateField } = cm;
  const { WidgetType } = cm;
  const { insertNewlineContinueMarkupCommand } = cm;
  // Optional bundle exports — feature-detected so the editor still works if
  // the vendored bundle predates them.
  const languages = cm.languages || null; // @codemirror/language-data
  const openSearchPanel = cm.openSearchPanel || null; // @codemirror/search
  if (!languages)
    console.warn(
      "[markdown-preview] code-block syntax highlighting needs the bundle " +
        'to export `languages` (add `export { languages } from ' +
        '"@codemirror/language-data";` to the codemirror bundle entry and ' +
        "install that package)",
    );

  // ── KaTeX (math rendering) ────────────────────────────────────────────────
  // Loaded from the app's local copy (CSP blocks CDNs). katex.min.js lives at
  // src/js/libs/, its CSS at src/css/. If it can't load, math just stays raw.
  let katex = null;
  try {
    if (window.katex) {
      katex = window.katex;
    } else {
      await new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "js/libs/katex.min.js"; // relative to index.html
        s.onload = resolve;
        s.onerror = () => reject(new Error("katex.min.js failed to load"));
        document.head.appendChild(s);
      });
      katex = window.katex || null;
    }
    // Ensure the stylesheet is present (fonts + layout).
    if (katex && !document.querySelector("link[data-katex]")) {
      const l = document.createElement("link");
      l.rel = "stylesheet";
      l.href = "css/katex.min.css";
      l.dataset.katex = "1";
      document.head.appendChild(l);
    }
  } catch (err) {
    console.warn("[markdown-preview] KaTeX unavailable:", err);
  }

  // GFM table live preview + visual editing (separate module). Requires the
  // bundle to export StateField; if it doesn't, tables simply stay raw and a
  // warning explains what to add — the rest of the editor is unaffected.
  let tableExtension = [];
  try {
    const tbl = await import("./markdown-table.js");
    tableExtension = await tbl.getTableExtension();
  } catch (err) {
    console.warn("[markdown-preview] table extension disabled:", err);
  }

  // ── Assemble the pieces from ./markdown/* ─────────────────────────────────
  const { resolveImageSrc, resolveImageSrcSync, writeImageWidth } =
    createImageResolver({ syntaxTree });

  const {
    LangLabelWidget,
    MarkerWidget,
    CheckboxWidget,
    ImageWidget,
    GlyphWidget,
    MathWidget,
    mathHeightCache,
  } = createWidgets({
    WidgetType,
    katex,
    resolveImageSrc,
    resolveImageSrcSync,
    writeImageWidth,
  });

  const {
    mdHighlight,
    hideDeco,
    emphMarkDeco,
    markerDeco,
    hrLineDeco,
    codeLineDeco,
    codeFirstDeco,
    codeLastDeco,
    codeSoloDeco,
    codeFirstPadDeco,
    codeLastPadDeco,
    codeSoloPadDeco,
    codeLineRenderedDeco,
    listLineDeco,
    fenceLineDeco,
  } = createDecorations({ Decoration, HighlightStyle, t, MarkerWidget });

  const {
    linkClick,
    tabKeymap,
    enterKeymap,
    autoPair,
    noAutoClose,
    searchKeys,
  } = createKeymaps({
    EditorView,
    syntaxTree,
    keymap,
    Prec,
    insertNewlineContinueMarkupCommand,
    markdownLanguage,
    openSearchPanel,
  });

  // Glyph replace decorations are keyed by their output character; there are
  // only ~15 distinct glyphs, so memoizing gives every build the exact same
  // Decoration (and widget) instance → CodeMirror diffs them away entirely.
  const glyphDecoCache = new Map();
  const glyphReplace = (g) => {
    let d = glyphDecoCache.get(g);
    if (!d) {
      d = Decoration.replace({ widget: new GlyphWidget(g) });
      glyphDecoCache.set(g, d);
    }
    return d;
  };

  // Blockquote line decorations keyed by (depth, first, last). The style
  // string draws `depth` thin bars via stacked background gradients and
  // indents the text clear of the last bar.
  //
  // IMPORTANT: the indent is a transparent border-left, NOT padding-left.
  // CodeMirror's drawSelection layer derives the left edge of every
  // fully-selected-line rectangle from the computed padding-left of the FIRST
  // rendered .cm-line in the viewport; any line with nonstandard padding-left
  // that scrolls to the top poisons that edge for the whole selection
  // (indented selection rects, and negative-width pieces that make the
  // highlight vanish during downward drag-scroll). Borders are never sampled.
  // background-origin/clip: border-box keeps the bars and the fill anchored
  // at the line's true left edge, and 6px is subtracted because the base
  // .cm-line theme already pads 6px on the left.
  const BASE_LINE_PAD = 6; // px — @codemirror/view base theme .cm-line padding-left
  const QUOTE_GAP = 14;
  const quoteDecoCache = new Map();
  const quoteLineDeco = (depth, first, last) => {
    const key = depth + (first ? "f" : "") + (last ? "l" : "");
    let d = quoteDecoCache.get(key);
    if (d) return d;
    const imgs = [];
    const sizes = [];
    const poss = [];
    for (let i = 0; i < depth; i++) {
      imgs.push("linear-gradient(var(--quote-bar),var(--quote-bar))");
      sizes.push("3px 100%");
      poss.push(`${i * QUOTE_GAP}px 0`);
    }
    const indent = Math.max(0, (depth - 1) * QUOTE_GAP + 12 - BASE_LINE_PAD);
    const style =
      `background-image:${imgs.join(",")};` +
      `background-size:${sizes.join(",")};` +
      `background-position:${poss.join(",")};` +
      `background-repeat:no-repeat;` +
      `background-origin:border-box;background-clip:border-box;` +
      `border-left:${indent}px solid transparent;`;
    let cls = "cm-md-quote";
    if (first) cls += " cm-md-quote-first";
    if (last) cls += " cm-md-quote-last";
    d = Decoration.line({ attributes: { class: cls, style } });
    quoteDecoCache.set(key, d);
    return d;
  };

  // Outermost-wrapper resolution set for inline marks (see the generic
  // inline-mark branch below).
  const WRAP = new Set([
    "Emphasis",
    "StrongEmphasis",
    "Strikethrough",
    "InlineCode",
    "Link",
    "Image",
  ]);

  // Overrides the highlighter's t.link styling (cm-md-link: blue, underline,
  // pointer) on bracket text that is NOT actually a link. The HighlightStyle
  // is tag-based and can't see tree structure, so URL-less "links" are
  // un-styled here with a mark instead.
  const notLinkDeco = Decoration.mark({ class: "cm-md-not-link" });

  // ── Document scan: everything derivable without the selection ────────────
  function scanDoc(state, tree) {
    const doc = state.doc;
    const always = [];
    const lineItems = [];
    const rangeItems = [];
    const codeLines = new Set(); // line.from of EVERY fenced-code line
    const quotedLines = new Set();

    // Ordered-list numbering (hierarchical). Always rendered — the number is
    // derived, not literal content the user edits, so revealing the raw
    // source value (e.g. "6.") on the active line would make the marker flip
    // between "1.2.5" and "6." as the caret moves. Keep it stable.
    for (const { from, to, label } of computeOrderedLabels(doc, tree))
      always.push(markerDeco(label).range(from, to));

    tree.iterate({
      from: 0,
      to: doc.length,
      enter(node) {
        const name = node.name;

        // ── Headings: hide "#… " marker when not editing the line ────────
        if (name.startsWith("ATXHeading")) {
          const line = doc.lineAt(node.from);
          if (/^#{1,6}\s*$/.test(line.text)) return; // empty heading: keep "#"
          const m = /^#{1,6}\s*/.exec(line.text);
          if (m)
            lineItems.push({
              ln: line.number,
              off: [hideDeco.range(line.from, line.from + m[0].length)],
            });
          return; // continue into children (inline emphasis inside heading)
        }

        // ── Horizontal rule ──────────────────────────────────────────────
        if (name === "HorizontalRule") {
          const line = doc.lineAt(node.from);
          const off = [hrLineDeco.range(line.from)];
          if (line.from < line.to) off.push(hideDeco.range(line.from, line.to));
          lineItems.push({ ln: line.number, off });
          return;
        }

        // ── Fenced code block ────────────────────────────────────────────
        // Both variants are prebuilt: `on` (selection touches the block →
        // raw fences visible, compact padding) and `off` (rendered → fences
        // collapsed, label widget, padded background).
        if (name === "FencedCode") {
          const firstLn = doc.lineAt(node.from).number;
          const lastLn = doc.lineAt(node.to).number;
          for (let ln = firstLn; ln <= lastLn; ln++)
            codeLines.add(doc.line(ln).from);

          let codeText = "";
          if (lastLn - firstLn >= 2)
            codeText = doc.sliceString(
              doc.line(firstLn + 1).from,
              doc.line(lastLn - 1).to,
            );

          // Language label (CodeInfo node after the opening ```) + the mark
          // ranges to hide in rendered mode, gathered in one child pass.
          let lang = "";
          const markHides = [];
          tree.iterate({
            from: node.from,
            to: node.to,
            enter(child) {
              if (child.name === "CodeInfo") {
                lang = doc.sliceString(child.from, child.to);
                markHides.push(hideDeco.range(child.from, child.to));
              } else if (
                child.name === "CodeMark" &&
                child.from < child.to
              ) {
                markHides.push(hideDeco.range(child.from, child.to));
              }
            },
          });

          const bg = (editing) => {
            const out = [];
            const bgFirst = editing ? firstLn : firstLn + 1;
            const bgLast = editing ? lastLn : lastLn - 1;
            const firstD = editing ? codeFirstDeco : codeFirstPadDeco;
            const lastD = editing ? codeLastDeco : codeLastPadDeco;
            const soloD = editing ? codeSoloDeco : codeSoloPadDeco;
            const midD = editing ? codeLineDeco : codeLineRenderedDeco;
            for (let ln = bgFirst; ln <= bgLast; ln++) {
              const deco =
                bgFirst === bgLast
                  ? soloD
                  : ln === bgFirst
                    ? firstD
                    : ln === bgLast
                      ? lastD
                      : midD;
              out.push(deco.range(doc.line(ln).from));
            }
            return out;
          };

          const on = bg(true); // editing: raw fences + compact background
          const off = bg(false); // rendered
          // Language/copy button, anchored on the OPENING FENCE line. The
          // fence line is height-collapsed in rendered mode but it is NOT a
          // scroll container (code-line classes go to content lines only),
          // so an absolutely-positioned label there simply never moves when
          // the block pans — no counter-translation needed. The label sizes
          // itself in rem (see .cm-md-code-lang) so the fence line's
          // font-size:0 collapse can't zero it out. Must be an inline
          // widget — plugins can't provide block widgets.
          off.push(
            Decoration.widget({
              widget: new LangLabelWidget(lang, codeText),
              side: -1,
            }).range(doc.line(firstLn).from),
          );
          off.push(fenceLineDeco.range(doc.line(firstLn).from));
          if (lastLn !== firstLn)
            off.push(fenceLineDeco.range(doc.line(lastLn).from));
          for (const h of markHides) off.push(h);

          rangeItems.push({ tFrom: node.from, tTo: node.to, on, off });
          return false;
        }

        // ── Blockquote: one bar per nesting level + indentation ──────────
        // Depth comes from the leading ">" run in each line's text, so a
        // "> > x" line draws two stacked bars and indents the text past
        // them. Always rendered; the dedupe Set keeps a line from being
        // processed twice when the outer and a nested Blockquote node both
        // cover it.
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
          return; // QuoteMark children hidden by the generic rule below
        }

        // ── Ordered list ─────────────────────────────────────────────────
        // Numbering (incl. nesting) is computed in computeOrderedLabels.
        // Descend so inline marks inside list items still get handled; the
        // ListMark branch below skips ordered markers.
        if (name === "OrderedList") return;

        // ── List marker (-, *, +) → bullet rendering ─────────────────────
        if (name === "ListMark") {
          const txt = doc.sliceString(node.from, node.to);
          const markLine = doc.lineAt(node.from);
          if (!LIST_LINE_RE.test(markLine.text)) return;

          // Task-list item ("- [ ] …"): the checkbox stands in for the
          // marker. Hide the raw "- " (marker + spaces up to the "[") while
          // the checkbox is shown; reveal it — together with the raw "[ ]" —
          // only when the caret actually touches the "[ ]" range. Ordered
          // task markers ("1. [ ]") keep their computed number, so we only
          // hide unordered "-/*/+".
          if (TASK_LINE_RE.test(markLine.text)) {
            if ("-*+".includes(txt)) {
              const rel = markLine.text.indexOf("[", node.to - markLine.from);
              if (rel >= 0) {
                const boxFrom = markLine.from + rel;
                const boxTo = boxFrom + 3; // "[ ]" is 3 chars
                rangeItems.push({
                  tFrom: boxFrom,
                  tTo: boxTo,
                  on: EMPTY,
                  off: [hideDeco.range(node.from, boxFrom)],
                });
              }
            }
            return;
          }

          if (!"-*+".includes(txt)) return; // ordered → numbering pass
          // Always replace with a "•" widget (same rationale as ordered
          // markers: stable display + correct click/caret behavior).
          always.push(markerDeco("\u2022").range(node.from, node.to));
          return;
        }

        // ── Task checkbox ("[ ]" / "[x]") → clickable checkbox widget ────
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

        // ── Quote marks: hide when not editing the line ──────────────────
        if (name === "QuoteMark") {
          if (node.from < node.to)
            lineItems.push({
              ln: doc.lineAt(node.from).number,
              off: [hideDeco.range(node.from, node.to)],
            });
          return;
        }

        // ── Inline image (![alt](src)) → <img> preview ──────────────────
        if (name === "Image") {
          let url = "";
          const c = node.node.cursor();
          if (c.firstChild()) {
            do {
              if (c.name === "URL") {
                url = doc.sliceString(c.from, c.to);
                break;
              }
            } while (c.nextSibling());
          }
          if (!url) return false;
          const am = /^!\[([^\]]*)\]/.exec(
            doc.sliceString(node.from, node.to),
          );
          let alt = am ? am[1] : "";
          // Optional stored size, Obsidian-style: "![alt|WIDTH](src)".
          let width = null;
          const pipe = alt.lastIndexOf("|");
          if (pipe >= 0 && /^\d+$/.test(alt.slice(pipe + 1).trim())) {
            width = parseInt(alt.slice(pipe + 1), 10);
            alt = alt.slice(0, pipe);
          }
          // The image is ALWAYS shown, as a widget right after the syntax (a
          // block box on its own line below the source). The raw "![]()" is
          // hidden only while the caret is away; touching it reveals the
          // source directly ABOVE the still-visible image.
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

        // ── Generic inline marks: hide when not editing that node ─────────
        if (
          name === "EmphasisMark" ||
          name === "StrikethroughMark" ||
          name === "CodeMark" ||
          name === "LinkMark" ||
          name === "URL"
        ) {
          if (node.from >= node.to) return;
          // A Link only COUNTS as a link with an inline URL: [text](url).
          // The parser also emits Link for bare "[0,250]" (shortcut
          // reference) and "[text][ref]" — for those, (a) don't hide the
          // bracket LinkMarks (previously "[0,250]" rendered as "0,250"),
          // and (b) lay cm-md-not-link over the whole node once (at the
          // opening mark) to cancel the highlighter's blue/underline/
          // pointer. Plain text in, plain text out.
          if (name === "LinkMark" || name === "URL") {
            let enc = node.node.parent;
            while (enc && enc.name !== "Link" && enc.name !== "Image")
              enc = enc.parent;
            if (enc && enc.name === "Link") {
              let hasUrl = false;
              for (let c = enc.firstChild; c; c = c.nextSibling)
                if (c.name === "URL") {
                  hasUrl = true;
                  break;
                }
              if (!hasUrl) {
                if (node.from === enc.from)
                  always.push(notLinkDeco.range(enc.from, enc.to));
                return; // keep the brackets visible, no reveal machinery
              }
            }
          }
          // Resolve to the OUTERMOST emphasis/code/link node, not the direct
          // parent. "***x***" nests Emphasis > StrongEmphasis; the inner **'s
          // parent (StrongEmphasis) excludes the outer *, so a caret at the
          // very end would reveal only half. Unifying on the outer range
          // fixes that, and keeps sibling marks on the same line independent.
          let outer = node.node.parent;
          while (outer && outer.parent && WRAP.has(outer.parent.name))
            outer = outer.parent;
          const on =
            name === "EmphasisMark"
              ? [emphMarkDeco.range(node.from, node.to)]
              : EMPTY;
          const off = [hideDeco.range(node.from, node.to)];
          if (outer) {
            rangeItems.push({ tFrom: outer.from, tTo: outer.to, on, off });
          } else {
            // No wrapping node (shouldn't happen in practice): fall back to
            // the old per-line reveal.
            lineItems.push({ ln: doc.lineAt(node.from).number, off });
          }
          return;
        }
      },
    });

    // ── List-line indentation by line text (not parser) ──────────────────
    // The markdown parser only emits a ListMark once a list item has content,
    // so a freshly typed "1. " isn't recognized as a list yet and wouldn't
    // indent; scanning line text makes any "- "/"* "/"+ "/"N. "/"N) " line
    // indent immediately. A bare "1" (no trailing space) won't match, so
    // lazy-continuation lines stay un-indented. Lines inside fenced code are
    // skipped — previously "- item" inside a ``` block got list padding.
    for (let ln = 1; ln <= doc.lines; ln++) {
      const line = doc.line(ln);
      if (codeLines.has(line.from)) continue;
      if (!LIST_LINE_RE.test(line.text)) continue;
      always.push(listLineDeco.range(line.from));
    }

    // ── Arrow / operator glyphs ───────────────────────────────────────────
    // Scan line text for sequences; skip code (fenced lines via codeLines,
    // inline code via the syntax tree). The exact match range doubles as the
    // reveal range: the caret touching it shows the raw text.
    const inInlineCode = (pos) => {
      let n = tree.resolveInner(pos, 1);
      while (n) {
        if (n.name === "InlineCode" || n.name === "CodeText") return true;
        n = n.parent;
      }
      return false;
    };
    for (let ln = 1; ln <= doc.lines; ln++) {
      const line = doc.line(ln);
      if (codeLines.has(line.from)) continue;
      const text = line.text;

      // Ranges (doc coords) claimed by a bidirectional arrow, so the
      // unidirectional/operator scan below won't re-match pieces of them.
      const consumed = [];
      const overlaps = (a, b) => consumed.some(([c, d]) => a < d && b > c);

      // Bidirectional arrows first. run 1..2 → a single glyph; run ≥ 3 →
      // only the two ends convert and the middle dashes stay raw. Caret
      // anywhere inside reveals the WHOLE token (no 3:1 split).
      BIARROW_RE.lastIndex = 0;
      let bm;
      while ((bm = BIARROW_RE.exec(text)) !== null) {
        const from = line.from + bm.index;
        const to = from + bm[0].length;
        consumed.push([from, to]); // claim it even if skipped below
        if (inInlineCode(from)) continue;
        const dash = bm[1][0] === "-";
        const n = bm[1].length;
        const off =
          n <= 2
            ? [glyphReplace(biSingle(dash, n)).range(from, to)]
            : [
                glyphReplace(biLeft(dash)).range(from, from + 2), // "<-"
                glyphReplace(biRight(dash)).range(to - 2, to), // "->"
              ];
        rangeItems.push({ tFrom: from, tTo: to, on: EMPTY, off });
      }

      // Unidirectional arrows + operators.
      GLYPH_RE.lastIndex = 0;
      let m;
      while ((m = GLYPH_RE.exec(text)) !== null) {
        const from = line.from + m.index;
        const to = from + m[0].length;
        if (overlaps(from, to)) continue; // part of a bidirectional arrow
        if (inInlineCode(from)) continue;
        const glyph = GLYPH_MAP.get(m[0]);
        if (!glyph) continue;
        rangeItems.push({
          tFrom: from,
          tTo: to,
          on: EMPTY,
          off: [glyphReplace(glyph).range(from, to)],
        });
      }
    }

    return { always, lineItems, rangeItems };
  }

  // ── Selection assembly + change signature ─────────────────────────────────
  // Returns null when the reveal state is identical to prevSig (nothing to
  // do), else { deco, sig }. Called both for normal selection changes and
  // live mid-drag (identical logic: reveal exactly what the selection
  // touches, re-render exactly what it doesn't — the moment it doesn't).
  function assemble(scan, state, prevSig) {
    const doc = state.doc;
    const sel = state.selection.main;
    const aLine = doc.lineAt(sel.from).number;
    const bLine = doc.lineAt(sel.to).number;
    const items = scan.rangeItems;
    const bits = new Uint8Array(items.length);
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
    for (const li of scan.lineItems) {
      if (li.ln < aLine || li.ln > bLine)
        for (const r of li.off) decos.push(r);
    }
    for (let i = 0; i < items.length; i++) {
      const src = bits[i] ? items[i].on : items[i].off;
      for (const r of src) decos.push(r);
    }
    return { deco: Decoration.set(decos, true), sig: { aLine, bLine, bits } };
  }

  // ── Margin mousedown forwarding ──────────────────────────────────────────
  // The editor's side margins are .cm-scroller padding — OUTSIDE contentDOM,
  // and CodeMirror registers all mouse handlers on contentDOM only
  // (InputState.ensureHandlers). A mousedown in the margin therefore never
  // created a MouseSelection; the browser's native contenteditable
  // drag-select took the gesture instead, and native selection cannot span a
  // contenteditable=false widget — crossing an image re-anchored the
  // selection below it. Forward margin presses into contentDOM: block the
  // native gesture, re-dispatch a synthetic mousedown at the same
  // coordinates, and CM's own machinery takes over (its MouseSelection
  // listens for the REAL mousemove/mouseup on document, so only this first
  // event needs cloning). Targets: the scroller itself (its padding) and the
  // presentational .cm-layer children (old selection rects the pointer might
  // press through). The absolutely-positioned title input keeps its own
  // behavior — its target is neither.
  const marginMouseDown = ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.view = view;
        this.onDown = (e) => {
          if (e.button !== 0) return;
          const t = e.target;
          if (view.contentDOM.contains(t)) return; // CM already sees these
          const isMargin =
            t === view.scrollDOM ||
            (t instanceof Element && t.closest(".cm-layer"));
          if (!isMargin) return;
          e.preventDefault();
          view.contentDOM.dispatchEvent(
            new MouseEvent("mousedown", {
              bubbles: true,
              cancelable: true,
              clientX: e.clientX,
              clientY: e.clientY,
              button: e.button,
              buttons: e.buttons,
              detail: e.detail, // preserves double/triple-click selection
              shiftKey: e.shiftKey,
              ctrlKey: e.ctrlKey,
              altKey: e.altKey,
              metaKey: e.metaKey,
            }),
          );
        };
        view.scrollDOM.addEventListener("mousedown", this.onDown);
      }
      destroy() {
        this.view.scrollDOM.removeEventListener("mousedown", this.onDown);
      }
    },
  );

  // ── Caret placement on rendered math (KaTeX widgets) ─────────────────────
  // Rendered $…$ / $$…$$ are Decoration.replace WIDGETS. Events that
  // originate inside widget DOM are, depending on the widget's ignoreEvent,
  // either ignored by CodeMirror entirely (caret moves nowhere) or handed to
  // CM's MouseSelection, which resolves a degenerate position over
  // contenteditable=false content and re-dispatches it on mouseup —
  // overwriting anything set on mousedown. Usually masked by clicking the
  // text AROUND an equation, but `#### $A_{CM}$` is a trap: the "#### "
  // marker is hidden, so the entire visible line is the widget and there is
  // no plain text to click — the caret can never enter the line and the raw
  // source can never reveal.
  //
  // Interception is therefore CAPTURE-phase on scrollDOM: ancestors run
  // before contentDOM's own listeners in capture order, so this fires before
  // ANY CodeMirror mouse machinery. stopPropagation keeps CM from starting a
  // competing MouseSelection in the same gesture (whose mouseup dispatch was
  // exactly what clobbered the bubble-phase version of this fix), and
  // preventDefault blocks the browser's native selection on the
  // non-editable span. The selection is then dispatched directly; either
  // math boundary satisfies mathAssemble's reveal test (sel.from <= tTo &&
  // sel.to >= tFrom), so the equation flips to raw with the caret on it.
  //
  // The hit test deliberately does NOT rely on widget class names (widgets.js
  // may wrap KaTeX arbitrarily, and a katex parse failure renders fallback
  // DOM): any target inside a contenteditable=false subtree of contentDOM
  // that contains or belongs to KaTeX / display-math output counts. Table
  // cells are excluded — their KaTeX comes from renderInline inside the
  // table widget, which owns its own editing lifecycle.
  const mathMouseDown = ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.view = view;
        // TEMP DIAGNOSTICS — flip to false (or delete the dbg lines) once the
        // math-click issue is confirmed fixed. One click on a rendered
        // equation should print: fire → guards → pos → post-dispatch state.
        const DBG = false; // diagnosis complete — delete the dbg lines whenever
        const dbg = (...a) => DBG && console.debug("[mathClick]", ...a);
        this.onDown = (e) => {
          if (e.button !== 0) return;
          const t = e.target;
          if (!(t instanceof Element)) return;
          dbg("fire", { target: t.tagName + "." + t.className });
          if (!view.contentDOM.contains(t)) return dbg("reject: outside contentDOM");
          if (t.closest(".cm-md-table-wrap")) return dbg("reject: table");

          // Nearest non-editable (widget) root above the target.
          let root = null;
          for (
            let n = t;
            n && n !== view.contentDOM;
            n = n.parentElement
          ) {
            if (n.getAttribute && n.getAttribute("contenteditable") === "false")
              root = n;
          }
          if (!root) return dbg("reject: no widget root (plain text)");
          const isMath =
            root.matches(".katex, .katex *, .cm-md-math-display") ||
            !!root.querySelector(".katex, .katex-error") ||
            !!t.closest(".katex, .cm-md-math-display");
          if (!isMath) return dbg("reject: widget but not math", root);

          // posAtDOM, NOT posAtCoords. Diagnosed live: clicking the KaTeX
          // glyphs of `#### $A_{CM},\ A_{diff}$` made posAtCoords return
          // lineEnd+1 — the START OF THE NEXT LINE. Chromium's
          // caretPositionFromPoint resolves a point inside
          // contenteditable=false content to the nearest EDITABLE position,
          // and with the whole heading being one widget that nearest position
          // is the following line. The selection then held there (sel.from =
          // tTo+1 fails mathAssemble's `sel.from <= tTo`), so the equation
          // never revealed and the caret sat invisibly on the next line —
          // the exact degenerate-caret-API behavior already documented on
          // the image widget. posAtDOM walks CM's own ContentView tree
          // instead of the browser's caret APIs and returns the widget's
          // exact `from`, which always satisfies the reveal test.
          let pos;
          try {
            pos = view.posAtDOM(root);
          } catch (err) {
            return dbg("reject: posAtDOM failed", err);
          }
          dbg("dispatch", { pos, docLen: view.state.doc.length });

          e.preventDefault();
          e.stopPropagation();
          view.dispatch({
            selection: e.shiftKey
              ? { anchor: view.state.selection.main.anchor, head: pos }
              : { anchor: pos },
            userEvent: "select.pointer",
            scrollIntoView: false,
          });
          view.focus();

          // Refinement pass: the dispatch above reveals the raw $…$ source
          // in place of the widget. One frame later the SAME pixel now sits
          // over real editable text, where posAtCoords is trustworthy — so
          // re-resolve it and move the caret to where the user actually
          // aimed (e.g. clicking the "diff" subscript lands the caret near
          // "diff" in the source). Clamped to the revealed line so a stale
          // coordinate can't teleport the caret; skipped for shift-extends.
          if (!e.shiftKey) {
            const cx = e.clientX;
            const cy = e.clientY;
            requestAnimationFrame(() => {
              if (view.state.selection.main.anchor !== pos) return; // user moved on
              const p2 = view.posAtCoords({ x: cx, y: cy }, false);
              if (p2 == null || p2 === pos) return;
              const ln = view.state.doc.lineAt(pos);
              if (p2 < ln.from || p2 > ln.to) return; // degenerate again — keep from-side
              view.dispatch({
                selection: { anchor: p2 },
                userEvent: "select.pointer",
                scrollIntoView: false,
              });
            });
          }
        };
        view.scrollDOM.addEventListener("mousedown", this.onDown, true);
      }
      destroy() {
        this.view.scrollDOM.removeEventListener("mousedown", this.onDown, true);
      }
    },
  );

  // ── Drag auto-scroll, rAF-driven ─────────────────────────────────────────
  // CodeMirror's built-in drag edge-scrolling steps scrollTop from a 50ms
  // setInterval (MouseSelection.setScrollSpeed → scroll()), a hard 20fps
  // ceiling that reads as chop, and it only engages in the last ~6px before
  // the scroller edge, which reads as slow. This plugin owns drag scrolling
  // instead: a 24px edge zone, a distance-proportional speed curve, and a
  // requestAnimationFrame loop (60fps). CM's own interval is disabled by
  // patching setScrollSpeed to a no-op on the live MouseSelection instance
  // right after mousedown — scrollMargins can't do it (getScrollMargins
  // clamps at 0 via Math.max), and there is no public switch. The patch is
  // guarded: if a future CM restructures inputState, we silently fall back
  // to CM's own (chunkier) scrolling rather than breaking selection.
  const DRAG_EDGE = 24; // px inside the scroller edge where scrolling starts
  const DRAG_GAIN = 0.35; // px/frame per px of overshoot
  const DRAG_BASE = 4; // px/frame right at the zone boundary
  const DRAG_MAX = 48; // px/frame cap (~2900 px/s at 60fps)
  const dragScroll = ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.view = view;
        this.armed = false;
        this.raf = -1;
        this.x = 0;
        this.y = 0;
        this.rect = null;
        this.step = this.step.bind(this);

        this.patch = () => {
          try {
            const ms = view.inputState && view.inputState.mouseSelection;
            if (ms && !ms._nibScrollPatched) {
              ms._nibScrollPatched = true;
              ms.setScrollSpeed = () => {}; // rAF loop owns drag scrolling
            }
          } catch (_) {
            /* private API drifted: CM keeps its own scrolling, still works */
          }
        };
        this.onDown = (e) => {
          if (e.button !== 0) return;
          if (!(e.target instanceof Node) || !view.scrollDOM.contains(e.target))
            return;
          this.armed = true;
          this.rect = view.scrollDOM.getBoundingClientRect();
          this.x = e.clientX;
          this.y = e.clientY;
          // CM constructs its MouseSelection during this same event's
          // dispatch (we're in capture, it handles on contentDOM); the
          // microtask runs after the dispatch completes, when the instance
          // exists. Covers the margin-forwarded synthetic mousedown too.
          queueMicrotask(this.patch);
        };
        this.onMove = (e) => {
          if (!this.armed || !e.isTrusted) return; // ignore our own synthetics
          if ((e.buttons & 1) === 0) return this.stop();
          this.x = e.clientX;
          this.y = e.clientY;
          this.patch();
          if (this.raf < 0 && this.speed() !== 0)
            this.raf = requestAnimationFrame(this.step);
        };
        this.onEnd = () => this.stop();
        window.addEventListener("mousedown", this.onDown, true);
        window.addEventListener("mousemove", this.onMove, true);
        window.addEventListener("mouseup", this.onEnd, true);
        window.addEventListener("dragstart", this.onEnd, true); // native DnD suppresses mouse events
        window.addEventListener("blur", this.onEnd);
      }
      speed() {
        const r = this.rect;
        if (!r) return 0;
        const top = r.top + DRAG_EDGE;
        const bottom = r.bottom - DRAG_EDGE;
        if (this.y < top)
          return -Math.min(DRAG_MAX, DRAG_BASE + (top - this.y) * DRAG_GAIN);
        if (this.y > bottom)
          return Math.min(DRAG_MAX, DRAG_BASE + (this.y - bottom) * DRAG_GAIN);
        return 0;
      }
      step() {
        this.raf = -1;
        if (!this.armed) return;
        const s = this.speed();
        if (s === 0) return; // park; the next mousemove restarts the loop
        const sc = this.view.scrollDOM;
        const before = sc.scrollTop;
        sc.scrollTop = before + s;
        if (sc.scrollTop !== before) {
          // Keep the selection head extending while the pointer HOLDS past
          // the edge: CM re-selects on mousemove, so feed it one at the
          // current pointer position. buttons:1 is required — CM destroys
          // the mouse selection on any move with buttons == 0.
          document.dispatchEvent(
            new MouseEvent("mousemove", {
              bubbles: true,
              clientX: this.x,
              clientY: this.y,
              buttons: 1,
            }),
          );
        }
        this.raf = requestAnimationFrame(this.step);
      }
      stop() {
        this.armed = false;
        if (this.raf >= 0) cancelAnimationFrame(this.raf);
        this.raf = -1;
      }
      destroy() {
        this.stop();
        window.removeEventListener("mousedown", this.onDown, true);
        window.removeEventListener("mousemove", this.onMove, true);
        window.removeEventListener("mouseup", this.onEnd, true);
        window.removeEventListener("dragstart", this.onEnd, true);
        window.removeEventListener("blur", this.onEnd);
      }
    },
  );

  const livePreviewPlugin = ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.tree = null;
        this.scan = null;
        this.sig = null;
        this.pendingRefresh = false;
        this.pointerDragging = false;
        this.detached = false;
        this.decorations = Decoration.none;
        // Releasing a pointer drag produces no transaction of its own, so a
        // freeze deferred in update() (see pointer-drag freeze) would sit
        // stale until the next keystroke. Window-level (not editor-level:
        // drags routinely end outside the editor) mouseup releases the drag
        // flag and dispatches one empty transaction to run the deferred
        // refresh; setTimeout lets CodeMirror finish its own mouseup
        // selection handling first.
        this.onWinMouseUp = () => {
          this.pointerDragging = false;
          if (!this.pendingRefresh) return;
          setTimeout(() => {
            // "reveal.sync": both this plugin (via pendingRefresh) and the
            // math field key off this to reconcile reveal state after the
            // drag. NOT named under "select.pointer": isUserEvent matches
            // by dot-prefix, so anything under that name would re-trigger
            // the freezes this nudge exists to release.
            if (!this.detached) view.dispatch({ userEvent: "reveal.sync" });
          }, 0);
        };
        window.addEventListener("mouseup", this.onWinMouseUp);
        this.refresh(view.state, true);
      }
      destroy() {
        this.detached = true;
        window.removeEventListener("mouseup", this.onWinMouseUp);
      }
      update(update) {
        // ── IME composition guard ─────────────────────────────────────────
        // While a hangul/CJK preedit is active, never rebuild the decoration
        // set. Each preedit keystroke is a doc change; rebuilding makes
        // CodeMirror reconcile the composed line's DOM while the IME still
        // owns uncommitted text there. With a replace widget sitting on the
        // ListMark, that reconciliation surfaces the raw literal ("1.") next
        // to the rendered marker ("1.") — which reads as a spurious extra
        // nesting level ("1.1.") — and the DOM reader can even feed the
        // duplicated marker text back into the document ("1. 1. x" then
        // genuinely parses as a nested list). Freeze instead: map the
        // existing decorations through the changes so positions stay
        // correct, and defer the rebuild to composition end (the
        // composeEndNudge below guarantees an update fires then).
        const composing =
          update.view.composing || update.view.compositionStarted === true;
        if (composing) {
          if (update.docChanged)
            this.decorations = this.decorations.map(update.changes);
          this.pendingRefresh = true;
          return;
        }
        // ── Pointer-drag live reveal ──────────────────────────────────────
        // While a mouse selection is being extended, re-assemble reveal
        // state LIVE, in both directions: content the selection sweeps
        // unrenders immediately, and content the selection leaves
        // re-renders immediately (this used to be a full mouseup-deferred
        // freeze).
        //
        // The drag state is STATEFUL (pointerDragging), not per-update: in
        // long documents the incremental parser keeps progressing in the
        // background, and each progression fires an update that is NOT
        // "select.pointer" — those keep deferring (a rescan mid-gesture
        // would rebuild rangeItems and restyle the document's tail under
        // the pointer). pendingRefresh stays armed for the whole drag, so
        // the window-mouseup listener (constructor) always dispatches the
        // "reveal.sync" that runs any deferred rescan.
        if (this.pointerDragging) {
          const pointer = update.transactions.some((tr) =>
            tr.isUserEvent("select.pointer"),
          );
          if (!update.docChanged && (pointer || !update.selectionSet)) {
            if (pointer && this.scan) this.liveAssemble(update.state);
            this.pendingRefresh = true;
            return;
          }
          // A doc change or a non-pointer selection can't happen mid-drag —
          // the release was missed (button let go outside the window, focus
          // loss, …). Unstick and fall through to normal handling.
          this.pointerDragging = false;
        } else if (
          update.selectionSet &&
          !update.docChanged &&
          !update.state.selection.main.empty &&
          update.transactions.some((tr) => tr.isUserEvent("select.pointer"))
        ) {
          this.pointerDragging = true;
          this.pendingRefresh = true; // arms the mouseup reveal.sync nudge
          if (this.scan) this.liveAssemble(update.state);
          return;
        }
        if (this.pendingRefresh) {
          this.pendingRefresh = false;
          this.refresh(update.state, true);
          return;
        }
        // Rescan when the doc changed OR the syntax tree progressed (large
        // documents parse incrementally in the background; the old plugin
        // never picked up the finished parse, leaving the tail unstyled).
        const tree = syntaxTree(update.state);
        if (update.docChanged || tree !== this.tree) {
          this.refresh(update.state, true);
          return;
        }
        // Selection-only change: re-assemble from the cache. The signature
        // check inside assemble() makes moves that don't alter any reveal
        // state (most mousemoves of a drag) completely free — no new
        // decoration set, no DOM churn under an in-progress selection.
        if (update.selectionSet) this.refresh(update.state, false);
      }
      refresh(state, rescan) {
        try {
          if (rescan || !this.scan) {
            this.tree = syntaxTree(state);
            this.scan = scanDoc(state, this.tree);
            this.sig = null;
          }
          const res = assemble(this.scan, state, this.sig);
          if (res) {
            this.decorations = res.deco;
            this.sig = res.sig;
          }
        } catch (e) {
          // Never let a build error kill the plugin (which would drop all
          // decorations). Log and fall back to no decorations for this pass.
          console.log("[markdown-preview] build error:", e && e.message);
          this.decorations = Decoration.none;
          this.scan = null;
          this.sig = null;
        }
      }
      // Mid-drag assembly: the same cache-only path as a normal selection
      // change (no scan, no parsing). The signature check inside assemble()
      // still makes mousemoves that don't change any reveal state
      // completely free. Separate from refresh() only for the catch: a
      // build error mid-gesture must keep the CURRENT decorations, not
      // flash the document unstyled.
      liveAssemble(state) {
        try {
          const res = assemble(this.scan, state, this.sig);
          if (res) {
            this.decorations = res.deco;
            this.sig = res.sig;
          }
        } catch (e) {
          console.log(
            "[markdown-preview] drag assemble error:",
            e && e.message,
          );
        }
      }
    },
    { decorations: (v) => v.decorations },
  );

  // ── LaTeX source colorizing ─────────────────────────────────────────────
  // When the caret reveals raw math ($…$ / $$…$$), the source is colorized
  // with lightweight regex tokens: \commands, braces, script/align operators
  // (^ _ &), % comments, and numbers. This is scan-time work (selection-
  // independent), so the marks are prebuilt alongside each math item and
  // only emitted while that item is being edited.
  const TEX_TOKEN_RE =
    /(\\(?:[a-zA-Z]+\*?|.))|([{}])|([\^_&])|(%[^\n]*)|(\d+(?:\.\d+)?)/g;
  const texMarkCache = new Map();
  const texMark = (cls) => {
    let d = texMarkCache.get(cls);
    if (!d) {
      d = Decoration.mark({ class: cls });
      texMarkCache.set(cls, d);
    }
    return d;
  };
  const texDelim = texMark("cm-tex-delim");
  function texTokenMarks(src, base) {
    const out = [];
    // Base ink for the whole revealed source, delimiters excluded (src is
    // the content BETWEEN the $'s). Token marks are pushed after and cover
    // their sub-ranges as nested spans, so their palette wins wherever a
    // token exists — this class only ends up coloring what nothing else
    // claims: variable letters, punctuation, spaces. Net effect: raw math
    // reads as "formula" at a glance without touching any token color.
    if (src.length) out.push(texMark("cm-tex-body").range(base, base + src.length));
    TEX_TOKEN_RE.lastIndex = 0;
    let m;
    while ((m = TEX_TOKEN_RE.exec(src)) !== null) {
      const cls = m[1]
        ? "cm-tex-cmd"
        : m[2]
          ? "cm-tex-brace"
          : m[3]
            ? "cm-tex-op"
            : m[4]
              ? "cm-tex-comment"
              : "cm-tex-num";
      out.push(texMark(cls).range(base + m.index, base + m.index + m[0].length));
    }
    return out;
  }

  // ── Math field (KaTeX) ──────────────────────────────────────────────────
  // Block $$…$$ needs a BLOCK decoration to render full-width (centered),
  // which ViewPlugins can't provide — so all math lives in this StateField.
  // Inline $…$ stays an inline replace; block $$…$$ on its own lines becomes
  // a block:true replace. Both reveal raw when the caret touches them.
  //
  // Same scan/assemble split as the plugin: doc.toString() and the regex
  // passes run once per doc version (WeakMap keyed by the immutable Text),
  // not on every keystroke AND every caret move like before. The editing
  // (`on`) variant of a block is built lazily at assembly time because it
  // reads mathHeightCache, which is filled asynchronously after first render.
  const BLOCK_RE = /\$\$([^$]*?)\$\$/g;
  const INLINE_RE = /(?<![\\$])\$(?![\s$])((?:\\.|[^$\\\n])*?[^\s\\])\$(?!\$)/g;
  const mathScanCache = new WeakMap(); // Text -> { tree, items }

  function scanMath(state, scanText) {
    const doc = state.doc;
    const tree = syntaxTree(state);
    const inCode = (pos) => {
      let n = tree.resolveInner(pos, 1);
      while (n) {
        if (n.name === "InlineCode" || n.name === "FencedCode") return true;
        n = n.parent;
      }
      return false;
    };

    const fullText = scanText != null ? scanText : doc.toString();
    const items = [];
    const mathRanges = [];
    const overlapsMath = (a, b) => mathRanges.some(([c, d]) => a < d && b > c);

    // Block $$…$$ (may span lines). Empty content is allowed so a just-typed
    // "$$$$" still gets the block treatment (centering/padding) immediately.
    let bm;
    BLOCK_RE.lastIndex = 0;
    while ((bm = BLOCK_RE.exec(fullText)) !== null) {
      const from = bm.index;
      const to = from + bm[0].length;
      mathRanges.push([from, to]);
      if (inCode(from)) continue;
      const tex = bm[1].trim();
      const l1 = doc.lineAt(from);
      const l2 = doc.lineAt(to);
      // block:true only when the $$…$$ occupies whole lines; otherwise an
      // inline (mid-text) $$…$$ falls back to an inline replace.
      const asBlock = from === l1.from && to === l2.to;

      const off = tex
        ? [
            Decoration.replace({
              widget: new MathWidget(tex, true),
              block: asBlock,
            }).range(from, to),
          ]
        : EMPTY; // empty $$$$ not being edited → nothing to render

      // Colorize the raw source while editing: $$ delimiters + tex tokens.
      const texMarks = [
        texDelim.range(from, from + 2),
        ...texTokenMarks(fullText.slice(from + 2, to - 2), from + 2),
        texDelim.range(to - 2, to),
      ];

      let on = texMarks;
      if (asBlock) {
        // Editing: show raw, styled like the rendered block (centered +
        // matching padding). For a single-line block, reserve the rendered
        // equation's measured height as min-height so tall equations don't
        // shift the content below on toggle. Built lazily — the height cache
        // fills after the widget first renders.
        const lines = [];
        for (let n = l1.number; n <= l2.number; n++) {
          let cls = "cm-md-math-source";
          if (n === l1.number) cls += " cm-md-math-source-first";
          if (n === l2.number) cls += " cm-md-math-source-last";
          lines.push({ from: doc.line(n).from, cls });
        }
        const single = l1.number === l2.number;
        on = () => {
          const h = single ? mathHeightCache.get(tex) : null;
          const out = lines.map(({ from: lf, cls }) => {
            const spec = { class: cls };
            if (h) spec.attributes = { style: `min-height:${h}px` };
            return Decoration.line(spec).range(lf);
          });
          for (const r of texMarks) out.push(r);
          return out;
        };
      }
      items.push({ tFrom: from, tTo: to, on, off });
    }

    // Inline $…$.
    for (let ln = 1; ln <= doc.lines; ln++) {
      const line = doc.line(ln);
      INLINE_RE.lastIndex = 0;
      let im;
      while ((im = INLINE_RE.exec(line.text)) !== null) {
        const from = line.from + im.index;
        const to = from + im[0].length;
        if (overlapsMath(from, to)) continue;
        if (inCode(from)) continue;
        const tex = im[1].trim();
        if (!tex) continue;
        // Heading lines reveal as ONE unit. The "#### " marker is line-based
        // (livePreviewPlugin lineItems: caret on the line reveals it) but
        // math is range-based — so a caret at the line START showed the raw
        // "####" while the equation stayed rendered, and a caret in the
        // equation revealed both. Half-raw headings read as broken. Widening
        // the TOUCH range (tFrom/tTo feed only mathAssemble's reveal test;
        // the replace decorations in on/off keep their exact positions) to
        // the whole line makes any caret on a heading line reveal marker +
        // every equation together. Deliberately headings ONLY: a body
        // paragraph is one long wrapped "line", and line-wide reveal there
        // would flip every inline equation in the paragraph to raw the
        // moment the caret enters it.
        const isHeading = /^#{1,6}\s/.test(line.text);
        items.push({
          tFrom: isHeading ? line.from : from,
          tTo: isHeading ? line.to : to,
          on: [
            texDelim.range(from, from + 1),
            ...texTokenMarks(line.text.slice(im.index + 1, im.index + im[0].length - 1), from + 1),
            texDelim.range(to - 1, to),
          ],
          off: [
            Decoration.replace({ widget: new MathWidget(tex, false) }).range(
              from,
              to,
            ),
          ],
        });
      }
    }

    return { tree, items };
  }

  function mathAssemble(state, prev) {
    const sel = state.selection.main;
    const doc = state.doc;

    // Neutralize the "$" pair the caret sits between ONLY when it's an exact
    // 2-"$" group ("$|$" — a freshly auto-paired inline), which would
    // otherwise mis-pair with a real block below. A 4-"$" group ("$$|$$") is
    // a self-contained empty display block, so leave it alone. This is the
    // one selection-dependent input to the scan, so it bypasses the cache —
    // it only holds for the instant after typing "$", which is rare.
    const cp = sel.from;
    const neutral =
      sel.empty &&
      cp > 0 &&
      cp < doc.length &&
      doc.sliceString(cp - 1, cp) === "$" &&
      doc.sliceString(cp, cp + 1) === "$" &&
      (cp < 2 || doc.sliceString(cp - 2, cp - 1) !== "$") &&
      doc.sliceString(cp + 1, cp + 2) !== "$";

    let scan;
    if (neutral) {
      const fullText = doc.toString();
      scan = scanMath(
        state,
        fullText.slice(0, cp - 1) + "\uffff\uffff" + fullText.slice(cp + 1),
      );
    } else {
      scan = mathScanCache.get(doc);
      if (!scan || scan.tree !== syntaxTree(state)) {
        scan = scanMath(state);
        mathScanCache.set(doc, scan);
      }
    }

    const items = scan.items;
    const bits = new Uint8Array(items.length);
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (sel.from <= it.tTo && sel.to >= it.tFrom) bits[i] = 1;
    }
    if (prev && prev.items === items && sameBits(prev.bits, bits)) return prev;

    const decos = [];
    for (let i = 0; i < items.length; i++) {
      let src = bits[i] ? items[i].on : items[i].off;
      if (typeof src === "function") src = src();
      for (const r of src) decos.push(r);
    }
    return { deco: Decoration.set(decos, true), items, bits };
  }

  const mathField = StateField.define({
    create: (state) => mathAssemble(state, null),
    update(value, tr) {
      // IME composition guard (same rationale as the live-preview plugin's):
      // never swap decoration sets under an active preedit — just keep the
      // current set's positions mapped. CodeMirror flags preedit changes
      // with userEvent "input.type.compose". The stale items/bits are fine:
      // they're discarded by the full reassemble that the composeEndNudge's
      // "compose.end" transaction forces once the IME commits.
      if (tr.isUserEvent("input.type.compose"))
        return {
          deco: value.deco.map(tr.changes),
          items: value.items,
          bits: value.bits,
        };
      if (tr.isUserEvent("compose.end")) return mathAssemble(tr.state, null);
      // Pointer drags deliberately have NO special branch here: a
      // "select.pointer" transaction carries a selection, so it falls
      // through to the default mathAssemble below and equations reveal /
      // re-render live, in both directions, exactly as the selection
      // touches or leaves them (mirrors the live-preview plugin). The
      // reveal.sync nudge stays for the post-drag reconcile of anything the
      // plugin deferred (here it just forces one fresh reassemble).
      if (tr.isUserEvent("reveal.sync")) return mathAssemble(tr.state, null);
      if (!tr.docChanged && !tr.selection) return value;
      return mathAssemble(tr.state, tr.docChanged ? null : value);
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
  });

  // ── IME composition end nudge ─────────────────────────────────────────────
  // compositionend does not always produce its own transaction (e.g. the IME
  // commits text identical to the current preedit), so the deferred rebuilds
  // above could otherwise sit stale until the next keystroke. Dispatch one
  // empty "compose.end" transaction right after CodeMirror finishes its own
  // compositionend flush (setTimeout puts it behind the observer's work);
  // the plugin's pendingRefresh path and the math field both key off it.
  const composeEndNudge = EditorView.domEventHandlers({
    compositionend(_event, view) {
      setTimeout(() => {
        if (!view.composing) view.dispatch({ userEvent: "compose.end" });
      }, 0);
      return false;
    },
  });

  // ── Per-block horizontal scrolling for fenced code ────────────────────────
  // Code lines are individual overflow-x scroll containers (see the CSS), so
  // the browser gives each LINE panning — this plugin turns that into
  // BLOCK panning: when any line of a fence scrolls (Shift+wheel, trackpad,
  // or CodeMirror revealing the caret), every line of that fence follows.
  // It also survives CodeMirror recreating line DOM on updates, which
  // resets scrollLeft to 0: offsets are remembered per fence (keyed by the
  // fence's start position, remapped through document changes) and
  // re-applied in a measure pass after each update.
  //
  // It also owns one floating horizontal scrollbar PER overflowing block
  // (createHBar): per-line native scrollbars are hidden in CSS because a
  // scrollbar on every line would be absurd, and no single line can host
  // the bar (a short last line's own scroll range doesn't cover the
  // block's). Bars live in scroller-content coordinates inside .cm-scroller
  // (see hscrollbar.js), are created/positioned in a two-phase (read all,
  // then write all) measure pass to avoid layout thrash, and only the
  // hovered/most-recently-scrolled bar is visible — pointer routing against
  // cached rects costs zero layout reads per mousemove.
  const codeBlockHScroll = ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.view = view;
        this.offsets = new Map(); // FencedCode.from -> scrollLeft
        this.syncing = false;
        this.destroyed = false;
        this.bars = new Map(); // FencedCode.from -> { from, to, bar }
        this.barsMeasureKey = {}; // stable requestMeasure dedupe key
        // Caret-follow scrolls while typing at an overflowing line would
        // otherwise flash the bar on every keystroke; suppress showTemp
        // shortly after any keydown (same idea as the vertical bar's
        // typing-hide, minus the hide — position sync still runs).
        this.lastKeyTs = 0;
        this.onKeyDown = () => {
          this.lastKeyTs = Date.now();
        };
        view.scrollDOM.addEventListener("keydown", this.onKeyDown, true);
        // Pointer routing: one rAF-coalesced mousemove on the scroller
        // converts to content coordinates once, then fans out to every
        // bar's cached-metrics hit test.
        this.moveRaf = false;
        this.lastMove = null;
        this.onMove = (e) => {
          if (!this.bars.size) return;
          this.lastMove = e;
          if (this.moveRaf) return;
          this.moveRaf = true;
          window.requestAnimationFrame(() => {
            this.moveRaf = false;
            if (this.destroyed) return;
            const ev = this.lastMove;
            this.lastMove = null;
            if (!ev) return;
            const sr = this.view.scrollDOM.getBoundingClientRect();
            const cx = ev.clientX - sr.left;
            const cy = ev.clientY - sr.top + this.view.scrollDOM.scrollTop;
            for (const rec of this.bars.values()) rec.bar.pointer(cx, cy);
          });
        };
        view.scrollDOM.addEventListener("mousemove", this.onMove);
        this.onLeave = () => {
          for (const rec of this.bars.values()) rec.bar.pointerLeave();
        };
        view.scrollDOM.addEventListener("mouseleave", this.onLeave);
        this.scheduleBarsRefresh();
        this.onScroll = (e) => {
          const el = e.target;
          if (!el || el.nodeType !== 1 || !el.classList?.contains("cm-line"))
            return;
          if (
            !el.classList.contains("cm-md-code-line") &&
            !el.classList.contains("cm-md-code-first") &&
            !el.classList.contains("cm-md-code-last")
          )
            return;
          if (this.syncing) return;
          let pos;
          try {
            pos = view.posAtDOM(el, 0);
          } catch {
            return;
          }
          const block = this.blockAt(pos);
          if (!block) return;
          // Equality check both dedupes and terminates the echo loop: our
          // own sibling writes fire scroll events asynchronously, after the
          // syncing flag has already been cleared.
          if (this.offsets.get(block.from) === el.scrollLeft) return;
          this.offsets.set(block.from, el.scrollLeft);
          this.applyBlock(block.from, block.to, el.scrollLeft, el);
          // Reveal the block's scrollbar (unless the scroll came from the
          // caret following typing) and queue a geometry sync for the new
          // offset. The dedupe check above keeps our own sibling-write
          // echoes from re-triggering this.
          const rec = this.bars.get(block.from);
          if (rec && Date.now() - this.lastKeyTs > 500) rec.bar.showTemp();
          this.scheduleBarsRefresh();
          // Cursor/selection overlays are positioned from measured text
          // geometry — refresh them for the new offsets.
          view.requestMeasure();
        };
        // scroll doesn't bubble; capture catches it from descendant lines.
        view.scrollDOM.addEventListener("scroll", this.onScroll, true);
      }

      blockAt(pos) {
        let n = syntaxTree(this.view.state).resolveInner(pos, 1);
        while (n && n.name !== "FencedCode") n = n.parent;
        return n;
      }

      lineEl(pos) {
        try {
          let n = this.view.domAtPos(pos).node;
          while (n && !(n.classList && n.classList.contains("cm-line")))
            n = n.parentNode;
          return n;
        } catch {
          return null;
        }
      }

      applyBlock(from, to, left, skipEl) {
        const doc = this.view.state.doc;
        const first = doc.lineAt(from).number;
        const last = doc.lineAt(to).number;
        this.syncing = true;
        try {
          for (let ln = first; ln <= last; ln++) {
            const el = this.lineEl(doc.line(ln).from);
            if (el && el !== skipEl && el.scrollLeft !== left)
              el.scrollLeft = left;
          }
        } finally {
          this.syncing = false;
        }
      }

      // ── Horizontal scrollbar bars ─────────────────────────────────────────
      // Two-phase refresh via requestMeasure: read() measures every visible
      // fenced block (rects + scrollWidths, batched with no interleaved
      // writes), write() creates/syncs/destroys bar DOM. The stable key
      // dedupes to one refresh per frame no matter how many callers ask.
      scheduleBarsRefresh() {
        this.view.requestMeasure({
          key: this.barsMeasureKey,
          read: (view) => this.readBars(view),
          write: (measured) => this.writeBars(measured),
        });
      }

      readBars(view) {
        const out = [];
        const doc = view.state.doc;
        const sr = view.scrollDOM.getBoundingClientRect();
        const st = view.scrollDOM.scrollTop;
        const tree = syntaxTree(view.state);
        for (const { from, to } of view.visibleRanges) {
          tree.iterate({
            from,
            to,
            enter: (n) => {
              if (n.name !== "FencedCode") return;
              out.push({
                from: n.from,
                to: n.to,
                m: this.measureBlock(n.from, n.to, doc, sr, st),
              });
              return false;
            },
          });
        }
        return out;
      }

      // Metrics for one block in scroller-content coordinates (hscrollbar.js
      // contract). Only code-line scroll containers count — fence lines are
      // collapsed non-containers in rendered mode. maxScroll comes from the
      // widest RENDERED line, so a huge block whose widest line is outside
      // the viewport underestimates until it scrolls in — the thumb just
      // recalibrates on the next refresh.
      measureBlock(from, to, doc, sr, st) {
        if (to > doc.length) return null;
        const first = doc.lineAt(from).number;
        const last = doc.lineAt(to).number;
        let maxSW = 0;
        let cw = 0;
        let sl = 0;
        let firstRect = null;
        let lastRect = null;
        for (let ln = first; ln <= last; ln++) {
          const el = this.lineEl(doc.line(ln).from);
          if (!el || !el.classList.contains("cm-md-code-line")) continue;
          if (el.scrollWidth > maxSW) maxSW = el.scrollWidth;
          if (el.scrollLeft > sl) sl = el.scrollLeft;
          cw = el.clientWidth;
          const r = el.getBoundingClientRect();
          if (!firstRect) firstRect = r;
          lastRect = r;
        }
        if (!firstRect) return null;
        const maxScroll = maxSW - cw;
        if (maxScroll <= 1) return null;
        // The intended offset (this.offsets) beats the measured one: on the
        // update that recreates line DOM, this read pass runs BEFORE the
        // offsets-restore write pass, so the lines still sit at 0.
        const intent = this.offsets.get(from);
        const left = lastRect.left - sr.left;
        const top = firstRect.top - sr.top + st;
        const bottom = lastRect.bottom - sr.top + st;
        return {
          trackLeft: left + 8,
          trackWidth: Math.max(0, lastRect.width - 16),
          y: bottom - 5, // thumb BOTTOM edge, flush near the block bottom
          scrollLeft: Math.min(intent != null ? intent : sl, maxScroll),
          clientWidth: cw,
          maxScroll,
          hoverRect: { left, right: left + lastRect.width, top, bottom },
        };
      }

      writeBars(measured) {
        if (this.destroyed) return;
        const seen = new Set();
        for (const item of measured) {
          seen.add(item.from);
          let rec = this.bars.get(item.from);
          if (!item.m) {
            if (rec) {
              rec.bar.destroy();
              this.bars.delete(item.from);
            }
            continue;
          }
          if (!rec) {
            rec = { from: item.from, to: item.to, bar: null };
            rec.bar = createHBar({
              container: this.view.scrollDOM,
              onDrag: (left) => {
                this.offsets.set(rec.from, left);
                this.applyBlock(rec.from, rec.to, left, null);
                this.scheduleBarsRefresh();
                this.view.requestMeasure();
              },
            });
            this.bars.set(item.from, rec);
          }
          rec.from = item.from;
          rec.to = item.to;
          rec.bar.sync(item.m);
        }
        for (const [k, rec] of this.bars) {
          if (!seen.has(k)) {
            rec.bar.destroy();
            this.bars.delete(k);
          }
        }
      }

      update(update) {
        if (update.docChanged) {
          const remapped = new Map();
          for (const [k, v] of this.offsets)
            remapped.set(update.changes.mapPos(k, 1), v);
          this.offsets = remapped;
          // Bars remap identically so an edit above a block moves its bar
          // record (and its DOM) instead of destroy+recreate flicker.
          const remappedBars = new Map();
          for (const [k, rec] of this.bars) {
            const pos = update.changes.mapPos(k, 1);
            const clash = remappedBars.get(pos);
            if (clash) clash.bar.destroy(); // merged blocks: keep one bar
            rec.from = pos;
            remappedBars.set(pos, rec);
          }
          this.bars = remappedBars;
        }
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.geometryChanged
        )
          this.scheduleBarsRefresh();
        // Line elements may have been recreated with scrollLeft 0 — restore
        // remembered offsets once the new DOM is in place.
        if (
          (update.docChanged ||
            update.viewportChanged ||
            update.geometryChanged) &&
          this.offsets.size
        ) {
          this.view.requestMeasure({
            key: this,
            read: () => null,
            write: (_, view) => {
              const tree = syntaxTree(view.state);
              for (const { from, to } of view.visibleRanges) {
                tree.iterate({
                  from,
                  to,
                  enter: (n) => {
                    if (n.name !== "FencedCode") return;
                    const left = this.offsets.get(n.from);
                    if (left) this.applyBlock(n.from, n.to, left, null);
                    return false;
                  },
                });
              }
            },
          });
        }
      }

      destroy() {
        this.destroyed = true;
        this.view.scrollDOM.removeEventListener("scroll", this.onScroll, true);
        this.view.scrollDOM.removeEventListener(
          "keydown",
          this.onKeyDown,
          true,
        );
        this.view.scrollDOM.removeEventListener("mousemove", this.onMove);
        this.view.scrollDOM.removeEventListener("mouseleave", this.onLeave);
        this.lastMove = null;
        for (const rec of this.bars.values()) rec.bar.destroy();
        this.bars.clear();
      }
    },
  );

  return [
    // Editor-wide soft wrap. Without it, .cm-content grows to the widest
    // line in the document, so a code line's own width always fits and its
    // overflow-x:auto never triggers — the overflow escalates to the
    // scroller and the WHOLE editor pans sideways. With wrapping on, prose
    // wraps at the editor width; fenced-code lines opt back out via
    // `white-space: pre !important` (markdown-preview.css) and become the
    // app's only horizontal scroll containers, synced per block by
    // codeBlockHScroll below.
    EditorView.lineWrapping,
    markdown({
      base: markdownLanguage,
      completeHTMLTags: false,
      // Nested highlighting for fenced code: ```js / ```python / … parse
      // with the real language grammar so mdHighlight's code-token rules
      // light up. No-op when the bundle doesn't ship language-data.
      ...(languages ? { codeLanguages: languages } : {}),
      extensions: [
        { remove: ["SetextHeading"] },
        backtickOnlyFence,
        smartTable,
      ],
    }),
    syntaxHighlighting(mdHighlight),
    livePreviewPlugin,
    marginMouseDown,
    mathMouseDown,
    dragScroll,
    composeEndNudge,
    codeBlockHScroll,
    linkClick,
    noAutoClose,
    tabKeymap,
    enterKeymap,
    autoPair,
    searchKeys,
    tableExtension,
    mathField,
  ];
}
