import {
  refreshFileTree,
  renderTree,
  revealInSidebar,
  destroyEditorView,
  getSearchResultIcon,
} from "./file-tree.js";
import {
  showToast,
  showToastWithAction,
  showCustomConfirm,
  showSaveIndicator,
} from "./utils.js";
import { getContextMenu } from "./state/uiState.js";
import { refreshToc } from "./toc.js";
import {
  getPinnedPaths,
  persistPins,
  remapPinnedPaths,
  getSelectedTreePath,
  setSelectedTreePath,
  getExpandedFolders,
  setIsRenaming,
} from "./state/treeState.js";
import { getVaultPath } from "./state/appState.js";
import { serializeTable } from "./markdown/table-model.js";
import {
  getEditorView,
  setEditorView,
  getCurrentOpenFile,
  setCurrentOpenFile,
  getAutoSaveTimeout,
  setAutoSaveTimeout,
  getPanzoom,
  setPanzoom,
} from "./state/editorState.js";

// True if a path points to an image file. Mirrors file-tree.js's private
// helper; used to keep text-editing actions (save, cut, paste…) off images.
function isImageFilePath(p) {
  if (!p) return false;
  const lower = p.toLowerCase();
  return [
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".svg",
    ".webp",
    ".bmp",
    ".ico",
  ].some((ext) => lower.endsWith(ext));
}

// ─── 1. Context Menu Manager ──────────────────────────────────────────────────
const ContextMenuManager = (() => {
  let contextHoveredLabel = null;

  const closeAllMenus = () => {
    document.getElementById("sidebar-context-menu")?.classList.remove("show");
    document.getElementById("main-context-menu")?.classList.remove("show");
    document.getElementById("ctx-main-insert-submenu")?.classList.remove("show");
    document.querySelectorAll(".item-label.context-selected").forEach((el) => {
      el.classList.remove("context-selected");
    });
    if (contextHoveredLabel) {
      contextHoveredLabel.classList.remove("hovered");
      contextHoveredLabel = null;
    }
  };

  const updateDividers = (menuElement) => {
    if (!menuElement) return;
    const children = Array.from(menuElement.children);
    let visibleBefore = false;
    let pendingDivider = null;

    children.forEach((child) => {
      if (
        child.classList.contains("context-menu-item") &&
        child.classList.contains("disabled")
      )
        return;

      if (
        child.classList.contains("context-menu-item") &&
        !child.classList.contains("disabled")
      ) {
        visibleBefore = true;
        if (pendingDivider) {
          pendingDivider.style.display = "block";
          pendingDivider = null;
        }
      }

      if (child.classList.contains("context-menu-divider")) {
        child.style.display = "none";
        if (visibleBefore) pendingDivider = child;
      }
    });

    if (pendingDivider) pendingDivider.style.display = "none";
  };

  const evaluateSidebarContext = (e, sidebar, sidebarMenu) => {
    const treeContainer = sidebar.querySelector(".file-tree-container");
    if (!treeContainer?.contains(e.target)) return false;

    e.preventDefault();
    e.stopPropagation();

    const buttons = {
      newFile: document.getElementById("ctx-sidebar-newfile"),
      newFolder: document.getElementById("ctx-sidebar-newfolder"),
      rename: document.getElementById("ctx-sidebar-rename"),
      duplicate: document.getElementById("ctx-sidebar-duplicate"),
      delete: document.getElementById("ctx-sidebar-delete"),
      togglePin: document.getElementById("ctx-sidebar-pin"),
      showInFolder: document.getElementById("ctx-sidebar-show-in-folder"),
      reveal: document.getElementById("ctx-sidebar-reveal"),
      unpinAll: document.getElementById("ctx-sidebar-unpin-all"),
    };

    Object.values(buttons).forEach((btn) => btn?.classList.remove("disabled"));

    const treeItem = e.target.closest(".tree-item");

    if (treeItem) {
      getContextMenu().targetElement = treeItem;
      getContextMenu().targetPath = treeItem.getAttribute("data-path");

      const labelSpan = treeItem.querySelector(".item-label");
      const isPinnedCopy = treeItem.getAttribute("data-pinned-copy") === "true";
      const isFile = treeItem.classList.contains("file");
      const isFolder = treeItem.classList.contains("directory");
      const isVirtual = treeItem.getAttribute("data-virtual-root") === "true";

      if (!(isPinnedCopy && isFile)) buttons.reveal?.classList.add("disabled");

      if (labelSpan) {
        document
          .querySelectorAll(".item-label.context-selected")
          .forEach((el) => el.classList.remove("context-selected"));
        labelSpan.classList.add("context-selected");
        contextHoveredLabel = labelSpan;
      }

      if (!isFolder) {
        buttons.newFile?.classList.add("disabled");
        buttons.newFolder?.classList.add("disabled");
      }

      if (isVirtual) {
        buttons.rename?.classList.add("disabled");
        buttons.duplicate?.classList.add("disabled");
        buttons.delete?.classList.add("disabled");
        buttons.togglePin?.classList.add("disabled");
        buttons.showInFolder?.classList.add("disabled");

        if (getContextMenu().targetPath === "__VIRTUAL_PINNED_ROOT__") {
          buttons.unpinAll?.classList.remove("disabled");
        } else {
          buttons.unpinAll?.classList.add("disabled");
        }
      } else {
        buttons.unpinAll?.classList.add("disabled");

        if (buttons.togglePin) {
          const pinSpan = buttons.togglePin.querySelector("span");
          const isPinned = getPinnedPaths()?.has(getContextMenu().targetPath);
          if (pinSpan) pinSpan.textContent = isPinned ? "Unpin" : "Pin";
        }
      }
    } else {
      getContextMenu().targetElement = null;
      getContextMenu().targetPath = getVaultPath();
      buttons.rename?.classList.add("disabled");
      buttons.duplicate?.classList.add("disabled");
      buttons.delete?.classList.add("disabled");
      buttons.togglePin?.classList.add("disabled");
      buttons.reveal?.classList.add("disabled");
      buttons.unpinAll?.classList.add("disabled");
    }

    if (sidebarMenu) {
      updateDividers(sidebarMenu);
      positionMenu(sidebarMenu, e.clientX, e.clientY);
      sidebarMenu.classList.add("show");
    }
    return true;
  };

  // Clamp a menu's position so it never opens past the window edge. The app
  // shell is overflow:clip (see base.css), so an overflowing menu wouldn't
  // scroll into view — its bottom items would simply be unreachable. Measure
  // AFTER disabled classes / updateDividers have settled (disabled items are
  // display:none, so they change the menu's final size) and BEFORE .show —
  // the hidden state is visibility-based, so offsetWidth/Height are real.
  const positionMenu = (menu, x, y) => {
    const margin = 8;
    const w = menu.offsetWidth || 180;
    const h = menu.offsetHeight || 200;
    menu.style.left = `${Math.max(margin, Math.min(x, window.innerWidth - w - margin))}px`;
    menu.style.top = `${Math.max(margin, Math.min(y, window.innerHeight - h - margin))}px`;
  };

  const evaluateMainContext = (e, mainView, mainCtxMenu) => {
    e.preventDefault();
    e.stopPropagation();
    getContextMenu().targetElement = mainView;
    getContextMenu().targetPath = null;

    if (!mainCtxMenu) return;

    // Snapshot the editor state at right-click time; the handlers re-read
    // live state when they run, this only drives which items are visible.
    const view = getEditorView();
    const openFile = getCurrentOpenFile();
    const fileEditorEl = document.getElementById("file-editor");
    const hasEditor =
      !!view && !!fileEditorEl && !fileEditorEl.classList.contains("hidden");
    const isReading = !!fileEditorEl?.classList.contains("reading-mode");
    const hasSelection = hasEditor && !view.state.selection.main.empty;
    const isImage = isImageFilePath(openFile);

    const setDisabled = (id, disabled) =>
      document.getElementById(id)?.classList.toggle("disabled", disabled);

    setDisabled("ctx-main-cut", !(hasEditor && hasSelection && !isReading));
    setDisabled("ctx-main-copy", !(hasEditor && hasSelection));
    setDisabled("ctx-main-paste", !(hasEditor && !isReading));
    setDisabled("ctx-main-selectall", !hasEditor);
    setDisabled("ctx-main-bold", !(hasEditor && !isReading));
    setDisabled("ctx-main-italic", !(hasEditor && !isReading));
    setDisabled("ctx-main-insert", !(hasEditor && !isReading));
    setDisabled("ctx-main-save", !(hasEditor && openFile && !isImage));
    setDisabled("ctx-main-copy-path", !openFile);
    setDisabled("ctx-main-reveal", !openFile);
    setDisabled("ctx-main-show-in-folder", !openFile);

    updateDividers(mainCtxMenu);
    positionMenu(mainCtxMenu, e.clientX, e.clientY);
    mainCtxMenu.classList.add("show");
  };

  return {
    closeAllMenus,
    updateDividers,
    evaluateSidebarContext,
    evaluateMainContext,
    positionMenu,
  };
})();

// ─── 2. File Operations Manager ───────────────────────────────────────────────
const FileOpsManager = {
  handleRename: (e) => {
    e.stopPropagation();
    ContextMenuManager.closeAllMenus();

    if (!getContextMenu().targetElement || !getContextMenu().targetPath) return;

    const targetElement = getContextMenu().targetElement;
    const targetPath = getContextMenu().targetPath;
    const labelSpan = targetElement.querySelector(".item-label");
    if (!labelSpan) return;

    setIsRenaming(true);
    const isFolder = targetElement.classList.contains("directory");
    const fullName = targetPath.substring(targetPath.lastIndexOf("/") + 1);
    const iconClone = labelSpan.querySelector(".tree-icon")?.cloneNode(true);

    labelSpan.innerHTML = "";
    if (iconClone) labelSpan.appendChild(iconClone);

    const input = document.createElement("input");
    input.type = "text";
    input.className = "tree-inline-input";
    input.value = fullName;
    labelSpan.appendChild(input);

    requestAnimationFrame(() => {
      input.focus();
      if (!isFolder && fullName.includes(".")) {
        input.setSelectionRange(0, fullName.lastIndexOf("."));
      } else {
        input.select();
      }
    });

    let finished = false;

    const commit = async () => {
      if (finished) return;
      finished = true;
      const newName = input.value.trim();

      if (newName && newName !== fullName) {
        try {
          const parentDir = targetPath.substring(
            0,
            targetPath.lastIndexOf("/"),
          );
          const newPath = parentDir ? `${parentDir}/${newName}` : newName;

          const isOpenFile = getCurrentOpenFile() === targetPath;
          if (isOpenFile && getAutoSaveTimeout()) {
            clearTimeout(getAutoSaveTimeout());
            setAutoSaveTimeout(null);
          }

          await api.renameFileOrFolder({ oldPath: targetPath, newPath });

          remapPinnedPaths(targetPath, newPath);

          if (getCurrentOpenFile() === targetPath) {
            setCurrentOpenFile(newPath);
            const titleInput = document.getElementById("editor-title");
            if (titleInput) {
              const dotIndex = newName.lastIndexOf(".");
              titleInput.value =
                dotIndex > 0 ? newName.slice(0, dotIndex) : newName;
            }
          }
          showToast("Name changed successfully.");
        } catch (err) {
          alert(`Failed to rename: ${err}`);
        }
      }
      setIsRenaming(false);
      await refreshFileTree();
    };

    const cancel = async () => {
      if (finished) return;
      finished = true;
      setIsRenaming(false);
      await refreshFileTree();
    };

    input.addEventListener("keydown", async (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        input.removeEventListener("blur", cancel);
        await commit();
      }
      if (ev.key === "Escape") {
        ev.preventDefault();
        input.removeEventListener("blur", cancel);
        await cancel();
      }
    });
    input.addEventListener("blur", cancel);
  },

  handleDelete: async (e, path) => {
    e.stopPropagation();
    ContextMenuManager.closeAllMenus();
    const targetPath = path ?? getContextMenu().targetPath;
    if (!targetPath) return;

    try {
      await api.deleteFileOrFolder({ targetPath });

      showToastWithAction("Moved to Trash", "Undo", async () => {
        try {
          await api.restoreFromTrash({ originalPath: targetPath });
          await refreshFileTree();
          showToast("Restored");
        } catch (restoreErr) {
          showToast("Restore failed");
          console.error("Restore error:", restoreErr);
        }
      });

      if (getPinnedPaths()) {
        let pinChanged = false;
        getPinnedPaths().forEach((pinnedPath) => {
          if (
            pinnedPath === targetPath ||
            pinnedPath.startsWith(targetPath + "/")
          ) {
            getPinnedPaths().delete(pinnedPath);
            pinChanged = true;
          }
        });
        if (pinChanged) persistPins();
      }

      if (
        getCurrentOpenFile() &&
        (getCurrentOpenFile() === targetPath ||
          getCurrentOpenFile().startsWith(targetPath + "/"))
      ) {
        const welcomeMsg = document.getElementById("welcome-message");
        const fileEditor = document.getElementById("file-editor");
        const imageViewer = document.getElementById("image-viewer");

        if (fileEditor && welcomeMsg) {
          fileEditor.classList.add("hidden");
          welcomeMsg.classList.remove("hidden");
        }
        if (imageViewer) imageViewer.classList.add("hidden");

        if (getPanzoom()) {
          getPanzoom().destroy();
          setPanzoom(null);
        }
        const viewerImg = document.getElementById("viewer-image");
        if (viewerImg) {
          viewerImg.src = "";
          viewerImg.alt = "";
        }

        destroyEditorView();

        document.getElementById("editor-stats")?.classList.add("hidden");
        document.getElementById("read-mode-btn")?.classList.add("hidden");
        document.getElementById("export-btn")?.classList.add("hidden");
        setCurrentOpenFile(null);
        setSelectedTreePath(null);
        refreshToc(); // outline panel falls back to "No open document."
      } else if (getSelectedTreePath() === targetPath) {
        setSelectedTreePath(null);
      }

      await refreshFileTree();
    } catch (err) {
      showToast("Failed to delete");
      console.error("Delete error:", err);
    }
  },
};

// ─── 3. Sidebar Actions Manager ───────────────────────────────────────────────
const SidebarActionManager = {
  runSidebarCreation: async (type) => {
    let parentPath = getContextMenu().targetPath || getVaultPath();
    if (!parentPath) return;

    let isPinnedContext = parentPath === "__VIRTUAL_PINNED_ROOT__";
    if (!isPinnedContext && getContextMenu().targetElement) {
      if (
        getContextMenu().targetElement.getAttribute("data-pinned-copy") ===
        "true"
      )
        isPinnedContext = true;
    }

    if (
      parentPath === "__VIRTUAL_VAULT_ROOT__" ||
      parentPath === "__VIRTUAL_PINNED_ROOT__"
    ) {
      parentPath = getVaultPath();
    }

    const targetEl = document.querySelector(
      `.tree-item[data-path="${parentPath}"]`,
    );
    if (targetEl && !targetEl.classList.contains("directory")) {
      parentPath = parentPath.includes("/")
        ? parentPath.substring(0, parentPath.lastIndexOf("/"))
        : getVaultPath();
    }

    try {
      let finalPath;
      if (type === "file") {
        finalPath = await api.createNewFile({
          parentPath,
          fileName: "Untitled",
        });
        showToast("File Created Successfully");
      } else {
        finalPath = await api.createNewFolder({
          parentPath,
          folderName: "Untitled",
        });
        showToast("Folder Created Successfully");
      }

      if (isPinnedContext && finalPath) {
        getPinnedPaths().add(finalPath);
        persistPins();
      }

      if (parentPath !== getVaultPath()) {
        getExpandedFolders().add(parentPath);
      }

      setSelectedTreePath(finalPath);
      await refreshFileTree();

      if (type === "file") {
        requestAnimationFrame(() => {
          document
            .querySelector(
              `.tree-item.file[data-path="${finalPath}"] .item-label`,
            )
            ?.click();
        });
      }
    } catch (err) {
      alert(`Failed to process command: ${err}`);
    }
  },

  initAddButtons: () => {
    const setTargetAndCreate = (type) => {
      const targetPath = getSelectedTreePath() || getVaultPath();
      getContextMenu().targetPath = targetPath;
      getContextMenu().targetElement = targetPath
        ? document.querySelector(
            `.tree-item:not([data-pinned-copy="true"])[data-path="${targetPath}"]`,
          ) || document.querySelector(`.tree-item[data-path="${targetPath}"]`)
        : null;
      SidebarActionManager.runSidebarCreation(type);
    };

    document
      .getElementById("add-file-btn")
      ?.addEventListener("click", () => setTargetAndCreate("file"));
    document
      .getElementById("add-folder-btn")
      ?.addEventListener("click", () => setTargetAndCreate("folder"));
  },
};

// ─── 4. Sidebar Search Manager ─────────────────────────────────────────────────
//
// Search box next to the add-file/add-folder buttons. Expands on click (same
// "grow a box, then reveal an inline input" language as the rename input),
// debounces keystrokes, calls the Rust-side fuzzy search, and swaps the
// regular file tree for a flat, highlighted results list while a query is
// active.
const SidebarSearchManager = (() => {
  // Debounce delay: long enough that a normal typing burst (multiple
  // keystrokes a few hundred ms apart) collapses into a single search call,
  // short enough that the results still feel like they're keeping up with
  // typing rather than lagging behind it.
  const DEBOUNCE_MS = 150;

  let debounceTimer = null;
  let isExpanded = false;
  let latestRequestId = 0; // guards against out-of-order async responses

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

  // Build the row's inner HTML, wrapping ONLY the characters at
  // matchIndices in a highlight span — not the whole range from the first
  // to the last match. matchIndices are UTF-16 code unit positions, which is
  // exactly how JS already indexes strings, so no conversion is needed.
  const renderHighlightedName = (name, matchIndices) => {
    const matchSet = new Set(matchIndices);
    let html = "";
    let runStart = null; // start of the current contiguous highlighted run

    const flushRun = (end) => {
      if (runStart === null) return;
      html += `<span class="search-match-highlight">${escapeHtml(name.slice(runStart, end))}</span>`;
      runStart = null;
    };

    for (let i = 0; i < name.length; i++) {
      if (matchSet.has(i)) {
        if (runStart === null) {
          // Flush any preceding plain-text characters as-is before opening
          // a highlighted run.
          runStart = i;
        }
      } else {
        flushRun(i);
        html += escapeHtml(name[i]);
      }
    }
    flushRun(name.length);

    return html;
  };

  const renderResults = (matches) => {
    const container = document.getElementById("search-results-container");
    const treeContainer = document.querySelector(".file-tree-container");
    if (!container || !treeContainer) return;

    container.innerHTML = "";

    if (matches.length === 0) {
      const empty = document.createElement("div");
      empty.className = "search-result-empty";
      empty.textContent = "No matching files or folders.";
      container.appendChild(empty);
      return;
    }

    matches.forEach((m) => {
      const row = document.createElement("div");
      row.className = `search-result-item tree-item ${m.isDir ? "directory" : "file"}`;
      row.setAttribute("data-path", m.path);

      const label = document.createElement("span");
      label.className = "item-label";

      const img = document.createElement("img");
      img.className = "tree-icon";
      img.src = getSearchResultIcon(m.isDir, m.name);
      img.alt = m.isDir ? "folder" : "file";

      const textSpan = document.createElement("span");
      textSpan.className = "item-text";
      textSpan.innerHTML = renderHighlightedName(m.name, m.matchIndices);

      label.appendChild(img);
      label.appendChild(textSpan);
      row.appendChild(label);

      label.addEventListener("mouseenter", () =>
        label.classList.add("hovered"),
      );
      label.addEventListener("mouseleave", () =>
        label.classList.remove("hovered"),
      );

      label.addEventListener("click", () => {
        SidebarSearchManager.openResult(m.path);
      });

      container.appendChild(row);
    });
  };

  const runSearch = async (query) => {
    const vaultPath = getVaultPath();
    if (!vaultPath) return;

    const requestId = ++latestRequestId;
    try {
      const matches = await api.searchFileTree({ vaultPath, query });
      // Drop stale responses: if the user kept typing, a newer search is
      // already in flight (or already resolved) and should win.
      if (requestId !== latestRequestId) return;
      renderResults(matches);
    } catch (err) {
      if (requestId !== latestRequestId) return;
      console.error("Search failed:", err);
      renderResults([]);
    }
  };

  const setActiveView = (searching) => {
    document
      .querySelector(".file-tree-container")
      ?.classList.toggle("hidden", searching);
    document
      .getElementById("search-results-container")
      ?.classList.toggle("hidden", !searching);
  };

  const ICON_BTN_WIDTH = 28; // one add-btn's natural (icon-only) width

  // Target width for the expanded search box: the action group's inner
  // content width, minus the space the two add-btns need to still show as
  // normal icon buttons (28px each) plus the gaps between all three items.
  // Reading this BEFORE adding the "expanded" class matters: add-folder-btn
  // and add-file-btn are flex:1, so while collapsed their offsetWidth is
  // inflated by whatever free space they're currently splitting — that
  // inflated number is not what we want to reserve. What we actually want
  // to reserve is their steady-state icon size, not their current stretched
  // size, so ICON_BTN_WIDTH is used directly instead of measuring them.
  const computeExpandedWidth = () => {
    const group = document.getElementById("sidebar-action-group");
    if (!group) return 160; // sane fallback

    const groupStyle = getComputedStyle(group);
    const gap = parseFloat(groupStyle.columnGap || groupStyle.gap) || 0;
    const paddingLeft = parseFloat(groupStyle.paddingLeft) || 0;
    const paddingRight = parseFloat(groupStyle.paddingRight) || 0;

    const contentWidth = group.clientWidth - paddingLeft - paddingRight;
    // 3 items in the row (search, folder, file) => 2 gaps between them.
    const reserved = ICON_BTN_WIDTH * 2 + gap * 2;

    return Math.max(ICON_BTN_WIDTH, contentWidth - reserved);
  };

  const collapse = () => {
    const wrapper = document.getElementById("sidebar-search");
    const input = document.getElementById("sidebar-search-input");
    if (!wrapper || !input) return;

    isExpanded = false;
    clearTimeout(debounceTimer);
    latestRequestId++; // invalidate any in-flight search
    input.value = "";
    wrapper.style.width = `${ICON_BTN_WIDTH}px`;
    wrapper.classList.remove("expanded");
    setActiveView(false);
  };

  const expand = () => {
    const wrapper = document.getElementById("sidebar-search");
    const input = document.getElementById("sidebar-search-input");
    if (!wrapper || !input) return;

    // Measure BEFORE mutating anything (see computeExpandedWidth's comment
    // on why pre-expand measurement matters here).
    const targetWidth = computeExpandedWidth();

    isExpanded = true;
    wrapper.classList.add("expanded");
    wrapper.style.width = `${targetWidth}px`;

    // Focus after the transition kicks off so the caret doesn't jump in
    // visually before the box has grown.
    requestAnimationFrame(() => input.focus());
  };

  const init = () => {
    const toggleBtn = document.getElementById("search-toggle-btn");
    const wrapper = document.getElementById("sidebar-search");
    const input = document.getElementById("sidebar-search-input");
    if (!toggleBtn || !wrapper || !input) return;

    toggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (isExpanded) {
        collapse();
      } else {
        expand();
      }
    });

    input.addEventListener("input", () => {
      clearTimeout(debounceTimer);
      const query = input.value.trim();

      if (!query) {
        latestRequestId++;
        setActiveView(false);
        return;
      }

      debounceTimer = setTimeout(() => {
        setActiveView(true);
        runSearch(query);
      }, DEBOUNCE_MS);
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        collapse();
      }
      // Prevent Enter from doing anything unexpected (e.g. bubbling into a
      // parent form-like handler); search is already live via debounce.
      if (e.key === "Enter") {
        e.preventDefault();
        clearTimeout(debounceTimer);
        const query = input.value.trim();
        if (query) {
          setActiveView(true);
          runSearch(query);
        }
      }
    });

    // Clicking anywhere outside the search box collapses it back down, same
    // spirit as the sidebar context menu's outside-click handling — but only
    // when the query is empty, so an active search result list stays open
    // while the user is browsing it.
    document.addEventListener(
      "mousedown",
      (e) => {
        if (!isExpanded) return;
        if (wrapper.contains(e.target)) return;
        if (
          document
            .getElementById("search-results-container")
            ?.contains(e.target)
        )
          return;
        if (!input.value.trim()) collapse();
      },
      true,
    );
  };

  return { init, collapse };
})();

// Open a search result: reveal it in the real tree (expanding ancestor
// folders as needed), then act on it — for files, click the tree's own row
// so we go through the exact same open pipeline as a normal click (editor
// setup, autosave flush, image handling, etc.) rather than re-implementing
// any of that here; for folders, revealing is enough.
SidebarSearchManager.openResult = (path) => {
  SidebarSearchManager.collapse();
  revealInSidebar(path);

  const row = document.querySelector(
    `.tree-item.file[data-path="${CSS.escape(path)}"]:not([data-pinned-copy])`,
  );
  row?.querySelector(".item-label")?.click();
};

// ─── 4. Main Editor Context-Menu Actions ──────────────────────────────────────
//
// All handlers re-read live state (editor view, open file) at click time
// rather than trusting anything captured when the menu opened — the menu can
// sit open across async work, same reasoning as syncTreeSelectionUI's fresh
// queries. Every mutating action ends with focus({ preventScroll: true }):
// plain focus() can scroll an ancestor "into view" and shift the whole
// window (see the scrollRowIntoTreeView notes in file-tree.js).
const EditorMenuActions = (() => {
  const getLiveEditor = () => {
    const view = getEditorView();
    const fileEditorEl = document.getElementById("file-editor");
    if (!view || !fileEditorEl || fileEditorEl.classList.contains("hidden"))
      return null;
    return view;
  };

  const isReadingMode = () =>
    !!document.getElementById("file-editor")?.classList.contains(
      "reading-mode",
    );

  const copySelection = async (cut = false) => {
    const view = getLiveEditor();
    if (!view) return;
    if (cut && isReadingMode()) return;
    const sel = view.state.selection.main;
    if (sel.empty) return;

    const text = view.state.sliceDoc(sel.from, sel.to);
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      console.error("Clipboard write failed:", err);
      showToast("Clipboard unavailable.");
      return;
    }
    if (cut) {
      // Re-read the selection AFTER the clipboard await: the write is async
      // and (rarely) the doc/selection could have changed under it — deleting
      // a stale range would eat the wrong text.
      const cur = view.state.selection.main;
      if (!cur.empty) {
        view.dispatch({
          changes: { from: cur.from, to: cur.to },
          selection: { anchor: cur.from },
        });
      }
    }
    view.focus({ preventScroll: true });
  };

  const paste = async () => {
    const view = getLiveEditor();
    if (!view || isReadingMode()) return;
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch (err) {
      console.error("Clipboard read failed:", err);
      showToast("Clipboard unavailable.");
      return;
    }
    if (!text) return;
    view.dispatch(view.state.replaceSelection(text));
    view.focus({ preventScroll: true });
  };

  const selectAll = () => {
    const view = getLiveEditor();
    if (!view) return;
    view.dispatch({
      selection: { anchor: 0, head: view.state.doc.length },
    });
    view.focus({ preventScroll: true });
  };

  // Toggle an inline markdown marker (** / * / `) around the main selection.
  // Three cases, checked in order:
  //   1. markers just OUTSIDE the selection  -> strip them
  //   2. markers INSIDE the selection's ends -> strip them
  //   3. otherwise                           -> wrap, keeping the same text
  //      selected (empty selection wraps nothing and parks the caret between
  //      the markers, ready to type).
  const toggleInlineMark = (marker) => {
    const view = getLiveEditor();
    if (!view || isReadingMode()) return;

    const { state } = view;
    const { from, to } = state.selection.main;
    const len = marker.length;
    const before = state.sliceDoc(Math.max(0, from - len), from);
    const after = state.sliceDoc(to, Math.min(state.doc.length, to + len));
    const inner = state.sliceDoc(from, to);

    if (from - len >= 0 && before === marker && after === marker) {
      view.dispatch({
        changes: [
          { from: from - len, to: from },
          { from: to, to: to + len },
        ],
        selection: { anchor: from - len, head: to - len },
      });
    } else if (
      inner.length >= 2 * len &&
      inner.startsWith(marker) &&
      inner.endsWith(marker)
    ) {
      view.dispatch({
        changes: [
          { from, to: from + len },
          { from: to - len, to },
        ],
        selection: { anchor: from, head: to - 2 * len },
      });
    } else {
      view.dispatch({
        changes: [
          { from, insert: marker },
          { from: to, insert: marker },
        ],
        selection: { anchor: from + len, head: to + len },
      });
    }
    view.focus({ preventScroll: true });
  };

  // Immediate save, bypassing the 2s autosave debounce. Kills any pending
  // autosave timer first so it can't fire a redundant (or, if the user
  // switches files in the gap, wrongly-timed) second write.
  const saveNow = async () => {
    const view = getLiveEditor();
    const path = getCurrentOpenFile();
    const vault = getVaultPath();
    if (!view || !path || !vault || isImageFilePath(path)) return;

    if (getAutoSaveTimeout()) {
      clearTimeout(getAutoSaveTimeout());
      setAutoSaveTimeout(null);
    }
    try {
      await api.writeFileContent({
        vaultPath: vault,
        filePath: path,
        content: view.state.doc.toString(),
      });
      showSaveIndicator();
    } catch (err) {
      console.error("Manual save failed:", err);
      showToast("Save failed.");
    }
  };

  const copyPath = async () => {
    const path = getCurrentOpenFile();
    if (!path) return;
    try {
      await navigator.clipboard.writeText(path);
      showToast("Path copied.");
    } catch (err) {
      console.error("Clipboard write failed:", err);
      showToast("Clipboard unavailable.");
    }
  };

  // Insert an empty GFM table at the caret. serializeTable() does the column
  // padding, so what lands in the doc is already aligned and round-trips
  // through markdown-table.js's editor unchanged.
  //
  // A table is a block: smartTable's leaf parser starts at the header row, so
  // a non-blank line directly above would be swallowed as that header and the
  // real header becomes the delimiter — the whole block then fails to form.
  // Hence the blank line above whenever the current line has content.
  const insertTable = (cols = 2, rows = 1) => {
    const view = getLiveEditor();
    if (!view || isReadingMode()) return;

    const md = serializeTable({
      header: Array(cols).fill(""),
      aligns: Array(cols).fill(null),
      rows: Array.from({ length: rows }, () => Array(cols).fill("")),
    });

    const { state } = view;
    const line = state.doc.lineAt(state.selection.main.head);
    const at = line.to;
    const before = line.text.trim() === "" ? "" : "\n\n";
    const after = at === state.doc.length ? "\n" : "\n\n";

    view.dispatch({
      changes: { from: at, insert: before + md + after },
      // +2 clears the leading "| " of the header row, parking the caret on
      // the first cell's text so it can be typed over immediately.
      selection: { anchor: at + before.length + 2 },
      scrollIntoView: true,
    });
    view.focus({ preventScroll: true });
  };

  // Fenced code block. backtickOnlyFence (smart-table.js) requires >=3
  // backticks and rejects a "`" anywhere in the info string, so a bare ``` is
  // the safe opener; the caret parks on the info-string slot so a language
  // can be typed straight away.
  const insertCodeBlock = () => {
    const view = getLiveEditor();
    if (!view || isReadingMode()) return;

    const { state } = view;
    const sel = state.selection.main;
    const inner = state.sliceDoc(sel.from, sel.to);
    const line = state.doc.lineAt(sel.from);

    // With a selection, wrap it in place; otherwise open an empty block after
    // the current line. Both need the surrounding blank lines a fence wants.
    if (!sel.empty) {
      const before = line.from === 0 ? "" : "\n";
      view.dispatch({
        changes: {
          from: sel.from,
          to: sel.to,
          insert: before + "```\n" + inner + "\n```\n",
        },
        selection: { anchor: sel.from + before.length + 3 },
        scrollIntoView: true,
      });
    } else {
      const at = line.to;
      const pre = line.text.trim() === "" ? "" : "\n\n";
      const post = at === state.doc.length ? "\n" : "\n\n";
      view.dispatch({
        changes: { from: at, insert: pre + "```\n\n```" + post },
        selection: { anchor: at + pre.length + 3 },
        scrollIntoView: true,
      });
    }
    view.focus({ preventScroll: true });
  };

  // Inline link. Selection becomes the label and the caret lands inside the
  // empty (), ready for a URL; with no selection the caret lands in the label
  // brackets instead.
  const insertLink = () => {
    const view = getLiveEditor();
    if (!view || isReadingMode()) return;

    const { state } = view;
    const sel = state.selection.main;
    const label = state.sliceDoc(sel.from, sel.to);

    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: `[${label}]()` },
      selection: {
        anchor: sel.empty
          ? sel.from + 1 // inside []
          : sel.from + label.length + 3, // inside ()
      },
      scrollIntoView: true,
    });
    view.focus({ preventScroll: true });
  };

  const showInFolder = async () => {
    const path = getCurrentOpenFile();
    if (!path) return;
    try {
      await api.showInFolder({ targetPath: path });
    } catch (err) {
      showToast(`Failed to open native explorer: ${err}`);
    }
  };

  return {
    copySelection,
    paste,
    selectAll,
    toggleInlineMark,
    insertTable,
    insertCodeBlock,
    insertLink,
    saveNow,
    copyPath,
    showInFolder,
  };
})();

// ─── 5. Initialization Events ─────────────────────────────────────────────────
function initSidebarContextMenu() {
  const sidebar = document.querySelector(".sidebar");
  const mainView = document.getElementById("main-view");
  const mainCtxMenu = document.getElementById("main-context-menu");
  const sidebarMenu = document.getElementById("sidebar-context-menu");

  SidebarSearchManager.init();

  // Global ContextMenu Event
  document.addEventListener("contextmenu", (e) => {
    ContextMenuManager.closeAllMenus();
    if (
      sidebar?.contains(e.target) &&
      ContextMenuManager.evaluateSidebarContext(e, sidebar, sidebarMenu)
    )
      return;
    if (mainView?.contains(e.target))
      return ContextMenuManager.evaluateMainContext(e, mainView, mainCtxMenu);
    ContextMenuManager.closeAllMenus();
  });

  // Global Outside Click
  document.addEventListener(
    "mousedown",
    (e) => {
      // The Insert submenu lives at <body>, NOT inside #main-context-menu, so
      // it must be tested separately — otherwise this capture-phase handler
      // closes both menus before a submenu item's click handler can run.
      const insertSubmenuEl = document.getElementById(
        "ctx-main-insert-submenu",
      );
      if (
        !sidebarMenu?.contains(e.target) &&
        !mainCtxMenu?.contains(e.target) &&
        !insertSubmenuEl?.contains(e.target)
      )
        ContextMenuManager.closeAllMenus();
    },
    true,
  );

  // Bind Buttons
  document
    .getElementById("ctx-sidebar-newfile")
    ?.addEventListener("click", () =>
      SidebarActionManager.runSidebarCreation("file"),
    );
  document
    .getElementById("ctx-sidebar-newfolder")
    ?.addEventListener("click", () =>
      SidebarActionManager.runSidebarCreation("folder"),
    );
  document
    .getElementById("ctx-sidebar-rename")
    ?.addEventListener("click", FileOpsManager.handleRename);
  document
    .getElementById("ctx-sidebar-delete")
    ?.addEventListener("click", (e) => FileOpsManager.handleDelete(e));

  document.getElementById("ctx-main-reveal")?.addEventListener("click", () => {
    ContextMenuManager.closeAllMenus();
    revealInSidebar();
  });

  // Submenu: hover-opened, positioned exactly like the table menu's submenus
  // (markdown-table.js renderMenu) — position:fixed with left/top written
  // here at hover time, inherited straight from .context-menu.
  //
  // The table menu overlaps its parent by 3px so the pointer never crosses a
  // gap; we use a real gap instead, which means mouseleave on the parent WILL
  // fire mid-crossing. So closing is deferred a beat and cancelled if the
  // pointer lands on the submenu.
  const insertParent = document.getElementById("ctx-main-insert");
  const insertSubmenu = document.getElementById("ctx-main-insert-submenu");
  if (insertParent && insertSubmenu) {
    // Authored inside the parent row for readability, but moved to <body>
    // here — exactly where markdown-table.js appends its menus. Left nested,
    // it is a flex ITEM of the row (.context-menu-item is display:flex), so
    // it stretches the row and is clipped by the parent menu's rounded box.
    // At <body> it is a plain fixed-position sibling that owes nothing to
    // the parent's layout.
    document.body.appendChild(insertSubmenu);

    const SUBMENU_GAP = 2;
    let closeTimer = null;
    const cancelClose = () => {
      if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = null;
      }
    };
    const openSubmenu = () => {
      cancelClose();
      if (insertParent.classList.contains("disabled")) return;

      // Measurable while hidden: .context-menu hides with opacity, not
      // display, so it is always laid out.
      const rect = insertParent.getBoundingClientRect();
      const mw = insertSubmenu.offsetWidth;
      const mh = insertSubmenu.offsetHeight;

      let left = rect.right + SUBMENU_GAP;
      // No room on the right -> flip to the left of the parent MENU (not the
      // row) so the submenu never sits on top of the menu it came from.
      if (left + mw > window.innerWidth - 6) {
        const parentMenu = document.getElementById("main-context-menu");
        const menuLeft = parentMenu
          ? parentMenu.getBoundingClientRect().left
          : rect.left;
        left = Math.max(6, menuLeft - mw - SUBMENU_GAP);
      }
      // -5px lines the submenu's first row up with the parent row, matching
      // the table menu's rect.top - 5.
      const top = Math.max(
        6,
        Math.min(rect.top - 5, window.innerHeight - mh - 6),
      );

      insertSubmenu.style.left = `${left}px`;
      insertSubmenu.style.top = `${top}px`;
      insertSubmenu.classList.add("show");
    };
    const scheduleClose = () => {
      cancelClose();
      closeTimer = setTimeout(() => {
        insertSubmenu.classList.remove("show");
        closeTimer = null;
      }, 180);
    };

    insertParent.addEventListener("mouseenter", openSubmenu);
    insertParent.addEventListener("mouseleave", scheduleClose);
    insertSubmenu.addEventListener("mouseenter", cancelClose);
    insertSubmenu.addEventListener("mouseleave", scheduleClose);

    // Hovering any OTHER row in the same menu closes the submenu at once —
    // otherwise it lingers over unrelated items for the timeout's duration.
    document
      .getElementById("main-context-menu")
      ?.querySelectorAll(".context-menu-item")
      .forEach((row) => {
        if (row === insertParent) return;
        row.addEventListener("mouseenter", () => {
          cancelClose();
          insertSubmenu.classList.remove("show");
        });
      });

    // Clicking the parent row is a no-op: it is not a command, so it must not
    // reach bindMainItem's closeAllMenus(). (After reparenting, submenu
    // clicks no longer bubble through this row at all.)
    insertParent.addEventListener("click", (e) => e.stopPropagation());
  }

  // Main editor menu: bind each item, always closing the menu first so the
  // action runs against a visually settled UI (matches the sidebar handlers).
  const bindMainItem = (id, handler) => {
    document.getElementById(id)?.addEventListener("click", (e) => {
      e.stopPropagation();
      ContextMenuManager.closeAllMenus();
      handler();
    });
  };

  bindMainItem("ctx-main-cut", () => EditorMenuActions.copySelection(true));
  bindMainItem("ctx-main-copy", () => EditorMenuActions.copySelection(false));
  bindMainItem("ctx-main-paste", EditorMenuActions.paste);
  bindMainItem("ctx-main-selectall", EditorMenuActions.selectAll);
  bindMainItem("ctx-main-bold", () =>
    EditorMenuActions.toggleInlineMark("**"),
  );
  bindMainItem("ctx-main-italic", () =>
    EditorMenuActions.toggleInlineMark("*"),
  );
  bindMainItem("ctx-main-ins-table", () => EditorMenuActions.insertTable());
  bindMainItem("ctx-main-ins-codeblock", EditorMenuActions.insertCodeBlock);
  bindMainItem("ctx-main-ins-inlinecode", () =>
    EditorMenuActions.toggleInlineMark("`"),
  );
  bindMainItem("ctx-main-ins-link", EditorMenuActions.insertLink);
  bindMainItem("ctx-main-save", EditorMenuActions.saveNow);
  bindMainItem("ctx-main-copy-path", EditorMenuActions.copyPath);
  bindMainItem("ctx-main-show-in-folder", EditorMenuActions.showInFolder);

  document
    .getElementById("ctx-sidebar-duplicate")
    ?.addEventListener("click", async () => {
      ContextMenuManager.closeAllMenus();
      const sourcePath = getContextMenu().targetPath;
      if (
        !sourcePath ||
        sourcePath === "__VIRTUAL_VAULT_ROOT__" ||
        sourcePath === "__VIRTUAL_PINNED_ROOT__"
      )
        return;
      try {
        // Backend picks the non-colliding name ("name copy.md", …) and
        // returns the new path. If it returns nothing, just refresh.
        const newPath = await api.copyFileOrFolder({ sourcePath });
        if (typeof newPath === "string" && newPath) {
          setSelectedTreePath(newPath);
        }
        await refreshFileTree();
        showToast("Duplicated.");
      } catch (err) {
        showToast(`Failed to duplicate: ${err}`);
      }
    });

  document
    .getElementById("ctx-sidebar-reveal")
    ?.addEventListener("click", () => {
      ContextMenuManager.closeAllMenus();
      revealInSidebar(getContextMenu().targetPath);
    });

  document
    .getElementById("ctx-sidebar-show-in-folder")
    ?.addEventListener("click", async () => {
      ContextMenuManager.closeAllMenus();
      let targetPath = getContextMenu().targetPath;
      if (!targetPath) return;

      if (targetPath === "__VIRTUAL_VAULT_ROOT__") targetPath = getVaultPath();
      else if (targetPath === "__VIRTUAL_PINNED_ROOT__")
        return showToast("Pinned group root has no physical directory.");

      try {
        await api.showInFolder({ targetPath });
      } catch (err) {
        showToast(`Failed to open native explorer: ${err}`);
      }
    });

  document.getElementById("ctx-sidebar-pin")?.addEventListener("click", () => {
    ContextMenuManager.closeAllMenus();
    const targetPath = getContextMenu().targetPath;
    if (!targetPath) return;

    if (getPinnedPaths().has(targetPath)) {
      getPinnedPaths().delete(targetPath);
      showToast("Item unpinned.");
    } else {
      getPinnedPaths().add(targetPath);
      showToast("Item pinned to top.");
    }
    persistPins();
    renderTree();
  });

  document
    .getElementById("ctx-sidebar-unpin-all")
    ?.addEventListener("click", async () => {
      ContextMenuManager.closeAllMenus();
      if (getContextMenu().targetPath !== "__VIRTUAL_PINNED_ROOT__") return;

      const confirmUnpin = await showCustomConfirm(
        "Unpin All Items",
        "Are you sure you want to unpin all items from the sidebar? This action cannot be undone.",
        "Unpin All",
      );
      if (!confirmUnpin) return;

      if (getPinnedPaths()) {
        getPinnedPaths().clear();
        persistPins();
        showToast("All items unpinned.");
        renderTree();
      }
    });
}

// ─── 6. Module exports ────────────────────────────────────────────────────────
export const closeAllMenus = ContextMenuManager.closeAllMenus;
export const updateContextMenuDividers = ContextMenuManager.updateDividers;
export { initSidebarContextMenu };
export const initSidebarAddButtons = SidebarActionManager.initAddButtons;
export const runSidebarCreation = SidebarActionManager.runSidebarCreation;
export const handleRename = FileOpsManager.handleRename;
export const handleDelete = FileOpsManager.handleDelete;
export const initSidebarSearch = SidebarSearchManager.init;
export const collapseSidebarSearch = SidebarSearchManager.collapse;
