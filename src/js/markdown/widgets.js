// widgets.js
//
// All CodeMirror WidgetType subclasses used by the live preview. Exposed as a
// factory because every class extends WidgetType from the dynamically-imported
// bundle, and several close over katex or the image resolver. Returns the
// widget constructors plus mathHeightCache, which the plugin's buildMathDecos
// shares to reserve block-equation height while editing.

// Module import, not window.showToast: the god-object cleanup removed the
// global, which made the copy button's toast silently vanish. utils.js is
// already evaluated by app.js at startup, so this is a cache hit with no
// duplicate side effects.
import { showToast } from "../utils.js";
import { katexOptions } from "./katex-macros.js";

export function createWidgets({
  WidgetType,
  katex,
  resolveImageSrc,
  resolveImageSrcSync,
  writeImageWidth,
}) {
  // Canonical hues for the language label pill (see .cm-md-code-lang[data-lang]
  // in markdown-preview.css — the pill's text/background are derived from
  // --lang-hue). Unknown languages get a stable hash-derived hue so every
  // label is colored, not just the mapped ones.
  const LANG_HUES = {
    js: 45, javascript: 45, jsx: 45, mjs: 45, cjs: 45,
    ts: 211, typescript: 211, tsx: 211,
    python: 207, py: 207,
    rust: 20, rs: 20,
    c: 210, cpp: 230, "c++": 230, h: 210, hpp: 230,
    cs: 265, csharp: 265, "c#": 265,
    java: 15, kotlin: 275, swift: 25,
    go: 190, golang: 190,
    html: 14, xml: 14, css: 215, scss: 330, sass: 330, less: 250,
    json: 95, yaml: 175, yml: 175, toml: 0,
    bash: 130, sh: 130, shell: 130, zsh: 130, fish: 130,
    sql: 30, ruby: 355, rb: 355, php: 240, lua: 230,
    md: 210, markdown: 210, tex: 145, latex: 145,
    dockerfile: 195, docker: 195, diff: 80,
  };
  const langHue = (lang) => {
    const key = String(lang).toLowerCase();
    if (key in LANG_HUES) return LANG_HUES[key];
    let h = 0;
    for (let i = 0; i < key.length; i++)
      h = (h * 31 + key.charCodeAt(i)) % 360;
    return h;
  };

  // Language-label button shown above a rendered code block. Clicking it copies
  // the block's code to the clipboard.
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
      // Per-language coloring: expose the language + its hue to CSS. The
      // bare "copy" label (no info string) keeps the neutral gray styling
      // because [data-lang] doesn't match.
      if (this.lang) {
        btn.dataset.lang = this.lang;
        btn.style.setProperty("--lang-hue", String(langHue(this.lang)));
      }
      const code = this.code;
      btn.addEventListener("mousedown", (e) => {
        // mousedown (not click): stops CodeMirror from moving the caret first.
        e.preventDefault();
        e.stopPropagation();
        const notify = () => showToast("클립보드에 복사됨");
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard
            .writeText(code)
            .then(notify)
            .catch(() => {});
        }
      });
      return btn;
    }
    ignoreEvent() {
      return false; // let the button receive its own events
    }
  }

  // Rendered list marker (replaces the literal "1."/"-"). Atomic, so clicks map
  // to the caret position after it rather than into a hidden zero-width literal.
  class MarkerWidget extends WidgetType {
    constructor(text) {
      super();
      this.text = text;
    }
    eq(other) {
      return other.text === this.text;
    }
    toDOM() {
      const span = document.createElement("span");
      span.className = "cm-md-marker";
      span.textContent = this.text;
      return span;
    }
    ignoreEvent() {
      return false; // let CodeMirror handle clicks for caret placement
    }
  }

  // Task-list checkbox (replaces the literal "[ ]"/"[x]"). Clicking it flips
  // the state character in the document, so the checkbox is just a view of the
  // source — the doc stays the single source of truth (a rebuild re-derives
  // `checked`). mousedown+preventDefault so CodeMirror doesn't move the caret
  // into the line first (same pattern as the code-block copy button).
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
        e.preventDefault();
        e.stopPropagation();
        const pos = view.posAtDOM(box);
        const line = view.state.doc.lineAt(pos);
        // The state char sits between the "[" (right after the list marker)
        // and the "]". Match the first task marker on the line.
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

  // Natural dimensions of every image seen this session, keyed by raw src.
  // CodeMirror renders lines as they enter the viewport, and an <img> whose
  // height is auto is 0px tall until the (always-async) decode delivers its
  // metadata — so each re-render popped the document open by the image's
  // height a frame later. During a drag-selection with auto-scroll that pop
  // lands mid-gesture, shifts every coordinate under the pointer, and the
  // selection collapses. With the cache we set aspect-ratio (and width, when
  // no |WIDTH override exists) BEFORE the src, so layout reserves the exact
  // final height immediately. Only the very first sighting of an image can
  // still pop once.
  const imageSizeCache = new Map();

  // Inline image preview (![alt](src)).
  // The document stores only the path/URL — never base64. Local files are read
  // through the existing Rust `read_image_base64` bridge and shown as a data:
  // URL (which the app CSP already allows via `img-src … data:`); remote
  // http(s)/data: sources are used directly. Results are cached by resolved
  // absolute path so repeated rebuilds don't re-read the file.
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
    toDOM(view) {
      // A block box (own line, below the source) that shrink-wraps the image,
      // so the resize handle sits at the picture's corner.
      const box = document.createElement("span");
      box.className = "cm-md-image-box";

      const img = document.createElement("img");
      img.className = "cm-md-image";
      img.alt = this.alt || "";
      img.decoding = "async";
      // Native image drag hijacks an in-progress selection drag the moment
      // the pointer engages the picture; CSS also sets pointer-events:none
      // (see .cm-md-image), this is the DOM-level half of the same fix.
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
      // read lands. Errors just leave a broken-image icon (the app won't crash).
      const syncSrc = resolveImageSrcSync(this.src);
      if (syncSrc) {
        img.src = syncSrc;
      } else {
        resolveImageSrc(this.src)
          .then((u) => {
            if (u) img.src = u;
          })
          .catch(() => {});
      }
      box.appendChild(img);

      // Four corner resize handles. Only the width is changed (height:auto
      // keeps the aspect ratio), so the drag maths depend solely on the corner's
      // horizontal side: right corners grow when dragged right (sign +1), left
      // corners grow when dragged left (sign -1).
      const corners = [
        ["nw", -1],
        ["ne", 1],
        ["sw", -1],
        ["se", 1],
      ];
      for (const [name, sign] of corners) {
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

      return box;
    }
    ignoreEvent() {
      return false; // let a plain click on the image place the caret → reveal
    }
  }

  class GlyphWidget extends WidgetType {
    constructor(glyph) {
      super();
      this.glyph = glyph;
    }
    eq(other) {
      return other.glyph === this.glyph;
    }
    toDOM() {
      const span = document.createElement("span");
      span.className = "cm-md-glyph";
      span.textContent = this.glyph;
      return span;
    }
    ignoreEvent() {
      return false;
    }
  }

  // Measured pixel height of each rendered block equation (keyed by its LaTeX),
  // used to reserve the same height while editing so tall equations (integrals,
  // fractions) don't make the content below jump on render/raw toggle.
  const mathHeightCache = new Map();

  // Renders a LaTeX string with KaTeX. `display` = block ($$…$$) vs inline ($…$).
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
          el.innerHTML = katex.renderToString(this.tex, katexOptions({ displayMode: this.display }));
        } catch (e) {
          el.classList.add("cm-md-math-error");
          el.textContent = this.tex;
        }
      } else {
        // No KaTeX → show the raw delimiters so nothing silently disappears.
        const d = this.display ? "$$" : "$";
        el.textContent = d + this.tex + d;
      }

      // Cache the rendered *core* height (the KaTeX box itself, WITHOUT the
      // vertical padding CSS now adds to el). The raw-editing source line
      // reserves exactly this via min-height so nothing jumps on toggle;
      // measuring el would include the padding and double-count it.
      if (this.display) {
        const tex = this.tex;
        requestAnimationFrame(() => {
          const core = el.querySelector(".katex-display") || el;
          const h = core.getBoundingClientRect().height;
          if (h) mathHeightCache.set(tex, Math.round(h));
        });
      }

      // Clicking a rendered *block* equation: place the caret just inside it so
      // the raw $$…$$ source reveals. Done explicitly (posAtDOM) instead of
      // letting CM map the click coords — for a full-line block widget a click
      // in its lower half resolves to the *next* line ("cursor jumps down").
      // posAtDOM(el) gives the widget's start regardless of where you click,
      // clamped to its own line so it can never land below. No baked-in
      // absolute offsets → survives edits.
      if (this.display) {
        el.addEventListener("mousedown", (e) => {
          if (e.button !== 0) return; // left-click only
          const p = view.posAtDOM(el);
          const line = view.state.doc.lineAt(p);
          const anchor = Math.min(p + 2, line.to); // just past "$$", same line
          view.dispatch({ selection: { anchor } });
          view.focus();
          e.preventDefault();
        });
      }

      return el;
    }
    ignoreEvent(event) {
      // Block math handles its own mousedown (above); tell CM to ignore that
      // one so its coordinate-mapping doesn't also fire and fight the caret
      // placement. Inline math keeps CM's default click handling.
      if (this.display && event && event.type === "mousedown") return true;
      return false;
    }
  }

  return {
    LangLabelWidget,
    MarkerWidget,
    CheckboxWidget,
    ImageWidget,
    GlyphWidget,
    MathWidget,
    mathHeightCache,
  };
}
