import { getVaultPath } from "./state/appState.js";
import { getSetting, setSetting } from "./state/settingsState.js";
import { getEditorView, getCurrentOpenFile } from "./state/editorState.js";
import { revealInSidebar } from "./file-tree.js";
import { showToast } from "./utils.js";
import { attachScrollbar } from "./scrollbar.js";
import { parseTagQuery } from "./tag-search.js";
import { closePathInfo } from "./path-info.js";
import { openFileNode } from "./editor/open-file.js";

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

  // replace row (current-document scope only)
  let replaceOpen = false;

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

  // Scope is held in memory as the single source of truth for the session
  // and only MIRRORED into settings for persistence. Previously every read
  // went back through getSetting(), so a scope change and the search that
  // immediately followed it raced: if setSetting doesn't update its cache
  // synchronously (async persist, write-through on next tick, etc.) the
  // very next getScope() still returned the OLD value — which is exactly
  // why Ctrl+F kept running a vault-wide search despite setting "current"
  // one line earlier. Reading a plain variable can't race.
  let activeScope = null; // lazily seeded from the persisted setting

  const getScope = () => {
    if (activeScope === null) {
      activeScope = getSetting(SETTING_KEY) || DEFAULT_SCOPE;
    }
    return activeScope;
  };

  const setScope = (scope) => {
    activeScope = scope; // takes effect immediately
    setSetting(SETTING_KEY, scope); // persisted at whatever pace it likes
  };

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

    // The info popover is anchored to (and only reachable from) the expanded
    // breadcrumb, so collapsing it to a 32px square has to take the popover
    // with it — otherwise it floats over the search bar with no visible owner.
    if (mode === "search") closePathInfo();

    if (mode === "path") {
      // Leaving search: close any open dropdowns so they don't float over
      // the collapsed square button.
      closeScopeMenu();
      closeResultsDropdown();
      closeReplaceRow();
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

    // Single source of truth for "nothing is open", published as a body class
    // so CSS can react. This poll's 500ms granularity is fine for chrome that
    // only needs to look right; anything needing exact timing (the context
    // menu suppressor in app.js) reads getCurrentOpenFile() directly instead.
    document.body.classList.toggle("no-file-open", !openFile);
    if (!openFile) closePathInfo();

    if (!vaultPath) {
      pathText.textContent = "SomeApp";
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
    replaceToggleBtn: document.getElementById("titlebar-search-replace-btn"),
    replaceRow: document.getElementById("titlebar-search-replace-row"),
    replaceInput: document.getElementById("titlebar-replace-input"),
    replaceOneBtn: document.getElementById("titlebar-replace-one-btn"),
    replaceAllBtn: document.getElementById("titlebar-replace-all-btn"),
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
  // Both under-the-bar panels (results dropdown AND replace row) sit inside
  // the drag-region overlap, so the body class is on whenever either is
  // visible — computed from actual state rather than toggled ad hoc, so the
  // two panels can't fight over it.
  const syncFusedState = () => {
    const resultsVisible =
      !els().resultsContainer?.classList.contains("hidden");
    document.body.classList.toggle(
      "titlebar-results-open",
      resultsVisible || replaceOpen,
    );
  };

  const closeResultsDropdown = () => {
    els().resultsContainer?.classList.add("hidden");
    syncFusedState();
  };

  // ── replace row (fused under the bar, current-document scope only) ──
  const openReplaceRow = () => {
    // Replace only makes sense inside the open document; the results
    // dropdown occupies the same slot, so it yields.
    closeResultsDropdown();
    closeScopeMenu();
    replaceOpen = true;
    els().replaceRow?.classList.remove("hidden");
    els().replaceToggleBtn?.classList.add("active");
    syncFusedState();
  };

  const closeReplaceRow = () => {
    replaceOpen = false;
    els().replaceRow?.classList.add("hidden");
    els().replaceToggleBtn?.classList.remove("active");
    syncFusedState();
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
    syncFusedState();
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

      // Type badge on tag-query rows: says "this row is a tag hit, not a
      // text hit" and nothing more. The label is "tag:" — the query prefix
      // itself — rather than "#tag", because "tag" is a perfectly legal tag
      // NAME and a "#tag" badge would be indistinguishable from a row that
      // literally matched #tag; a colon can never appear in a tag name, so
      // "tag:" is unambiguous. Which tag matched is shown by the snippet's
      // highlight, and what was typed is in the search box.
      //
      // Appended BEFORE the line number: that span carries margin-left:auto
      // to pin itself to the right edge, so anything added after it would be
      // pushed out past it instead of sitting next to the filename.
      if (m.isTag) {
        const chip = document.createElement("span");
        chip.className = "titlebar-result-tag-chip";
        chip.textContent = "tag:";
        fileRow.appendChild(chip);
      }

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
        setAllActiveIndex(idx, {
          openFile: true,
          scroll: false,
          focusEditor: true,
        });
      });

      resultsContainer.appendChild(row);
    });
  };

  const setAllActiveIndex = (
    idx,
    { openFile = false, scroll = true, focusEditor = false } = {},
  ) => {
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
      openResultInEditor(match, { focusEditor });
    }
  };

  const openResultInEditor = async (match, { focusEditor = false } = {}) => {
    // Instant, not smooth — an animated sidebar scroll here reads as the
    // whole app jarringly shifting right as a search result is clicked.
    revealInSidebar(match.path, "instant");

    // openFileNode directly, awaited — not a simulated .click() on the tree
    // row plus a fixed setTimeout. The timer version had no way to know when
    // the async open (file read + CodeMirror doc swap) actually finished: too
    // short and it dispatched into the PREVIOUS document, guarded and it
    // silently did nothing for any file that took longer than the delay.
    // Awaiting the open removes the race outright; when this resumes, the
    // document is in the view (or the open failed, which the path check
    // below catches). Both tag-search and text-search results normalize to
    // the same {path, name, lineNumber, matchStart, matchLen} shape upstream
    // in runAllSearch, so this one path serves both.
    await openFileNode({ path: match.path, name: match.name });

    const view = getEditorView();
    if (!view || getCurrentOpenFile() !== match.path) return;

    try {
      const line = view.state.doc.line(
        Math.min(match.lineNumber, view.state.doc.lines),
      );
      const pos = Math.min(line.from + match.matchStart, line.to);
      view.dispatch({
        selection: { anchor: pos, head: pos + (match.matchLen || 0) },
        // No scrollIntoView here: centreMatch does the scrolling, and letting
        // CodeMirror also scroll would mean two competing scrolls per match.
      });
      centreMatch(view, pos);
      // Only hand focus to the editor when the user explicitly clicked a
      // result row. During Enter/arrow cycling this used to steal focus
      // from the search input mid-navigation, so the NEXT Enter (or worse,
      // the next typed character) landed inside the document instead of
      // the search bar. openTextFile focuses the editor as part of every
      // open, so the cycling case has to actively take focus BACK.
      if (focusEditor) view.focus({ preventScroll: true });
      else els().input?.focus({ preventScroll: true });
    } catch (err) {
      console.error("Failed to jump to search match:", err);
    }
  };

  const runAllSearch = async (query) => {
    const vaultPath = getVaultPath();
    if (!vaultPath) return;

    const requestId = ++latestRequestId;
    // A `tag:` / `#` token routes to the tag index instead of the full-text
    // walk. Order matters on the Rust side: the tag filter is a set operation
    // over data already in memory, while the text pass is file I/O — narrowing
    // by tag first is the whole reason this is fast on a large vault.
    const { include, exclude, text, isTagQuery } = parseTagQuery(query);
    try {
      const raw = isTagQuery
        ? await api.searchByTags({ vaultPath, include, exclude, text })
        : await api.searchContentInVault({ vaultPath, query });
      if (requestId !== latestRequestId) return;

      // Case-sensitivity applies to the free-text half only. `query` still
      // carries the `tag:` tokens, so filtering rows against it would drop
      // every single hit.
      const literal = isTagQuery ? text : query;
      allResults = (raw || [])
        .filter((m) =>
          caseSensitive && literal ? m.lineText.includes(literal) : true,
        )
        .map((m) => ({
          path: m.path,
          name: m.name,
          lineNumber: m.lineNumber,
          lineText: m.lineText,
          matchStart: m.matchStart,
          matchLen: m.matchLen,
          // Row provenance for the results list: tag-query rows get a type
          // badge. A boolean, not the filter strings — the typed query is
          // already sitting in the search box (and under prefix matching
          // it's often a fragment like "태"), while the ACTUAL matched tag
          // is visible in the snippet via the locator's highlight span, so
          // repeating either next to the filename adds nothing.
          isTag: isTagQuery,
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

  const runCurrentSearch = (query, { anchorPos = null } = {}) => {
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
      // Land on the match nearest the cursor (first match at/after it,
      // wrapping to the top) instead of always yanking the view back to
      // match #1 — re-searching while typing no longer teleports you to
      // the top of the document.
      let startIdx = 0;
      if (anchorPos != null) {
        const found = cmMatches.findIndex((m) => m.from >= anchorPos);
        startIdx = found === -1 ? 0 : found;
      }
      setCmActiveIndex(startIdx);
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
  //
  // The match is CENTERED rather than nudged just inside the nearest edge.
  // The old minimum-movement version left a hit sitting on the very first or
  // last visible line with no context on one side, which is the half of the
  // context that usually tells you whether it's the hit you wanted. Centering
  // also makes cycling through matches stable: each one arrives in the same
  // place instead of alternating between the top and bottom edges.
  //
  // Unconditional, deliberately: "already visible, leave it" is what made a
  // match one line below the top stay pinned there while the next one jumped
  // to the middle.
  // Places the TOP of the match's line at the vertical middle of the editor —
  // not the line's own middle. The distinction matters twice over: the results
  // dropdown hangs down over the editor's upper region, so anything in the top
  // half can be covered, and a line here can be arbitrarily tall (a rendered
  // table or block math is one "line"), where centering its midpoint could
  // still leave the match's first visible text up under the dropdown. Top of
  // line at half-height guarantees the match starts in the uncovered lower
  // half. (A match in the first few lines of a document can't be pushed down —
  // scrollTop clamps at 0 — which is physics, not a bug.)
  //
  // Scheduled through requestMeasure rather than run straight after a
  // dispatch: a selection-moving dispatch makes CodeMirror reveal the new
  // cursor during its own measure cycle, which runs AFTER the dispatch call
  // returns, overwriting any scrollTop written synchronously in between.
  //
  // The read/write split is not optional. CodeMirror throws "Reading the
  // editor layout isn't allowed during an update" if anything measures the
  // DOM during the write phase, so the geometry is gathered in `read` and
  // only the scrollTop assignment happens in `write`.
  //
  // lineBlockAt is what's measured, NOT coordsAtPos: it answers from the
  // height map instead of the rendered DOM, so it works for a position
  // CodeMirror hasn't laid out yet — the normal case right after opening a
  // file and jumping deep into it, which is exactly when this matters most.
  // Its `top` is already in document coordinates, the same space as scrollTop.
  const centreMatch = (view, pos) => {
    view.requestMeasure({
      key: "titlebar-search-centre",
      read: () => {
        const scroller = view.scrollDOM;
        if (!scroller) return null;
        const block = view.lineBlockAt(
          Math.min(Math.max(pos, 0), view.state.doc.length),
        );
        const target = block.top - scroller.clientHeight / 2;
        // Clamped so a match near either end of the document doesn't ask for
        // an out-of-range scrollTop; the browser would clamp anyway, but this
        // keeps the value honest for anything reading it back.
        return Math.max(
          0,
          Math.min(target, scroller.scrollHeight - scroller.clientHeight),
        );
      },
      write: (top) => {
        if (top == null) return;
        view.scrollDOM.scrollTop = top;
      },
    });
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
        // No scrollIntoView here: centreMatch does the scrolling, and letting
        // CodeMirror also scroll would mean two scrolls per match.
      });
      centreMatch(view, match.from);
      // Deliberately NOT view.focus() here. This runs on the 150ms typing
      // debounce, so focusing the editor meant that halfway through typing a
      // query, focus silently jumped into the document and the rest of the
      // keystrokes were typed INTO THE FILE. Focus is handed back to the
      // editor only on Escape (see the input keydown handler).
    } catch (err) {
      console.error("Failed to select search match:", err);
    }
  };

  // ── shared: run whichever scope is active ──
  const runSearch = (query) => {
    // A tag query is inherently vault-wide: filtering the one open document by
    // its own tags answers a question nobody asks. Route it down the all-docs
    // path regardless of the sticky scope — without mutating the scope, so
    // deleting the tag token restores the user's real preference.
    if (getScope() === "all" || parseTagQuery(query).isTagQuery) {
      closeReplaceRow();
      runAllSearch(query);
    } else {
      closeResultsDropdown();
      if (!getCurrentOpenFile()) {
        showToast("No document is currently open.");
        clearCmHighlights();
        return;
      }
      const view = getEditorView();
      const anchorPos = view ? view.state.selection.main.from : null;
      runCurrentSearch(query, { anchorPos });
    }
  };

  // ── replace (current-document scope only) ──
  // Guard against stale offsets: the user can edit the document between the
  // search pass and the replace click, which would make cmMatches point at
  // the wrong text. Verify the slice still equals the query before touching
  // the doc; on mismatch, silently re-run the search instead of corrupting.
  const matchStillValid = (view, match, query) => {
    const slice = view.state.sliceDoc(match.from, match.to);
    return caseSensitive
      ? slice === query
      : slice.toLowerCase() === query.toLowerCase();
  };

  const replaceCurrent = () => {
    if (getScope() !== "current") return;
    const view = getEditorView();
    const { input, replaceInput } = els();
    if (!view || !input || cmMatches.length === 0 || cmActiveIndex < 0) return;

    const query = input.value.trim();
    const match = cmMatches[cmActiveIndex];
    if (!query || !match) return;

    if (!matchStillValid(view, match, query)) {
      runCurrentSearch(query, { anchorPos: view.state.selection.main.from });
      return;
    }

    const replacement = replaceInput?.value ?? "";
    view.dispatch({
      changes: { from: match.from, to: match.to, insert: replacement },
    });
    // Anchor just past the inserted text so the active match advances to the
    // next occurrence — even when the replacement itself contains the query
    // (e.g. "cat" -> "cats"), which would otherwise loop in place forever.
    runCurrentSearch(query, { anchorPos: match.from + replacement.length });
  };

  const replaceAll = () => {
    if (getScope() !== "current") return;
    const view = getEditorView();
    const { input, replaceInput } = els();
    if (!view || !input || cmMatches.length === 0) return;

    const query = input.value.trim();
    if (!query) return;

    if (!cmMatches.every((m) => matchStillValid(view, m, query))) {
      runCurrentSearch(query, { anchorPos: view.state.selection.main.from });
      showToast("Document changed — search refreshed. Try again.");
      return;
    }

    const replacement = replaceInput?.value ?? "";
    const count = cmMatches.length;
    // cmMatches is ascending and non-overlapping by construction, so all
    // changes can go out in a single dispatch (one undo step).
    view.dispatch({
      changes: cmMatches.map((m) => ({
        from: m.from,
        to: m.to,
        insert: replacement,
      })),
    });
    showToast(`Replaced ${count} occurrence${count === 1 ? "" : "s"}.`);
    runCurrentSearch(query);
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
    closeReplaceRow();
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

    // Tag chips (breadcrumb info popover today, a tag panel later) hand over a
    // ready-made query through a window event rather than reaching into this
    // module's internals. Keeps the dependency one-directional.
    window.addEventListener("nib:search-query", (e) => {
      const q = String(e.detail || "").trim();
      if (!q) return;
      setMode("search", { focus: true });
      input.value = q;
      input.setSelectionRange(q.length, q.length);
      clearTimeout(debounceTimer);
      runSearch(q);
    });

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
          if (newScope === "all") closeReplaceRow();
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
        } else if (replaceOpen) {
          closeReplaceRow();
        } else if (input.value.trim()) {
          // Escape no longer nukes the query — it hands focus back to the
          // editor with the cursor sitting on the current match, matching
          // find-bar muscle memory everywhere else (VS Code, browsers).
          // The query survives, so the next Ctrl+F re-selects it for reuse.
          const view = getEditorView();
          if (view && getCurrentOpenFile()) {
            view.focus({ preventScroll: true });
          } else {
            input.blur();
          }
        } else {
          // Empty input: step all the way back out to breadcrumb mode.
          input.blur();
          setMode("path");
        }
        return;
      }
      // With the replace row open, Tab hops down into the replace input.
      if (e.key === "Tab" && !e.shiftKey && replaceOpen) {
        e.preventDefault();
        els().replaceInput?.focus({ preventScroll: true });
        els().replaceInput?.select();
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
          closeReplaceRow();
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

    // ── global find/replace shortcuts ──
    // Registered in the CAPTURE phase with stopPropagation, which is the
    // whole fix for the "CodeMirror's own panel appears" problem: CodeMirror
    // registers its keymaps (incl. the built-in search panel bindings) on
    // its contentDOM, so with a plain bubble-phase document listener, CM ran
    // FIRST whenever the editor had focus — it opened its native panel and
    // this handler never stood a chance. Capture phase fires top-down before
    // the event ever reaches contentDOM, so CM never sees these keys at all.
    //
    // Scope mapping is now deterministic instead of sticky-last-used:
    //   Ctrl/Cmd+F        -> current document (falls back to "all" if no
    //                        document is open)
    //   Ctrl/Cmd+Shift+F  -> all documents
    //   Ctrl/Cmd+H        -> current document + replace row
    // The scope dropdown still exists for the mouse, but the shortcuts
    // always mean the same thing — pressing Ctrl+F can no longer surprise
    // you with a vault-wide file list just because that was the last scope
    // picked with the mouse days ago.

    // If the editor holds a short single-line selection, carry it into the
    // search box (standard find-bar behavior: select a word, Ctrl+F, done).
    const selectionPrefill = () => {
      const view = getEditorView();
      if (!view) return "";
      const sel = view.state.selection.main;
      if (sel.empty) return "";
      const text = view.state.sliceDoc(sel.from, sel.to);
      if (!text || text.includes("\n") || text.length > 200) return "";
      return text;
    };

    const applyShortcutScope = (scope) => {
      if (scope === getScope()) return;
      setScope(scope);
      syncScopeMenuSelection();
      clearAllResults();
      clearCmHighlights();
    };

    const openSearchViaShortcut = ({ scope, withReplace = false } = {}) => {
      applyShortcutScope(scope);
      if (withReplace) openReplaceRow();
      else closeReplaceRow();

      const prefill = selectionPrefill();
      setMode("search", { focus: true });
      requestAnimationFrame(() => {
        const { input: inp } = els();
        if (!inp) return;
        if (prefill) inp.value = prefill;
        inp.focus({ preventScroll: true });
        inp.select();
        const query = inp.value.trim();
        if (query) runSearch(query);
      });
    };

    // Clicking a #tag pill in the editor (markdown-preview.js dispatches this)
    // runs it as a vault-wide tag search. runSearch already treats any tag
    // query as vault-wide regardless of scope, but the scope is set to "all"
    // explicitly so the results DROPDOWN renders — under "current" scope the
    // UI expects in-document match cycling and shows no list.
    document.addEventListener("nib-tag-click", (e) => {
      const tag = e.detail?.tag;
      if (!tag) return;
      applyShortcutScope("all");
      closeReplaceRow();
      setMode("search", { focus: true });
      requestAnimationFrame(() => {
        const { input: inp } = els();
        if (!inp) return;
        inp.value = `tag:${tag}`;
        inp.focus({ preventScroll: true });
        // Caret to the end rather than select-all: the next thing a user
        // typically types is a further filter term, not a replacement query.
        inp.setSelectionRange(inp.value.length, inp.value.length);
        runSearch(inp.value.trim());
      });
    });

    document.addEventListener(
      "keydown",
      (e) => {
        if (!(e.ctrlKey || e.metaKey) || e.altKey) return;

        // Match on the PHYSICAL key (e.code) first, falling back to e.key.
        // With a Hangul IME active, e.key for a Ctrl combo can come through
        // as a jamo or as "Process" depending on the input method and
        // compositor, which would silently break these shortcuts in exactly
        // the state you'd normally be typing in. e.code is layout- and
        // IME-independent — KeyF is KeyF regardless of what the IME would
        // have produced.
        const matches = (code, letter) =>
          e.code === code || (!e.code && e.key.toLowerCase() === letter);

        if (matches("KeyF", "f")) {
          e.preventDefault();
          e.stopPropagation();
          // Shift is the only thing that widens the scope: Ctrl+Shift+F is
          // always the whole vault, plain Ctrl+F is always the open document
          // (falling back to vault-wide only when nothing is open at all).
          const scope =
            !e.shiftKey && getCurrentOpenFile() ? "current" : "all";
          openSearchViaShortcut({ scope });
          return;
        }

        if (matches("KeyH", "h") && !e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          if (!getCurrentOpenFile()) {
            showToast("No document is currently open.");
            return;
          }
          openSearchViaShortcut({ scope: "current", withReplace: true });
        }
      },
      true,
    );

    // ── replace row wiring ──
    const { replaceToggleBtn, replaceInput, replaceOneBtn, replaceAllBtn } =
      els();

    replaceToggleBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (replaceOpen) {
        closeReplaceRow();
        return;
      }
      if (!getCurrentOpenFile()) {
        showToast("No document is currently open.");
        return;
      }
      // Mouse path mirrors Ctrl+H: replace implies current-document scope.
      applyShortcutScope("current");
      openReplaceRow();
      const query = input.value.trim();
      if (query) runSearch(query);
      els().replaceInput?.focus({ preventScroll: true });
    });

    replaceInput?.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeReplaceRow();
        input.focus({ preventScroll: true });
        return;
      }
      if (e.key === "Tab" && e.shiftKey) {
        e.preventDefault();
        input.focus({ preventScroll: true });
        input.select();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) replaceAll();
        else replaceCurrent();
      }
    });

    replaceOneBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      replaceCurrent();
    });
    replaceAllBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      replaceAll();
    });
  };

  return { init, clearSearch };
})();

export const initTitlebarSearch = TitlebarSearchManager.init;
export const clearTitlebarSearch = TitlebarSearchManager.clearSearch;
