import { getVaultPath } from "./state/appState.js";
import { getSetting, setSetting } from "./state/settingsState.js";
import { getEditorView, getCurrentOpenFile } from "./state/editorState.js";
import { revealInSidebar } from "./file-tree.js";
import { showToast } from "./utils.js";
import { attachScrollbar } from "./scrollbar.js";

// ─── Titlebar Search Manager ───────────────────────────────────────────────
//
// Full-text search that lives permanently in the titlebar (not to be
// confused with the sidebar's filename-only search). The bar itself never
// expands or collapses — it's always present, filling the space between the
// stats cluster and the window controls. Two scopes, chosen from a dropdown
// that opens in-place under the bar:
//   - "all"     search every text document in the vault; results render as
//               a flat file/line list in a dropdown under the bar.
//   - "current" search only the currently open document; matches are found
//               and cycled through directly inside the CodeMirror view, no
//               results dropdown.
//
// The scope choice is sticky: once the user picks one, it's persisted via
// settingsState and reused on every future search until changed again.
const TitlebarSearchManager = (() => {
  const DEBOUNCE_MS = 150;
  const SETTING_KEY = "titlebar_search_scope";
  const DEFAULT_SCOPE = "all";
  const MODE_KEY = "titlebar_bar_mode"; // "path" | "search", sticky
  const DEFAULT_MODE = "path";

  let debounceTimer = null;
  let latestRequestId = 0;
  let caseSensitive = false;

  // "all" scope state
  let allResults = []; // ContentSearchMatch[]
  let allActiveIndex = -1;

  // "current" scope state: CodeMirror match positions {from, to}
  let cmMatches = [];
  let cmActiveIndex = -1;

  const escapeHtml = (s) =>
    s.replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );

  const getScope = () => getSetting(SETTING_KEY) || DEFAULT_SCOPE;
  const setScope = (scope) => setSetting(SETTING_KEY, scope);

  // ── bar mode (breadcrumb path <-> search) ──
  // Exactly one segment is expanded at a time; the other collapses to a
  // square button. The choice is sticky across sessions, matching the
  // scope preference.
  const getMode = () => getSetting(MODE_KEY) || DEFAULT_MODE;

  const setMode = (mode, { focus = false } = {}) => {
    const { barContainer, input } = els();
    if (!barContainer) return;
    setSetting(MODE_KEY, mode);
    barContainer.classList.toggle("mode-path", mode === "path");
    barContainer.classList.toggle("mode-search", mode === "search");

    if (mode === "path") {
      // Leaving search: close any open dropdowns so they don't float over
      // the collapsed square button.
      closeScopeMenu();
      closeResultsDropdown();
      updatePathDisplay();
    } else if (focus && input) {
      requestAnimationFrame(() => input.focus({ preventScroll: true }));
    }
  };

  // ── breadcrumb path display ──
  // "VaultName / sub / folder / file.md" relative to the vault root.
  let lastPathSignature = null;

  const updatePathDisplay = () => {
    const { pathText } = els();
    if (!pathText) return;

    const vaultPath = getVaultPath();
    const openFile = getCurrentOpenFile();
    const signature = `${vaultPath}|${openFile}`;
    if (signature === lastPathSignature) return;
    lastPathSignature = signature;

    if (!vaultPath) {
      pathText.textContent = "Nib";
      return;
    }

    // Vault root folder name (handles both / and \ separators).
    const vaultName = vaultPath.split(/[\\/]/).filter(Boolean).pop() || "Vault";

    if (!openFile) {
      pathText.textContent = vaultName;
      return;
    }

    // Relative path of the open file under the vault root.
    let rel = openFile.startsWith(vaultPath)
      ? openFile.slice(vaultPath.length)
      : openFile;
    const parts = rel.split(/[\\/]/).filter(Boolean);
    pathText.textContent = [vaultName, ...parts].join(" / ");
  };

  // ── DOM handles (looked up lazily so this module tolerates being loaded
  // before the titlebar markup exists) ──
  const els = () => ({
    barContainer: document.getElementById("titlebar-bar"),
    pathSegment: document.getElementById("titlebar-path-segment"),
    pathText: document.getElementById("titlebar-path-text"),
    bar: document.getElementById("titlebar-search-bar"),
    input: document.getElementById("titlebar-search-input"),
    count: document.getElementById("titlebar-search-count"),
    resultsContainer: document.getElementById("titlebar-search-results"),
    scopeWrapper: document.getElementById("titlebar-search-scope"),
    scopeBtn: document.getElementById("titlebar-search-scope-btn"),
    scopeMenu: document.getElementById("titlebar-search-scope-menu"),
    prevBtn: document.getElementById("titlebar-search-prev-btn"),
    nextBtn: document.getElementById("titlebar-search-next-btn"),
    caseBtn: document.getElementById("titlebar-search-case-btn"),
  });

  // ── scope dropdown (opens in-place under the bar, same as Firefox's
  // "Search once with:" panel — nothing else in the titlebar shifts) ──
  const closeScopeMenu = () => {
    els().scopeWrapper?.classList.remove("open");
  };

  const openScopeMenu = () => {
    // Only one dropdown open at a time.
    closeResultsDropdown();
    els().scopeWrapper?.classList.add("open");
    syncScopeMenuSelection();
  };

  const syncScopeMenuSelection = () => {
    const scope = getScope();
    document.querySelectorAll(".titlebar-scope-option").forEach((opt) => {
      opt.classList.toggle("selected", opt.dataset.scope === scope);
    });
  };

  // ── count label ("3 / 12") ──
  const updateCount = () => {
    const { count } = els();
    if (!count) return;
    const scope = getScope();

    if (scope === "all") {
      count.textContent = allResults.length
        ? `${allActiveIndex + 1} / ${allResults.length}`
        : "";
    } else {
      count.textContent = cmMatches.length
        ? `${cmActiveIndex + 1} / ${cmMatches.length}`
        : "";
    }
  };

  const updateNavButtons = () => {
    const { prevBtn, nextBtn } = els();
    const scope = getScope();
    const total = scope === "all" ? allResults.length : cmMatches.length;
    if (prevBtn) prevBtn.disabled = total < 2;
    if (nextBtn) nextBtn.disabled = total < 2;
  };

  // ── results dropdown open/close (visual only; data cleared separately) ──
  // The titlebar's own drag regions (.window-controls / .titlebar-bar /
  // .titlebar-search-bar) geometrically overlap the top of this dropdown,
  // and Electron's app-region hit-testing swallows pointer events in that
  // overlap regardless of DOM nesting or z-index — including for the
  // scrollbar thumb, a fixed-position element appended to <body> that ends
  // up in that same screen rectangle. A CSS `:has()` toggle was tried first
  // but didn't reliably neutralize it, so this drives the same no-drag
  // override directly from JS at the exact moments the dropdown opens and
  // closes, via a class read by layout.css.
  const setResultsOpenState = (isOpen) => {
    document.body.classList.toggle("titlebar-results-open", isOpen);
  };

  const closeResultsDropdown = () => {
    els().resultsContainer?.classList.add("hidden");
    setResultsOpenState(false);
  };

  // ── "all documents" scope ──
  const clearAllResults = () => {
    allResults = [];
    allActiveIndex = -1;
    const { resultsContainer } = els();
    if (resultsContainer) resultsContainer.innerHTML = "";
    closeResultsDropdown();
    updateCount();
    updateNavButtons();
  };

  const highlightSnippet = (lineText, matchStart, matchLen) => {
    // matchStart/matchLen come from the Rust side as UTF-16 code-unit
    // offsets, which is exactly how JS string indices work already.
    const before = lineText.slice(0, matchStart);
    const match = lineText.slice(matchStart, matchStart + matchLen);
    const after = lineText.slice(matchStart + matchLen);
    return `${escapeHtml(before)}<span class="titlebar-search-highlight">${escapeHtml(match)}</span>${escapeHtml(after)}`;
  };

  const renderAllResults = () => {
    const { resultsContainer } = els();
    if (!resultsContainer) return;

    resultsContainer.innerHTML = "";
    resultsContainer.classList.remove("hidden");
    setResultsOpenState(true);
    closeScopeMenu();

    if (allResults.length === 0) {
      const empty = document.createElement("div");
      empty.className = "titlebar-search-empty";
      empty.textContent = "No matches found.";
      resultsContainer.appendChild(empty);
      return;
    }

    allResults.forEach((m, idx) => {
      const row = document.createElement("div");
      row.className = "titlebar-search-result-row";
      row.dataset.index = String(idx);

      const fileRow = document.createElement("div");
      fileRow.className = "titlebar-result-file";

      const img = document.createElement("img");
      img.src = "assets/document.svg";
      img.alt = "";
      fileRow.appendChild(img);

      const nameSpan = document.createElement("span");
      nameSpan.textContent = m.name;
      fileRow.appendChild(nameSpan);

      const lineSpan = document.createElement("span");
      lineSpan.className = "titlebar-result-line-number";
      lineSpan.textContent = `Ln ${m.lineNumber}`;
      fileRow.appendChild(lineSpan);

      const snippet = document.createElement("div");
      snippet.className = "titlebar-result-snippet";
      snippet.innerHTML = highlightSnippet(
        m.lineText,
        m.matchStart,
        m.matchLen,
      );

      row.appendChild(fileRow);
      row.appendChild(snippet);

      row.addEventListener("click", () => {
        setAllActiveIndex(idx, { openFile: true, scroll: false });
      });

      resultsContainer.appendChild(row);
    });
  };

  const setAllActiveIndex = (idx, { openFile = false, scroll = true } = {}) => {
    if (allResults.length === 0) return;
    allActiveIndex =
      ((idx % allResults.length) + allResults.length) % allResults.length;
    updateCount();

    document
      .querySelectorAll(".titlebar-search-result-row")
      .forEach((row, i) =>
        row.classList.toggle("active-result", i === allActiveIndex),
      );

    // Skip on a direct click: the row the user just clicked is already
    // fully visible, so scrollIntoView here is a no-op for that case and
    // only matters for keyboard-driven prev/next navigation instead.
    if (scroll) {
      const activeRow = document.querySelector(
        `.titlebar-search-result-row[data-index="${allActiveIndex}"]`,
      );
      activeRow?.scrollIntoView({ block: "nearest" });
    }

    if (openFile) {
      const match = allResults[allActiveIndex];
      openResultInEditor(match);
    }
  };

  const openResultInEditor = (match) => {
    // Instant, not smooth — an animated sidebar scroll here reads as the
    // whole app jarringly shifting right as a search result is clicked.
    revealInSidebar(match.path, "instant");
    const row = document.querySelector(
      `.tree-item.file[data-path="${CSS.escape(match.path)}"]:not([data-pinned-copy])`,
    );
    row?.querySelector(".item-label")?.click();

    // Jump to the matched line once the file is open. A short delay lets
    // the normal file-open pipeline (async read + CodeMirror doc swap)
    // finish before we touch the view.
    setTimeout(() => {
      const view = getEditorView();
      if (!view) return;
      try {
        const line = view.state.doc.line(
          Math.min(match.lineNumber, view.state.doc.lines),
        );
        const pos = Math.min(line.from + match.matchStart, line.to);
        view.dispatch({
          selection: { anchor: pos, head: pos + (match.matchLen || 0) },
        });
        scrollMatchIntoView(view, pos);
        view.focus({ preventScroll: true });
      } catch (err) {
        console.error("Failed to jump to search match:", err);
      }
    }, 120);
  };

  const runAllSearch = async (query) => {
    const vaultPath = getVaultPath();
    if (!vaultPath) return;

    const requestId = ++latestRequestId;
    try {
      const raw = await api.searchContentInVault({ vaultPath, query });
      if (requestId !== latestRequestId) return;

      allResults = (raw || [])
        .filter((m) => (caseSensitive ? m.lineText.includes(query) : true))
        .map((m) => ({
          path: m.path,
          name: m.name,
          lineNumber: m.lineNumber,
          lineText: m.lineText,
          matchStart: m.matchStart,
          matchLen: m.matchLen,
        }));

      renderAllResults();
      updateNavButtons();
      if (allResults.length > 0) {
        setAllActiveIndex(0);
      } else {
        allActiveIndex = -1;
        updateCount();
      }
    } catch (err) {
      if (requestId !== latestRequestId) return;
      console.error("Content search failed:", err);
      allResults = [];
      renderAllResults();
      updateNavButtons();
    }
  };

  // ── "current document" scope (CodeMirror-native, no results dropdown) ──
  const clearCmHighlights = () => {
    cmMatches = [];
    cmActiveIndex = -1;
    updateCount();
    updateNavButtons();
  };

  const runCurrentSearch = (query) => {
    const view = getEditorView();
    cmMatches = [];
    cmActiveIndex = -1;

    if (!view || !query) {
      updateCount();
      updateNavButtons();
      return;
    }

    const docText = view.state.doc.toString();
    const haystack = caseSensitive ? docText : docText.toLowerCase();
    const needle = caseSensitive ? query : query.toLowerCase();

    if (needle.length === 0) {
      updateCount();
      updateNavButtons();
      return;
    }

    let fromIdx = 0;
    while (true) {
      const foundAt = haystack.indexOf(needle, fromIdx);
      if (foundAt === -1) break;
      cmMatches.push({ from: foundAt, to: foundAt + needle.length });
      fromIdx = foundAt + needle.length;
    }

    updateNavButtons();

    if (cmMatches.length > 0) {
      setCmActiveIndex(0);
    } else {
      updateCount();
    }
  };

  // Scrolls the editor's own internal scroller directly instead of using
  // CodeMirror's built-in `scrollIntoView: true` dispatch effect. That
  // built-in effect coincided exactly with a reported whole-window shift
  // (.cm-focused appearing right as it fired) — it likely walks further up
  // the DOM than intended looking for a scrollable ancestor. This keeps the
  // scroll fully contained to .cm-scroller.
  const scrollMatchIntoView = (view, pos) => {
    try {
      const coords = view.coordsAtPos(pos);
      const scroller = view.scrollDOM;
      if (coords && scroller) {
        const scrollerRect = scroller.getBoundingClientRect();
        if (coords.top < scrollerRect.top) {
          scroller.scrollTop -= scrollerRect.top - coords.top + 40;
        } else if (coords.bottom > scrollerRect.bottom) {
          scroller.scrollTop += coords.bottom - scrollerRect.bottom + 40;
        }
      }
    } catch (scrollErr) {
      console.error("Failed to scroll match into view:", scrollErr);
    }
  };

  const setCmActiveIndex = (idx) => {
    if (cmMatches.length === 0) return;
    cmActiveIndex =
      ((idx % cmMatches.length) + cmMatches.length) % cmMatches.length;
    updateCount();

    const view = getEditorView();
    const match = cmMatches[cmActiveIndex];
    if (!view || !match) return;

    try {
      view.dispatch({
        selection: { anchor: match.from, head: match.to },
      });
      scrollMatchIntoView(view, match.from);
      view.focus({ preventScroll: true });
    } catch (err) {
      console.error("Failed to select search match:", err);
    }
  };

  // ── shared: run whichever scope is active ──
  const runSearch = (query) => {
    if (getScope() === "all") {
      runAllSearch(query);
    } else {
      closeResultsDropdown();
      if (!getCurrentOpenFile()) {
        showToast("No document is currently open.");
        clearCmHighlights();
        return;
      }
      runCurrentSearch(query);
    }
  };

  const goToNext = () => {
    const scope = getScope();
    if (scope === "all") {
      if (allResults.length === 0) return;
      setAllActiveIndex(allActiveIndex + 1, { openFile: true });
    } else {
      if (cmMatches.length === 0) return;
      setCmActiveIndex(cmActiveIndex + 1);
    }
  };

  const goToPrev = () => {
    const scope = getScope();
    if (scope === "all") {
      if (allResults.length === 0) return;
      setAllActiveIndex(allActiveIndex - 1, { openFile: true });
    } else {
      if (cmMatches.length === 0) return;
      setCmActiveIndex(cmActiveIndex - 1);
    }
  };

  // Fully clear the bar back to its empty resting state (used by Escape)
  // without ever hiding the bar itself.
  const clearSearch = () => {
    const { input } = els();
    clearTimeout(debounceTimer);
    latestRequestId++;
    if (input) input.value = "";
    clearAllResults();
    clearCmHighlights();
    closeScopeMenu();
  };

  // ── wiring ──
  const init = () => {
    const {
      input,
      scopeBtn,
      scopeMenu,
      prevBtn,
      nextBtn,
      caseBtn,
      resultsContainer,
    } = els();
    if (!input) return;

    syncScopeMenuSelection();
    updateNavButtons();

    // Custom overlay scrollbar for the all-documents results list. The
    // container node itself is never replaced (renderAllResults only
    // clears/rebuilds its innerHTML), so attaching once here is enough —
    // attachScrollbar's own dataset guard also makes this safe to call
    // again if init ever re-runs. Mirrors the marker-class bookkeeping
    // initCustomScrollbars's own attach() helper does for its elements.
    // bottomGap matches .titlebar-search-results' own border-radius (10px)
    // rather than the default 16px, so the thumb's travel stops right at
    // the rounded corner instead of an arbitrary larger gap.
    if (resultsContainer && !resultsContainer.dataset.scrollbarAttached) {
      resultsContainer.classList.add("custom-scroll");
      resultsContainer.dataset.scrollbarAttached = "1";
      attachScrollbar(resultsContainer, { bottomGap: 10 });
    }

    // Restore the sticky mode (no focus steal on launch).
    setMode(getMode());
    updatePathDisplay();

    // The current-open-file setter lives in editorState and is called from
    // several modules; rather than hooking every call site, a cheap poll
    // (string compare, real work only on change) keeps the breadcrumb
    // fresh across open/rename/delete/restore paths alike.
    setInterval(updatePathDisplay, 500);

    // Collapsed search square (mode-path) → expand into search mode.
    els().bar?.addEventListener("click", () => {
      if (els().barContainer?.classList.contains("mode-path")) {
        setMode("search", { focus: true });
      }
    });

    // Collapsed home square (mode-search) → back to breadcrumb mode.
    els().pathSegment?.addEventListener("click", () => {
      if (els().barContainer?.classList.contains("mode-search")) {
        setMode("path");
      }
    });

    scopeBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (els().scopeWrapper?.classList.contains("open")) closeScopeMenu();
      else openScopeMenu();
    });

    scopeMenu?.querySelectorAll(".titlebar-scope-option").forEach((opt) => {
      opt.addEventListener("click", (e) => {
        e.stopPropagation();
        const newScope = opt.dataset.scope;
        if (newScope && newScope !== getScope()) {
          setScope(newScope);
          syncScopeMenuSelection();
          // Re-run whatever query is currently typed under the new scope.
          clearAllResults();
          clearCmHighlights();
          const query = input.value.trim();
          if (query) runSearch(query);
        }
        closeScopeMenu();
      });
    });

    caseBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      caseSensitive = !caseSensitive;
      caseBtn.classList.toggle("active", caseSensitive);
      const query = input.value.trim();
      if (query) runSearch(query);
    });

    input.addEventListener("focus", () => {
      closeScopeMenu();
    });

    input.addEventListener("input", () => {
      clearTimeout(debounceTimer);
      const query = input.value.trim();

      if (!query) {
        latestRequestId++;
        clearAllResults();
        clearCmHighlights();
        return;
      }

      debounceTimer = setTimeout(() => runSearch(query), DEBOUNCE_MS);
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (els().scopeWrapper?.classList.contains("open")) {
          closeScopeMenu();
        } else if (input.value.trim()) {
          clearSearch();
        } else {
          // Empty input: step all the way back out to breadcrumb mode.
          input.blur();
          setMode("path");
        }
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        clearTimeout(debounceTimer);
        const query = input.value.trim();
        if (!query) return;
        if (
          (getScope() === "all" && allResults.length > 0) ||
          (getScope() === "current" && cmMatches.length > 0)
        ) {
          if (e.shiftKey) goToPrev();
          else goToNext();
        } else {
          runSearch(query);
        }
      }
    });

    prevBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      goToPrev();
    });
    nextBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      goToNext();
    });

    // Outside click closes whichever in-place dropdown is open (scope menu
    // or results list); the bar and its query stay exactly as they are.
    document.addEventListener(
      "mousedown",
      (e) => {
        // The results scrollbar thumb is appended directly to <body>
        // (scrollbar.js positions it via fixed coordinates, not DOM
        // nesting), so `bar.contains(e.target)` is false for it even
        // though it's visually part of the results dropdown. Without this
        // check, every mousedown on the thumb was misread as "clicked
        // outside" and immediately closed the dropdown out from under the
        // drag, before it could ever start.
        if (e.target.closest(".custom-scrollbar-thumb")) return;

        const { bar, scopeWrapper } = els();
        if (!bar?.contains(e.target)) {
          closeScopeMenu();
          closeResultsDropdown();
          return;
        }
        if (
          scopeWrapper?.classList.contains("open") &&
          !scopeWrapper.contains(e.target)
        ) {
          closeScopeMenu();
        }
      },
      true,
    );

    // Global shortcut: Ctrl/Cmd+F focuses the titlebar search bar instead of
    // the browser's native find bar (which is disabled anyway in this shell).
    document.addEventListener("keydown", (e) => {
      const isFindShortcut =
        (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f";
      if (!isFindShortcut) return;
      e.preventDefault();
      if (els().barContainer?.classList.contains("mode-path")) {
        setMode("search", { focus: true });
      } else {
        input.focus({ preventScroll: true });
        input.select();
      }
    });
  };

  return { init, clearSearch };
})();

export const initTitlebarSearch = TitlebarSearchManager.init;
export const clearTitlebarSearch = TitlebarSearchManager.clearSearch;
