// Mirror console.log/.error to the dev terminal as well.
(function () {
  // Route console output to the terminal via the native jsLog command.
  if (!window.api || typeof window.api.jsLog !== "function") return;
  const send = (level, args) => {
    try {
      const msg = args
        .map((a) => {
          if (typeof a === "string") return a;
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        })
        .join(" ");
      api.jsLog({ msg: `[${level}] ${msg}` });
    } catch {}
  };
  ["log", "info", "warn", "error"].forEach((k) => {
    const orig = console[k].bind(console);
    console[k] = (...args) => {
      orig(...args); // keep it in the inspector
      send(k, args); // and forward to the terminal
    };
  });
})();

import { attachScrollbar } from "./scrollbar.js";
import { showToast, showSaveIndicator } from "./utils.js";
import { refreshToc, scheduleTocRefresh } from "./toc.js";
import {
  getRawTreeData,
  setRawTreeData,
  getExpandedFolders,
  getSelectedTreePath,
  setSelectedTreePath,
  getPinnedPaths,
  isPinnedExpanded,
  setPinnedExpanded,
  remapPinnedPaths,
  isVaultExpanded,
  setVaultExpanded,
  getIsRenaming,
} from "./state/treeState.js";
import { getVaultPath } from "./state/appState.js";
import {
  getEditorView,
  setEditorView,
  getCurrentOpenFile,
  setCurrentOpenFile,
  getIsSwitchingFile,
  setIsSwitchingFile,
  getAutoSaveTimeout,
  setAutoSaveTimeout,
  getTriggerAutoSave,
  setTriggerAutoSave,
  getCodeMirrorModules,
  setCodeMirrorModules,
  getFileScrollPositions,
  getFileCursorPositions,
  getFileReadingModeStates,
} from "./state/editorState.js";

/**
 * Tear down the CodeMirror editor safely.
 *
 * On open, #editor-title is appended into the live .cm-scroller (see the end of
 * the open handler) so it scrolls with the document and is positioned by the
 * scroller. CodeMirror's destroy() removes the whole .cm-editor subtree, which
 * would delete the title input along with it — and then the next text-file open
 * can't find #editor-title and bails at its early `return`, so the file appears
 * not to open. Park the title back in its static home (#editor-content-inner)
 * before destroying so it always survives; the open handler re-adopts it into
 * the new scroller, keeping the exact same layout.
 */
export function destroyEditorView() {
  if (!getEditorView()) return;
  const titleInput = document.getElementById("editor-title");
  const home = document.getElementById("editor-content-inner");
  const body = document.getElementById("editor-body");
  if (titleInput && home && titleInput.parentElement !== home) {
    // Restore original order: title before the editor body.
    home.insertBefore(titleInput, body || null);
  }
  getEditorView().destroy();
  setEditorView(null);
}

/**
 * Recursively find a node by its path within a tree.
 * @param {Array|null} nodes
 * @param {string} path
 * @returns {object|null}
 */
export function findNodeByPath(nodes, path) {
  if (!nodes) return null;
  for (const n of nodes) {
    if (n.path === path) return n;
    if (n.children) {
      const found = findNodeByPath(n.children, path);
      if (found) return found;
    }
  }
  return null;
}

function getTreeNodeIcon(node, isPinnedCopy = false) {
  if (node.path === "__VIRTUAL_PINNED_ROOT__") return "assets/pin.svg";
  if (node.path === "__VIRTUAL_VAULT_ROOT__") {
    return "assets/box.svg";
  }
  if (node.is_dir) {
    const key = isPinnedCopy ? node.path + "__PINNED__" : node.path;
    return getExpandedFolders().has(key)
      ? "assets/open-folder.svg"
      : "assets/close-folder.svg";
  }
  const imageExts = [
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".svg",
    ".webp",
    ".bmp",
    ".ico",
  ];
  return imageExts.some((ext) => node.name.toLowerCase().endsWith(ext))
    ? "assets/image.svg"
    : "assets/document.svg";
}

// Icon for a flat search result row. Unlike getTreeNodeIcon, a search result
// is never expanded/collapsed in place, so folders always show the closed
// icon rather than reflecting getExpandedFolders() state.
export function getSearchResultIcon(isDir, name) {
  if (isDir) return "assets/close-folder.svg";
  const imageExts = [
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".svg",
    ".webp",
    ".bmp",
    ".ico",
  ];
  return imageExts.some((ext) => name.toLowerCase().endsWith(ext))
    ? "assets/image.svg"
    : "assets/document.svg";
}

// True if a path points to an image file (used to keep text writes off images).
function isImageFile(p) {
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

export async function refreshFileTree() {
  const vaultPath = getVaultPath();
  if (!vaultPath) return;
  try {
    setRawTreeData(await api.getFileTree({ vaultPath }));
    renderTree();
    initTreeContainerDrop();
  } catch (err) {
    console.error("[Vault] Failed to refresh file tree:", err);
  }
}

// Reveal the currently open file in the sidebar: open the sidebar, expand every
// ancestor folder, re-render, then select and scroll the file into view.
export function revealInSidebar(targetPath, scrollBehavior = "smooth") {
  const filePath = targetPath || getCurrentOpenFile();
  if (!filePath || !getVaultPath()) return;
  const vault = getVaultPath();
  if (!filePath.startsWith(vault + "/")) return;

  // If the row is already present in the DOM (its parent folders are
  // already expanded and the sidebar is already open), skip straight to
  // scrolling it into view — no need to touch expanded-folder state, force
  // the sidebar open, or force a full renderTree() re-render. This is the
  // common case when called from search results (the file is usually
  // already visible in the tree), and doing all that unconditionally on
  // every single result click was the one operation unique to this path
  // vs. a normal sidebar click — a likely source of an unwanted layout
  // shift elsewhere in the window.
  const existingRow = document.querySelector(
    `.tree-item.file[data-path="${CSS.escape(filePath)}"]:not([data-pinned-copy])`,
  );
  if (existingRow) {
    setSelectedTreePath(filePath);
    syncTreeSelectionUI();
    scrollRowIntoTreeView(existingRow, scrollBehavior);
    flashRevealRow(existingRow);
    return;
  }

  // Build each ancestor folder path between the vault and the file, and mark
  // them expanded. e.g. vault/a/b/c.md -> expand vault/a and vault/a/b.
  const rel = filePath.slice(vault.length + 1); // a/b/c.md
  const parts = rel.split("/");
  parts.pop(); // drop the file name
  let acc = vault;
  for (const part of parts) {
    acc = `${acc}/${part}`;
    getExpandedFolders().add(acc);
  }
  setVaultExpanded(true);

  // Open the sidebar if it's collapsed.
  const sidebar = document.getElementById("sidebar");
  if (sidebar && !sidebar.classList.contains("open")) {
    sidebar.classList.add("open");
    const w = getComputedStyle(document.documentElement)
      .getPropertyValue("--sidebar-width")
      .trim();
    if (!w || w === "0px") {
      document.documentElement.style.setProperty("--sidebar-width", "200px");
    }
  }

  setSelectedTreePath(filePath);
  renderTree();
  syncTreeSelectionUI();

  // Scroll the file's row into view (renderTree is synchronous, so it exists).
  // Reveal targets the Workspace copy (not a pinned shortcut), so scope the
  // selector to exclude pinned copies.
  const row = document.querySelector(
    `.tree-item.file[data-path="${CSS.escape(filePath)}"]:not([data-pinned-copy])`,
  );
  if (!row) return;
  scrollRowIntoTreeView(row, scrollBehavior);
  flashRevealRow(row);
}

// Center a tree row inside the sidebar's OWN scroller, and nothing else.
// element.scrollIntoView() walks the entire ancestor chain and scrolls every
// "scroll container" it finds — and overflow:hidden boxes ARE scroll
// containers (their scrollbars are hidden, but they remain programmatically
// scrollable). .app-container, .window, <body> and <html> are all
// overflow:hidden here, and .window has ~10px of scrollable overflow because
// #apply-toast rests at bottom:-10px inside it (its positioned ancestor is
// .window, position:relative). So block:"center" nudged .window.scrollTop by
// up to that 10px to "center" the row in the window box — shifting the
// titlebar/sidebar/editor (everything inside .window) up permanently, since
// nothing ever resets that scrollTop and the hidden scrollbar gives the user
// no way to. Same class of bug as CodeMirror's built-in scrollIntoView (see
// titlebar-search.js scrollMatchIntoView); same cure: scroll only the
// intended scroller, by hand.
function scrollRowIntoTreeView(row, behavior = "smooth") {
  const scroller = row.closest(".file-tree-container");
  if (!scroller) return;
  const rowRect = row.getBoundingClientRect();
  const scRect = scroller.getBoundingClientRect();
  const delta =
    rowRect.top + rowRect.height / 2 - (scRect.top + scRect.height / 2);
  if (Math.abs(delta) < 1) return; // already centered; skip a no-op scroll
  scroller.scrollTo({
    top: scroller.scrollTop + delta, // scrollTo clamps to valid range itself
    behavior: behavior === "smooth" ? "smooth" : "auto",
  });
}

// Flash a tree row a few times so it's easy to spot after being revealed.
// Factored out so both the fast (already-visible) and slow (needs
// expand + re-render) paths in revealInSidebar share the same behavior.
function flashRevealRow(row) {
  const label = row.querySelector(".item-label");
  if (label) {
    label.classList.remove("reveal-flash"); // restart if already flashing
    void label.offsetWidth; // reflow so re-adding restarts the animation
    label.classList.add("reveal-flash");
    label.addEventListener(
      "animationend",
      () => label.classList.remove("reveal-flash"),
      { once: true },
    );
  }
}

export function renderTree() {
  const container = document.querySelector(".file-tree-container");
  if (!container || !getRawTreeData()) return;

  container.innerHTML = "";

  if (getPinnedPaths().size > 0) {
    const pinnedHeader = makeItem(
      { name: "Pinned", path: "__VIRTUAL_PINNED_ROOT__", is_dir: true },
      0,
      true,
      false,
    );
    container.appendChild(pinnedHeader);

    const pinnedChildren = document.createElement("div");
    pinnedChildren.className = "tree-children";
    if (isPinnedExpanded()) pinnedChildren.classList.add("expanded");

    const pinnedInner = document.createElement("div");
    pinnedInner.className = "tree-children-inner tree-children-root";
    Array.from(getPinnedPaths())
      .reverse()
      .forEach((path) => {
        const node = findNodeByPath(getRawTreeData(), path);
        if (node) buildSubTree(pinnedInner, node, 0, true);
      });

    pinnedChildren.appendChild(pinnedInner);
    container.appendChild(pinnedChildren);
  }

  const vaultHeader = makeItem(
    { name: "Workspace", path: "__VIRTUAL_VAULT_ROOT__", is_dir: true },
    0,
    true,
    false,
  );
  container.appendChild(vaultHeader);

  const vaultChildren = document.createElement("div");
  vaultChildren.className = "tree-children";
  if (isVaultExpanded()) vaultChildren.classList.add("expanded");

  const vaultInner = document.createElement("div");
  vaultInner.className = "tree-children-inner tree-children-root";

  // Workspace direct children start at depth 0 (no indent) — the virtual header
  // shouldn't cost a level. Their nested folders/files still cascade normally.
  getRawTreeData().forEach((node) => buildSubTree(vaultInner, node, 0, false));

  vaultChildren.appendChild(vaultInner);
  container.appendChild(vaultChildren);
}

function buildSubTree(parent, node, depth, isPinnedCopy) {
  const li = makeItem(node, depth, false, isPinnedCopy);
  parent.appendChild(li);

  if (node.is_dir && node.children) {
    const key = isPinnedCopy ? node.path + "__PINNED__" : node.path;

    const childWrapper = document.createElement("div");
    childWrapper.className = "tree-children";
    if (getExpandedFolders().has(key)) childWrapper.classList.add("expanded");

    const childInner = document.createElement("div");
    childInner.className = "tree-children-inner";
    // Vertical guide line x-position, aligned under the parent folder's icon.
    // Parent label padding is 6 + depth*14; place the guide a touch right of
    // that so it runs under the folder icon.
    childInner.style.setProperty("--guide-x", `${6 + depth * 14 + 5}px`);

    node.children.forEach((child) =>
      buildSubTree(childInner, child, depth + 1, isPinnedCopy),
    );

    childWrapper.appendChild(childInner);
    parent.appendChild(childWrapper);
  }
}

function makeItem(node, depth, isVirtual, isPinnedCopy) {
  const li = document.createElement("div");
  li.className = node.is_dir ? "tree-item directory" : "tree-item file";
  li.setAttribute("data-path", node.path);

  if (isVirtual) li.setAttribute("data-virtual-root", "true");
  if (isPinnedCopy) li.setAttribute("data-pinned-copy", "true");
  if (!isVirtual && !isPinnedCopy) li.setAttribute("draggable", "true");

  if (!isVirtual) {
    if (getCurrentOpenFile() === node.path) {
      li.classList.add("selected");
    } else if (getSelectedTreePath() === node.path) {
      li.classList.add("focused-item");
    }
  }
  if (getCurrentOpenFile() === node.path && !isVirtual) {
    li.classList.add("opened");
  }

  const span = document.createElement("span");
  span.className = "item-label";
  span.style.paddingLeft = `${6 + depth * 14}px`;
  span.style.paddingRight = "10px";
  span.style.width = "100%";
  span.style.display = "inline-flex";
  span.style.alignItems = "center";
  span.style.boxSizing = "border-box";

  const img = document.createElement("img");
  img.className = "tree-icon";
  img.src = getTreeNodeIcon(node, isPinnedCopy);
  img.alt = node.is_dir ? "folder" : "file";
  if (node.path === "__VIRTUAL_PINNED_ROOT__") {
    img.style.width = "13px";
    img.style.height = "13px";
  }

  span.appendChild(img);
  const textSpan = document.createElement("span");
  textSpan.className = "item-text";
  textSpan.textContent = node.name;
  span.appendChild(textSpan);

  if (isVirtual) {
    const arrowImg = document.createElement("img");
    arrowImg.className = "section-arrow-icon";
    arrowImg.src = "assets/arrow-down.svg";
    const isExpanded =
      node.path === "__VIRTUAL_VAULT_ROOT__"
        ? isVaultExpanded()
        : isPinnedExpanded();

    if (isExpanded) {
      arrowImg.classList.add("expanded");
    }
    span.appendChild(arrowImg);
  }

  li.appendChild(span);

  span.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (getIsRenaming()) return;

    if (
      node.path === "__VIRTUAL_VAULT_ROOT__" ||
      node.path === "__VIRTUAL_PINNED_ROOT__"
    ) {
      const isVault = node.path === "__VIRTUAL_VAULT_ROOT__";
      if (isVault) setVaultExpanded(!isVaultExpanded());
      else setPinnedExpanded(!isPinnedExpanded());

      const childWrapper = li.nextElementSibling;
      if (childWrapper && childWrapper.classList.contains("tree-children")) {
        if (
          (isVault && isVaultExpanded()) ||
          (!isVault && isPinnedExpanded())
        ) {
          childWrapper.classList.add("expanded");
        } else {
          childWrapper.classList.remove("expanded");
        }
      }
      const arrowImg = span.querySelector(".section-arrow-icon");
      if (arrowImg) {
        const isExpanded = isVault ? isVaultExpanded() : isPinnedExpanded();
        if (isExpanded) {
          arrowImg.classList.add("expanded");
        } else {
          arrowImg.classList.remove("expanded");
        }
      }
      img.src = getTreeNodeIcon(node, isPinnedCopy);
      return;
    }

    setSelectedTreePath(node.path);
    syncTreeSelectionUI();

    if (node.is_dir) {
      const key = isPinnedCopy ? node.path + "__PINNED__" : node.path;
      const childWrapper = li.nextElementSibling;

      if (getExpandedFolders().has(key)) {
        getExpandedFolders().delete(key);
        childWrapper?.classList.remove("expanded");
      } else {
        getExpandedFolders().add(key);
        childWrapper?.classList.add("expanded");
      }
      img.src = getTreeNodeIcon(node, isPinnedCopy);
      return;
    }

    if (getIsSwitchingFile()) return;

    if (getCurrentOpenFile() === node.path) return;

    const titleInput = document.getElementById("editor-title");
    if (titleInput && document.activeElement === titleInput) {
      titleInput.blur();
    }

    const lowerName = node.name.toLowerCase();
    const isImage = [
      ".png",
      ".jpg",
      ".jpeg",
      ".gif",
      ".webp",
      ".svg",
      ".bmp",
    ].some((ext) => lowerName.endsWith(ext));
    const isText = lowerName.endsWith(".md") || lowerName.endsWith(".txt");

    if (!isImage && !isText) {
      showToast("Unsupported file type.");
      return;
    }

    const welcomeMsg = document.getElementById("welcome-message");
    const fileEditor = document.getElementById("file-editor");
    const imageViewer = document.getElementById("image-viewer");

    void fileEditor.offsetHeight;

    // The path of the file currently in the editor (may be null on first open).
    // Capture it BEFORE changing anything so we can flush its content to the
    // right path, never to the file we're switching to.
    const previousOpenFile = getCurrentOpenFile();

    // UNIVERSAL switch guard: whenever the open file changes — to a text file,
    // an image, anything — immediately flush the previous file's edits to ITS
    // OWN path and destroy the autosave timer. This runs before any branch, so
    // no stale timer can later write the editor's text into the new file (which
    // previously corrupted images). Skip the flush only if the previous file
    // was itself an image (it never held editor text).
    if (getAutoSaveTimeout()) {
      clearTimeout(getAutoSaveTimeout());
      setAutoSaveTimeout(null);
    }
    if (
      previousOpenFile &&
      previousOpenFile !== node.path &&
      !isImageFile(previousOpenFile) &&
      getVaultPath() &&
      getEditorView()
    ) {
      try {
        await api.writeFileContent({
          vaultPath: getVaultPath(),
          filePath: previousOpenFile,
          content: getEditorView().state.doc.toString(),
        });
      } catch (err) {
        console.error("Save-before-switch failed:", err);
      }
    }

    welcomeMsg?.classList.add("hidden");

    // Image file pipeline (immediate display).
    if (isImage) {
      // The previous file was already flushed above; drop the stale editor so
      // nothing can write its contents to the image.
      destroyEditorView();
      setCurrentOpenFile(node.path);
      syncTreeSelectionUI();
      refreshToc(); // outline panel shows its "Markdown only" empty state

      document.getElementById("editor-stats")?.classList.add("hidden");
      document.getElementById("read-mode-btn")?.classList.add("hidden");
      document.getElementById("export-btn")?.classList.add("hidden");
      fileEditor?.classList.add("hidden");
      imageViewer?.classList.remove("hidden");

      const originalImgElement = document.getElementById("viewer-image");

      if (originalImgElement) {
        const imgElement = originalImgElement.cloneNode(true);
        originalImgElement.parentNode.replaceChild(
          imgElement,
          originalImgElement,
        );

        // Clear alt/src before loading the new image.
        imgElement.alt = "";
        imgElement.src = "";

        try {
          let safePath = node.path.replace(/\\/g, "/");
          if (!safePath.startsWith("/")) {
            safePath = "/" + safePath;
          }

          const encodedPath = encodeURI(safePath)
            .replace(/#/g, "%23")
            .replace(/\?/g, "%3F");

          imgElement.src = `local-media://${encodedPath}`;
        } catch (err) {
          console.error("Failed to load image:", err);
          showToast("Could not load image.");
        }
      }
      return;
    }

    // Guard the whole switch: while true, triggerAutoSave is a no-op, so a timer
    // that fires during the awaits below can't write to the wrong path. (The
    // previous file was already flushed and the timer killed above.)
    setIsSwitchingFile(true);

    try {
      const fileContent = await api.readFileContent({
        filePath: node.path,
      });
      const welcomeMsg = document.getElementById("welcome-message");
      const fileEditor = document.getElementById("file-editor");
      const titleInput = document.getElementById("editor-title");
      const bodyElement = document.getElementById("editor-body");
      const imageViewer = document.getElementById("image-viewer");

      if (!fileEditor || !titleInput || !bodyElement) return;

      if (
        getEditorView() &&
        getCurrentOpenFile() &&
        getEditorView().scrollDOM
      ) {
        getFileScrollPositions()[getCurrentOpenFile()] =
          getEditorView().scrollDOM.scrollTop;
        getFileCursorPositions()[getCurrentOpenFile()] =
          getEditorView().state.selection.main.head;
      }

      setCurrentOpenFile(node.path);
      syncTreeSelectionUI();

      const dotIndex = node.name.lastIndexOf(".");
      titleInput.value =
        dotIndex > 0 ? node.name.slice(0, dotIndex) : node.name;

      welcomeMsg?.classList.add("hidden");
      fileEditor.classList.remove("hidden");
      imageViewer?.classList.add("hidden");

      // ─── Dynamically load CodeMirror modules + markdown preview ───
      if (!getCodeMirrorModules()) {
        try {
          const cm = await import("./libs/codemirror.js");
          const mdPreview = await import("./markdown-preview.js");
          const mdExtensions = await mdPreview.getMarkdownExtensions();

          setCodeMirrorModules({
            EditorView: cm.EditorView,
            basicSetup: cm.basicSetup,
            mdExtensions: mdExtensions,
          });
        } catch (err) {
          console.error("Failed to initialize editor:", err);
          showToast(
            "Failed to load editor modules. Please check your installation.",
          );

          if (fileEditor) fileEditor.classList.add("hidden");
          if (welcomeMsg) welcomeMsg.classList.remove("hidden");
          setCurrentOpenFile(null);
          syncTreeSelectionUI();

          return;
        }
      }

      // Pull mdExtensions into scope.
      const { EditorView, basicSetup, mdExtensions } = getCodeMirrorModules();

      if (!getTriggerAutoSave()) {
        setAutoSaveTimeout(null);
        setTriggerAutoSave(() => {
          if (getIsSwitchingFile()) return;
          if (getAutoSaveTimeout()) clearTimeout(getAutoSaveTimeout());
          setAutoSaveTimeout(
            setTimeout(async () => {
              setAutoSaveTimeout(null);
              const currentPath = getCurrentOpenFile();
              const currentVault = getVaultPath();
              if (!currentPath || !currentVault || !getEditorView()) return;
              // Never autosave editor text onto an image file (would corrupt it).
              if (isImageFile(currentPath)) return;
              try {
                await api.writeFileContent({
                  vaultPath: currentVault,
                  filePath: currentPath,
                  content: getEditorView().state.doc.toString(),
                });
                showSaveIndicator();
              } catch {
                showToast("Auto-save failed.");
              }
            }, 2000),
          );
        });
      }

      destroyEditorView();
      function updateEditorStats(state) {
        const doc = state.doc;
        const fullText = doc.toString();

        // Always-visible stats.
        const charsWithSpace = fullText.length;
        const totalLines = doc.lines;
        const curLine = doc.lineAt(state.selection.main.head).number;

        // Main indicator.
        const statChars = document.getElementById("stat-chars");
        if (statChars) statChars.textContent = charsWithSpace;
        const statLine = document.getElementById("stat-line");
        if (statLine) statLine.textContent = curLine;
        const statTotal = document.getElementById("stat-total");
        if (statTotal) statTotal.textContent = totalLines;

        // Detailed metrics.
        const charsNoSpace = fullText.replace(/\s/g, "").length;
        const words =
          fullText.trim() === "" ? 0 : fullText.trim().split(/\s+/).length;

        // UTF-8 byte size.
        const byteLength = new TextEncoder().encode(fullText).length;
        let fileSizeStr = "";
        if (byteLength < 1024) {
          fileSizeStr = `${byteLength} Bytes`;
        } else {
          fileSizeStr = `${(byteLength / 1024).toFixed(2)} KB`;
        }

        // Selection summary with singular/plural handling.
        const mainSel = state.selection.main;
        let selStr = "-";
        if (!mainSel.empty) {
          const selText = doc.slice(mainSel.from, mainSel.to).toString();
          const selChars = selText.length;

          const startLine = doc.lineAt(mainSel.from).number;
          const endLine = doc.lineAt(mainSel.to).number;
          const selLines = endLine - startLine + 1;

          const charUnit = selChars === 1 ? "char" : "chars";
          const lineUnit = selLines === 1 ? "line" : "lines";

          selStr = `${selChars} ${charUnit}, ${selLines} ${lineUnit}`;
        }

        // Write values to the DOM.
        const tCharsSpace = document.getElementById("tooltip-chars-with-space");
        if (tCharsSpace) tCharsSpace.textContent = charsWithSpace;

        const tCharsNoSpace = document.getElementById("tooltip-chars-no-space");
        if (tCharsNoSpace) tCharsNoSpace.textContent = charsNoSpace;

        const tWords = document.getElementById("tooltip-words");
        if (tWords) tWords.textContent = words;

        const tTotalLines = document.getElementById("tooltip-total-lines");
        if (tTotalLines) tTotalLines.textContent = totalLines;

        const tSelection = document.getElementById("tooltip-selection");
        if (tSelection) tSelection.textContent = selStr;

        const tFileSize = document.getElementById("tooltip-file-size");
        if (tFileSize) tFileSize.textContent = fileSizeStr;
      }
      try {
        const isReadingMode = !!getFileReadingModeStates()?.[node.path];

        const readBtn = document.getElementById("read-mode-btn");
        const fileEditor = document.getElementById("file-editor");
        if (readBtn) {
          const readImg = readBtn.querySelector("img");
          if (isReadingMode) {
            readBtn.classList.add("active");
            readBtn.title = "Toggle Editing Mode";
            if (readImg) readImg.src = "assets/edit_mode.svg";
          } else {
            readBtn.classList.remove("active");
            readBtn.title = "Toggle Reading Mode";
            if (readImg) readImg.src = "assets/read_mode.svg";
          }
        }

        if (fileEditor) {
          if (isReadingMode) {
            fileEditor.classList.add("reading-mode");
          } else {
            fileEditor.classList.remove("reading-mode");
          }
        }

        const isMarkdown = lowerName.endsWith(".md");
        setEditorView(
          new EditorView({
            doc: fileContent,
            extensions: [
              basicSetup,
              EditorView.lineWrapping,
              isMarkdown ? mdExtensions || [] : [],
              EditorView.updateListener.of((u) => {
                if (u.docChanged) {
                  getTriggerAutoSave()();
                  // Keep the outline panel in sync while typing (debounced,
                  // and a no-op while the panel is hidden).
                  scheduleTocRefresh();
                }

                // Recompute stats on typing or selection change.
                if (u.docChanged || u.selectionSet) {
                  updateEditorStats(u.state);
                }
              }),

              EditorView.theme({
                "&": { height: "100%", background: "transparent" },
                "&.cm-focused": { outline: "none" },
                // Hide CM's native scrollbar; the custom overlay draws its own.
                ".cm-scroller": { scrollbarWidth: "none" },
                ".cm-scroller::-webkit-scrollbar": {
                  width: "0",
                  height: "0",
                  display: "none",
                },
              }),
            ],
            parent: bodyElement,
          }),
        );
        // CM was just recreated, so its .cm-scroller is new — (re)attach the
        // custom overlay scrollbar to it.
        if (attachScrollbar) {
          getEditorView().scrollDOM.classList.add("custom-scroll");
          attachScrollbar(getEditorView().scrollDOM, {
            editor: true,
          });
        }
        const savedCursor = getFileCursorPositions()?.[node.path] || 0;
        const docLength = getEditorView().state.doc.length;
        const validCursor = Math.min(savedCursor, docLength);

        getEditorView().dispatch({
          selection: { anchor: validCursor, head: validCursor },
        });
        // Run once on open so stats are populated immediately.
        updateEditorStats(getEditorView().state);
        if (titleInput) {
          titleInput.readOnly = isReadingMode;
        }
        if (isReadingMode && getEditorView().contentDOM) {
          getEditorView().contentDOM.setAttribute("contenteditable", "false");
        }

        const savedScroll = getFileScrollPositions()?.[node.path] || 0;
        if (savedScroll > 0) {
          getEditorView().requestMeasure({
            read: () => {},
            write: () => {
              if (getEditorView()?.scrollDOM) {
                getEditorView().scrollDOM.scrollTop = savedScroll;
              }
            },
          });
        }
        if (!isReadingMode && getEditorView()) {
          // preventScroll: focusing the editor here can otherwise trigger
          // the browser's default "scroll nearest scrollable ancestor into
          // view" behavior, which can visibly jerk the whole window when
          // the file is opened from an already-scrolled context (e.g. the
          // titlebar search results dropdown).
          getEditorView().focus({ preventScroll: true });
        }
      } finally {
        setIsSwitchingFile(false);
        document.getElementById("editor-stats")?.classList.remove("hidden");
        document.getElementById("read-mode-btn")?.classList.remove("hidden");
        document.getElementById("export-btn")?.classList.remove("hidden");
      }

      const scroller = bodyElement.querySelector(".cm-scroller");
      if (scroller && titleInput.parentElement !== scroller)
        scroller.appendChild(titleInput);
      fileEditor.scrollTop = 0;

      // New file, new EditorView: rebuild the outline (also rebinds the
      // active-section scroll tracker to the freshly created scroller).
      refreshToc();
    } catch (err) {
      console.error(err);
      showToast(`Error reading file: ${err}`);
      setIsSwitchingFile(false);
    }
  });

  if (!isVirtual && !isPinnedCopy) {
    li.addEventListener("dragstart", (e) => {
      e.stopPropagation();
      if (getIsRenaming()) {
        e.preventDefault();
        return;
      }
      document
        .querySelector(".file-tree-container")
        ?.classList.add("tree-dragging");
      e.dataTransfer.setData("text/plain", node.path);
      e.dataTransfer.setData("application/x-file-tree-path", node.path);
      e.dataTransfer.effectAllowed = "move";
      li.classList.add("dragging");
    });
    li.addEventListener("dragend", (e) => {
      e.stopPropagation();
      document
        .querySelector(".file-tree-container")
        ?.classList.remove("tree-dragging");
      li.classList.remove("dragging");
      document
        .querySelectorAll(".drag-over")
        .forEach((el) => el.classList.remove("drag-over"));
      document
        .querySelector(".file-tree-container")
        ?.classList.remove("drag-over");
    });
  }

  return li;
}

export function syncTreeSelectionUI() {
  // Always clear ALL matching elements via a fresh query rather than trusting
  // a single cached reference. A file open spans multiple async steps (click
  // -> read file -> dynamic import -> editor mount), and this function gets
  // called more than once across that gap. A cached element can go stale if
  // another sync (e.g. from clicking empty space, or a second file click)
  // interleaves in between, leaving classes stuck on the wrong row. A full
  // clear is cheap and removes that whole class of races.
  document
    .querySelectorAll(".tree-item.selected, .tree-item.opened")
    .forEach((el) => el.classList.remove("selected", "opened"));
  document
    .querySelectorAll(".tree-item.focused-item")
    .forEach((el) => el.classList.remove("focused-item"));

  // A pinned file exists in the DOM twice (Pinned copy + Workspace original),
  // both sharing the same data-path. Use querySelectorAll so BOTH rows get
  // highlighted in sync, rather than querySelector's single first-match
  // (which would always resolve to whichever renders first).
  if (getCurrentOpenFile()) {
    const escapedPath = CSS.escape(getCurrentOpenFile());
    document
      .querySelectorAll(
        `.tree-item[data-path="${escapedPath}"]:not([data-virtual-root="true"])`,
      )
      .forEach((el) => el.classList.add("selected", "opened"));
  }

  if (getSelectedTreePath() && getSelectedTreePath() !== getCurrentOpenFile()) {
    const escapedPath = CSS.escape(getSelectedTreePath());
    document
      .querySelectorAll(
        `.tree-item[data-path="${escapedPath}"]:not([data-virtual-root="true"]):not(.selected)`,
      )
      .forEach((el) => el.classList.add("focused-item"));
  }
}

function initTreeContainerDrop() {
  const container = document.querySelector(".file-tree-container");
  if (!container) return;

  document
    .querySelectorAll(".drag-over")
    .forEach((el) => el.classList.remove("drag-over"));

  container.ondragover = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";

    let target = e.target.closest(
      ".tree-item:not([data-virtual-root]):not([data-pinned-copy])",
    );

    if (target && !target.classList.contains("directory")) {
      const childrenWrapper = target.closest(".tree-children");
      if (
        childrenWrapper &&
        childrenWrapper.previousElementSibling?.classList.contains("directory")
      ) {
        target = childrenWrapper.previousElementSibling;
      } else {
        target = null;
      }
    }

    const newTarget = target || container;

    if (container._currentDropTarget !== newTarget) {
      container._currentDropTarget?.classList.remove("drag-over");
      newTarget.classList.add("drag-over");
      container._currentDropTarget = newTarget;
    }
  };

  container.ondragleave = (e) => {
    const rect = container.getBoundingClientRect();
    if (
      e.clientX < rect.left ||
      e.clientX >= rect.right ||
      e.clientY < rect.top ||
      e.clientY >= rect.bottom
    ) {
      container._currentDropTarget?.classList.remove("drag-over");
      container._currentDropTarget = null;
      container.classList.remove("drag-over");
    }
  };

  container.ondrop = async (e) => {
    if (e.defaultPrevented) return;
    e.preventDefault();

    const resolvedDropTarget = container._currentDropTarget;
    resolvedDropTarget?.classList.remove("drag-over");
    container._currentDropTarget = null;
    container.classList.remove("drag-over");

    const wasInternalDrag = container.classList.contains("tree-dragging");
    const sourcePath =
      e.dataTransfer.getData("application/x-file-tree-path") ||
      e.dataTransfer.getData("text/plain");
    if (!sourcePath || sourcePath.startsWith("__VIRTUAL")) {
      if (wasInternalDrag) {
        showToast("Move failed — please try dragging again.");
      }
      return;
    }

    // Use the target dragover already resolved, rather than recomputing from
    // e.target. On fast drags, dragover fires at a throttled rate, so the
    // drop's e.target can land on an element that never got a dragover of
    // its own (e.g. between paint frames). _currentDropTarget always holds
    // the last element dragover actually highlighted, which is what the user
    // saw as the drop target — recomputing here can silently disagree with it.
    const dropTarget = resolvedDropTarget;
    let targetPath = getVaultPath();

    if (dropTarget && dropTarget !== container) {
      const dropPath = dropTarget.getAttribute("data-path");
      const isDir = dropTarget.classList.contains("directory");
      targetPath = isDir
        ? dropPath
        : dropPath.substring(0, dropPath.lastIndexOf("/")) || getVaultPath();
    }

    if (sourcePath === targetPath) return;
    if (targetPath.startsWith(sourcePath + "/")) {
      showToast("Cannot move into its own subfolder.");
      return;
    }

    const sourceParent = sourcePath.substring(0, sourcePath.lastIndexOf("/"));
    if (sourceParent === targetPath) return;

    const fileName = sourcePath.substring(sourcePath.lastIndexOf("/") + 1);
    const newPath = `${targetPath}/${fileName}`;

    try {
      // If the file being moved is the one currently open, cancel any pending
      // debounced autosave BEFORE the move. The autosave callback reads
      // getCurrentOpenFile() live (not a captured path), so as long as we
      // repoint currentOpenFile to newPath immediately after the rename
      // succeeds, any autosave that fires later will correctly target the
      // new path. We must not let a timer scheduled against the OLD path
      // fire mid-move: the backend's write_file_content has no existence
      // check, so it would silently recreate a file at the path we just
      // renamed away from.
      const isOpenFile = getCurrentOpenFile() === sourcePath;
      if (isOpenFile && getAutoSaveTimeout()) {
        clearTimeout(getAutoSaveTimeout());
        setAutoSaveTimeout(null);
      }

      await api.renameFileOrFolder({ oldPath: sourcePath, newPath });
      remapPinnedPaths(sourcePath, newPath);
      if (isOpenFile) setCurrentOpenFile(newPath);
      if (targetPath !== getVaultPath()) getExpandedFolders().add(targetPath);
      setSelectedTreePath(newPath);
      showToast("Moved successfully.");
      await refreshFileTree();
      syncTreeSelectionUI();
    } catch (err) {
      showToast(`Failed to move: ${err}`);
    }
  };
}

export function initTreeHover() {
  const container = document.querySelector(".file-tree-container");
  if (!container) return;

  let currentHovered = null;

  container.addEventListener("mouseover", (e) => {
    if (
      document
        .getElementById("sidebar-context-menu")
        ?.classList.contains("show")
    )
      return;
    if (container.classList.contains("tree-dragging")) return;
    const label = e.target.closest(".item-label");
    if (currentHovered === label) return;
    currentHovered?.classList.remove("hovered");
    currentHovered = label;
    label?.classList.add("hovered");
  });

  container.addEventListener("mouseleave", () => {
    if (
      document
        .getElementById("sidebar-context-menu")
        ?.classList.contains("show")
    )
      return;
    document
      .querySelectorAll(".item-label.hovered")
      .forEach((el) => el.classList.remove("hovered"));
    currentHovered = null;
  });
  container.addEventListener("click", (e) => {
    if (!e.target.closest(".tree-item")) {
      if (getCurrentOpenFile()) {
        setSelectedTreePath(getCurrentOpenFile());
      } else {
        setSelectedTreePath(null);
      }
      syncTreeSelectionUI();
    }
  });
}
