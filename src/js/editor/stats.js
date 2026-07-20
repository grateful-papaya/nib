// js/editor/stats.js
// The status-bar counters and the detailed metrics tooltip.
//
// PERFORMANCE NOTE
// The original version ran on every single updateListener tick and, per
// keystroke, did: doc.toString(), a `\s` regex replace over the whole
// document (allocating a second full copy), a trim + split over the whole
// document, and a TextEncoder pass over the whole document — plus twelve
// getElementById calls. On a large note that is four O(n) passes and three
// full-document allocations per character typed.
//
// Now: cheap always-visible counters update immediately from doc metadata
// (no toString at all), and the expensive detailed metrics are deferred to
// idle time and coalesced, so a burst of typing computes them once.

const ELEMENT_IDS = {
  chars: "stat-chars",
  line: "stat-line",
  total: "stat-total",
  tipCharsWithSpace: "tooltip-chars-with-space",
  tipCharsNoSpace: "tooltip-chars-no-space",
  tipWords: "tooltip-words",
  tipTotalLines: "tooltip-total-lines",
  tipSelection: "tooltip-selection",
  tipFileSize: "tooltip-file-size",
};

// getElementById is cheap but not free, and these nodes are stable for the
// life of the window. Re-resolve only if a cached node was detached.
const elementCache = new Map();

function el(key) {
  const cached = elementCache.get(key);
  if (cached && cached.isConnected) return cached;
  const found = document.getElementById(ELEMENT_IDS[key]);
  if (found) elementCache.set(key, found);
  return found;
}

function setText(key, value) {
  const node = el(key);
  if (node) node.textContent = value;
}

const plural = (n, unit) => `${n} ${unit}${n === 1 ? "" : "s"}`;

function formatBytes(bytes) {
  return bytes < 1024 ? `${bytes} Bytes` : `${(bytes / 1024).toFixed(2)} KB`;
}

/** Words and non-whitespace characters in a single pass, with no allocation. */
function scanText(text) {
  let nonSpace = 0;
  let words = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const isSpace =
      code === 32 || code === 9 || code === 10 || code === 13 || code === 12 ||
      code === 11 || code === 0xa0 || code === 0xfeff ||
      (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029 ||
      code === 0x3000;
    if (isSpace) {
      inWord = false;
    } else {
      nonSpace++;
      if (!inWord) {
        inWord = true;
        words++;
      }
    }
  }
  return { nonSpace, words };
}

let idleHandle = null;
const scheduleIdle =
  typeof window.requestIdleCallback === "function"
    ? (fn) => window.requestIdleCallback(fn, { timeout: 500 })
    : (fn) => setTimeout(fn, 200);
const cancelIdle =
  typeof window.cancelIdleCallback === "function"
    ? (id) => window.cancelIdleCallback(id)
    : (id) => clearTimeout(id);

const encoder = new TextEncoder();

function updateDetailedMetrics(state) {
  const text = state.doc.toString();
  const { nonSpace, words } = scanText(text);
  setText("tipCharsWithSpace", text.length);
  setText("tipCharsNoSpace", nonSpace);
  setText("tipWords", words);
  setText("tipFileSize", formatBytes(encoder.encode(text).length));
}

function updateSelectionSummary(state) {
  const sel = state.selection.main;
  if (sel.empty) {
    setText("tipSelection", "-");
    return;
  }
  const doc = state.doc;
  const chars = sel.to - sel.from;
  const lines = doc.lineAt(sel.to).number - doc.lineAt(sel.from).number + 1;
  setText("tipSelection", `${plural(chars, "char")}, ${plural(lines, "line")}`);
}

/**
 * @param {import("@codemirror/state").EditorState} state
 * @param {{docChanged?: boolean, immediate?: boolean}} [opts]
 */
export function updateEditorStats(state, opts = {}) {
  const { docChanged = true, immediate = false } = opts;
  const doc = state.doc;

  // Cheap, always-visible counters — straight from doc metadata.
  setText("chars", doc.length);
  setText("line", doc.lineAt(state.selection.main.head).number);
  setText("total", doc.lines);
  setText("tipTotalLines", doc.lines);

  updateSelectionSummary(state);

  if (!docChanged && !immediate) return;

  if (idleHandle !== null) cancelIdle(idleHandle);
  if (immediate) {
    idleHandle = null;
    updateDetailedMetrics(state);
    return;
  }
  idleHandle = scheduleIdle(() => {
    idleHandle = null;
    updateDetailedMetrics(state);
  });
}

/** Drop cached nodes — call when the editor DOM is torn down and rebuilt. */
export function resetStatsCache() {
  if (idleHandle !== null) {
    cancelIdle(idleHandle);
    idleHandle = null;
  }
  elementCache.clear();
}
