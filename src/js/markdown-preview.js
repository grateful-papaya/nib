// markdown-preview.js
//
// Orchestrator for the Obsidian-style markdown live preview. It loads the
// CodeMirror bundle and KaTeX, wires the ./markdown/* factories together, and
// returns the extension array. It also owns the three editor-level input
// plugins at the bottom of this file — they are pure CodeMirror plumbing with
// no markdown knowledge, and each is small enough that a module of its own
// would say less than the comment above it.
//
//   scanner.js       scan once per doc, assemble per selection (+ ordered-list
//                    numbering and the glyph table, its only consumers)
//   live-preview.js  the decoration ViewPlugin driving that scan
//   math-field.js    $…$ / $$…$$ rendering, source colorizing, caret handling
//   decorations.js   highlight style + every reusable decoration
//   widgets.js       WidgetType subclasses
//   image-resolver.js  image path resolution + cache
//   code-hscroll.js  per-block horizontal scrolling for fenced code
//   hscrollbar.js    the floating scrollbar thumb both scrollers share
//   keymaps.js       Tab/Enter/auto-pair/link-click/search bindings
//   md-extensions.js  the grammar extensions: fences, tables, ==highlight==,
//                    [^footnotes] (pure)
//   table-*.js       the GFM table extension, entered via markdown-table.js
//
// The factories exist because their contents close over symbols from the
// dynamically imported bundle, which is only available inside this function.

import { createImageResolver } from "./markdown/image-resolver.js";
import { createWidgets } from "./markdown/widgets.js";
import { createDecorations } from "./markdown/decorations.js";
import { createKeymaps } from "./markdown/keymaps.js";
import { createScanner, computeOrderedLabels, isTagName } from "./markdown/scanner.js";
import { createLivePreviewPlugin } from "./markdown/live-preview.js";
import { createMathExtensions } from "./markdown/math-field.js";
import { createCodeBlockHScroll } from "./markdown/code-hscroll.js";
import {
  backtickOnlyFence,
  smartTable,
  highlight,
  footnotes,
} from "./markdown/md-extensions.js";

// Re-exported for tests, which exercise the numbering rules directly.
export { computeOrderedLabels };

const DRAG_EDGE = 24; // px inside the scroller edge where auto-scroll starts
const DRAG_GAIN = 0.35; // px/frame per px of overshoot
const DRAG_BASE = 4; // px/frame right at the zone boundary
const DRAG_MAX = 48; // px/frame cap (~2900 px/s at 60fps)

// KaTeX comes from the app's local copy (the CSP blocks CDNs). If it can't
// load, math just stays raw.
let katexPromise = null;
async function loadKatex() {
  if (katexPromise) return katexPromise;
  katexPromise = (async () => {
    if (!window.katex)
      await new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "js/libs/katex.min.js"; // relative to index.html
        s.onload = resolve;
        s.onerror = () => reject(new Error("katex.min.js failed to load"));
        document.head.appendChild(s);
      });
    const katex = window.katex || null;
    if (katex && !document.querySelector("link[data-katex]")) {
      const link = document.createElement("link"); // fonts + layout
      link.rel = "stylesheet";
      link.href = "css/katex.min.css";
      link.dataset.katex = "1";
      document.head.appendChild(link);
    }
    return katex;
  })().catch((err) => {
    console.warn("[markdown-preview] KaTeX unavailable:", err);
    return null;
  });
  return katexPromise;
}

export async function getMarkdownExtensions() {
  const cm = await import("./libs/codemirror.js");
  const { markdown, markdownLanguage } = cm;
  const { HighlightStyle, syntaxHighlighting, syntaxTree, tags: t } = cm;
  const { Decoration, ViewPlugin, EditorView, StateField, WidgetType } = cm;
  const { keymap, Prec, insertNewlineContinueMarkupCommand } = cm;

  // Optional bundle exports, feature-detected so the editor still works if the
  // vendored bundle predates them.
  const languages = cm.languages || null; // @codemirror/language-data
  const openSearchPanel = cm.openSearchPanel || null; // @codemirror/search
  if (!languages)
    console.warn(
      "[markdown-preview] code-block syntax highlighting needs the bundle to " +
        'export `languages` (add `export { languages } from ' +
        '"@codemirror/language-data";` to the codemirror bundle entry and ' +
        "install that package)",
    );

  const katex = await loadKatex();

  // Reveal-on-touch exists so the caret can reach the source it is about to
  // edit. In read mode there is no editing, so nothing reveals: every construct
  // stays rendered wherever the selection goes. Read-only and non-editable are
  // separate switches in CodeMirror and either one means "reader".
  const isReadMode = (state) =>
    state.readOnly || state.facet(EditorView.editable) === false;

  // GFM tables are a separate extension. If the bundle can't provide what it
  // needs, tables simply stay raw and a warning explains why — the rest of the
  // editor is unaffected.
  let tableExtension = [];
  try {
    const tbl = await import("./markdown-table.js");
    tableExtension = await tbl.getTableExtension();
  } catch (err) {
    console.warn("[markdown-preview] table extension disabled:", err);
  }

  const { resolveImageSrc, resolveImageSrcSync, writeImageWidth } =
    createImageResolver({ syntaxTree });

  const widgets = createWidgets({
    WidgetType,
    katex,
    resolveImageSrc,
    resolveImageSrcSync,
    writeImageWidth,
  });

  const deco = createDecorations({
    Decoration,
    HighlightStyle,
    t,
    MarkerWidget: widgets.MarkerWidget,
    GlyphWidget: widgets.GlyphWidget,
    ColorSwatchWidget: widgets.ColorSwatchWidget,
  });

  const { scanDoc, assemble } = createScanner({
    Decoration,
    deco,
    widgets,
    isReadMode,
  });

  const livePreviewPlugin = createLivePreviewPlugin({
    ViewPlugin,
    Decoration,
    syntaxTree,
    scanDoc,
    assemble,
    isReadMode,
  });

  const { mathField, mathMouseDown } = createMathExtensions({
    StateField,
    ViewPlugin,
    EditorView,
    Decoration,
    syntaxTree,
    MathWidget: widgets.MathWidget,
    mathHeightCache: widgets.mathHeightCache,
    isReadMode,
  });

  const codeBlockHScroll = createCodeBlockHScroll({ ViewPlugin, syntaxTree });

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

  // ── Margin mousedown forwarding ────────────────────────────────────────
  // The editor's side margins are .cm-scroller padding — OUTSIDE contentDOM,
  // and CodeMirror registers all mouse handlers on contentDOM only. A mousedown
  // in the margin therefore never created a MouseSelection; the browser's
  // native contenteditable drag-select took the gesture instead, and native
  // selection cannot span a contenteditable=false widget, so crossing an image
  // re-anchored the selection below it. Forward margin presses into contentDOM:
  // block the native gesture and re-dispatch a synthetic mousedown at the same
  // coordinates. CM's MouseSelection listens for the real mousemove/mouseup on
  // document, so only this first event needs cloning. Targets are the scroller
  // itself (its padding) and the presentational .cm-layer children; the
  // absolutely positioned title input is neither, so it keeps its behavior.
  const marginMouseDown = ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.view = view;
        this.onDown = (e) => {
          if (e.button !== 0) return;
          const target = e.target;
          if (view.contentDOM.contains(target)) return; // CM already sees these
          const isMargin =
            target === view.scrollDOM ||
            (target instanceof Element && target.closest(".cm-layer"));
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

  // ── Drag auto-scroll, rAF driven ───────────────────────────────────────
  // CodeMirror's built-in edge scrolling steps scrollTop from a 50ms interval
  // (a hard 20fps ceiling that reads as chop) and only engages in the last ~6px
  // before the scroller edge (which reads as slow). This plugin owns drag
  // scrolling instead: a 24px zone, a distance-proportional curve and a 60fps
  // rAF loop. CM's own interval is disabled by patching setScrollSpeed to a
  // no-op on the live MouseSelection right after mousedown — scrollMargins
  // can't do it (getScrollMargins clamps at 0) and there is no public switch.
  // The patch is guarded: if a future CM restructures inputState we silently
  // fall back to CM's own scrolling rather than breaking selection.
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
              ms.setScrollSpeed = () => {}; // the rAF loop owns drag scrolling
            }
          } catch {
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
          // CM constructs its MouseSelection during this same event's dispatch
          // (we are in capture, it handles on contentDOM); the microtask runs
          // once that completes, when the instance exists. Covers the
          // margin-forwarded synthetic mousedown too.
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
        window.addEventListener("dragstart", this.onEnd, true); // native DnD kills mouse events
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
          // Keep the selection head extending while the pointer HOLDS past the
          // edge: CM re-selects on mousemove, so feed it one at the current
          // pointer position. buttons:1 is required — CM destroys the mouse
          // selection on any move with buttons == 0.
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

  // ── IME composition end nudge ──────────────────────────────────────────
  // compositionend does not always produce its own transaction (e.g. the IME
  // commits text identical to the current preedit), so the rebuilds deferred by
  // the composition guards in live-preview.js and math-field.js could sit stale
  // until the next keystroke. Dispatch one empty "compose.end" transaction
  // right after CodeMirror finishes its own compositionend flush; both key off
  // it.
  const composeEndNudge = EditorView.domEventHandlers({
    compositionend(_event, view) {
      setTimeout(() => {
        if (!view.composing) view.dispatch({ userEvent: "compose.end" });
      }, 0);
      return false;
    },
  });

  // ── Tag click ──────────────────────────────────────────────────────────
  //
  // Clicking a #tag pill searches the vault for it. mousedown rather than
  // click, matching the footnote reference: by the time a click fires,
  // CodeMirror has already moved the caret into the tag, and a caret inside
  // the pill is both a visible flicker and the thing that would have to be
  // undone afterwards.
  //
  // Ctrl/Cmd-click and middle-click are left alone so the usual "put the
  // cursor here" gestures still reach the document — the pill is a
  // convenience, not a hijack of the text underneath it.
  const tagClick = EditorView.domEventHandlers({
    mousedown(event, view) {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey)
        return false;
      const el = event.target?.closest?.(".cm-md-tag");
      if (!el || !view.dom.contains(el)) return false;

      // Read the tag out of the DOCUMENT, not the element's text: a pill split
      // across a line wrap renders as two elements, and textContent of one of
      // them is half a tag.
      const pos = view.posAtDOM(el);
      const line = view.state.doc.lineAt(pos);
      const rel = pos - line.from;
      const m = /^#([\p{L}_][\p{L}\p{N}_\-/]{0,63})/u.exec(line.text.slice(rel));
      const name = m && m[1].replace(/[-/]+$/, "");
      if (!name || !isTagName(name)) return false;

      event.preventDefault();
      event.stopPropagation();
      // A CustomEvent rather than a callback threaded through
      // getMarkdownExtensions(): this module is built once with no arguments,
      // and the search bar that handles this lives several layers away.
      // Bubbles so a single listener on document catches every editor.
      view.dom.dispatchEvent(
        new CustomEvent("nib-tag-click", { detail: { tag: name }, bubbles: true }),
      );
      return true;
    },
  });

  return [
    // Editor-wide soft wrap. Without it, .cm-content grows to the widest line
    // in the document, so a code line's own width always fits and its
    // overflow-x:auto never triggers — the overflow escalates to the scroller
    // and the WHOLE editor pans sideways. With wrapping on, prose wraps at the
    // editor width and fenced-code lines opt back out via
    // `white-space: pre !important` (markdown-preview.css), becoming the app's
    // only horizontal scroll containers, synced per block by codeBlockHScroll.
    EditorView.lineWrapping,
    markdown({
      base: markdownLanguage,
      completeHTMLTags: false,
      // Nested highlighting for fenced code: ```js / ```python / … parse with
      // the real language grammar so the code-token rules in decorations.js
      // light up. No-op when the bundle doesn't ship language-data.
      ...(languages ? { codeLanguages: languages } : {}),
      extensions: [
        // SetextHeading is removed because "===" underlining collides with the
        // ==highlight== delimiter, and Nib's headings are ATX-only anyway.
        { remove: ["SetextHeading"] },
        backtickOnlyFence,
        smartTable,
        highlight,
        footnotes,
      ],
    }),
    syntaxHighlighting(deco.mdHighlight),

    livePreviewPlugin,
    mathField,
    tableExtension,

    marginMouseDown,
    mathMouseDown,
    dragScroll,
    composeEndNudge,
    tagClick,
    codeBlockHScroll,

    linkClick,
    noAutoClose,
    tabKeymap,
    enterKeymap,
    autoPair,
    searchKeys,
  ];
}
