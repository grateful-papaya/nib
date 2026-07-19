import {
  showToast,
  applyFontFamily,
  updateDropdownValue,
  addFontDropdownOption,
  applyEditorPadding,
  showSaveIndicator,
} from "./utils.js";
import {
  refreshFileTree,
  revealInSidebar,
  findNodeByPath,
  initTreeHover,
} from "./file-tree.js";
import {
  initSidebarContextMenu,
  initSidebarAddButtons,
  handleDelete,
} from "./sidebar.js";
import { initTitlebarSearch } from "./titlebar-search.js";
import { initSidebarViews } from "./toc.js";
import { initSettingsPanel, initFontDropdown } from "./settings.js";
import { initSidebarResizer } from "./resize.js";
import { initRawSourceTooltip } from "./raw-tooltip.js";
import { initPathInfo } from "./path-info.js";
import { invalidateTagList } from "./tag-search.js";
import {
  initCustomScrollbars,
  hideAllScrollbarsInstantly,
} from "./scrollbar.js";
import {
  getSelectedTreePath,
  setSelectedTreePath,
  getIsRenaming,
  getPinnedPaths,
  getRawTreeData,
  persistExpanded,
} from "./state/treeState.js";
import {
  getVaultPath,
  setVaultPath,
  getCloudBackupInterval,
  setCloudBackupInterval,
} from "./state/appState.js";
import {
  getEditorView,
  getCurrentOpenFile,
  setCurrentOpenFile,
  getCurrentTitle,
  setCurrentTitle,
  getAutoSaveTimeout,
  setAutoSaveTimeout,
  getFileScrollPositions,
  getFileCursorPositions,
  getFileReadingModeStates,
  persistScrollPositions,
  persistCursorPositions,
} from "./state/editorState.js";
import {
  getSetting,
  setSetting,
} from "./state/settingsState.js";
import { setSettingsSliderDragging } from "./state/uiState.js";
import { saveAllSettings } from "./settingsService.js";
import {
  getSidebarOpen,
  getSidebarWidth,
  isScrollbarDragging,
} from "./state/uiState.js";

// ─── Utils ────────────────────────────────────────────────────────────────────
const Utils = {
  formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  },
  formatDate(unix) {
    if (!unix) return "Unknown";
    return new Date(unix * 1000).toLocaleString(undefined, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  },
  showToastMsg(msg) {
    showToast(msg);
  },
};

// ─── UI & Styling Manager ─────────────────────────────────────────────────────
const UIManager = {
  applyEditorFontSize(size) {
    const body = document.getElementById("editor-body");
    if (body) body.style.setProperty("--editor-font-size", `${size}px`);
  },
  applyEditorLineSpacing(spacing) {
    const body = document.getElementById("editor-body");
    if (body) body.style.setProperty("--editor-line-height", spacing);
  },
  // Sets --slider-fill to the current value's percentage across the
  // slider's min/max range, so the custom track CSS can paint the filled
  // (blue) portion up to the thumb. Falls back to 0/100 min/max like the
  // native input does when the attributes are absent.
  updateSliderFill(slider) {
    if (!slider) return;
    const min = Number(slider.min) || 0;
    const max = Number(slider.max) || 100;
    const pct = ((Number(slider.value) - min) / (max - min)) * 100;
    slider.style.setProperty("--slider-fill", `${pct}%`);
  },
  initSliderUIValues(fontSize, lineSpacing, padding) {
    const fsSlider = document.getElementById("editor-fontsize-slider");
    const fsValue = document.getElementById("editor-fontsize-value");
    const lsSlider = document.getElementById("editor-linespacing-slider");
    const lsValue = document.getElementById("editor-linespacing-value");
    const padSlider = document.getElementById("editor-padding-slider");
    const padValue = document.getElementById("editor-padding-value");

    if (fsSlider && fsValue) {
      fsSlider.value = fontSize;
      fsValue.textContent = `${fontSize}px`;
      UIManager.updateSliderFill(fsSlider);
    }
    if (lsSlider && lsValue) {
      lsSlider.value = lineSpacing;
      lsValue.textContent = lineSpacing;
      UIManager.updateSliderFill(lsSlider);
    }
    if (padSlider && padValue) {
      padSlider.value = padding;
      padValue.textContent = `${padding}%`;
      UIManager.updateSliderFill(padSlider);
    }
  },
  // Corner squaring is decided in the main process and pushed over the
  // "window-squared-changed" channel: Wayland hides window position from
  // clients, so the BrowserWindow's size/maximize/fullscreen signals are the
  // only reliable inputs (see the corner-squaring block in main.js). The
  // renderer just applies the class.
  setWindowSquared(squared) {
    document.querySelector(".window")?.classList.toggle("squared", !!squared);
  },
};

// ─── Settings & State Manager ─────────────────────────────────────────────────
const SettingsManager = {
  saveAllUiStates() {
    if (getEditorView() && getCurrentOpenFile() && getEditorView().scrollDOM) {
      getFileScrollPositions()[getCurrentOpenFile()] =
        getEditorView().scrollDOM.scrollTop;
    }
    if (getEditorView() && getCurrentOpenFile() && getEditorView().state) {
      getFileCursorPositions()[getCurrentOpenFile()] =
        getEditorView().state.selection.main.head;
    }

    persistScrollPositions();
    persistCursorPositions();

    if (getCurrentOpenFile()) {
      localStorage.setItem("vault_last_opened_file", getCurrentOpenFile());
    }

    persistExpanded();

    localStorage.setItem("vault_sidebar_open", getSidebarOpen());

    if (getSidebarWidth() && getSidebarWidth() !== "0px") {
      localStorage.setItem("vault_sidebar_width", getSidebarWidth());
    }
  },
};

// ─── Editor Logic Manager ─────────────────────────────────────────────────────
const EditorManager = {
  async commitTitleRename() {
    const titleInput = document.getElementById("editor-title");

    const currentPath = getCurrentOpenFile();
    if (!currentPath) return currentPath;

    const rawTitle = getCurrentTitle() || titleInput?.value || "";
    const newTitle = rawTitle.trim();

    const oldNameWithExt = currentPath.substring(
      currentPath.lastIndexOf("/") + 1,
    );
    const oldName = oldNameWithExt.substring(
      0,
      oldNameWithExt.lastIndexOf("."),
    );

    if (!newTitle) {
      Utils.showToastMsg("Title cannot be empty.");
      if (titleInput) titleInput.value = oldName;
      setCurrentTitle(oldName);
      return currentPath;
    }

    const parentDir = currentPath.substring(0, currentPath.lastIndexOf("/"));
    const oldExt = oldNameWithExt.includes(".")
      ? oldNameWithExt.substring(oldNameWithExt.lastIndexOf("."))
      : ".md";

    if (newTitle === oldName) return currentPath;

    const newPath = parentDir
      ? `${parentDir}/${newTitle}${oldExt}`
      : `${newTitle}${oldExt}`;
    try {
      await api.renameFileOrFolder({ oldPath: currentPath, newPath });

      setSelectedTreePath(newPath);
      setCurrentOpenFile(newPath);

      localStorage.setItem("vault_last_opened_file", newPath);

      if (
        getFileScrollPositions() &&
        getFileScrollPositions()[currentPath] !== undefined
      ) {
        getFileScrollPositions()[newPath] =
          getFileScrollPositions()[currentPath];
        delete getFileScrollPositions()[currentPath];
        persistScrollPositions();
      }
      if (
        getFileCursorPositions() &&
        getFileCursorPositions()[currentPath] !== undefined
      ) {
        getFileCursorPositions()[newPath] =
          getFileCursorPositions()[currentPath];
        delete getFileCursorPositions()[currentPath];
        persistCursorPositions();
      }
      return newPath;
    } catch (err) {
      Utils.showToastMsg(`Rename failed: ${err}`);
      if (titleInput) titleInput.value = oldName;
      setCurrentTitle(oldName);
      return currentPath;
    }
  },

  async handleSafeQuitSequence() {
    if (getCloudBackupInterval()) {
      clearInterval(getCloudBackupInterval());
      setCloudBackupInterval(null);
    }
    const fileEditor = document.getElementById("file-editor");
    const currentVault = getVaultPath();

    // The quit backup is local-only and incremental: 7z `u` rewrites just the
    // archive entries whose files changed, then the snapshot policy runs.
    // Fast enough that no "please wait" toast is needed.
    const quitBtn = document.getElementById("quit-btn");
    if (quitBtn) quitBtn.style.pointerEvents = "none";

    try {
      if (
        fileEditor &&
        !fileEditor.classList.contains("hidden") &&
        getCurrentOpenFile() &&
        getEditorView()
      ) {
        const latestPath = await this.commitTitleRename();
        const content = getEditorView().state.doc.toString();
        await api.writeFileContent({
          vaultPath: currentVault,
          filePath: latestPath,
          content,
        });
      }
    } catch (err) {
      console.error("[Quit] Save error:", err);
    }

    SettingsManager.saveAllUiStates();

    try {
      if (currentVault) await api.backupOnQuit({ vaultPath: currentVault });
    } catch (err) {
      console.error("[Quit] Backup error:", err);
    }

    try {
      api.windowClose();
    } catch (err) {
      console.error("[Quit] Close error:", err);
      if (quitBtn) quitBtn.style.pointerEvents = "auto";
    }
  },
};

// ─── Interaction & Tooltip Features ───────────────────────────────────────────
const InteractionManager = {
  initElasticScroll() {
    const bodyArea = document.getElementById("editor-body");
    if (!bodyArea) return;

    const MOUSE_MULTIPLIER = 2.5;
    const MOUSE_FRICTION = 0.12;

    let targetScrollTop = 0;
    let smoothScrollAnimId = null;

    bodyArea.addEventListener("mousedown", () => {
      if (smoothScrollAnimId !== null) {
        cancelAnimationFrame(smoothScrollAnimId);
        smoothScrollAnimId = null;
        const scroller = bodyArea.querySelector(".cm-scroller");
        if (scroller) targetScrollTop = scroller.scrollTop;
      }
    });

    bodyArea.addEventListener(
      "wheel",
      (e) => {
        if (isScrollbarDragging()) return;
        const scroller = bodyArea.querySelector(".cm-scroller");
        if (!scroller) return;

        const maxScroll = scroller.scrollHeight - scroller.clientHeight;
        const isTrackpad =
          !Number.isInteger(e.deltaY) || Math.abs(e.deltaY) < 18;

        if (isTrackpad) {
          if (smoothScrollAnimId) {
            cancelAnimationFrame(smoothScrollAnimId);
            smoothScrollAnimId = null;
          }
          return;
        }

        e.preventDefault();
        if (smoothScrollAnimId === null) targetScrollTop = scroller.scrollTop;
        targetScrollTop = Math.max(
          0,
          Math.min(maxScroll, targetScrollTop + e.deltaY * MOUSE_MULTIPLIER),
        );

        if (!smoothScrollAnimId) {
          const loop = () => {
            if (isScrollbarDragging() || !scroller.isConnected) {
              smoothScrollAnimId = null;
              return;
            }
            const diff = targetScrollTop - scroller.scrollTop;
            if (Math.abs(diff) < 0.5) {
              scroller.scrollTop = targetScrollTop;
              smoothScrollAnimId = null;
              return;
            }
            scroller.scrollTop += diff * MOUSE_FRICTION;
            smoothScrollAnimId = requestAnimationFrame(loop);
          };
          smoothScrollAnimId = requestAnimationFrame(loop);
        }
      },
      { passive: false },
    );

    bodyArea.addEventListener(
      "scroll",
      (e) => {
        const scroller = e.target.closest(".cm-scroller");
        if (!scroller) return;
        if (smoothScrollAnimId === null || isScrollbarDragging()) {
          targetScrollTop = scroller.scrollTop;
        }
      },
      true,
    );
  },

  initFileHoverTooltip() {
    const tooltip = document.getElementById("file-meta-tooltip");
    const treeContainer = document.querySelector(".file-tree-container");
    if (!tooltip) return;

    let showTimer = null;
    let activeHoveredItem = null;

    function hideTooltip() {
      clearTimeout(showTimer);
      activeHoveredItem = null;
      tooltip.classList.remove("visible");
    }

    function countContents(node) {
      let files = 0,
        folders = 0,
        totalSize = 0;
      if (!node?.children) return { files, folders, totalSize };
      const traverse = (children) => {
        for (const c of children) {
          if (c.is_dir) {
            folders++;
            if (c.children) traverse(c.children);
          } else {
            files++;
            totalSize += c.size || 0;
          }
        }
      };
      traverse(node.children);
      return { files, folders, totalSize };
    }

    function countAll(treeData) {
      let files = 0,
        folders = 0,
        totalSize = 0;
      if (!treeData) return { files, folders, totalSize };
      const traverse = (nodes) => {
        for (const n of nodes) {
          if (n.is_dir) {
            folders++;
            if (n.children) traverse(n.children);
          } else {
            files++;
            totalSize += n.size || 0;
          }
        }
      };
      traverse(treeData);
      return { files, folders, totalSize };
    }

    treeContainer?.addEventListener("scroll", hideTooltip, { passive: true });
    document.addEventListener("contextmenu", hideTooltip);

    document.addEventListener("mouseover", (e) => {
      const sidebar = document.getElementById("sidebar");
      const ctxMenu = document.getElementById("sidebar-context-menu");

      if (
        sidebar?.classList.contains("resizing") ||
        ctxMenu?.classList.contains("show")
      ) {
        hideTooltip();
        return;
      }

      const item = e.target.closest(".tree-item");
      if (!item) {
        if (activeHoveredItem) hideTooltip();
        return;
      }
      if (activeHoveredItem === item) return;

      clearTimeout(showTimer);
      tooltip.classList.remove("visible");
      activeHoveredItem = item;

      const path = item.getAttribute("data-path");
      if (!path) return;
      const isVirtual = item.getAttribute("data-virtual-root") === "true";
      const isDir = item.classList.contains("directory");
      const name = isVirtual
        ? path === "__VIRTUAL_VAULT_ROOT__"
          ? "Workspace"
          : "Pinned"
        : path.split("/").pop();

      showTimer = setTimeout(async () => {
        if (activeHoveredItem !== item) return;
        if (
          sidebar?.classList.contains("resizing") ||
          ctxMenu?.classList.contains("show")
        )
          return;

        try {
          let meta = { size: 0, created: 0, modified: 0 };
          try {
            meta = await api.getFileMeta({ filePath: path });
          } catch (_) {}

          tooltip.innerHTML = "";
          const nameDiv = document.createElement("div");
          nameDiv.className = "fmeta-name";
          nameDiv.textContent = name;
          tooltip.appendChild(nameDiv);

          let statsHtml = "";

          if (path === "__VIRTUAL_PINNED_ROOT__") {
            const pinCount = getPinnedPaths()?.size ?? 0;
            statsHtml = `<div class="fmeta-row"><span>Pinned Items</span><span>${pinCount}</span></div>`;
          } else if (path === "__VIRTUAL_VAULT_ROOT__") {
            const c = countAll(getRawTreeData());
            const size = c.totalSize > 0 ? c.totalSize : meta.size;
            statsHtml = `
                    <div class="fmeta-row"><span>Folders</span><span>${c.folders}</span></div>
                    <div class="fmeta-row"><span>Files</span><span>${c.files}</span></div>
                    <div class="fmeta-row"><span>Size</span><span>${Utils.formatBytes(size)}</span></div>`;
          } else if (isDir) {
            const node = findNodeByPath(getRawTreeData(), path); // Assumes global existance
            const c = countContents(node);
            statsHtml = `
                    <div class="fmeta-row"><span>Folders</span><span>${c.folders}</span></div>
                    <div class="fmeta-row"><span>Files</span><span>${c.files}</span></div>
                    <div class="fmeta-row"><span>Created</span><span>${Utils.formatDate(meta.created)}</span></div>
                    <div class="fmeta-row"><span>Modified</span><span>${Utils.formatDate(meta.modified)}</span></div>
                    <div class="fmeta-row"><span>Size</span><span>${Utils.formatBytes(c.totalSize)}</span></div>`;
          } else {
            statsHtml = `
                    <div class="fmeta-row"><span>Created</span><span>${Utils.formatDate(meta.created)}</span></div>
                    <div class="fmeta-row"><span>Modified</span><span>${Utils.formatDate(meta.modified)}</span></div>
                    <div class="fmeta-row"><span>Size</span><span>${Utils.formatBytes(meta.size)}</span></div>`;
          }

          tooltip.insertAdjacentHTML("beforeend", statsHtml);

          const sidebarRect = sidebar.getBoundingClientRect();
          const itemRect = item.getBoundingClientRect();
          tooltip.style.top = `${itemRect.top}px`;
          tooltip.style.left = `${sidebarRect.right + 8}px`;
          tooltip.classList.add("visible");
        } catch (err) {
          console.error("Tooltip error:", err);
        }
      }, 800);
    });
  },
};

// ─── Event Binding Manager ────────────────────────────────────────────────────
const EventBinder = {
  bindSliderDrag(sliderId, valueId, unit, applyFn, stateKey) {
    const slider = document.getElementById(sliderId);
    const valueSpan = document.getElementById(valueId);
    if (!slider) return;
    const card = slider.closest(".setting-card");
    const row = slider.closest(".setting-row");

    slider.addEventListener("input", (e) => {
      const val = e.target.value;
      if (valueSpan) valueSpan.textContent = `${val}${unit}`;
      UIManager.updateSliderFill(slider);
      if (stateKey) setSetting(stateKey, val);
      applyFn(val);
    });

    const startDrag = () => {
      document
        .getElementById("settings-view")
        ?.classList.add("dragging-slider");
      card?.classList.add("active-drag");
      row?.classList.add("active-row");
      setSettingsSliderDragging(true);
      hideAllScrollbarsInstantly();
    };
    const stopDrag = () => {
      document
        .getElementById("settings-view")
        ?.classList.remove("dragging-slider");
      card?.classList.remove("active-drag");
      row?.classList.remove("active-row");
      setSettingsSliderDragging(false);
      saveAllSettings();
    };

    slider.addEventListener("mousedown", startDrag);
    slider.addEventListener("touchstart", startDrag, { passive: true });
    slider.addEventListener("mouseup", stopDrag);
    slider.addEventListener("touchend", stopDrag);
    slider.addEventListener("mouseleave", stopDrag);
  },

  bindAllEvents() {
    // Sliders
    this.bindSliderDrag(
      "editor-fontsize-slider",
      "editor-fontsize-value",
      "px",
      UIManager.applyEditorFontSize,
      "font_size",
    );
    this.bindSliderDrag(
      "editor-linespacing-slider",
      "editor-linespacing-value",
      "",
      UIManager.applyEditorLineSpacing,
      "line_spacing",
    );
    this.bindSliderDrag(
      "editor-padding-slider",
      "editor-padding-value",
      "%",
      (val) => {
        applyEditorPadding(val);
      },
      "editor_padding",
    );

    // Titlebar drag block
    document
      .querySelector(".window-controls")
      ?.addEventListener("mousedown", (e) => {
        if (
          e.target.closest(".window-btn") ||
          e.target.closest("#editor-stats") ||
          e.target.closest("#read-mode-btn")
        )
          return;

        // Tell main the drag handle is pressed so it can force rounded
        // corners for the duration (see main.js setTitlebarPressed — GNOME's
        // own drag-to-untile convention doesn't apply to a CSS
        // app-region: drag titlebar, so we approximate it from here). The
        // OS takes over the actual move after this mousedown, so mouseup
        // must be caught on `document` since it won't necessarily land back
        // on the titlebar element.
        window.api?.titlebarPressed?.(true);
        const release = () => {
          window.api?.titlebarPressed?.(false);
          document.removeEventListener("mouseup", release);
          window.removeEventListener("blur", release);
        };
        document.addEventListener("mouseup", release);
        // Fallback: if the window itself loses focus mid-drag without a
        // mouseup ever reaching us, still release (main.js has the same
        // safety net independently, this just keeps the two in sync sooner).
        window.addEventListener("blur", release);
      });

    // Window corner squaring (pushed from main; initial state included —
    // main re-sends on did-finish-load and preload replays the last value).
    if (window.api?.onWindowSquaredChange) {
      window.api.onWindowSquaredChange(UIManager.setWindowSquared);
    }

    // Read Mode Toggle
    const readModeBtn = document.getElementById("read-mode-btn");
    readModeBtn?.addEventListener("click", () => {
      const fileEditor = document.getElementById("file-editor");
      const titleInput = document.getElementById("editor-title");
      const btnImg = readModeBtn.querySelector("img");
      if (!fileEditor || fileEditor.classList.contains("hidden")) return;

      const currentFile = getCurrentOpenFile();
      if (!currentFile) return;

      const currentMode = !!getFileReadingModeStates()[currentFile];
      const nextMode = !currentMode;

      getFileReadingModeStates()[currentFile] = nextMode;
      readModeBtn.classList.toggle("active", nextMode);
      fileEditor.classList.toggle("reading-mode", nextMode);

      if (btnImg)
        btnImg.src = nextMode ? "assets/edit_mode.svg" : "assets/read_mode.svg";
      readModeBtn.title = nextMode
        ? "Toggle Editing Mode"
        : "Toggle Reading Mode";
      if (titleInput) titleInput.readOnly = nextMode;
      if (getEditorView()?.contentDOM) {
        getEditorView().contentDOM.setAttribute(
          "contenteditable",
          nextMode ? "false" : "true",
        );
      }
      Utils.showToastMsg(
        nextMode ? "Reading Mode enabled." : "Editing Mode enabled.",
      );
    });
    // Editor Stats Popup
    const editorStats = document.getElementById("editor-stats");
    editorStats?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!e.target.closest(".stats-tooltip"))
        editorStats.classList.toggle("open");
    });
    document.addEventListener("click", (e) => {
      if (!document.getElementById("editor-stats")?.contains(e.target)) {
        document.getElementById("editor-stats")?.classList.remove("open");
      }
    });

    // Window Controls
    document
      .getElementById("min-btn")
      ?.addEventListener("click", () => api.windowMinimize());
    document
      .getElementById("quit-btn")
      ?.addEventListener("click", () => EditorManager.handleSafeQuitSequence());

    // Title Rename
    const titleInput = document.getElementById("editor-title");
    titleInput?.addEventListener("input", (e) => {
      setCurrentTitle(e.target.value);
    });
    titleInput?.addEventListener("change", async () => {
      await EditorManager.commitTitleRename();
    });
    titleInput?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        titleInput.blur();
      }
    });

    // Keyboard Shortcuts
    document.addEventListener("keydown", async (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        const fileEditor = document.getElementById("file-editor");
        const currentVault = getVaultPath();
        if (
          fileEditor &&
          !fileEditor.classList.contains("hidden") &&
          getCurrentOpenFile() &&
          getEditorView()
        ) {
          if (getAutoSaveTimeout()) {
            clearTimeout(getAutoSaveTimeout());
            setAutoSaveTimeout(null);
          }
          const latestPath = await EditorManager.commitTitleRename();
          const content = getEditorView().state.doc.toString();
          try {
            await api.writeFileContent({
              vaultPath: currentVault,
              filePath: latestPath,
              content,
            });
            showSaveIndicator();
          } catch {
            Utils.showToastMsg("Save failed.");
          }
        }
        return;
      }
      if (
        e.key === "Delete" &&
        getSelectedTreePath() &&
        !getIsRenaming() &&
        !["INPUT", "TEXTAREA"].includes(e.target.tagName) &&
        !e.target.isContentEditable &&
        !e.target.closest(".cm-editor")
      ) {
        handleDelete(e, getSelectedTreePath());
      }
    });

    // Sidebar toggle moved to toc.js (initSidebarViews): the menu button now
    // cycles closed → tree → outline → closed (reverse on right-click), and
    // hover shows a quick-switch popup. Bound in DOMContentLoaded below.

    // Welcome Screen
    document
      .getElementById("welcome-new-file-btn")
      ?.addEventListener("click", async () => {
        try {
          const finalPath = await api.createNewFile({
            parentPath: getVaultPath(),
            fileName: "Untitled",
          });
          Utils.showToastMsg("File Created in Workspace");
          setSelectedTreePath(finalPath);
          await refreshFileTree();
          requestAnimationFrame(() => {
            document
              .querySelector(
                `.tree-item.file[data-path="${finalPath}"] .item-label`,
              )
              ?.click();
          });
        } catch (err) {
          alert(`Failed to create file: ${err}`);
        }
      });
    document
      .getElementById("welcome-new-folder-btn")
      ?.addEventListener("click", async () => {
        try {
          const finalPath = await api.createNewFolder({
            parentPath: getVaultPath(),
            folderName: "Untitled",
          });
          Utils.showToastMsg("Folder Created in Workspace");
          setSelectedTreePath(finalPath);
          await refreshFileTree();
        } catch (err) {
          alert(`Failed to create folder: ${err}`);
        }
      });

    // PDF Export
    document.getElementById("export-btn")?.addEventListener("click", () => {
      const fileEditor = document.getElementById("file-editor");
      if (
        !fileEditor ||
        fileEditor.classList.contains("hidden") ||
        !getCurrentOpenFile()
      ) {
        Utils.showToastMsg("No active file to export.");
        return;
      }
      Utils.showToastMsg("Opening PDF export dialog...");
      setTimeout(() => window.print(), 150);
    });

    // Settings Close
    document
      .querySelector(".settings-close-btn")
      ?.addEventListener("click", () => {
        document.getElementById("settings-view")?.classList.remove("visible");
        document.querySelector(".window")?.classList.remove("settings-active");
        saveAllSettings();
      });

    // Backup Panel
    // (The separate "mirror the archive to another folder" feature is gone:
    // the snapshot policy below IS the local backup. One mechanism, one card.)

    // ── Restore tab ──────────────────────────────────────────────────────
    // Lists .backup/snapshots/ newest-first and restores the chosen one.
    // Confirmation is two-click-in-place (the button arms itself) rather than
    // a modal: destructive, but always undoable -- lib.rs snapshots the
    // current state before touching anything.

    // vault_2026-07-14_183012.7z -> "2026-07-14 18:30" (quit mode)
    // vault_2026-07-14.7z        -> "2026-07-14 · end of day" (daily mode)
    const formatSnapshotName = (name) => {
      const m = name.match(
        /^vault_(\d{4}-\d{2}-\d{2})(?:_(\d{2})(\d{2})\d{2})?\.7z$/,
      );
      if (!m) return name; // unexpected file: show as-is rather than hide it
      return m[2] ? `${m[1]} ${m[2]}:${m[3]}` : `${m[1]} · end of day`;
    };

    const formatSize = (bytes) => {
      if (bytes >= 1024 * 1024)
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
      return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    };

    const populateRestoreList = async () => {
      const list = document.getElementById("restore-list");
      if (!list) return;
      list.innerHTML = "";

      let snaps = [];
      try {
        snaps = await api.listBackupSnapshots({ vaultPath: getVaultPath() });
      } catch (e) {
        console.error("[Restore] list failed:", e?.message || e);
      }

      if (!snaps.length) {
        const li = document.createElement("li");
        li.className = "restore-empty";
        li.textContent =
          "No snapshots yet — quit the app once to create the first one.";
        list.appendChild(li);
        return;
      }

      for (const s of snaps) {
        const li = document.createElement("li");
        li.className = "restore-item";

        const info = document.createElement("div");
        info.className = "restore-item-info";
        const title = document.createElement("span");
        title.className = "restore-item-title";
        title.textContent = formatSnapshotName(s.name);
        const meta = document.createElement("span");
        meta.className = "restore-item-meta";
        meta.textContent = formatSize(s.size);
        info.appendChild(title);
        info.appendChild(meta);

        const btn = document.createElement("button");
        btn.className = "restore-item-btn";
        btn.textContent = "Restore";

        // Two-click confirm: first click arms, second within 4s fires.
        let armTimer = null;
        btn.addEventListener("click", async () => {
          if (!btn.classList.contains("armed")) {
            btn.classList.add("armed");
            btn.textContent = "Confirm restore";
            armTimer = setTimeout(() => {
              btn.classList.remove("armed");
              btn.textContent = "Restore";
            }, 4000);
            return;
          }
          clearTimeout(armTimer);
          btn.disabled = true;
          btn.textContent = "Restoring…";
          list
            .querySelectorAll(".restore-item-btn")
            .forEach((b) => (b.disabled = true));

          try {
            // Flush the open editor buffer first: it is part of the "current
            // state" the safety snapshot should capture, and after the swap
            // an autosave of the stale buffer would clobber a restored file.
            if (getCurrentOpenFile() && getEditorView()) {
              await api.writeFileContent({
                vaultPath: getVaultPath(),
                filePath: getCurrentOpenFile(),
                content: getEditorView().state.doc.toString(),
              });
            }
            await api.restoreSnapshot({
              vaultPath: getVaultPath(),
              snapshotPath: s.path,
            });
            // Everything on screen (tree, tabs, editor, pins) describes the
            // pre-restore vault; a full reload rebuilds it all from disk.
            location.reload();
          } catch (e) {
            console.error("[Restore] failed:", e?.message || e);
            Utils.showToastMsg(
              "Restore failed: " + (e?.message || "unknown error"),
            );
            list
              .querySelectorAll(".restore-item-btn")
              .forEach((b) => (b.disabled = false));
            btn.classList.remove("armed");
            btn.textContent = "Restore";
          }
        });

        li.appendChild(info);
        li.appendChild(btn);
        list.appendChild(li);
      }
    };

    // Refresh the list each time the Backup tab is opened -- a quit-created
    // snapshot from a previous session should appear without restarting the
    // settings panel. (Restore now lives inside that tab, under Backup.)
    document
      .querySelector('.settings-menu li[data-target="panel-backup"]')
      ?.addEventListener("click", populateRestoreList);

    // ── Backup snapshot policy ───────────────────────────────────────────
    // Two settings drive .backup/snapshots/ retention (see lib.rs):
    //   backup_snapshot_mode: "quit" (new snapshot per quit)
    //                       | "daily" (one per day, last quit of the day wins)
    //   backup_snapshot_keep: how many to retain; 0 disables snapshots
    //
    // Mode is a two-option segmented control (#snapshot-mode-segment). The
    // thumb position is pure CSS keyed off the container's data-value, so the
    // handler only has to flip state -- no open/close or outside-click
    // plumbing like the dropdown this replaced.

    document
      .getElementById("snapshot-mode-segment")
      ?.addEventListener("click", (e) => {
        const btn = e.target.closest(".segment-option");
        if (!btn || btn.classList.contains("active")) return;
        const val = btn.getAttribute("data-value");
        setSnapshotModeUI(val);
        setSetting("backup_snapshot_mode", val);
        saveAllSettings();
      });

    document
      .getElementById("snapshot-keep-input")
      ?.addEventListener("change", (e) => {
        const v = Math.max(0, parseInt(e.target.value, 10) || 0);
        e.target.value = v;
        setSetting("backup_snapshot_keep", v);
        saveAllSettings();
      });

    // Links Handling
    window.app.openExternalLink = (url) => {
      if (!url || !/^https?:\/\//i.test(url)) return;
      try {
        api.openExternalUrl({ url });
      } catch (err) {
        console.error("Failed to open external link:", err);
      }
    };

    window.app.openInternalLink = (rawPath) => {
      const vault = getVaultPath();
      if (!vault) return;
      let rel = rawPath.split(/[?#]/)[0];
      try {
        rel = decodeURIComponent(rel);
      } catch (_) {}
      if (!rel) return;

      let baseDir;
      if (rel.startsWith("/")) {
        baseDir = vault;
        rel = rel.replace(/^\/+/, "");
      } else {
        const cur = getCurrentOpenFile();
        baseDir =
          cur && cur.includes("/") ? cur.slice(0, cur.lastIndexOf("/")) : vault;
      }

      const parts = baseDir.split("/");
      for (const seg of rel.split("/")) {
        if (seg === "" || seg === ".") continue;
        if (seg === "..") {
          if (parts.length > 0) parts.pop();
        } else {
          parts.push(seg);
        }
      }
      let target = parts.join("/");

      if (target !== vault && !target.startsWith(vault + "/")) {
        Utils.showToastMsg("Link points outside the workspace.");
        return;
      }
      if (!/\.[^/]+$/.test(target)) target += ".md";

      revealInSidebar(target);
      const row = document.querySelector(
        `.tree-item.file[data-path="${CSS.escape(target)}"]:not([data-pinned-copy]) .item-label`,
      );
      if (row) row.click();
      else Utils.showToastMsg("Linked file not found.");
    };

    document.addEventListener("click", async (e) => {
      const link = e.target.closest("a");
      if (link && link.href && link.href.startsWith("http")) {
        e.preventDefault();
        try {
          await api.openExternalUrl({ url: link.href });
        } catch (err) {
          console.error("Failed to open external link:", err);
        }
      }
    });

    window.addEventListener("beforeunload", () => {
      if (getCloudBackupInterval()) {
        clearInterval(getCloudBackupInterval());
        setCloudBackupInterval(null);
      }
      SettingsManager.saveAllUiStates();
    });

    // Focus/Blur
    const setBlurred = (blurred) =>
      document.body.classList.toggle("app-blurred", blurred);
    const applyFocus = (focused) => setBlurred(!focused);
    if (window.api?.onWindowFocusChange) {
      window.api.onWindowFocusChange(applyFocus);
    }
    window.addEventListener("blur", () => applyFocus(false));
    window.addEventListener("focus", () => applyFocus(true));
  },
};

// ─── Vault location ───────────────────────────────────────────────────────────
// Where the vault lives, once resolved. Persisted because the default location
// is not always usable: on Windows, Defender's Controlled Folder Access blocks
// unsigned apps from writing to Documents, and corporate policy or a broken
// OneDrive redirect can do the same. When that happens we ask the user for a
// folder ONCE and remember it, rather than silently relocating the vault
// somewhere they'd never find it.
export const VAULT_PATH_KEY = "vault_path";

/**
 * Resolve the vault path: saved location first, then the default, then ask.
 * @returns {Promise<boolean>} true if we ended up with a usable vault.
 */
export async function resolveVaultPath() {
  const saved = localStorage.getItem(VAULT_PATH_KEY);
  if (saved) {
    try {
      setVaultPath(await api.verifyVault({ path: saved }));
      return true;
    } catch (err) {
      // Don't clear the key yet -- the picker below may overwrite it, and if
      // the user cancels we'd rather keep pointing at their real vault (which
      // might just be on an unmounted drive) than forget where it was.
      console.warn("[Init] Saved vault unusable:", err);
    }
  }

  // Windows skips the default location entirely. Defender's Controlled Folder
  // Access protects Documents from unsigned apps by default, so attempting it
  // there mostly produces a confusing failure toast before the picker appears
  // anyway -- and when it does succeed, the vault lands in a folder that may
  // start being blocked later. Ask up front instead.
  if (api.platform !== "win32") {
    try {
      const p = await api.createVaultDirectory();
      if (!p) throw new Error("Vault path is empty or invalid.");
      setVaultPath(p);
      localStorage.setItem(VAULT_PATH_KEY, p);
      return true;
    } catch (err) {
      console.error("[Init] Default vault location failed:", err);
    }
    Utils.showToastMsg("Couldn't use the default folder. Please choose one.");
  } else {
    Utils.showToastMsg("Choose where to keep your notes.");
  }

  for (;;) {
    let picked = null;
    try {
      picked = await api.pickVaultFolder();
    } catch (err) {
      console.error("[Init] Folder picker failed:", err);
      return false;
    }
    if (!picked) {
      Utils.showToastMsg("No folder selected. Choose one in Settings.");
      return false;
    }
    try {
      setVaultPath(await api.createVaultAt({ path: picked }));
      localStorage.setItem(VAULT_PATH_KEY, getVaultPath());
      return true;
    } catch (err) {
      console.error("[Init] Chosen folder unusable:", err);
      Utils.showToastMsg("That folder can't be written to. Try another.");
      // Ask again.
    }
  }
}

/**
 * Let the user move the vault to a different folder. Existing notes are NOT
 * copied -- this only repoints the app -- so the caller should make that clear.
 * Reloads on success: nearly every module caches state derived from the vault.
 * @returns {Promise<boolean>} true if the vault was changed.
 */
export async function changeVaultLocation() {
  let picked = null;
  try {
    picked = await api.pickVaultFolder();
  } catch (err) {
    console.error("[Vault] Folder picker failed:", err);
    return false;
  }
  if (!picked) return false;

  try {
    const p = await api.createVaultAt({ path: picked });
    localStorage.setItem(VAULT_PATH_KEY, p);
    // Per-file scroll/cursor state and the last-opened file are keyed by
    // absolute path; they mean nothing under a different root.
    localStorage.removeItem("vault_last_opened_file");
    location.reload();
    return true;
  } catch (err) {
    console.error("[Vault] Chosen folder unusable:", err);
    Utils.showToastMsg("That folder can't be written to. Try another.");
    return false;
  }
}

// ─── App Initialization ───────────────────────────────────────────────────────
// Sync the snapshot-mode segmented control to a mode value ("quit" | "daily").
// Shared by the click handler in EventBinder.bindAllEvents() and the settings
// load in initApp(). Setting data-value on the container is what moves the
// thumb (settings.css keys the translateX off it); the .active classes drive
// the label dim/scale styling.
function setSnapshotModeUI(mode) {
  const segment = document.getElementById("snapshot-mode-segment");
  if (!segment) return;
  segment.setAttribute("data-value", mode);
  segment.querySelectorAll(".segment-option").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-value") === mode);
  });
}

async function initApp(dropdownList, dropdownSelected) {
  let savedFont = "pretendard";
  let savedPadding = "12";
  let savedFontSize = "16";
  let savedLineSpacing = "1.6";

  // Note: no early return when this fails. The vault is only one of the things
  // initApp sets up -- bailing here would also skip the font, padding, and
  // scrollbar setup below, leaving a half-rendered window. Better to show an
  // empty but correct UI and let the user fix the folder from Settings.
  const vaultOk = await resolveVaultPath();

  try {
    if (vaultOk && window.api?.startVaultWatcher)
      window.api.startVaultWatcher(getVaultPath());

    const settings = vaultOk
      ? await api.loadSettings({ vaultPath: getVaultPath() })
      : {};

    setSetting("font_size", settings.font_size || "16");
    setSetting("editor_padding", settings.editor_padding || "12");
    setSetting("line_spacing", settings.line_spacing || "1.6");

    savedFont = settings.font_family || "pretendard";
    setSetting("font_family", savedFont);
    savedPadding = getSetting("editor_padding");
    savedFontSize = getSetting("font_size");
    savedLineSpacing = getSetting("line_spacing");

    // Sidebar open/width/view restore moved to toc.js initSidebarViews(),
    // which runs BEFORE initApp so the restored state (including which panel
    // is on top) is applied with transitions suppressed prior to first paint.

    if (vaultOk) await refreshFileTree();

    const lastOpenedFile = vaultOk
      ? localStorage.getItem("vault_last_opened_file")
      : null;
    if (lastOpenedFile) {
      requestAnimationFrame(() => {
        const fileNode = document.querySelector(
          `.tree-item.file[data-path="${lastOpenedFile}"] .item-label`,
        );
        if (fileNode) fileNode.click();
      });
    }

    // Snapshot policy -> state AND UI. The state write is not optional:
    // saveAllSettings() reads from settingsState, and until these keys hold
    // real values any unrelated save (font change, slider drag) would export
    // stale defaults for them.
    // "days" is the retired interval mode; treat it as "daily" on the way in.
    let snapMode = settings.backup_snapshot_mode || "quit";
    if (snapMode === "days") snapMode = "daily";
    setSetting("backup_snapshot_mode", snapMode);
    setSetting("backup_snapshot_keep", settings.backup_snapshot_keep ?? 5);

    setSnapshotModeUI(snapMode);

    const snapKeepEl = document.getElementById("snapshot-keep-input");
    if (snapKeepEl) snapKeepEl.value = settings.backup_snapshot_keep ?? 5;
  } catch (err) {
    console.error("[Init] Load failed:", err);
  }

  if (savedFont !== "pretendard" && savedFont !== "system") {
    addFontDropdownOption(savedFont, dropdownList);
  }
  updateDropdownValue(savedFont, dropdownSelected);
  applyFontFamily(savedFont);
  applyEditorPadding(savedPadding);

  UIManager.applyEditorFontSize(savedFontSize);
  UIManager.applyEditorLineSpacing(savedLineSpacing);
  UIManager.initSliderUIValues(savedFontSize, savedLineSpacing, savedPadding);

  initCustomScrollbars();
}

// ─── DOMContentLoaded Trigger ─────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", async () => {
  window.focus();

  // Right-clicking the welcome screen (no document open) opened the editor
  // context menu with every ITEM hidden but its three .context-menu-divider
  // elements still rendered — the container's padding, border and those rules
  // are the thin horizontal sliver. Suppressing the menu outright is the fix
  // rather than also hiding the dividers: a menu with nothing actionable in it
  // shouldn't appear at all.
  //
  // Registered first, in the CAPTURE phase: capture runs before the event
  // descends, so stopPropagation here beats any bubble-phase handler on the
  // menu's own wiring no matter which module registers it or when. The check
  // reads getCurrentOpenFile() at click time, so there's no staleness window
  // the way a polled body class would have.
  //
  // Scoped away from the sidebar deliberately — its context menu is how you
  // create the first file, so it MUST keep working while nothing is open.
  document.addEventListener(
    "contextmenu",
    (e) => {
      if (getCurrentOpenFile()) return;
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (t.closest("#sidebar, .context-menu")) return;
      // Native input menus (cut/copy/paste) stay useful even with no document.
      if (t.closest("input, textarea, [contenteditable='true']")) return;
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );
  const dropdown = document.getElementById("font-dropdown");
  const dropdownSelected = document.getElementById("dropdown-selected-val");
  const dropdownList = dropdown?.querySelector(".dropdown-list") ?? null;

  // Before initApp: restores the saved sidebar state (open/closed, width,
  // and which panel — tree or outline — is on top) without animation, and
  // binds the menu button's cycle/right-click/hover-popup behavior.
  initSidebarViews();

  await initApp(dropdownList, dropdownSelected);

  // Global function initializers
  initSidebarContextMenu();
  initSidebarAddButtons();
  initTreeHover();
  initTitlebarSearch();
  // After initTitlebarSearch: the info popover hands tag queries to the search
  // bar via a window event, and the bar has to be listening before a click can
  // reach it.
  initPathInfo();
  await initSettingsPanel();
  initFontDropdown(dropdownList, dropdownSelected);
  initSidebarResizer();

  InteractionManager.initElasticScroll();
  InteractionManager.initFileHoverTooltip();
  initRawSourceTooltip();
  EventBinder.bindAllEvents();

  // Vault-change watcher (moved here from electron-api.js so that file is a leaf).
  window.api.onVaultChange(() => {
    refreshFileTree();
    // External edits (git pull, another editor, a sync client) can add or
    // remove tags. Dropping the cached tag list makes the next autocomplete
    // re-fetch; the Rust index behind it is incremental, so this only reparses
    // the files whose mtime actually moved.
    invalidateTagList();
  });
});
