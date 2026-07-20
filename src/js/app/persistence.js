// js/app/persistence.js
// Everything that flushes state out of memory: the open document to disk, and
// the UI session to localStorage.
//
// These two live together because they change together. Every caller that
// wants one wants the other in the same breath — quit saves the file then the
// session, rename writes the file then re-keys the session's scroll/cursor
// maps. Splitting them would also create a cycle, since the quit sequence
// needs the session flush and the session's rename path needs the file write.
//
// Was: EditorManager + SettingsManager.saveAllUiStates in app.js.

import { showToast, showSaveIndicator } from "../utils.js";
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
  persistScrollPositions,
  persistCursorPositions,
} from "../state/editorState.js";
import { setSelectedTreePath, persistExpanded } from "../state/treeState.js";
import { getSidebarWidth } from "../state/uiState.js";
import {
  getVaultPath,
  getCloudBackupInterval,
  setCloudBackupInterval,
} from "../state/appState.js";
import { splitPath } from "./format.js";
import { byId } from "./dom.js";

// ─── UI session ───────────────────────────────────────────────────────────

export const LAST_OPENED_FILE_KEY = "vault_last_opened_file";
// vault_sidebar_open and vault_sidebar_view are owned by sidebarViews.js,
// which writes them on every view change. This module must not also write
// them: saveAllUiStates() runs on beforeunload, so its copy of the open flag
// would land LAST and win — clobbering a correct value with one derived from
// uiState, which sidebarViews only ever pushes to one-way.
const SIDEBAR_WIDTH_KEY = "vault_sidebar_width";

/**
 * Record where the caret and viewport sit in the active document. Split out
 * because the rename path needs the same capture before it re-keys the maps.
 *
 * The original ran getEditorView()/getCurrentOpenFile() four times each and
 * re-tested the same two conditions; one read of each is enough and removes
 * the (theoretical but real) window where the view is torn down between the
 * scroll check and the cursor check.
 */
export function captureEditorPositions() {
  const view = getEditorView();
  const path = getCurrentOpenFile();
  if (!view || !path) return;

  if (view.scrollDOM) {
    getFileScrollPositions()[path] = view.scrollDOM.scrollTop;
  }
  if (view.state) {
    getFileCursorPositions()[path] = view.state.selection.main.head;
  }
}

/** Flush everything session-shaped to localStorage. Safe to call repeatedly. */
export function saveAllUiStates() {
  captureEditorPositions();

  persistScrollPositions();
  persistCursorPositions();
  persistExpanded();

  const path = getCurrentOpenFile();
  if (path) localStorage.setItem(LAST_OPENED_FILE_KEY, path);

  // Sidebar open/view: NOT written here — see the note on SIDEBAR_WIDTH_KEY.

  // Width is still ours, but only because nothing else claims it. Note that
  // setSidebarWidth() currently has no callers anywhere in the codebase, so
  // getSidebarWidth() always returns its "250px" default and this write is a
  // no-op that pins the key to that value forever. The drag handler in
  // resize.js needs to call setSidebarWidth() for this to mean anything.
  //
  // A width of 0 means "collapsed", which the view state already encodes;
  // persisting it would restore a zero-width sidebar the user can't grab.
  const width = getSidebarWidth();
  if (width && width !== "0px") localStorage.setItem(SIDEBAR_WIDTH_KEY, width);
}

// ─── Document writes ──────────────────────────────────────────────────────

/**
 * True when there is a document on screen that can actually be written.
 * Three call sites repeated this four-clause test verbatim.
 *
 * @returns {boolean}
 */
export function isEditorActive() {
  const editor = byId("file-editor");
  return Boolean(
    editor &&
      !editor.classList.contains("hidden") &&
      getCurrentOpenFile() &&
      getEditorView(),
  );
}

/**
 * Move a path's remembered scroll/cursor offsets to its new key after a
 * rename. Returns nothing; persists only the maps that actually changed.
 *
 * @param {string} oldPath
 * @param {string} newPath
 */
function remapFilePositions(oldPath, newPath) {
  const maps = [
    [getFileScrollPositions(), persistScrollPositions],
    [getFileCursorPositions(), persistCursorPositions],
  ];

  for (const [map, persist] of maps) {
    if (!map || map[oldPath] === undefined) continue;
    map[newPath] = map[oldPath];
    delete map[oldPath];
    persist();
  }
}

/**
 * Commit a pending edit of the title input by renaming the file on disk.
 * Always resolves to the path the caller should write to — the new one on
 * success, the unchanged one on no-op or failure — so callers never have to
 * branch on whether a rename happened.
 *
 * @returns {Promise<string|null>}
 */
export async function commitTitleRename() {
  const currentPath = getCurrentOpenFile();
  if (!currentPath) return null;

  const titleInput = byId("editor-title");
  const { dir, stem: oldName, ext } = splitPath(currentPath);
  const newTitle = (getCurrentTitle() || titleInput?.value || "").trim();

  const revert = () => {
    if (titleInput) titleInput.value = oldName;
    setCurrentTitle(oldName);
    return currentPath;
  };

  if (!newTitle) {
    showToast("Title cannot be empty.");
    return revert();
  }
  if (newTitle === oldName) return currentPath;

  const newPath = dir ? `${dir}/${newTitle}${ext}` : `${newTitle}${ext}`;

  try {
    await api.renameFileOrFolder({ oldPath: currentPath, newPath });
  } catch (err) {
    showToast(`Rename failed: ${err}`);
    return revert();
  }

  setSelectedTreePath(newPath);
  setCurrentOpenFile(newPath);
  localStorage.setItem(LAST_OPENED_FILE_KEY, newPath);
  remapFilePositions(currentPath, newPath);

  return newPath;
}

/**
 * The single write path for the open document. Ctrl+S, the quit sequence and
 * the pre-restore flush each had their own copy of this; they had drifted
 * (only Ctrl+S cancelled the pending autosave, only Ctrl+S showed the
 * indicator), which is exactly the kind of divergence that produces a
 * "sometimes my last keystroke is lost" report.
 *
 * Cancelling the queued autosave is now unconditional. On the quit path that
 * is a behavior change and a deliberate one: a timer firing after the final
 * write used to be able to land a second write while the backup archive was
 * already being built.
 *
 * @param {{ showIndicator?: boolean, commitRename?: boolean }} [options]
 * @returns {Promise<string|null>} the path written, or null if nothing was
 */
export async function saveActiveFile({
  showIndicator = false,
  commitRename = true,
} = {}) {
  if (!isEditorActive()) return null;

  const pending = getAutoSaveTimeout();
  if (pending) {
    clearTimeout(pending);
    setAutoSaveTimeout(null);
  }

  const filePath = commitRename
    ? await commitTitleRename()
    : getCurrentOpenFile();
  if (!filePath) return null;

  // commitTitleRename awaits IPC; the view can be torn down by a file switch
  // in that window, and reading .state off a destroyed view throws.
  const view = getEditorView();
  if (!view) return null;

  await api.writeFileContent({
    vaultPath: getVaultPath(),
    filePath,
    content: view.state.doc.toString(),
  });

  if (showIndicator) showSaveIndicator();
  return filePath;
}

/** Stop the background backup timer, if one is running. */
export function clearBackupInterval() {
  const id = getCloudBackupInterval();
  if (!id) return;
  clearInterval(id);
  setCloudBackupInterval(null);
}

/**
 * Save, persist UI state, run the quit backup, then close. Each stage is
 * independently guarded: a failure in one must not skip the ones after it,
 * because the alternative is losing the user's work to a backup error.
 */
export async function handleSafeQuitSequence() {
  clearBackupInterval();

  const vaultPath = getVaultPath();
  const quitBtn = byId("quit-btn");

  // The quit backup is local-only and incremental: 7z `u` rewrites just the
  // archive entries whose files changed, then the snapshot policy runs. Fast
  // enough that no "please wait" toast is needed — just refuse a second click.
  if (quitBtn) quitBtn.style.pointerEvents = "none";

  try {
    await saveActiveFile();
  } catch (err) {
    console.error("[Quit] Save error:", err);
  }

  saveAllUiStates();

  try {
    if (vaultPath) await api.backupOnQuit({ vaultPath });
  } catch (err) {
    console.error("[Quit] Backup error:", err);
  }

  try {
    api.windowClose();
  } catch (err) {
    console.error("[Quit] Close error:", err);
    if (quitBtn) quitBtn.style.pointerEvents = "auto";
  }
}
