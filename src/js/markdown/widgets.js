// widgets.js
//
// Every CodeMirror WidgetType subclass used by the live preview. Factory form:
// each class extends WidgetType from the dynamically imported bundle, and
// several close over katex or the image resolver. Also returns
// mathHeightCache, which the math field shares to reserve block-equation
// height while editing.

// Module import, not window.showToast: the god-object cleanup removed the
// global, which made the copy button's toast silently vanish. utils.js is
// already evaluated by app.js at startup, so this is a cache hit with no
// duplicate side effects.
import { showToast } from "../utils.js";
import { katexOptions } from "./katex-macros.js";
import { eachLine } from "./scanner.js";

// Canonical hues for the language label pill (see .cm-md-code-lang[data-lang]
// in markdown-preview.css — the pill derives its text/background from
// --lang-hue). Unknown languages get a stable hash-derived hue so every label
// is colored, not just the mapped ones.
const LANG_HUES = {
  js: 45,
  javascript: 45,
  jsx: 45,
  mjs: 45,
  cjs: 45,
  ts: 211,
  typescript: 211,
  tsx: 211,
  python: 207,
  py: 207,
  rust: 20,
  rs: 20,
  c: 210,
  h: 210,
  cpp: 230,
  "c++": 230,
  hpp: 230,
  cs: 265,
  csharp: 265,
  "c#": 265,
  java: 15,
  kotlin: 275,
  swift: 25,
  go: 190,
  golang: 190,
  html: 14,
  xml: 14,
  css: 215,
  scss: 330,
  sass: 330,
  less: 250,
  json: 95,
  yaml: 175,
  yml: 175,
  toml: 0,
  bash: 130,
  sh: 130,
  shell: 130,
  zsh: 130,
  fish: 130,
  sql: 30,
  ruby: 355,
  rb: 355,
  php: 240,
  lua: 230,
  md: 210,
  markdown: 210,
  tex: 145,
  latex: 145,
  dockerfile: 195,
  docker: 195,
  diff: 80,
};

function langHue(lang) {
  const key = String(lang).toLowerCase();
  if (key in LANG_HUES) return LANG_HUES[key];
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360;
  return h;
}

// Natural dimensions of every image seen this session, keyed by raw src.
// CodeMirror renders lines as they enter the viewport, and an <img> whose
// height is auto is 0px tall until the (always async) decode delivers its
// metadata, so each re-render popped the document open by the image's height a
// frame later. During a drag-selection with auto-scroll that pop lands
// mid-gesture, shifts every coordinate under the pointer, and the selection
// collapses. With the cache we set aspect-ratio (and width, when no |WIDTH
// override exists) BEFORE the src, so layout reserves the final height
// immediately. Only the very first sighting of an image can still pop once.
const imageSizeCache = new Map();

const FOOTNOTE_DEF_RE = /^\s*\[\^([^\]]+)\]:/;

// Position just after the "[^label]:" of the definition for `label`, or null.
// Scanned on demand (a click) rather than cached, so it can never go stale
// against an edited document.
function findFootnoteDef(doc, label) {
  let found = null;
  eachLine(doc, (text, from) => {
    if (found !== null) return;
    const m = FOOTNOTE_DEF_RE.exec(text);
    if (m && m[1] === label) found = from + m[0].length;
  });
  return found;
}

// Measured pixel height of each rendered block equation, keyed by its LaTeX.
// The raw source line reserves the same height while editing so tall equations
// (integrals, fractions) don't make the content below jump on toggle.
const mathHeightCache = new Map();

export function createWidgets({
  WidgetType,
  katex,
  resolveImageSrc,
  resolveImageSrcSync,
  writeImageWidth,
}) {
  // Shared base for the widgets that are a single span of static text.
  class TextSpanWidget extends WidgetType {
    constructor(text, cls) {
      super();
      this.text = text;
      this.cls = cls;
    }
    eq(other) {
      return other.text === this.text && other.cls === this.cls;
    }
    toDOM() {
      const span = document.createElement("span");
      span.className = this.cls;
      span.textContent = this.text;
      return span;
    }
    ignoreEvent() {
      return false; // let CodeMirror handle clicks for caret placement
    }
  }

  // Rendered list marker (replaces the literal "1."/"-"). Atomic, so clicks map
  // to the caret position after it rather than into a hidden zero-width literal.
  class MarkerWidget extends TextSpanWidget {
    constructor(text) {
      super(text, "cm-md-marker");
    }
  }

  class GlyphWidget extends TextSpanWidget {
    constructor(glyph) {
      super(glyph, "cm-md-glyph");
    }
  }

  // Language-label button above a rendered code block; clicking it copies the
  // block's code to the clipboard.
  class LangLabelWidget extends WidgetType {
    constructor(lang, code) {
      super();
      this.lang = lang;
      this.code = code;
    }
    eq(other) {
      return other.lang === this.lang && other.code === this.code;
    }
    toDOM() {
      const btn = document.createElement("button");
      btn.className = "cm-md-code-lang";
      btn.type = "button";
      btn.textContent = this.lang || "copy";
      // Per-language coloring: expose the language and its hue to CSS. A bare
      // "copy" label (no info string) keeps the neutral gray because
      // [data-lang] doesn't match.
      if (this.lang) {
        btn.dataset.lang = this.lang;
        btn.style.setProperty("--lang-hue", String(langHue(this.lang)));
      }
      const code = this.code;
      btn.addEventListener("mousedown", (e) => {
        // mousedown, not click: stops CodeMirror from moving the caret first.
        e.preventDefault();
        e.stopPropagation();
        navigator.clipboard
          ?.writeText(code)
          .then(() => showToast("Copied to clipboard"))
          .catch(() => {});
      });
      return btn;
    }
    ignoreEvent() {
      return false; // let the button receive its own events
    }
  }

  // Task-list checkbox (replaces the literal "[ ]"/"[x]"). Clicking it flips the
  // state character in the document, so the checkbox is only a view of the
  // source and a rebuild re-derives `checked`.
  class CheckboxWidget extends WidgetType {
    constructor(checked) {
      super();
      this.checked = checked;
    }
    eq(other) {
      return other.checked === this.checked;
    }
    toDOM(view) {
      const box = document.createElement("input");
      box.type = "checkbox";
      box.className = "cm-md-checkbox";
      box.checked = this.checked;
      box.addEventListener("mousedown", (e) => {
        e.preventDefault(); // don't let CM move the caret into the line first
        e.stopPropagation();
        const pos = view.posAtDOM(box);
        const line = view.state.doc.lineAt(pos);
        // The state char sits between the "[" (right after the list marker) and
        // the "]". Match the first task marker on the line.
        const m = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])\]/.exec(line.text);
        if (!m) return;
        const at = line.from + m[1].length;
        view.dispatch({
          changes: { from: at, to: at + 1, insert: m[2] === " " ? "x" : " " },
          userEvent: "input.toggleTask",
        });
      });
      return box;
    }
    ignoreEvent() {
      return false;
    }
  }

  // Inline image preview (![alt](src)). The document stores only the path/URL,
  // never base64: local files are read through the Rust read_image_base64
  // bridge and shown as a data: URL (allowed by the app CSP via `img-src …
  // data:`), remote http(s)/data: sources are used directly. Results are cached
  // by resolved absolute path so rebuilds don't re-read the file.
  class ImageWidget extends WidgetType {
    constructor(src, alt, width) {
      super();
      this.src = src;
      this.alt = alt;
      this.width = width; // number (px) or null (natural size)
    }
    eq(other) {
      return (
        other.src === this.src &&
        other.alt === this.alt &&
        other.width === this.width
      );
    }

    buildImage() {
      const img = document.createElement("img");
      img.className = "cm-md-image";
      img.alt = this.alt || "";
      img.decoding = "async";
      // Native image drag hijacks an in-progress selection drag the moment the
      // pointer engages the picture. CSS also sets pointer-events:none; this is
      // the DOM-level half of the same fix.
      img.draggable = false;
      if (this.width) img.style.width = this.width + "px";

      // Reserve the final box BEFORE any src lands (see imageSizeCache).
      // aspect-ratio derives the height from whatever width the box ends up
      // with (explicit |WIDTH, natural, or the max-width:100% cap), so the
      // line's height is correct on the very first layout pass.
      const nat = imageSizeCache.get(this.src);
      if (nat) {
        img.style.aspectRatio = `${nat[0]} / ${nat[1]}`;
        if (!this.width) img.style.width = nat[0] + "px";
      }
      const src = this.src;
      img.addEventListener(
        "load",
        () => {
          if (img.naturalWidth && img.naturalHeight)
            imageSizeCache.set(src, [img.naturalWidth, img.naturalHeight]);
        },
        { once: true },
      );

      // Set src synchronously when we can (remote/cached) so the image never
      // collapses to height:0 on re-render; otherwise fill it in when the async
      // read lands. Errors just leave a broken-image icon.
      const syncSrc = resolveImageSrcSync(src);
      if (syncSrc) img.src = syncSrc;
      else
        resolveImageSrc(src)
          .then((u) => {
            if (u) img.src = u;
          })
          .catch(() => {});
      return img;
    }

    // Four corner resize handles. Only the width changes (height:auto keeps the
    // aspect ratio), so the drag maths depend solely on the corner's horizontal
    // side: right corners grow when dragged right (+1), left corners grow when
    // dragged left (-1).
    addHandles(box, img, view) {
      for (const [name, sign] of [
        ["nw", -1],
        ["ne", 1],
        ["sw", -1],
        ["se", 1],
      ]) {
        const handle = document.createElement("span");
        handle.className = "cm-md-image-resize cm-md-image-resize-" + name;
        handle.addEventListener("mousedown", (e) => {
          e.preventDefault();
          e.stopPropagation(); // don't let CM treat the drag as a selection
          const startX = e.clientX;
          const startW = img.getBoundingClientRect().width;
          const maxW = box.parentElement
            ? box.parentElement.getBoundingClientRect().width
            : Infinity;
          const onMove = (ev) => {
            let w = Math.round(startW + sign * (ev.clientX - startX));
            w = Math.max(40, Math.min(w, Math.round(maxW) || w));
            img.style.width = w + "px"; // height:auto keeps the aspect ratio
          };
          const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
            writeImageWidth(
              view,
              handle,
              Math.round(img.getBoundingClientRect().width),
            );
          };
          window.addEventListener("mousemove", onMove);
          window.addEventListener("mouseup", onUp);
        });
        box.appendChild(handle);
      }
    }

    toDOM(view) {
      // A block box (own line, below the source) that shrink-wraps the image,
      // so the resize handles sit at the picture's corners.
      const box = document.createElement("span");
      box.className = "cm-md-image-box";
      const img = this.buildImage();
      box.appendChild(img);
      this.addHandles(box, img, view);
      return box;
    }

    ignoreEvent() {
      return false; // a plain click on the image places the caret → reveal
    }
  }

  // A footnote, in both of its guises: the superscript number that replaces an
  // inline "[^label]" reference, and the "N." that replaces the "[^label]:" of
  // a definition line. One class because the two are the same object seen from
  // two positions, and eq() has to distinguish them anyway.
  class FootnoteWidget extends WidgetType {
    constructor(num, label, isDef) {
      super();
      this.num = num;
      this.label = label;
      this.isDef = isDef;
    }
    eq(other) {
      return (
        other.num === this.num &&
        other.label === this.label &&
        other.isDef === this.isDef
      );
    }
    toDOM(view) {
      if (this.isDef) {
        const span = document.createElement("span");
        span.className = "cm-md-footnote-def-mark";
        span.textContent = this.num + ".";
        return span;
      }
      const sup = document.createElement("sup");
      sup.className = "cm-md-footnote-ref";
      sup.textContent = String(this.num);
      sup.title = this.label;
      // Jump to the definition. mousedown rather than click so CodeMirror
      // doesn't move the caret into the reference first — which would reveal
      // the raw "[^label]" and destroy the widget mid-gesture.
      sup.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        const pos = findFootnoteDef(view.state.doc, this.label);
        if (pos == null) return; // no definition written yet: leave the caret
        e.preventDefault();
        e.stopPropagation();
        view.dispatch({
          selection: { anchor: pos },
          scrollIntoView: true,
          userEvent: "select.footnote",
        });
        view.focus();
      });
      return sup;
    }
    ignoreEvent(event) {
      // The reference owns its mousedown (above); everything else, including
      // every event on a definition marker, goes to CodeMirror so a click
      // still places the caret and reveals the source.
      return !!(!this.isDef && event && event.type === "mousedown");
    }
  }

  // Small color chip placed just before a color literal (#rrggbb, rgb(…),
  // oklch(…)). Purely presentational — it sits BESIDE the literal rather than
  // replacing it, so the source text stays editable and selectable and no
  // reveal-on-touch bookkeeping is needed.
  //
  // The color is applied via a custom property rather than background-color
  // directly: the chip paints itself over a checkerboard so a translucent
  // value (#00000080, rgba(…, .2)) reads as translucent instead of as a
  // darker opaque swatch.
  class ColorSwatchWidget extends WidgetType {
    constructor(color) {
      super();
      this.color = color;
    }
    eq(other) {
      return other.color === this.color;
    }
    toDOM() {
      const chip = document.createElement("span");
      chip.className = "cm-md-color-swatch";
      chip.style.setProperty("--swatch", this.color);
      chip.title = this.color;
      return chip;
    }
    ignoreEvent() {
      return false; // a click still places the caret in the literal
    }
  }

  // Renders a LaTeX string with KaTeX. `display` = block ($$…$$) vs inline.
  class MathWidget extends WidgetType {
    constructor(tex, display) {
      super();
      this.tex = tex;
      this.display = display;
    }
    eq(other) {
      return other.tex === this.tex && other.display === this.display;
    }
    toDOM(view) {
      const el = document.createElement(this.display ? "div" : "span");
      el.className = "cm-md-math" + (this.display ? " cm-md-math-display" : "");
      if (katex) {
        try {
          el.innerHTML = katex.renderToString(
            this.tex,
            katexOptions({ displayMode: this.display }),
          );
        } catch {
          el.classList.add("cm-md-math-error");
          el.textContent = this.tex;
        }
      } else {
        // No KaTeX: show the raw delimiters so nothing silently disappears.
        const d = this.display ? "$$" : "$";
        el.textContent = d + this.tex + d;
      }
      if (this.display) {
        this.cacheHeight(el);
        this.wireClick(el, view);
      }
      return el;
    }

    // Cache the rendered CORE height (the KaTeX box itself, WITHOUT the vertical
    // padding CSS adds to el): the raw source line reserves exactly this via
    // min-height, and measuring el would double-count the padding.
    cacheHeight(el) {
      const tex = this.tex;
      requestAnimationFrame(() => {
        const core = el.querySelector(".katex-display") || el;
        const h = core.getBoundingClientRect().height;
        if (h) mathHeightCache.set(tex, Math.round(h));
      });
    }

    // Clicking a rendered block equation places the caret just inside it so the
    // raw $$…$$ reveals. Done explicitly with posAtDOM instead of letting CM map
    // the click coords: for a full-line block widget a click in its lower half
    // resolves to the NEXT line ("cursor jumps down"). posAtDOM gives the
    // widget's start wherever you click, clamped to its own line, with no baked
    // in offsets to survive edits.
    wireClick(el, view) {
      el.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        const p = view.posAtDOM(el);
        const line = view.state.doc.lineAt(p);
        view.dispatch({ selection: { anchor: Math.min(p + 2, line.to) } });
        view.focus();
        e.preventDefault();
      });
    }

    ignoreEvent(event) {
      // Block math handles its own mousedown (above); tell CM to ignore that one
      // so its coordinate mapping doesn't also fire and fight the caret
      // placement. Inline math keeps CM's default click handling.
      return !!(this.display && event && event.type === "mousedown");
    }
  }

  return {
    LangLabelWidget,
    MarkerWidget,
    CheckboxWidget,
    ImageWidget,
    GlyphWidget,
    FootnoteWidget,
    ColorSwatchWidget,
    MathWidget,
    mathHeightCache,
  };
}
