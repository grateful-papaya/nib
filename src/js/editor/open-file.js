// js/editor/open-file.js
// Opening a file from the sidebar: the shared switch guard, the image-viewer
// branch, and the text/markdown editor branch.

import { showToast } from "../utils.js";
import { refreshToc } from "../toc.js";
import { getVaultPath } from "../state/appState.js";
import {
  getEditorView,
  getCurrentOpenFile,
  setCurrentOpenFile,
  getIsSwitchingFile,
  setIsSwitchingFile,
  getFileScrollPositions,
  getFileCursorPositions,
  getFileReadingModeStates,
} from "../state/editorState.js";
import {
  isImageFile,
  isOpenableFile,
  baseName,
} from "../file-types.js";
import { syncTreeSelectionUI } from "../tree/view.js";
import { cancelAutoSave, flushOpenFile } from "./autosave.js";
import {
  destroyEditorView,
  loadEditorModules,
  createEditorView,
  captureViewportState,
  restoreViewportState,
} from "./session.js";
import { updateEditorStats } from "./stats.js";

const CHROME_IDS = ["editor-stats", "read-mode-btn", "export-btn"];

function setEditorChromeHidden(hidden) {
  for (const id of CHROME_IDS) {
    document.getElementById(id)?.classList.toggle("hidden", hidden);
  }
}

function applyReadingModeChrome(isReadingMode) {
  const readBtn = document.getElementById("read-mode-btn");
  if (readBtn) {
    readBtn.classList.toggle("active", isReadingMode);
    readBtn.title = isReadingMode ? "Toggle Editing Mode" : "Toggle Reading Mode";
    const img = readBtn.querySelector("img");
    if (img) {
      img.src = isReadingMode ? "assets/edit_mode.svg" : "assets/read_mode.svg";
    }
  }
  document
    .getElementById("file-editor")
    ?.classList.toggle("reading-mode", isReadingMode);
}

/** file:// style path -> the app's local-media protocol URL. */
function toLocalMediaUrl(path) {
  let safePath = path.replace(/\\/g, "/");
  if (!safePath.startsWith("/")) safePath = "/" + safePath;
  return `local-media://${encodeURI(safePath)
    .replace(/#/g, "%23")
    .replace(/\?/g, "%3F")}`;
}

function openImage(node) {
  // The previous file was already flushed by the caller; drop the stale editor
  // so nothing can write its contents onto the image.
  destroyEditorView();
  setCurrentOpenFile(node.path);
  syncTreeSelectionUI();
  refreshToc(); // outline panel shows its "Markdown only" empty state

  setEditorChromeHidden(true);
  document.getElementById("file-editor")?.classList.add("hidden");
  document.getElementById("image-viewer")?.classList.remove("hidden");

  const original = document.getElementById("viewer-image");
  if (!original) return;

  // Replace the node so any in-flight decode of the previous image is dropped
  // along with its listeners.
  const img = original.cloneNode(true);
  original.parentNode.replaceChild(img, original);
  img.alt = "";
  img.src = "";

  try {
    img.src = toLocalMediaUrl(node.path);
  } catch (err) {
    console.error("Failed to load image:", err);
    showToast("Could not load image.");
  }
}

async function openTextFile(node) {
  // Guard the whole switch: while true, the autosave trigger is a no-op, so a
  // timer firing during the awaits below cannot write to the wrong path.
  setIsSwitchingFile(true);

  try {
    const fileContent = await api.readFileContent({ filePath: node.path });

    const fileEditor = document.getElementById("file-editor");
    const titleInput = document.getElementById("editor-title");
    const bodyElement = document.getElementById("editor-body");
    if (!fileEditor || !titleInput || !bodyElement) return;

    // Remember where the user was in the outgoing file before repointing.
    captureViewportState(
      getFileScrollPositions(),
      getFileCursorPositions(),
      getCurrentOpenFile(),
    );

    setCurrentOpenFile(node.path);
    syncTreeSelectionUI();

    titleInput.value = baseName(node.name);
    document.getElementById("welcome-message")?.classList.add("hidden");
    fileEditor.classList.remove("hidden");
    document.getElementById("image-viewer")?.classList.add("hidden");

    try {
      await loadEditorModules();
    } catch {
      // loadEditorModules already logged and toasted.
      fileEditor.classList.add("hidden");
      document.getElementById("welcome-message")?.classList.remove("hidden");
      setCurrentOpenFile(null);
      syncTreeSelectionUI();
      return;
    }

    const isReadingMode = !!getFileReadingModeStates()?.[node.path];
    applyReadingModeChrome(isReadingMode);

    try {
      const view = createEditorView({
        doc: fileContent,
        filePath: node.path,
        parent: bodyElement,
      });

      restoreViewportState(view, {
        cursor: getFileCursorPositions()?.[node.path] || 0,
        scroll: getFileScrollPositions()?.[node.path] || 0,
      });

      // Run once on open so the counters are populated immediately.
      updateEditorStats(view.state, { immediate: true });
      titleInput.readOnly = isReadingMode;

      // Reading mode is applied through EditorState.readOnly /
      // EditorView.editable by setEditorView() — see the long note in
      // state/editorState.js. Nothing writes contenteditable by hand.

      if (!isReadingMode) {
        // preventScroll: focusing here can otherwise trigger the browser's
        // default "scroll nearest scrollable ancestor into view" behavior,
        // which visibly jerks the whole window when the file is opened from
        // an already-scrolled context (e.g. the titlebar search dropdown).
        view.focus({ preventScroll: true });
      }
    } finally {
      setIsSwitchingFile(false);
      setEditorChromeHidden(false);
    }

    // Adopt the title into the live scroller so it scrolls with the document.
    const scroller = bodyElement.querySelector(".cm-scroller");
    if (scroller && titleInput.parentElement !== scroller) {
      scroller.appendChild(titleInput);
    }
    fileEditor.scrollTop = 0;

    // New file, new EditorView: rebuild the outline (this also rebinds the
    // active-section scroll tracker to the freshly created scroller).
    refreshToc();
  } catch (err) {
    console.error(err);
    showToast(`Error reading file: ${err}`);
    setIsSwitchingFile(false);
  }
}

/**
 * Open a file node from the tree. Handles the universal switch guard shared by
 * both branches, then dispatches to the image or text pipeline.
 *
 * @param {{path: string, name: string}} node
 */
export async function openFileNode(node) {
  if (getIsSwitchingFile()) return;
  if (getCurrentOpenFile() === node.path) return;

  const titleInput = document.getElementById("editor-title");
  if (titleInput && document.activeElement === titleInput) titleInput.blur();

  if (!isOpenableFile(node.name)) {
    showToast("Unsupported file type.");
    return;
  }

  const fileEditor = document.getElementById("file-editor");
  if (fileEditor) void fileEditor.offsetHeight;

  // Capture the outgoing path BEFORE changing anything, so the flush below
  // targets the right file and never the one we are switching to.
  const previousOpenFile = getCurrentOpenFile();

  // UNIVERSAL switch guard: whenever the open file changes — to a text file,
  // an image, anything — kill the autosave timer and flush the previous file
  // to ITS OWN path. This runs before any branch, so no stale timer can later
  // write editor text into the new file (which previously corrupted images).
  // The flush is skipped when the previous file was itself an image, since it
  // never held editor text (writeFileNow enforces that too).
  cancelAutoSave();
  if (
    previousOpenFile &&
    previousOpenFile !== node.path &&
    !isImageFile(previousOpenFile) &&
    getVaultPath() &&
    getEditorView()
  ) {
    await flushOpenFile(previousOpenFile);
  }

  document.getElementById("welcome-message")?.classList.add("hidden");

  if (isImageFile(node.name)) {
    openImage(node);
    return;
  }
  await openTextFile(node);
}
