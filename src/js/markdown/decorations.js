// decorations.js
//
// Syntax highlight style plus every reusable decoration the live preview
// applies. Factory form: needs Decoration, HighlightStyle and the tag set from
// the dynamically imported bundle, plus the widget classes used by the replace
// decorations built here.
//
// Decorations that vary by a small key (marker label, glyph, quote depth) are
// memoized so a rebuild hands CodeMirror the exact same Decoration/widget
// instance and its diff drops them without touching the DOM.

const BASE_LINE_PAD = 6; // @codemirror/view base theme .cm-line padding-left
const QUOTE_GAP = 14; // px between stacked blockquote bars

export function createDecorations({
  Decoration,
  HighlightStyle,
  t,
  MarkerWidget,
  GlyphWidget,
}) {
  const mdHighlight = HighlightStyle.define([
    { tag: t.heading1, class: "cm-md-h1" },
    { tag: t.heading2, class: "cm-md-h2" },
    { tag: t.heading3, class: "cm-md-h3" },
    { tag: t.heading4, class: "cm-md-h4" },
    { tag: t.heading5, class: "cm-md-h5" },
    { tag: t.heading6, class: "cm-md-h6" },
    { tag: t.strong, class: "cm-md-strong" },
    { tag: t.emphasis, class: "cm-md-emphasis" },
    { tag: t.strikethrough, class: "cm-md-strike" }, // GFM ~~text~~
    { tag: t.monospace, class: "cm-md-code" }, // inline + fenced code text
    { tag: t.link, class: "cm-md-link" }, // link + image syntax

    // Nested code-block tokens, emitted by the inner language grammars when
    // markdown() is configured with codeLanguages. Colors live in
    // markdown-preview.css under the same names; inert until the bundle ships
    // language-data, harmless to define either way.
    { tag: t.keyword, class: "cm-code-keyword" },
    { tag: [t.string, t.special(t.string)], class: "cm-code-string" },
    { tag: t.comment, class: "cm-code-comment" },
    {
      tag: [t.number, t.integer, t.float, t.bool, t.atom, t.null],
      class: "cm-code-number",
    },
    {
      tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName],
      class: "cm-code-function",
    },
    { tag: [t.typeName, t.className, t.namespace], class: "cm-code-type" },
    { tag: [t.propertyName, t.attributeName], class: "cm-code-property" },
    { tag: [t.operator, t.operatorKeyword], class: "cm-code-operator" },
    { tag: [t.regexp, t.escape], class: "cm-code-regexp" },
    { tag: [t.meta, t.annotation], class: "cm-code-meta" },
    // t.processingInstruction is what lezer-markdown puts on STRUCTURAL MARKS
    // (heading "#", quote ">", backtick CodeMark). It needs its own neutral
    // class: riding cm-code-meta leaked the vivid violet onto every revealed
    // "#", and dropping the rule entirely would let basicSetup's
    // defaultHighlightStyle paint these marks green. Real PIs inside nested
    // code (<?xml ?>, <?php) take the neutral color too — a fair trade.
    { tag: t.processingInstruction, class: "cm-md-mark" },
    { tag: t.definition(t.variableName), class: "cm-code-def" },
    { tag: t.tagName, class: "cm-code-tag" }, // HTML/JSX tags
  ]);

  const line = (cls) => Decoration.line({ attributes: { class: cls } });

  // Memoize a decoration per string key.
  const cached = (build) => {
    const cache = new Map();
    return (key) => {
      let d = cache.get(key);
      if (d === undefined) {
        d = build(key);
        cache.set(key, d);
      }
      return d;
    };
  };

  const hideDeco = Decoration.replace({}); // hide a mark range (no widget)
  const emphMarkDeco = Decoration.mark({ class: "cm-md-emph-mark" });

  // Overrides the highlighter's t.link styling on bracket text that is NOT
  // actually a link. HighlightStyle is tag-based and can't see tree structure,
  // so URL-less "links" are un-styled here with a mark instead.
  const notLinkDeco = Decoration.mark({ class: "cm-md-not-link" });

  // List markers (bullets + computed ordered numbers) are rendered by REPLACING
  // the literal marker text with a widget. A widget reserves exactly the
  // rendered width (so a hierarchical "1.2.5" never overflows into the text)
  // and is atomic for hit-testing, so clicking a list item lands the caret in
  // the content instead of being stranded before a zero-width literal — which
  // is what the old CSS ::before hack did.
  const markerDeco = cached(
    (text) => Decoration.replace({ widget: new MarkerWidget(text) }),
  );

  // Arrow / comparison glyph substitution; ~15 distinct outputs in practice.
  const glyphDeco = cached(
    (glyph) => Decoration.replace({ widget: new GlyphWidget(glyph) }),
  );

  // Blockquote line, keyed by (depth, first, last). `depth` thin bars are drawn
  // with stacked background gradients and the text is indented clear of the
  // last bar.
  //
  // IMPORTANT: the indent is a transparent border-left, NOT padding-left.
  // CodeMirror's drawSelection layer derives the left edge of every
  // fully-selected-line rectangle from the computed padding-left of the FIRST
  // rendered .cm-line in the viewport; a line with nonstandard padding-left
  // that scrolls to the top poisons that edge for the whole selection
  // (indented rects, negative-width pieces that make the highlight vanish
  // mid-drag). Borders are never sampled. background-origin/clip: border-box
  // keeps bars and fill anchored at the line's true left edge.
  const quoteLineDeco = (() => {
    const cache = new Map();
    return (depth, first, last) => {
      const key = depth + (first ? "f" : "") + (last ? "l" : "");
      let d = cache.get(key);
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
      cache.set(key, d);
      return d;
    };
  })();

  return {
    mdHighlight,
    hideDeco,
    emphMarkDeco,
    notLinkDeco,
    markerDeco,
    glyphDeco,
    quoteLineDeco,

    hrLineDeco: line("cm-md-hr"),
    listLineDeco: line("cm-md-list-line"),
    // Collapses a (now-empty) fence line in rendered mode so it adds no height.
    fenceLineDeco: line("cm-md-fence-line"),

    // Editing mode: raw fences visible, compact background.
    codeLineDeco: line("cm-md-code-line"),
    codeFirstDeco: line("cm-md-code-line cm-md-code-first"),
    codeLastDeco: line("cm-md-code-line cm-md-code-last"),
    codeSoloDeco: line("cm-md-code-line cm-md-code-first cm-md-code-last"),

    // Rendered mode: cm-md-code-rendered marks EVERY line of a fences-hidden
    // block so CSS can give it its own inset; first/last additionally reserve
    // the language label's top/bottom room.
    codeLineRenderedDeco: line("cm-md-code-line cm-md-code-rendered"),
    codeFirstPadDeco: line(
      "cm-md-code-line cm-md-code-rendered cm-md-code-first cm-md-code-pad-top",
    ),
    codeLastPadDeco: line(
      "cm-md-code-line cm-md-code-rendered cm-md-code-last cm-md-code-pad-bottom",
    ),
    codeSoloPadDeco: line(
      "cm-md-code-line cm-md-code-rendered cm-md-code-first cm-md-code-last " +
        "cm-md-code-pad-top cm-md-code-pad-bottom",
    ),
  };
}
