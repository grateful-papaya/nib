// math-field.js
//
// Everything about math in the live preview: KaTeX rendering for $…$ / $$…$$,
// colorizing of the raw source while the caret reveals it, and the capture
// phase mousedown plugin that lets a click actually land inside a rendered
// equation (they are the same problem seen from two sides, so they live
// together).
//
// Block $$…$$ needs a BLOCK decoration to render full width (centered), which
// ViewPlugins cannot provide — so all math lives in this StateField. Inline
// $…$ stays an inline replace; block $$…$$ on its own lines becomes a
// block:true replace. Both reveal raw when the selection touches them.
//
// Same scan/assemble split as the live-preview plugin: doc.toString() and the
// regex passes run once per doc version (WeakMap keyed by the immutable Text),
// not on every keystroke and every caret move.

import { EMPTY, eachLine, sameBits } from "./scanner.js";

const BLOCK_RE = /\$\$([^$]*?)\$\$/g;
const INLINE_RE = /(?<![\\$])\$(?![\s$])((?:\\.|[^$\\\n])*?[^\s\\])\$(?!\$)/g;

// Lightweight TeX tokens: \commands, braces, script/align operators, comments,
// numbers.
const TEX_TOKEN_RE =
  /(\\(?:[a-zA-Z]+\*?|.))|([{}])|([\^_&])|(%[^\n]*)|(\d+(?:\.\d+)?)/g;

export function createMathExtensions({
  StateField,
  ViewPlugin,
  EditorView,
  Decoration,
  syntaxTree,
  MathWidget,
  mathHeightCache,
  isReadMode,
}) {
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
    // Base ink for the whole revealed source, delimiters excluded. Token marks
    // are pushed after and cover their sub-ranges as nested spans, so their
    // palette wins wherever a token exists — this class only ends up coloring
    // what nothing else claims: variable letters, punctuation, spaces.
    if (src.length)
      out.push(texMark("cm-tex-body").range(base, base + src.length));
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
      out.push(
        texMark(cls).range(base + m.index, base + m.index + m[0].length),
      );
    }
    return out;
  }

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
    const claimed = []; // flat [from, to, …] of block matches

    // Block $$…$$ (may span lines). Empty content is allowed so a just-typed
    // "$$$$" gets the block treatment (centering/padding) immediately.
    BLOCK_RE.lastIndex = 0;
    let bm;
    while ((bm = BLOCK_RE.exec(fullText)) !== null) {
      const from = bm.index;
      const to = from + bm[0].length;
      claimed.push(from, to);
      if (inCode(from)) continue;

      const tex = bm[1].trim();
      const l1 = doc.lineAt(from);
      const l2 = doc.lineAt(to);
      // block:true only when the $$…$$ occupies whole lines; a mid-text
      // $$…$$ falls back to an inline replace.
      const asBlock = from === l1.from && to === l2.to;

      const off = tex
        ? [
            Decoration.replace({
              widget: new MathWidget(tex, true),
              block: asBlock,
            }).range(from, to),
          ]
        : EMPTY; // empty $$$$ not being edited: nothing to render

      const texMarks = [
        texDelim.range(from, from + 2),
        ...texTokenMarks(fullText.slice(from + 2, to - 2), from + 2),
        texDelim.range(to - 2, to),
      ];

      let on = texMarks;
      if (asBlock) {
        // Editing: show raw, styled like the rendered block (centered, matching
        // padding). For a single-line block, reserve the rendered equation's
        // measured height as min-height so tall equations don't shift the
        // content below on toggle. Built lazily — the height cache only fills
        // after the widget first renders.
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
    eachLine(doc, (text, lineFrom) => {
      INLINE_RE.lastIndex = 0;
      let im;
      while ((im = INLINE_RE.exec(text)) !== null) {
        const from = lineFrom + im.index;
        const to = from + im[0].length;
        let overlaps = false;
        for (let i = 0; i < claimed.length; i += 2)
          if (from < claimed[i + 1] && to > claimed[i]) {
            overlaps = true;
            break;
          }
        if (overlaps || inCode(from)) continue;
        const tex = im[1].trim();
        if (!tex) continue;

        // Heading lines reveal as ONE unit. The "#### " marker is line-based
        // (the live-preview plugin's lineItems) but math is range-based, so a
        // caret at the line start showed the raw "####" while the equation
        // stayed rendered. Widening the TOUCH range to the whole line makes any
        // caret on a heading line reveal marker + every equation together;
        // tFrom/tTo only feed the reveal test, the replace decorations keep
        // their exact positions. Headings ONLY: a body paragraph is one long
        // wrapped "line", and line-wide reveal there would flip every inline
        // equation in it the moment the caret entered.
        const isHeading = /^#{1,6}\s/.test(text);
        items.push({
          tFrom: isHeading ? lineFrom : from,
          tTo: isHeading ? lineFrom + text.length : to,
          on: [
            texDelim.range(from, from + 1),
            ...texTokenMarks(
              text.slice(im.index + 1, im.index + im[0].length - 1),
              from + 1,
            ),
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
    });

    return { tree, items };
  }

  function mathAssemble(state, prev) {
    const sel = state.selection.main;
    const doc = state.doc;

    // Neutralize the "$" pair the caret sits between ONLY when it is an exact
    // 2-"$" group ("$|$", a freshly auto-paired inline), which would otherwise
    // mis-pair with a real block below. A 4-"$" group ("$$|$$") is a
    // self-contained empty display block, so leave it alone. This is the one
    // selection-dependent input to the scan, so it bypasses the cache — it only
    // holds for the instant after typing "$".
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
    // Read mode: nothing reveals, so every equation keeps its KaTeX render.
    if (!isReadMode(state))
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
      // IME composition guard (same rationale as the live-preview plugin):
      // never swap decoration sets under an active preedit, just keep the
      // current set's positions mapped. CodeMirror flags preedit changes with
      // "input.type.compose". Stale items/bits are fine — they are discarded by
      // the full reassemble the "compose.end" nudge forces on commit.
      if (tr.isUserEvent("input.type.compose"))
        return { deco: value.deco.map(tr.changes), items: value.items, bits: value.bits };
      if (tr.isUserEvent("compose.end")) return mathAssemble(tr.state, null);
      // Pointer drags deliberately have no branch here: a "select.pointer"
      // transaction carries a selection, so it falls through to the default
      // below and equations reveal / re-render live in both directions. The
      // reveal.sync nudge stays for the post-drag reconcile.
      if (tr.isUserEvent("reveal.sync")) return mathAssemble(tr.state, null);
      // Toggling read mode changes every reveal decision without touching the
      // doc or the selection, so it needs its own trigger and a fresh assemble.
      if (isReadMode(tr.startState) !== isReadMode(tr.state))
        return mathAssemble(tr.state, null);
      if (!tr.docChanged && !tr.selection) return value;
      return mathAssemble(tr.state, tr.docChanged ? null : value);
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
  });

  // ── Caret placement on rendered math ─────────────────────────────────────
  // Rendered $…$ / $$…$$ are replace WIDGETS. Events originating inside widget
  // DOM are either ignored by CodeMirror entirely or handed to its
  // MouseSelection, which resolves a degenerate position over
  // contenteditable=false content and re-dispatches it on mouseup, overwriting
  // anything set on mousedown. Usually masked by clicking the text around an
  // equation, but `#### $A_{CM}$` is a trap: the "#### " marker is hidden, so
  // the entire visible line is the widget and the caret can never enter it.
  //
  // Interception is CAPTURE-phase on scrollDOM, so it runs before any
  // CodeMirror mouse machinery. stopPropagation keeps CM from starting a
  // competing MouseSelection in the same gesture (whose mouseup dispatch is
  // exactly what clobbered the bubble-phase version of this fix), and
  // preventDefault blocks native selection on the non-editable span.
  //
  // The hit test deliberately does NOT rely on widget class names (a KaTeX
  // parse failure renders fallback DOM): any target inside a
  // contenteditable=false subtree of contentDOM that contains or belongs to
  // KaTeX output counts. Table cells are excluded — their KaTeX comes from
  // renderInline inside the table widget, which owns its own lifecycle.
  const mathMouseDown = ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.view = view;
        this.onDown = (e) => {
          if (e.button !== 0) return;
          const t = e.target;
          if (!(t instanceof Element)) return;
          if (!view.contentDOM.contains(t)) return;
          if (t.closest(".cm-md-table-wrap")) return;

          // Nearest non-editable (widget) root above the target.
          let root = null;
          for (let n = t; n && n !== view.contentDOM; n = n.parentElement) {
            if (n.getAttribute && n.getAttribute("contenteditable") === "false")
              root = n;
          }
          if (!root) return; // plain text
          const isMath =
            root.matches(".katex, .katex *, .cm-md-math-display") ||
            !!root.querySelector(".katex, .katex-error") ||
            !!t.closest(".katex, .cm-md-math-display");
          if (!isMath) return;

          // posAtDOM, NOT posAtCoords. Chromium's caretPositionFromPoint
          // resolves a point inside contenteditable=false content to the
          // nearest EDITABLE position; with a whole heading being one widget
          // that position is the FOLLOWING line, so the selection landed past
          // the equation, the reveal test failed, and the caret sat invisibly
          // one line down. posAtDOM walks CM's own ContentView tree and returns
          // the widget's exact `from`, which always satisfies the reveal test.
          let pos;
          try {
            pos = view.posAtDOM(root);
          } catch {
            return;
          }

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
          if (e.shiftKey) return;

          // Refinement pass: the dispatch above reveals the raw $…$ source in
          // place of the widget, so one frame later the same pixel sits over
          // real editable text where posAtCoords is trustworthy. Re-resolve it
          // so clicking a subscript lands the caret near that subscript in the
          // source. Clamped to the revealed line so a stale coordinate can't
          // teleport the caret.
          const { clientX, clientY } = e;
          requestAnimationFrame(() => {
            if (view.state.selection.main.anchor !== pos) return; // user moved on
            const p2 = view.posAtCoords({ x: clientX, y: clientY }, false);
            if (p2 == null || p2 === pos) return;
            const ln = view.state.doc.lineAt(pos);
            if (p2 < ln.from || p2 > ln.to) return; // degenerate again
            view.dispatch({
              selection: { anchor: p2 },
              userEvent: "select.pointer",
              scrollIntoView: false,
            });
          });
        };
        view.scrollDOM.addEventListener("mousedown", this.onDown, true);
      }
      destroy() {
        this.view.scrollDOM.removeEventListener("mousedown", this.onDown, true);
      }
    },
  );

  return { mathField, mathMouseDown };
}
