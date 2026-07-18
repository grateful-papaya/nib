// ─── Raw-source hover tooltip ("렌더링 풀린 거") ──────────────────────────────
//
// In the live-preview editor most inline markdown is rendered and its source
// syntax hidden — a link shows only its label, an image shows the picture,
// $x$ shows the formula. This tooltip reveals the RAW markdown of whatever
// the pointer is over, in a small bubble above the cursor.
//
// It is deliberately decoration-agnostic: rather than reaching into
// markdown-preview.js's widget internals, it maps the pointer to a document
// position via the EditorView API (posAtCoords) and reconstructs the raw
// token from the source line. That keeps it correct no matter how the
// preview layer chooses to render any given element.
//
// It stays quiet where there's nothing to reveal: plain prose, and the caret
// line (which the live preview already shows as raw source). And it only
// appears after the pointer DWELLS on a token briefly (DWELL_MS) — just
// passing over things doesn't flash tooltips.
//
// Can be turned off entirely in Settings → General ("vault_raw_tooltip").

import { getEditorView } from "./state/editorState.js";

// How long the pointer must rest on the same token before the tooltip shows.
// Long enough that sweeping the cursor across a paragraph stays quiet, short
// enough that an intentional hover doesn't feel laggy.
const DWELL_MS = 350;

const ENABLED_KEY = "vault_raw_tooltip";
const isEnabled = () => localStorage.getItem(ENABLED_KEY) !== "false";

// Inline token patterns, ordered so the most specific/!-prefixed win. Each is
// scanned across the line; the innermost match covering the pointer column is
// shown.
const INLINE_PATTERNS = [
  /!\[[^\]]*\]\([^)]*\)/g, // image (inline)
  /!\[[^\]]*\]\[[^\]]*\]/g, // image (reference)
  /\[[^\]]*\]\([^)]*\)/g, // link (inline)
  /\[[^\]]*\]\[[^\]]*\]/g, // link (reference)
  /\[\^[^\]]+\]/g, // footnote marker
  /`[^`]+`/g, // inline code
  /\$\$[^$]+\$\$/g, // display math
  /\$[^$\n]+\$/g, // inline math
  /\*\*[^*]+\*\*/g, // bold
  /__[^_]+__/g, // bold
  /~~[^~]+~~/g, // strikethrough
  /\*[^*\n]+\*/g, // italic
  /(?<![\w])_[^_\n]+_(?![\w])/g, // italic (underscore, word-boundaried)
];

// Whole-line "rendered" cases where the leading markers are hidden in preview.
const isBlockLine = (text) =>
  /^\s{0,3}#{1,6}\s/.test(text) || // heading
  /^\s{0,3}>/.test(text) || // blockquote
  /^\s{0,3}(\d+[.)]|[-*+])\s+\[[ xX]\]\s/.test(text) || // task list item
  /^\s{0,3}\[[^\]^][^\]]*\]:\s*\S/.test(text) || // link ref definition
  /^\s{0,3}\[\^[^\]]+\]:\s+\S/.test(text); // footnote definition

// Return the raw markdown token under column `col` (0-based) within `text`,
// or null when the pointer isn't over anything that gets rendered.
function rawTokenAt(text, col) {
  let best = null; // narrowest covering span wins
  for (const re of INLINE_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (col >= start && col <= end) {
        if (!best || end - start < best.text.length) {
          best = { text: m[0], start, end };
        }
      }
      if (m.index === re.lastIndex) re.lastIndex++; // avoid zero-width loops
    }
  }
  if (best) return best.text;
  if (isBlockLine(text)) return text.trim();
  return null;
}

// ─── Settings → General wiring ───────────────────────────────────────────────
// The General panel's markup lives in index.html (menu item + #panel-general).
// Binding here keeps the setting self-contained; the tab switch is bound
// idempotently across ALL menu items so it composes safely with settings.js's
// own handler (both do the same class swap).
function bindGeneralSettings(onChange) {
  const toggle = document.getElementById("raw-tooltip-toggle");
  if (toggle) {
    toggle.checked = isEnabled();
    toggle.addEventListener("change", () => {
      localStorage.setItem(ENABLED_KEY, String(toggle.checked));
      onChange();
    });
  }

  const items = document.querySelectorAll(".settings-menu .menu-item");
  const panels = document.querySelectorAll(".settings-panel");
  items.forEach((item) => {
    item.addEventListener("click", () => {
      const target = item.getAttribute("data-target");
      if (!target || !document.getElementById(target)) return;
      items.forEach((i) => i.classList.toggle("active", i === item));
      panels.forEach((p) => p.classList.toggle("active", p.id === target));
    });
  });
}

export function initRawSourceTooltip() {
  let tip = document.getElementById("raw-source-tooltip");
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "raw-source-tooltip";
    tip.className = "raw-source-tooltip";
    document.body.appendChild(tip);
  }

  let rafPending = false;
  let lastEvent = null;
  let lastKey = null; // "line:token" — the token currently under the pointer
  let shownKey = null; // token the visible tooltip belongs to
  let dwellTimer = null;

  const hide = () => {
    clearTimeout(dwellTimer);
    dwellTimer = null;
    lastKey = null;
    shownKey = null;
    tip.classList.remove("visible");
  };

  const place = (x, y) => {
    // Above the pointer, centered, then clamped inside the viewport.
    tip.style.left = "0px";
    tip.style.top = "0px";
    const rect = tip.getBoundingClientRect();
    let left = x - rect.width / 2;
    let top = y - rect.height - 14;
    const m = 6;
    left = Math.max(m, Math.min(left, window.innerWidth - rect.width - m));
    if (top < m) top = y + 20; // not enough room above → drop below the pointer
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  };

  const show = (token, x, y) => {
    tip.textContent = token;
    place(x, y);
    tip.classList.add("visible");
  };

  const evaluate = () => {
    rafPending = false;
    const e = lastEvent;
    if (!e || !isEnabled()) return hide();

    const view = getEditorView();
    if (!view) return hide();

    const content = view.contentDOM;
    // Only within the editor's rendered content, and not in reading mode.
    const overContent = content && content.contains(e.target);
    const fileEditor = document.getElementById("file-editor");
    if (!overContent || fileEditor?.classList.contains("reading-mode")) {
      return hide();
    }

    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    if (pos == null) return hide();

    const line = view.state.doc.lineAt(pos);

    // Suppress on the caret line — the preview already shows its raw source.
    const caretLine = view.state.doc.lineAt(view.state.selection.main.head);
    if (line.number === caretLine.number) return hide();

    const col = pos - line.from;
    const token = rawTokenAt(line.text, col);
    if (!token) return hide();

    const key = `${line.number}:${token}`;

    // Already showing this token → just follow the pointer.
    if (shownKey === key) {
      place(e.clientX, e.clientY);
      return;
    }

    // New token under the pointer → (re)start the dwell timer. The tooltip
    // only appears if the pointer is still on the same token when it fires,
    // so sweeping across the document never flashes bubbles.
    if (key !== lastKey) {
      lastKey = key;
      shownKey = null;
      tip.classList.remove("visible");
      clearTimeout(dwellTimer);
      dwellTimer = setTimeout(() => {
        dwellTimer = null;
        if (lastKey === key && lastEvent) {
          shownKey = key;
          show(token, lastEvent.clientX, lastEvent.clientY);
        }
      }, DWELL_MS);
    }
  };

  document.addEventListener(
    "mousemove",
    (e) => {
      lastEvent = e;
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(evaluate);
    },
    { passive: true },
  );

  // Any scroll or leaving the window invalidates the position immediately.
  document.addEventListener("scroll", hide, { passive: true, capture: true });
  window.addEventListener("blur", hide);
  document.addEventListener("mouseleave", hide);
  document.addEventListener("mousedown", hide, true);

  bindGeneralSettings(hide);
}
