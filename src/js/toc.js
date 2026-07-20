// ─── Document outline + references panel ─────────────────────────────────────
//
// The outline panel (.sidebar-toc-panel) is the sidebar's top layer, slid in
// over the file tree. It holds two stacked sections:
//   • top  (~58% by default) — the document Outline (heading tree)
//   • bottom                 — References (links / documents / images the
//                              document actually points at)
// A horizontal splitter (#toc-vsplit) resizes the ratio between them; its
// right-end corner handle (#toc-vsplit-corner) resizes the ratio AND the
// sidebar width at once. See resize.js initTocSplitResizer.
//
// Sections below, in dependency order:
//   1. Document scanning   — pure functions of a CodeMirror doc; no DOM
//   2. Collapse state      — what's folded, and where that's persisted
//   3. Editor navigation   — scroll-to-position, active-heading detection
//   4. Rendering           — DOM construction for both sections
//   5. Panel orchestration — refresh cycle and the public entry points

import { getEditorView, getCurrentOpenFile, getCodeMirrorModules }
  from "./state/editorState.js";
import { readObject, readStringSet, writeJSON } from "./state/storage.js";

// ─── 1. Document scanning ────────────────────────────────────────────────────

// Fenced-code-block aware, so `# heading` and `[ref]: x` lines inside ```
// blocks are skipped by every collector rather than each rolling its own.
const forEachDocLine = (doc, fn) => {
  let inFence = false;
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    if (/^\s{0,3}(```|~~~)/.test(line.text)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) fn(line);
  }
};

// ── Headings ──

const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

// Strip common inline markdown so the outline shows clean text.
const INLINE_MARKDOWN = [
  [/!\[([^\]]*)\]\([^)]*\)/g, "$1"], // images -> alt text
  [/\[([^\]]*)\]\([^)]*\)/g, "$1"], // links  -> label
  [/`([^`]+)`/g, "$1"],
  [/\*\*([^*]+)\*\*/g, "$1"],
  [/__([^_]+)__/g, "$1"],
  [/\*([^*]+)\*/g, "$1"],
  [/_([^_]+)_/g, "$1"],
];

const cleanHeadingText = (raw) => {
  let out = raw;
  for (const [re, sub] of INLINE_MARKDOWN) out = out.replace(re, sub);
  return out.trim();
};

// ATX headings only (# … ######).
const collectHeadings = (doc) => {
  const found = [];
  forEachDocLine(doc, (line) => {
    const m = HEADING_RE.exec(line.text);
    if (m && m[2]) {
      found.push({
        level: m[1].length,
        text: cleanHeadingText(m[2]),
        pos: line.from,
      });
    }
  });
  return found;
};

// Fold the flat heading list into a tree (level jumps nest one visual step).
// Each node carries a stable `key` of "level:text#occurrence" so collapse state
// survives debounced re-renders while typing: positions shift on every edit,
// but a heading's identity usually doesn't.
const buildHeadingTree = (flat) => {
  const root = { children: [] };
  const stack = [{ node: root, level: 0 }];
  const occurrences = new Map();

  for (const h of flat) {
    const base = `${h.level}:${h.text}`;
    const n = occurrences.get(base) || 0;
    occurrences.set(base, n + 1);

    const node = { ...h, key: `${base}#${n}`, children: [] };
    while (stack.length > 1 && stack[stack.length - 1].level >= h.level) {
      stack.pop();
    }
    stack[stack.length - 1].node.children.push(node);
    stack.push({ node, level: h.level });
  }
  return root.children;
};

// ── References ──
//
// What this document actually references: which links it carries, which
// documents it points at, which images it loads. Scans real usages — inline
// `[text](url)` / `![alt](src)`, reference-style `[text][label]` (resolved
// through `[label]: dest` definitions), and `[[wikilinks]]` — and buckets them
// into link / doc / image. Deduped by destination; each entry keeps the
// position of its first occurrence for click-to-jump.

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)(\?|#|$)/i;
const DOC_EXT = /\.(md|markdown)(\?|#|$)/i;
const PROTOCOL_RE = /^[a-z][a-z0-9+.-]*:/i;
const DEFINITION_RE = /^\s{0,3}\[([^\]^][^\]]*)\]:\s*(.+)$/;
const ANGLE_DEST_RE = /^<([^>]*)>/;

const classifyDest = (dest, isImageSyntax) => {
  if (isImageSyntax || IMAGE_EXT.test(dest)) return "image";
  if (DOC_EXT.test(dest)) return "doc";
  // Any protocol: http(s), mailto, ftp, …
  if (PROTOCOL_RE.test(dest) || dest.startsWith("//")) return "link";
  // In-document anchors and bare relative paths are both "a document".
  return "doc";
};

const collectDefinitions = (doc) => {
  const defs = new Map();
  forEachDocLine(doc, (line) => {
    const m = DEFINITION_RE.exec(line.text);
    if (!m) return;
    const raw = m[2].trim();
    const angle = ANGLE_DEST_RE.exec(raw);
    defs.set(m[1].toLowerCase(), {
      dest: angle ? angle[1].trim() : raw.split(/\s+/)[0],
      pos: line.from,
    });
  });
  return defs;
};

const collectReferences = (doc) => {
  // Pass 1 — definitions, so `[text][label]` usages can resolve to a real
  // destination.
  const defs = collectDefinitions(doc);

  // Pass 2 — usages. Keyed "kind|dest"; first occurrence wins.
  const seen = new Map();
  const add = (kind, label, dest, pos) => {
    if (!dest) return;
    const key = `${kind}|${dest}`;
    if (!seen.has(key)) seen.set(key, { kind, label: label || dest, dest, pos });
  };

  const patterns = [
    // [!]?[text](dest "title")
    {
      re: /(!?)\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g,
      handle: (m, from) =>
        add(classifyDest(m[3], m[1] === "!"), m[2].trim(), m[3], from + m.index),
    },
    // [!]?[text][label] — resolved through the definitions map
    {
      re: /(!?)\[([^\]^][^\]]*)\]\[([^\]]*)\]/g,
      handle: (m, from) => {
        const def = defs.get((m[3] || m[2]).toLowerCase()); // [text][] shorthand
        if (!def) return;
        add(
          classifyDest(def.dest, m[1] === "!"),
          m[2].trim(),
          def.dest,
          from + m.index,
        );
      },
    },
    // [[wikilink]] / [[target|alias]] — a referenced document
    {
      re: /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g,
      handle: (m, from) =>
        add("doc", (m[2] || m[1]).trim(), m[1].trim(), from + m.index),
    },
  ];

  forEachDocLine(doc, (line) => {
    for (const { re, handle } of patterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line.text)) !== null) {
        handle(m, line.from);
        if (m.index === re.lastIndex) re.lastIndex++; // zero-length guard
      }
    }
  });

  // Unused definitions still count as references the document carries.
  for (const [label, def] of defs) {
    add(classifyDest(def.dest, false), `[${label}]`, def.dest, def.pos);
  }

  return [...seen.values()].sort((a, b) => a.pos - b.pos);
};

// ─── 2. Collapse state ───────────────────────────────────────────────────────
//
// Outline sections are PER FILE: the shape of one document's heading tree says
// nothing about another's, so the state is keyed by path and restored on file
// switch. Capped so the map can't grow forever; insertion order doubles as a
// recency list for eviction.
//
// Reference groups (Links / Documents / Images) are APP-WIDE: which groups you
// keep folded is a workflow habit ("I never look at Images"), not a property of
// a document, so it shouldn't reset every time you switch files. Separate key,
// loaded once, never swapped out.
//
// Both save on every toggle rather than on quit — same end result, but it also
// survives crashes and force-quits.

const COLLAPSED_KEY = "vault_toc_collapsed";
const REF_COLLAPSED_KEY = "vault_toc_refs_collapsed";
const COLLAPSED_MAX_FILES = 50;

let outlineCollapsed = new Set();
let collapsedPath = null;

const loadOutlineCollapsed = (path) => {
  collapsedPath = path;
  const stored = readObject(COLLAPSED_KEY)[path];
  outlineCollapsed = new Set(Array.isArray(stored) ? stored : []);
};

const saveOutlineCollapsed = () => {
  if (!collapsedPath) return;
  const store = readObject(COLLAPSED_KEY);
  delete store[collapsedPath]; // re-insert so key order == recency
  if (outlineCollapsed.size > 0) store[collapsedPath] = [...outlineCollapsed];

  const paths = Object.keys(store);
  for (let i = 0; i < paths.length - COLLAPSED_MAX_FILES; i++) {
    delete store[paths[i]]; // evict oldest
  }
  writeJSON(COLLAPSED_KEY, store);
};

const refCollapsed = readStringSet(REF_COLLAPSED_KEY);

const saveRefCollapsed = () =>
  writeJSON(REF_COLLAPSED_KEY, [...refCollapsed]);

// ─── 3. Editor navigation ────────────────────────────────────────────────────

// A clicked heading is scrolled to SCROLL_MARGIN px below the viewport top; the
// active-heading tracker treats a heading as "current" once it's within
// ACTIVE_THRESHOLD px of the top.
//
// ACTIVE_THRESHOLD MUST exceed SCROLL_MARGIN — otherwise the heading you just
// navigated to lands just past the line and the tracker highlights the heading
// ABOVE it instead.
const SCROLL_MARGIN = 12;
const ACTIVE_THRESHOLD = 28;

// How long a just-clicked heading owns the highlight, in ms. Long enough for
// the scroll and any CodeMirror re-measure churn to settle so the highlight
// can't flicker to a neighbour mid-adjustment.
const CLICK_SUPPRESS_MS = 400;

// Scroll a document position to the top of the editor viewport, cursor with it.
//
// CodeMirror's own scrollIntoView effect is the robust tool here: it re-measures
// while it scrolls, so a target whose line hadn't been laid out yet (estimated
// height) still lands accurately instead of the native smooth-scroll "starts
// moving then stops short" bug that many-heading docs exposed. It only touches
// the editor's own scrollers, and every app-shell ancestor is overflow:clip /
// non-overflowing (see base.css, layout.css), so it can't nudge the app chrome
// — the exact hazard the old hand-rolled version guarded against is already
// gone structurally.
const scrollToPos = (pos) => {
  const view = getEditorView();
  if (!view) return;

  const anchor = Math.min(pos, view.state.doc.length);
  const EV = getCodeMirrorModules()?.EditorView;

  if (typeof EV?.scrollIntoView === "function") {
    view.dispatch({
      selection: { anchor },
      effects: EV.scrollIntoView(anchor, { y: "start", yMargin: SCROLL_MARGIN }),
    });
    view.focus({ preventScroll: true });
    return;
  }

  // Fallback with no CM handle: a hand-rolled single scroll, measured first so
  // the target is accurate, and issued as the LAST scroller op so nothing
  // interrupts it.
  view.requestMeasure({
    read: () => {
      const block = view.lineBlockAt(anchor);
      const scroller = view.scrollDOM;
      const top = view.documentTop + block.top;
      return (
        scroller.scrollTop +
        (top - scroller.getBoundingClientRect().top - SCROLL_MARGIN)
      );
    },
    write: (top) => {
      view.scrollDOM.scrollTo({ top, behavior: "smooth" });
      view.dispatch({ selection: { anchor } });
      view.focus({ preventScroll: true });
    },
  });
};

// Which rendered heading row the viewport is currently sitting in.
const findActiveHeading = (rows) => {
  const view = getEditorView();
  if (!view || rows.length === 0) return null;

  const threshold =
    view.scrollDOM.getBoundingClientRect().top + ACTIVE_THRESHOLD;
  const docLen = view.state.doc.length;

  let active = rows[0];
  for (const h of rows) {
    const block = view.lineBlockAt(Math.min(h.pos, docLen));
    if (view.documentTop + block.top > threshold) break;
    active = h;
  }
  return active;
};

// ─── 4. Rendering ────────────────────────────────────────────────────────────

const ARROW_SRC = "assets/arrow-down.svg";

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const arrowImg = (className, collapsed) => {
  const img = el("img", `${className}${collapsed ? " collapsed" : ""}`);
  img.src = ARROW_SRC;
  img.alt = "";
  img.draggable = false;
  return img;
};

// A collapse wrapper reusing the file tree's .tree-children 0fr⇄1fr grid
// accordion. `innerClass` decides the inside: the outline indents and draws a
// guide line, References stays flat and edge-to-edge.
const collapseWrap = (collapsed, innerClass) => {
  const wrap = el("div", `tree-children${collapsed ? "" : " expanded"}`);
  const inner = el("div", innerClass);
  wrap.appendChild(inner);
  return { wrap, inner };
};

// Wire a chevron (or a whole header row) to fold its wrapper.
const bindToggle = (trigger, wrap, arrow, onChange) => {
  trigger.addEventListener("click", (e) => {
    // stopPropagation keeps an outline chevron from also navigating via the
    // row handler.
    e.stopPropagation();
    const nowCollapsed = wrap.classList.contains("expanded");
    wrap.classList.toggle("expanded", !nowCollapsed);
    arrow.classList.toggle("collapsed", nowCollapsed);
    onChange(nowCollapsed);
  });
};

const renderEmpty = (container, message) => {
  container.replaceChildren(el("div", "toc-empty", message));
};

// Render one nesting level of the outline. Indentation is container-based
// (.toc-children-inner padding-left) rather than per-item, which is what makes
// the highlight box (.toc-item::before) sit INSET per depth — hugging just
// inside the guide line — instead of running edge-to-edge. That's the
// deliberate difference from the file tree and from References: a deep outline
// reads its hierarchy better when the highlight tracks the indent. References
// is a flat list, where inset would buy nothing.
//
// Rows are collected into `rows` in document order for the active tracker.
const renderOutline = (nodes, container, onNavigate, rows) => {
  const frag = document.createDocumentFragment();

  for (const node of nodes) {
    const nodeEl = el("div", "toc-node");
    const row = el("div", "toc-item");
    row.dataset.level = String(node.level);
    row.title = node.text; // full text on hover for ellipsized rows

    const hasChildren = node.children.length > 0;
    const collapsed = hasChildren && outlineCollapsed.has(node.key);

    // Chevron as a real toggle control, or an aligned spacer for leaves. The
    // <span> wrapping the arrow img makes the whole padded box an unambiguous,
    // comfortably-sized click target — the old bare 10px <img> was easy to
    // miss, which read as "collapsing doesn't work".
    let toggle;
    let arrow = null;
    if (hasChildren) {
      toggle = el("span", "toc-toggle");
      arrow = arrowImg("toc-arrow", collapsed);
      toggle.appendChild(arrow);
    } else {
      toggle = el("span", "toc-arrow-spacer");
    }

    row.append(toggle, el("span", "toc-item-text", node.text));
    nodeEl.appendChild(row);

    // Row click navigates. Guarded so a click that actually landed on the
    // toggle never also navigates, even if stopPropagation is ever missed.
    row.addEventListener("click", (e) => {
      if (hasChildren && toggle.contains(e.target)) return;
      onNavigate(node.pos, row);
    });

    rows.push({ pos: node.pos, el: row });

    if (hasChildren) {
      const { wrap, inner } = collapseWrap(
        collapsed,
        "tree-children-inner toc-children-inner",
      );
      nodeEl.appendChild(wrap);
      renderOutline(node.children, inner, onNavigate, rows);

      bindToggle(toggle, wrap, arrow, (nowCollapsed) => {
        if (nowCollapsed) outlineCollapsed.add(node.key);
        else outlineCollapsed.delete(node.key);
        saveOutlineCollapsed();
      });
    }

    frag.appendChild(nodeEl);
  }

  container.appendChild(frag);
};

// Which links this document carries, which documents it references, and which
// images it loads. Each row jumps to the first place the reference appears.
const REF_GROUPS = [
  { kind: "link", title: "Links" },
  { kind: "doc", title: "Documents" },
  { kind: "image", title: "Images" },
];

const renderReferences = (refs, container, onNavigate) => {
  const frag = document.createDocumentFragment();

  const byKind = new Map(REF_GROUPS.map(({ kind }) => [kind, []]));
  for (const ref of refs) byKind.get(ref.kind)?.push(ref);

  for (const { kind, title } of REF_GROUPS) {
    const group = byKind.get(kind);
    if (group.length === 0) continue;

    const key = `ref:${kind}`;
    const collapsed = refCollapsed.has(key);

    // The whole header is the collapse toggle. Unlike outline rows — which
    // navigate on row-click and fold only via the chevron — a ref group header
    // has nowhere to navigate, so the entire row can toggle.
    const header = el("div", "toc-ref-group");
    const arrow = arrowImg("toc-ref-arrow", collapsed);
    header.append(arrow, el("span", null, title));

    const { wrap, inner } = collapseWrap(collapsed, "toc-ref-children");

    bindToggle(header, wrap, arrow, (nowCollapsed) => {
      if (nowCollapsed) refCollapsed.add(key);
      else refCollapsed.delete(key);
      saveRefCollapsed();
    });

    for (const ref of group) {
      const row = el("div", `toc-ref-item toc-ref-${ref.kind}`);
      row.title = `${ref.label} → ${ref.dest}`; // full text on hover
      row.append(
        el("span", "toc-ref-label", ref.label),
        el("span", "toc-ref-dest", ref.dest),
      );
      row.addEventListener("click", () => onNavigate(ref.pos));
      inner.appendChild(row);
    }

    frag.append(header, wrap);
  }

  container.replaceChildren(frag);
};

// ─── 5. Panel orchestration ──────────────────────────────────────────────────

// Long enough to coalesce a typing burst, short enough that the outline never
// feels stale while writing.
const REFRESH_DEBOUNCE_MS = 300;

const MESSAGES = {
  noDocument: "No open document.",
  outlineUnsupported: "Outline is available for Markdown files.",
  refsUnsupported: "References are available for Markdown files.",
  noHeadings: "No headings in this document.",
  noRefs: "No references in this document.",
};

let refreshTimer = null;
let headingRows = []; // [{ pos, el }] for the currently rendered outline
let scrollTarget = null; // the .cm-scroller the active tracker is bound to
let rafPending = false;
// While navigating from a click, the clicked heading is authoritative; ignore
// scroll-driven recomputation until the scroll settles.
let suppressActiveUntil = 0;
let lastFile = null;

const isMarkdownPath = (p) => !!p && p.toLowerCase().endsWith(".md");

const isPanelVisible = () => {
  const sidebar = document.getElementById("sidebar");
  return (
    !!sidebar &&
    sidebar.classList.contains("open") &&
    sidebar.classList.contains("toc-open")
  );
};

// Highlight the outline section the editor viewport currently sits in.
const updateActiveHeading = () => {
  rafPending = false;
  if (performance.now() < suppressActiveUntil) return;

  const active = findActiveHeading(headingRows);
  if (!active) return;

  for (const h of headingRows) h.el.classList.toggle("active", h === active);

  // If the active heading is inside collapsed section(s), also mark each
  // collapsed boundary row so whichever is visible reads as "you're in here".
  let cur = active.el.parentElement;
  while (cur && !cur.classList.contains("toc-list-container")) {
    if (
      cur.classList.contains("tree-children") &&
      !cur.classList.contains("expanded")
    ) {
      cur.parentElement
        ?.querySelector(":scope > .toc-item")
        ?.classList.add("active");
    }
    cur = cur.parentElement;
  }
};

const onScroll = () => {
  if (!isPanelVisible() || rafPending) return;
  rafPending = true;
  requestAnimationFrame(updateActiveHeading);
};

// Move the scroll listener onto the current editor's scroller. The view is
// rebuilt on every file switch, so the old target must be released first.
const bindScrollTracking = () => {
  const target = getEditorView()?.scrollDOM || null;
  if (scrollTarget === target) return;
  scrollTarget?.removeEventListener("scroll", onScroll);
  scrollTarget = target;
  scrollTarget?.addEventListener("scroll", onScroll, { passive: true });
};

const navigateFromOutline = (pos, row) => {
  // Claim the highlight for the clicked heading and hold it while the scroll
  // and any CodeMirror re-measure churn settle.
  suppressActiveUntil = performance.now() + CLICK_SUPPRESS_MS;
  scrollToPos(pos);
  for (const h of headingRows) h.el.classList.remove("active");
  row.classList.add("active");
};

export function refreshToc() {
  clearTimeout(refreshTimer);
  refreshTimer = null;

  const outlineContainer = document.getElementById("toc-list-container");
  if (!outlineContainer) return;
  const refsContainer = document.getElementById("toc-refs-container");

  headingRows = [];
  bindScrollTracking();

  const view = getEditorView();
  const openFile = getCurrentOpenFile();

  // Collapse state is per document, restored from the persisted store so the
  // outline reopens as it was left — including across app restarts.
  if (openFile !== lastFile) {
    lastFile = openFile;
    loadOutlineCollapsed(openFile);
  }

  if (!openFile || !view) {
    renderEmpty(outlineContainer, MESSAGES.noDocument);
    if (refsContainer) renderEmpty(refsContainer, MESSAGES.noDocument);
    return;
  }

  if (!isMarkdownPath(openFile)) {
    renderEmpty(outlineContainer, MESSAGES.outlineUnsupported);
    if (refsContainer) renderEmpty(refsContainer, MESSAGES.refsUnsupported);
    return;
  }

  const doc = view.state.doc;

  // ── Outline ──
  const found = collectHeadings(doc);
  if (found.length === 0) {
    renderEmpty(outlineContainer, MESSAGES.noHeadings);
  } else {
    outlineContainer.replaceChildren();
    renderOutline(
      buildHeadingTree(found),
      outlineContainer,
      navigateFromOutline,
      headingRows,
    );
    updateActiveHeading();
  }

  // ── References ──
  if (!refsContainer) return;
  const refs = collectReferences(doc);
  if (refs.length === 0) renderEmpty(refsContainer, MESSAGES.noRefs);
  else renderReferences(refs, refsContainer, scrollToPos);
}

// Doc-change entry point, called from the editor's updateListener. No-op while
// the panel is hidden; refreshToc() runs unconditionally whenever it's shown.
export function scheduleTocRefresh() {
  if (!isPanelVisible()) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshToc, REFRESH_DEBOUNCE_MS);
}
