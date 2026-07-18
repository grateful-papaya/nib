// decorations.js
//
// Syntax highlight style and the reusable line/mark/replace decorations for the
// live preview. Factory form: needs Decoration, HighlightStyle, and the tag set
// from the dynamically-imported bundle, plus MarkerWidget for the list-marker
// replacement. Returns mdHighlight and the decoration set the plugin applies.

export function createDecorations({
  Decoration,
  HighlightStyle,
  t,
  MarkerWidget,
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
    { tag: t.monospace, class: "cm-md-code" }, // inline code + fenced code text
    { tag: t.link, class: "cm-md-link" }, // link + image syntax

    // ── Nested code-block tokens ─────────────────────────────────────────
    // Emitted by the inner language grammars when markdown() is configured
    // with codeLanguages (```js, ```python, …). Colors live in
    // markdown-preview.css under the same class names. Inert until the
    // bundle ships language-data — harmless to define either way.
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
    {
      tag: [t.meta, t.annotation],
      class: "cm-code-meta",
    },
    // t.processingInstruction is what lezer-markdown puts on STRUCTURAL
    // MARKS — the heading "#", quote ">", backtick CodeMark, etc. It used to
    // ride the cm-code-meta rule above, so the vivid violet meant for code
    // annotations leaked onto every revealed "#" in the document. Own class,
    // own (neutral) color in markdown-preview.css. Side effect: real PIs
    // inside nested code (<?xml … ?>, <?php) also take this neutral color
    // instead of violet — a fair trade. Keeping SOME rule for this tag also
    // matters: it suppresses basicSetup's fallback defaultHighlightStyle,
    // which would otherwise paint these marks green (#164).
    { tag: t.processingInstruction, class: "cm-md-mark" },
    { tag: t.definition(t.variableName), class: "cm-code-def" },
    { tag: t.tagName, class: "cm-code-tag" }, // HTML/JSX tags
  ]);

  // ── Decoration factories ───────────────────────────────────────────────────
  const hideDeco = Decoration.replace({}); // hide a mark range (no widget)
  const emphMarkDeco = Decoration.mark({ class: "cm-md-emph-mark" });
  // List markers (bullets + computed ordered numbers) are rendered by REPLACING
  // the literal marker text with a small widget. A widget reserves exactly the
  // rendered width (so a hierarchical "1.2.5" never overflows into the text) and
  // is atomic for hit-testing, so clicking a list item lands the caret in the
  // content instead of being stranded before a zero-width literal — which is
  // what the CSS ::before hack did. A pseudo-element fundamentally can't
  // reconcile a variable-width number with correct click mapping.
  // Memoized per label: rebuilds then hand CodeMirror the exact same
  // Decoration (and widget) instance for "•", "1.", "1.2"…, so its diff drops
  // them without touching the DOM. The cache is small and bounded by the set
  // of distinct labels in the doc; MarkerWidget.eq made rebuilds cheap
  // already, identity makes them free.
  const markerDecoCache = new Map();
  const markerDeco = (text) => {
    let d = markerDecoCache.get(text);
    if (!d) {
      d = Decoration.replace({ widget: new MarkerWidget(text) });
      markerDecoCache.set(text, d);
    }
    return d;
  };
  const hrLineDeco = Decoration.line({ attributes: { class: "cm-md-hr" } });
  const codeLineDeco = Decoration.line({
    attributes: { class: "cm-md-code-line" },
  });
  const codeFirstDeco = Decoration.line({
    attributes: { class: "cm-md-code-line cm-md-code-first" },
  });
  const codeLastDeco = Decoration.line({
    attributes: { class: "cm-md-code-line cm-md-code-last" },
  });
  const codeSoloDeco = Decoration.line({
    attributes: { class: "cm-md-code-line cm-md-code-first cm-md-code-last" },
  });
  // Rendered-mode variants: cm-md-code-rendered marks EVERY line of a
  // rendered (fences hidden) block so CSS can give rendered blocks their own
  // inset without touching editing mode; first/last additionally add
  // cm-md-code-pad for the label's top/bottom room.
  const codeLineRenderedDeco = Decoration.line({
    attributes: { class: "cm-md-code-line cm-md-code-rendered" },
  });
  const codeFirstPadDeco = Decoration.line({
    attributes: {
      class:
        "cm-md-code-line cm-md-code-rendered cm-md-code-first cm-md-code-pad-top",
    },
  });
  const codeLastPadDeco = Decoration.line({
    attributes: {
      class:
        "cm-md-code-line cm-md-code-rendered cm-md-code-last cm-md-code-pad-bottom",
    },
  });
  const codeSoloPadDeco = Decoration.line({
    attributes: {
      class:
        "cm-md-code-line cm-md-code-rendered cm-md-code-first cm-md-code-last cm-md-code-pad-top cm-md-code-pad-bottom",
    },
  });
  const listLineDeco = Decoration.line({
    attributes: { class: "cm-md-list-line" },
  });
  // Collapses a (now-empty) fence line in rendered mode so it adds no height.
  const fenceLineDeco = Decoration.line({
    attributes: { class: "cm-md-fence-line" },
  });

  return {
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
  };
}
