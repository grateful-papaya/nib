// ─── Sidebar views: file tree ⇄ document outline + references ────────────────
//
// The sidebar hosts two stacked layers:
//   base layer — the pre-existing file-tree content (action group, tree,
//                search results, footer)
//   top layer  — the outline panel (.sidebar-toc-panel), absolutely
//                positioned over the tree and slid in/out via transform
//
// The outline panel itself is now split into two stacked sections:
//   • top  (~58% by default) — the document Outline (heading tree)
//   • bottom                 — References (link / image / footnote
//                              definitions found in the current document)
// A horizontal splitter (#toc-vsplit) resizes the ratio between them; its
// right-end corner handle (#toc-vsplit-corner) resizes the split ratio AND
// the sidebar width simultaneously (see resize.js initTocSplitResizer).
//
// The menu button cycles closed → tree → toc → closed on click, and the
// reverse on right-click. Switching panels animates only the top panel's
// transform; opening/collapsing keeps the width animation (transform snapped).

import {
  getEditorView,
  getCurrentOpenFile,
  getCodeMirrorModules,
} from "./state/editorState.js";
import { setSidebarOpen, getSidebarWidth } from "./state/uiState.js";

// ─── 1. Outline + References content ──────────────────────────────────────────
const TocManager = (() => {
  // Debounce for doc-change refreshes: long enough to coalesce a typing
  // burst, short enough that the outline never feels stale while writing.
  const REFRESH_DEBOUNCE_MS = 300;

  // A clicked heading is scrolled to SCROLL_MARGIN px below the viewport top;
  // the active-heading tracker treats a heading as "current" once it's within
  // ACTIVE_THRESHOLD px of the top. ACTIVE_THRESHOLD MUST exceed SCROLL_MARGIN
  // — otherwise the heading you just navigated to lands just past the line and
  // the tracker highlights the heading ABOVE it instead.
  const SCROLL_MARGIN = 12;
  const ACTIVE_THRESHOLD = 28;

  let refreshTimer = null;
  let headings = []; // [{ pos, el }] for the currently rendered outline
  let scrollTarget = null; // the .cm-scroller the active-tracker is bound to
  let scrollRafPending = false;
  // While navigating from a TOC click, the clicked heading is authoritative;
  // ignore scroll-driven recomputation until the scroll settles so it can't
  // flicker to a neighbour mid-adjustment.
  let suppressActiveUntil = 0;

  // Collapsed sections, keyed by "level:text#occurrence" so the state
  // survives debounced re-renders while typing (positions shift on every
  // edit, but a heading's identity usually doesn't).
  //
  // Persisted per file (like the tree's expanded-folders state) so the
  // outline reopens exactly as it was left after an app restart. Saved on
  // every toggle rather than on quit — same end result, but it also
  // survives crashes and force-quits. Capped so the map can't grow forever.
  const COLLAPSED_KEY = "vault_toc_collapsed";
  const COLLAPSED_MAX_FILES = 50;

  let collapsedKeys = new Set();
  let lastTocFile = null;

  const readCollapsedStore = () => {
    try {
      const parsed = JSON.parse(localStorage.getItem(COLLAPSED_KEY));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  };

  const loadCollapsedFor = (path) => {
    const stored = readCollapsedStore()[path];
    collapsedKeys = new Set(Array.isArray(stored) ? stored : []);
  };

  const saveCollapsedFor = (path) => {
    if (!path) return;
    const store = readCollapsedStore();
    delete store[path]; // re-insert so key order == recency
    if (collapsedKeys.size > 0) store[path] = [...collapsedKeys];

    const paths = Object.keys(store);
    for (let i = 0; i < paths.length - COLLAPSED_MAX_FILES; i++) {
      delete store[paths[i]]; // evict oldest
    }
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify(store));
    } catch {
      /* storage full/unavailable — the in-memory state still works */
    }
  };

  const isMarkdownPath = (p) => !!p && p.toLowerCase().endsWith(".md");

  const isPanelVisible = () => {
    const sidebar = document.getElementById("sidebar");
    return (
      !!sidebar &&
      sidebar.classList.contains("open") &&
      sidebar.classList.contains("toc-open")
    );
  };

  // Strip common inline markdown so the outline shows clean text.
  const cleanHeadingText = (raw) =>
    raw
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images -> alt text
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links  -> label
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/_([^_]+)_/g, "$1")
      .trim();

  // ── Fenced-code-block-aware line scan shared by both collectors ──
  // Returns the fence state so callers can skip `# heading` / `[ref]: x`
  // lines that are really inside ``` blocks.
  const forEachDocLine = (doc, fn) => {
    let inFence = false;
    for (let i = 1; i <= doc.lines; i++) {
      const line = doc.line(i);
      if (/^\s{0,3}(```|~~~)/.test(line.text)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      fn(line);
    }
  };

  // ATX headings only (# … ######).
  const collectHeadings = (doc) => {
    const found = [];
    forEachDocLine(doc, (line) => {
      const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line.text);
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

  // What this document actually references: which links it carries, which
  // documents it points at, which images it loads. Scans real usages —
  // inline `[text](url)` / `![alt](src)`, reference-style `[text][label]`
  // (resolved through `[label]: dest` definitions), and `[[wikilinks]]` —
  // and buckets them into link / doc / image. Deduped by destination; each
  // entry keeps the position of its first occurrence for click-to-jump.
  const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)(\?|#|$)/i;
  const DOC_EXT = /\.(md|markdown)(\?|#|$)/i;

  const classifyDest = (dest, isImageSyntax) => {
    if (isImageSyntax || IMAGE_EXT.test(dest)) return "image";
    if (DOC_EXT.test(dest)) return "doc";
    if (/^[a-z][a-z0-9+.-]*:/i.test(dest) || dest.startsWith("//"))
      return "link"; // any protocol: http(s), mailto, ftp, …
    if (dest.startsWith("#")) return "doc"; // in-document anchor
    return "doc"; // bare relative path → treated as a referenced document/file
  };

  const collectReferences = (doc) => {
    // Pass 1 — reference definitions `[label]: <dest> "title"`, so that
    // `[text][label]` usages can resolve to a real destination.
    const defs = new Map();
    forEachDocLine(doc, (line) => {
      const m = /^\s{0,3}\[([^\]^][^\]]*)\]:\s*(.+)$/.exec(line.text);
      if (!m) return;
      let dest = m[2].trim();
      const angle = /^<([^>]*)>/.exec(dest);
      dest = angle ? angle[1].trim() : dest.split(/\s+/)[0];
      defs.set(m[1].toLowerCase(), { dest, pos: line.from });
    });

    // Pass 2 — usages.
    const seen = new Map(); // "kind|dest" -> ref (first occurrence wins)
    const add = (kind, label, dest, pos) => {
      if (!dest) return;
      const key = `${kind}|${dest}`;
      if (!seen.has(key)) {
        seen.set(key, { kind, label: label || dest, dest, pos });
      }
    };

    const USAGE_PATTERNS = [
      // [!]?[text](dest "title")
      {
        re: /(!?)\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g,
        handle: (m, from) =>
          add(
            classifyDest(m[3], m[1] === "!"),
            m[2].trim(),
            m[3],
            from + m.index,
          ),
      },
      // [!]?[text][label] — resolved through the definitions map
      {
        re: /(!?)\[([^\]^][^\]]*)\]\[([^\]]*)\]/g,
        handle: (m, from) => {
          const label = (m[3] || m[2]).toLowerCase(); // [text][] shorthand
          const def = defs.get(label);
          if (def)
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
      for (const { re, handle } of USAGE_PATTERNS) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(line.text)) !== null) {
          handle(m, line.from);
          if (m.index === re.lastIndex) re.lastIndex++;
        }
      }
    });

    // Unused definitions still count as references the document carries.
    for (const [label, def] of defs) {
      add(classifyDest(def.dest, false), `[${label}]`, def.dest, def.pos);
    }

    return [...seen.values()].sort((a, b) => a.pos - b.pos);
  };

  const renderEmpty = (container, message) => {
    container.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "toc-empty";
    empty.textContent = message;
    container.appendChild(empty);
  };

  // ── Scroll a document position to the top of the editor viewport ──
  // CodeMirror's own scrollIntoView effect is the robust tool here: it
  // re-measures while it scrolls, so a target whose line hadn't been laid
  // out yet (estimated height) still lands accurately instead of the native
  // smooth-scroll "starts moving then stops short" bug that duplicate /
  // many-heading docs exposed. It only scrolls the editor's own scrollers,
  // and every app-shell ancestor is overflow:clip / non-overflowing
  // (see base.css / layout.css), so it can't nudge the app chrome — the
  // exact hazard the old hand-rolled version was avoiding is already gone.
  const scrollToHeading = (pos) => {
    const view = getEditorView();
    if (!view) return;
    const clamped = Math.min(pos, view.state.doc.length);
    const EV = getCodeMirrorModules()?.EditorView;

    if (EV && typeof EV.scrollIntoView === "function") {
      view.dispatch({
        selection: { anchor: clamped },
        effects: EV.scrollIntoView(clamped, {
          y: "start",
          yMargin: SCROLL_MARGIN,
        }),
      });
      view.focus({ preventScroll: true });
      return;
    }

    // Fallback (no CM handle): hand-rolled single scroll, measured first so
    // the target is accurate, and issued as the LAST scroller op so nothing
    // interrupts it.
    view.requestMeasure({
      read: () => {
        const block = view.lineBlockAt(clamped);
        const scroller = view.scrollDOM;
        const top = view.documentTop + block.top;
        const rect = scroller.getBoundingClientRect();
        return scroller.scrollTop + (top - rect.top - 12);
      },
      write: (top) => {
        view.scrollDOM.scrollTo({ top, behavior: "smooth" });
        view.dispatch({ selection: { anchor: clamped } });
        view.focus({ preventScroll: true });
      },
    });
  };

  // Highlight the outline section the editor viewport currently sits in.
  const updateActiveHeading = () => {
    scrollRafPending = false;
    // A just-clicked heading owns the highlight until the scroll settles.
    if (performance.now() < suppressActiveUntil) return;
    const view = getEditorView();
    if (!view || headings.length === 0) return;

    const scTop = view.scrollDOM.getBoundingClientRect().top;
    const threshold = scTop + ACTIVE_THRESHOLD;
    const docLen = view.state.doc.length;

    let active = headings[0];
    for (const h of headings) {
      const block = view.lineBlockAt(Math.min(h.pos, docLen));
      if (view.documentTop + block.top <= threshold) active = h;
      else break;
    }
    headings.forEach((h) => h.el.classList.toggle("active", h === active));

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
    if (!isPanelVisible() || scrollRafPending) return;
    scrollRafPending = true;
    requestAnimationFrame(updateActiveHeading);
  };

  const bindScrollTracking = () => {
    const target = getEditorView()?.scrollDOM || null;
    if (scrollTarget === target) return;
    scrollTarget?.removeEventListener("scroll", onScroll);
    scrollTarget = target;
    scrollTarget?.addEventListener("scroll", onScroll, { passive: true });
  };

  // Fold the flat heading list into a tree (level jumps nest one visual step).
  const buildHeadingTree = (flat) => {
    const root = { children: [] };
    const stack = [{ node: root, level: 0 }];
    const seen = new Map(); // occurrence counter for stable keys

    flat.forEach((h) => {
      const base = `${h.level}:${h.text}`;
      const n = seen.get(base) || 0;
      seen.set(base, n + 1);

      const node = { ...h, key: `${base}#${n}`, children: [] };
      while (stack.length > 1 && stack[stack.length - 1].level >= h.level) {
        stack.pop();
      }
      stack[stack.length - 1].node.children.push(node);
      stack.push({ node, level: h.level });
    });
    return root.children;
  };

  // Apply an expanded/collapsed state to a section's wrap + chevron.
  const setSectionCollapsed = (wrap, arrow, key, collapsed) => {
    if (collapsed) collapsedKeys.add(key);
    else collapsedKeys.delete(key);
    wrap.classList.toggle("expanded", !collapsed);
    arrow.classList.toggle("collapsed", collapsed);
    saveCollapsedFor(lastTocFile);
  };

  // References group collapse (Links / Documents / Images). Unlike the heading
  // outline, this is persisted APP-WIDE, not per file: which reference groups
  // you keep folded is a workflow habit ("I never look at Images"), not tied
  // to a specific document — so it shouldn't reset every time you switch files.
  // Kept under its own localStorage key, separate from the per-file heading
  // store, and loaded once (never swapped out on file change).
  const REF_COLLAPSED_KEY = "vault_toc_refs_collapsed";

  const loadRefCollapsed = () => {
    try {
      const parsed = JSON.parse(localStorage.getItem(REF_COLLAPSED_KEY));
      return new Set(Array.isArray(parsed) ? parsed : []);
    } catch {
      return new Set();
    }
  };

  const refCollapsedKeys = loadRefCollapsed();

  const saveRefCollapsed = () => {
    try {
      localStorage.setItem(
        REF_COLLAPSED_KEY,
        JSON.stringify([...refCollapsedKeys]),
      );
    } catch {
      /* storage full/unavailable — the in-memory state still works */
    }
  };

  const setRefSectionCollapsed = (wrap, arrow, key, collapsed) => {
    if (collapsed) refCollapsedKeys.add(key);
    else refCollapsedKeys.delete(key);
    wrap.classList.toggle("expanded", !collapsed);
    arrow.classList.toggle("collapsed", collapsed);
    saveRefCollapsed();
  };

  // Render one nesting level of the outline. Reuses the file tree's accordion
  // classes (.tree-children / .tree-children-inner grid 0fr⇄1fr animation, incl.
  // its ::before guide line). Indentation is container-based (.toc-children-inner
  // padding-left) rather than per-item, which is what makes the highlight box
  // (.toc-item::before) sit INSET per depth — hugging just inside the guide
  // line — instead of running edge-to-edge. That's the deliberate difference
  // from the file tree / References: a deep outline reads its hierarchy better
  // when the highlight tracks the indent. (References stays edge-to-edge; it's
  // a flat list where inset would buy nothing.)
  const renderNodes = (nodes, container) => {
    nodes.forEach((node) => {
      const nodeEl = document.createElement("div");
      nodeEl.className = "toc-node";

      const row = document.createElement("div");
      row.className = "toc-item";
      row.dataset.level = String(node.level);

      const hasChildren = node.children.length > 0;
      const collapsed = hasChildren && collapsedKeys.has(node.key);

      // Chevron (real toggle control) or an aligned spacer for leaves. Built
      // as a <span> button wrapping the arrow img so the whole padded box is
      // an unambiguous, comfortably-sized click target — the old bare 10px
      // <img> was easy to miss, which read as "collapsing doesn't work".
      let toggleBtn = null;
      let arrow = null;
      if (hasChildren) {
        toggleBtn = document.createElement("span");
        toggleBtn.className = "toc-toggle";
        arrow = document.createElement("img");
        arrow.className = `toc-arrow${collapsed ? " collapsed" : ""}`;
        arrow.src = "assets/arrow-down.svg";
        arrow.alt = "";
        arrow.draggable = false;
        toggleBtn.appendChild(arrow);
      } else {
        toggleBtn = document.createElement("span");
        toggleBtn.className = "toc-arrow-spacer";
      }

      const textSpan = document.createElement("span");
      textSpan.className = "toc-item-text";
      textSpan.textContent = node.text;

      row.title = node.text; // full text on hover for ellipsized rows
      row.append(toggleBtn, textSpan);
      nodeEl.appendChild(row);

      // Row click navigates. (Guarded so a click that actually landed on the
      // toggle never also navigates, even if stopPropagation is ever missed.)
      row.addEventListener("click", (e) => {
        if (hasChildren && toggleBtn.contains(e.target)) return;
        // Claim the highlight for the clicked heading and hold it while the
        // scroll (and any CM re-measure churn) settles, so it can't briefly
        // flip to a neighbour.
        suppressActiveUntil = performance.now() + 400;
        scrollToHeading(node.pos);
        headings.forEach((x) => x.el.classList.remove("active"));
        row.classList.add("active");
      });

      headings.push({ pos: node.pos, el: row });

      if (hasChildren) {
        const wrap = document.createElement("div");
        wrap.className = `tree-children${collapsed ? "" : " expanded"}`;
        const inner = document.createElement("div");
        inner.className = "tree-children-inner toc-children-inner";
        wrap.appendChild(inner);
        nodeEl.appendChild(wrap);

        renderNodes(node.children, inner);

        // Chevron toggles the section, folder-style. stopPropagation keeps
        // the toggle from also navigating via the row handler.
        toggleBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          const nowExpanded = wrap.classList.contains("expanded");
          setSectionCollapsed(wrap, arrow, node.key, nowExpanded);
        });
      }

      container.appendChild(nodeEl);
    });
  };

  // Grouped as 링크 / 문서 / 이미지: which links this document carries, which
  // documents it references, and which images it loads. Each row jumps to
  // the first place the reference appears.
  const REF_GROUPS = [
    { kind: "link", title: "Links" },
    { kind: "doc", title: "Documents" },
    { kind: "image", title: "Images" },
  ];

  const renderReferences = (refs, container) => {
    container.innerHTML = "";
    REF_GROUPS.forEach(({ kind, title }) => {
      const group = refs.filter((r) => r.kind === kind);
      if (group.length === 0) return;

      const key = `ref:${kind}`;
      const collapsed = refCollapsedKeys.has(key);

      // Header row. The whole header is the collapse toggle — unlike outline
      // rows (which navigate on row-click and fold only via the chevron), a
      // ref group header has nowhere to navigate, so the entire row toggles.
      const header = document.createElement("div");
      header.className = "toc-ref-group";

      const arrow = document.createElement("img");
      arrow.className = `toc-ref-arrow${collapsed ? " collapsed" : ""}`;
      arrow.src = "assets/arrow-down.svg";
      arrow.alt = "";
      arrow.draggable = false;

      const titleSpan = document.createElement("span");
      titleSpan.textContent = title;

      header.append(arrow, titleSpan);
      container.appendChild(header);

      // Collapse wrapper: reuses the tree's .tree-children 0fr⇄1fr grid
      // accordion (added here in JS) for the animation, but the inner stays
      // flat and edge-to-edge (.toc-ref-children — no indent or guide line,
      // unlike the outline's .toc-children-inner).
      const wrap = document.createElement("div");
      wrap.className = `tree-children${collapsed ? "" : " expanded"}`;
      const inner = document.createElement("div");
      inner.className = "toc-ref-children";
      wrap.appendChild(inner);
      container.appendChild(wrap);

      header.addEventListener("click", () => {
        const nowExpanded = wrap.classList.contains("expanded");
        setRefSectionCollapsed(wrap, arrow, key, nowExpanded);
      });

      group.forEach((ref) => {
        const row = document.createElement("div");
        row.className = `toc-ref-item toc-ref-${ref.kind}`;

        const label = document.createElement("span");
        label.className = "toc-ref-label";
        label.textContent = ref.label;

        const dest = document.createElement("span");
        dest.className = "toc-ref-dest";
        dest.textContent = ref.dest;

        row.title = `${ref.label} → ${ref.dest}`; // full text on hover
        row.append(label, dest);
        row.addEventListener("click", () => scrollToHeading(ref.pos));
        inner.appendChild(row);
      });
    });
  };

  const refresh = () => {
    clearTimeout(refreshTimer);
    refreshTimer = null;

    const outlineContainer = document.getElementById("toc-list-container");
    const refsContainer = document.getElementById("toc-refs-container");
    if (!outlineContainer) return;

    headings = [];
    bindScrollTracking();
    outlineContainer.innerHTML = "";

    const view = getEditorView();
    const openFile = getCurrentOpenFile();

    // Collapse state is per document, restored from the persisted store so
    // the outline reopens as it was left — including across app restarts.
    if (openFile !== lastTocFile) {
      lastTocFile = openFile;
      loadCollapsedFor(openFile);
    }

    if (!openFile || !view) {
      renderEmpty(outlineContainer, "No open document.");
      if (refsContainer) renderEmpty(refsContainer, "No open document.");
      return;
    }
    if (!isMarkdownPath(openFile)) {
      renderEmpty(outlineContainer, "Outline is available for Markdown files.");
      if (refsContainer)
        renderEmpty(refsContainer, "References are available for Markdown files.");
      return;
    }

    // ── Outline ──
    const found = collectHeadings(view.state.doc);
    if (found.length === 0) {
      renderEmpty(outlineContainer, "No headings in this document.");
    } else {
      renderNodes(buildHeadingTree(found), outlineContainer);
      updateActiveHeading();
    }

    // ── References ──
    if (refsContainer) {
      const refs = collectReferences(view.state.doc);
      if (refs.length === 0) {
        renderEmpty(refsContainer, "No references in this document.");
      } else {
        renderReferences(refs, refsContainer);
      }
    }
  };

  // Doc-change entry point (from the editor updateListener). No-op while the
  // panel is hidden — refresh() runs unconditionally whenever it's shown.
  const scheduleRefresh = () => {
    if (!isPanelVisible()) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, REFRESH_DEBOUNCE_MS);
  };

  return { refresh, scheduleRefresh };
})();

// ─── 2. Menu-button hover popup ───────────────────────────────────────────────
const MenuPopup = (() => {
  const SHOW_DELAY_MS = 450; // "hover briefly" before the popup appears
  const HIDE_DELAY_MS = 250; // grace period to travel from button to popup

  let showTimer = null;
  let hideTimer = null;

  const getPopup = () => document.getElementById("menu-popup");

  const show = () => {
    const popup = getPopup();
    const btn = document.getElementById("menu-btn");
    if (!popup || !btn) return;

    const rect = btn.getBoundingClientRect();
    popup.style.left = `${Math.max(8, rect.left)}px`;
    popup.style.top = `${rect.bottom + 6}px`;
    popup.classList.add("show");
  };

  const hide = () => {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    showTimer = hideTimer = null;
    getPopup()?.classList.remove("show");
  };

  const scheduleShow = () => {
    clearTimeout(hideTimer);
    hideTimer = null;
    if (showTimer) return;
    showTimer = setTimeout(() => {
      showTimer = null;
      show();
    }, SHOW_DELAY_MS);
  };

  const scheduleHide = () => {
    clearTimeout(showTimer);
    showTimer = null;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      hideTimer = null;
      getPopup()?.classList.remove("show");
    }, HIDE_DELAY_MS);
  };

  const syncActive = (view) => {
    document
      .getElementById("menu-popup-tree")
      ?.classList.toggle("active", view === "tree");
    document
      .getElementById("menu-popup-toc")
      ?.classList.toggle("active", view === "toc");
  };

  const init = (onPick) => {
    const popup = getPopup();
    const btn = document.getElementById("menu-btn");
    if (!popup || !btn) return;

    btn.addEventListener("mouseenter", scheduleShow);
    btn.addEventListener("mouseleave", scheduleHide);
    popup.addEventListener("mouseenter", () => {
      clearTimeout(hideTimer);
      hideTimer = null;
    });
    popup.addEventListener("mouseleave", scheduleHide);

    popup.querySelectorAll(".menu-popup-item").forEach((item) => {
      item.addEventListener("click", () => {
        hide();
        onPick(item.getAttribute("data-view"));
      });
    });

    window.addEventListener("blur", hide);
  };

  return { init, hide, syncActive };
})();

// ─── 3. Sidebar view state machine ────────────────────────────────────────────
const SidebarViewManager = (() => {
  const ORDER = ["closed", "tree", "toc"];
  let currentView = "closed";

  const applyOpenWidth = () => {
    const w = getSidebarWidth() || localStorage.getItem("vault_sidebar_width");
    document.documentElement.style.setProperty(
      "--sidebar-width",
      w && w !== "0px" ? w : "200px",
    );
  };

  const snapPanel = (mutate) => {
    const panel = document.getElementById("sidebar-toc-panel");
    if (!panel) return mutate();
    panel.style.transition = "none";
    mutate();
    void panel.offsetWidth; // commit the no-transition state
    panel.style.transition = "";
  };

  const setView = (next, { animate = true } = {}) => {
    const sidebar = document.getElementById("sidebar");
    if (!sidebar || !ORDER.includes(next) || next === currentView) return;

    const prev = currentView;
    currentView = next;

    const wasOpen = prev !== "closed";
    const isOpen = next !== "closed";

    if (isOpen) {
      const mutate = () => sidebar.classList.toggle("toc-open", next === "toc");
      if (animate && wasOpen) mutate(); // tree ⇄ toc: the overlay slide
      else snapPanel(mutate); // opening from closed: no slide
    }

    if (isOpen && !wasOpen) {
      sidebar.classList.add("open");
      applyOpenWidth();
    } else if (!isOpen && wasOpen) {
      sidebar.classList.remove("open");
      document.documentElement.style.setProperty("--sidebar-width", "0px");
    }

    setSidebarOpen(isOpen);
    localStorage.setItem("vault_sidebar_view", next);
    localStorage.setItem("vault_sidebar_open", String(isOpen));

    if (next === "toc") TocManager.refresh(); // never show a stale outline
    MenuPopup.syncActive(next);
  };

  const cycle = (dir) => {
    const i = ORDER.indexOf(currentView);
    setView(ORDER[(i + dir + ORDER.length) % ORDER.length]);
  };

  const init = () => {
    const menuBtn = document.getElementById("menu-btn");

    menuBtn?.addEventListener("click", () => {
      MenuPopup.hide();
      cycle(1);
    });

    menuBtn?.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      MenuPopup.hide();
      cycle(-1);
    });

    const sidebar = document.getElementById("sidebar");
    const savedOpen = localStorage.getItem("vault_sidebar_open");
    const savedView = localStorage.getItem("vault_sidebar_view");
    const savedWidth = localStorage.getItem("vault_sidebar_width");

    if (savedWidth) {
      document.documentElement.style.setProperty("--sidebar-width", savedWidth);
    }

    const initial =
      savedOpen === "false" ? "closed" : savedView === "toc" ? "toc" : "tree";

    if (sidebar) {
      sidebar.style.transition = "none";
      snapPanel(() => {
        sidebar.classList.toggle("open", initial !== "closed");
        sidebar.classList.toggle("toc-open", initial === "toc");
      });
      if (initial === "closed") {
        document.documentElement.style.setProperty("--sidebar-width", "0px");
      }
      void sidebar.offsetWidth;
      sidebar.style.transition = "";
    }

    currentView = initial;
    setSidebarOpen(initial !== "closed");
    if (initial === "toc") TocManager.refresh();
    MenuPopup.syncActive(initial);
  };

  return { init, setView };
})();

// ─── 4. Module exports ────────────────────────────────────────────────────────
export function initSidebarViews() {
  MenuPopup.init((view) => SidebarViewManager.setView(view));
  SidebarViewManager.init();
}

export const refreshToc = TocManager.refresh;
export const scheduleTocRefresh = TocManager.scheduleRefresh;
