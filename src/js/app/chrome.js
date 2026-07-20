// js/app/chrome.js
// Everything outside the editor surface: the frameless window's titlebar and
// controls, global keyboard shortcuts, and the document-level actions
// (title rename input, welcome-screen create buttons, PDF export).
//
// Was the window/shortcut/document halves of EventBinder, plus
// UIManager.setWindowSquared.

import { showToast } from "../utils.js";
import { refreshFileTree } from "../file-tree.js";
import { handleDelete } from "../sidebar.js";
import { getVaultPath } from "../state/appState.js";
import {
  getSelectedTreePath,
  getIsRenaming,
  setSelectedTreePath,
} from "../state/treeState.js";
import {
  getCurrentOpenFile,
  setCurrentTitle,
} from "../state/editorState.js";
import {
  saveActiveFile,
  commitTitleRename,
  handleSafeQuitSequence,
  clearBackupInterval,
  saveAllUiStates,
} from "./persistence.js";
import { byId, bySelector, findTreeFileLabel } from "./dom.js";

/**
 * Corner squaring is decided in the main process and pushed over the
 * "window-squared-changed" channel: Wayland hides window position from
 * clients, so the BrowserWindow's size/maximize/fullscreen signals are the
 * only reliable inputs (see the corner-squaring block in main.js). The
 * renderer just applies the class.
 *
 * @param {boolean} squared
 */
export function setWindowSquared(squared) {
  bySelector(".window")?.classList.toggle("squared", !!squared);
}

// ─── Window chrome ────────────────────────────────────────────────────────

/**
 * Right-clicking the welcome screen (no document open) opened the editor
 * context menu with every ITEM hidden but its three .context-menu-divider
 * elements still rendered — the container's padding, border and those rules
 * are the thin horizontal sliver. Suppressing the menu outright is the fix
 * rather than also hiding the dividers: a menu with nothing actionable in it
 * shouldn't appear at all.
 *
 * Must be registered FIRST and in the CAPTURE phase: capture runs before the
 * event descends, so stopPropagation here beats any bubble-phase handler on
 * the menu's own wiring no matter which module registers it or when. The check
 * reads getCurrentOpenFile() at click time, so there's no staleness window the
 * way a polled body class would have.
 */
export function suppressEmptyContextMenu() {
  document.addEventListener(
    "contextmenu",
    (e) => {
      if (getCurrentOpenFile()) return;

      const target = e.target;
      if (!(target instanceof Element)) return;
      // The sidebar's own menu is how you create the first file, so it MUST
      // keep working while nothing is open.
      if (target.closest("#sidebar, .context-menu")) return;
      // Native input menus (cut/copy/paste) stay useful with no document.
      if (target.closest("input, textarea, [contenteditable='true']")) return;

      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );
}

function bindTitlebarDrag() {
  bySelector(".window-controls")?.addEventListener("mousedown", (e) => {
    if (
      e.target.closest(".window-btn") ||
      e.target.closest("#editor-stats") ||
      e.target.closest("#read-mode-btn")
    )
      return;

    // Tell main the drag handle is pressed so it can force rounded corners
    // for the duration (see main.js setTitlebarPressed — GNOME's own
    // drag-to-untile convention doesn't apply to a CSS app-region: drag
    // titlebar, so we approximate it from here). The OS takes over the actual
    // move after this mousedown, so mouseup must be caught on `document`
    // since it won't necessarily land back on the titlebar element.
    window.api?.titlebarPressed?.(true);

    const release = () => {
      window.api?.titlebarPressed?.(false);
      document.removeEventListener("mouseup", release);
      window.removeEventListener("blur", release);
    };
    document.addEventListener("mouseup", release);
    // Fallback: if the window loses focus mid-drag without a mouseup ever
    // reaching us, still release (main.js has the same safety net
    // independently; this just keeps the two in sync sooner).
    window.addEventListener("blur", release);
  });
}

function bindEditorStats() {
  const stats = byId("editor-stats");
  if (!stats) return;

  stats.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!e.target.closest(".stats-tooltip")) stats.classList.toggle("open");
  });

  // Outside-click close. The old version re-ran getElementById twice per click
  // anywhere in the window and did the DOM work even when the popover was
  // already closed.
  document.addEventListener("click", (e) => {
    if (!stats.classList.contains("open")) return;
    if (!stats.contains(e.target)) stats.classList.remove("open");
  });
}

function bindFocusDimming() {
  const applyFocus = (focused) =>
    document.body.classList.toggle("app-blurred", !focused);

  // Three sources for the same signal: the main-process event is the accurate
  // one (it knows about workspace switches), the DOM events cover the gap
  // before preload wiring is ready. classList.toggle with an explicit boolean
  // is idempotent, so the overlap is harmless.
  window.api?.onWindowFocusChange?.(applyFocus);
  window.addEventListener("focus", () => applyFocus(true));
  window.addEventListener("blur", () => applyFocus(false));
}

export function initWindowChrome() {
  bindTitlebarDrag();
  bindEditorStats();
  bindFocusDimming();

  // Window corner squaring (pushed from main; initial state included — main
  // re-sends on did-finish-load and preload replays the last value).
  window.api?.onWindowSquaredChange?.(setWindowSquared);

  byId("min-btn")?.addEventListener("click", () => api.windowMinimize());
  byId("quit-btn")?.addEventListener("click", handleSafeQuitSequence);

  window.addEventListener("beforeunload", () => {
    clearBackupInterval();
    saveAllUiStates();
  });
}

// ─── Keyboard shortcuts ───────────────────────────────────────────────────

const TEXT_INPUT_TAGS = new Set(["INPUT", "TEXTAREA"]);

/**
 * True when the keystroke belongs to a text field and must not be hijacked.
 *
 * @param {EventTarget} target
 * @returns {boolean}
 */
function isTextEntryTarget(target) {
  if (!(target instanceof Element)) return false;
  return (
    TEXT_INPUT_TAGS.has(target.tagName) ||
    target.isContentEditable ||
    target.closest(".cm-editor") !== null
  );
}

export function initShortcuts() {
  document.addEventListener("keydown", async (e) => {
    // Compared against both cases rather than e.key.toLowerCase(): this runs
    // on every keystroke in the app, and the old version allocated a string
    // each time just to test one character.
    if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
      e.preventDefault();
      try {
        await saveActiveFile({ showIndicator: true });
      } catch (err) {
        console.error("[Shortcuts] Save failed:", err);
        showToast("Save failed.");
      }
      return;
    }

    if (
      e.key === "Delete" &&
      getSelectedTreePath() &&
      !getIsRenaming() &&
      !isTextEntryTarget(e.target)
    ) {
      handleDelete(e, getSelectedTreePath());
    }
  });
}

// ─── Document actions ─────────────────────────────────────────────────────

const PRINT_DIALOG_DELAY_MS = 150;

function bindTitleInput() {
  const input = byId("editor-title");
  if (!input) return;

  input.addEventListener("input", (e) => setCurrentTitle(e.target.value));
  // `change` fires on blur, which the Enter handler below triggers — so both
  // routes converge on one commit rather than racing two renames.
  input.addEventListener("change", () => commitTitleRename());
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    input.blur();
  });
}

/**
 * @param {"file"|"folder"} kind
 */
async function createFromWelcome(kind) {
  const parentPath = getVaultPath();
  if (!parentPath) {
    showToast("No workspace selected. Choose one in Settings.");
    return;
  }

  try {
    const finalPath =
      kind === "file"
        ? await api.createNewFile({ parentPath, fileName: "Untitled" })
        : await api.createNewFolder({ parentPath, folderName: "Untitled" });

    showToast(
      kind === "file"
        ? "File Created in Workspace"
        : "Folder Created in Workspace",
    );
    setSelectedTreePath(finalPath);
    await refreshFileTree();

    if (kind !== "file") return;
    // Wait for the tree to paint before reaching for the new row.
    requestAnimationFrame(() => findTreeFileLabel(finalPath)?.click());
  } catch (err) {
    // Was a raw alert(), which blocks the renderer and looks nothing like the
    // rest of the app. Every other failure in this file uses a toast.
    console.error(`[Welcome] Failed to create ${kind}:`, err);
    showToast(`Failed to create ${kind}: ${err?.message || err}`);
  }
}

function bindWelcomeButtons() {
  byId("welcome-new-file-btn")?.addEventListener("click", () =>
    createFromWelcome("file"),
  );
  byId("welcome-new-folder-btn")?.addEventListener("click", () =>
    createFromWelcome("folder"),
  );
}

function bindPdfExport() {
  byId("export-btn")?.addEventListener("click", () => {
    const editor = byId("file-editor");
    if (
      !editor ||
      editor.classList.contains("hidden") ||
      !getCurrentOpenFile()
    ) {
      showToast("No active file to export.");
      return;
    }
    showToast("Opening PDF export dialog...");
    // window.print() blocks synchronously; the delay lets the toast paint.
    setTimeout(() => window.print(), PRINT_DIALOG_DELAY_MS);
  });
}

export function initDocumentActions() {
  bindTitleInput();
  bindWelcomeButtons();
  bindPdfExport();
}
