// js/editor/autosave.js
// Debounced autosave plus the explicit flush used when switching files.

import { showToast, showSaveIndicator } from "../utils.js";
import { getVaultPath } from "../state/appState.js";
import {
  getEditorView,
  getCurrentOpenFile,
  getIsSwitchingFile,
  getAutoSaveTimeout,
  setAutoSaveTimeout,
  getTriggerAutoSave,
  setTriggerAutoSave,
} from "../state/editorState.js";
import { isImageFile } from "../file-types.js";

const AUTOSAVE_DELAY_MS = 2000;

/**
 * Cancel any pending autosave.
 *
 * Callers must do this before a rename/move: the autosave callback reads
 * getCurrentOpenFile() live rather than a captured path, and the backend's
 * write_file_content has no existence check, so a timer scheduled against the
 * OLD path would silently recreate a file at the path we just renamed away
 * from.
 */
export function cancelAutoSave() {
  const pending = getAutoSaveTimeout();
  if (pending) {
    clearTimeout(pending);
    setAutoSaveTimeout(null);
  }
}

/** Write the editor's current text to `filePath`. Resolves to true on success. */
export async function writeFileNow(filePath, content) {
  const vaultPath = getVaultPath();
  if (!filePath || !vaultPath) return false;
  // Never write editor text onto an image file — it would corrupt it.
  if (isImageFile(filePath)) return false;
  await api.writeFileContent({ vaultPath, filePath, content });
  return true;
}

/**
 * Flush the file that is currently in the editor to ITS OWN path.
 *
 * Runs before any branch of the open pipeline, so no stale timer can later
 * write the editor's text into the file being switched to.
 */
export async function flushOpenFile(filePath) {
  const view = getEditorView();
  if (!filePath || !view) return;
  try {
    await writeFileNow(filePath, view.state.doc.toString());
  } catch (err) {
    console.error("Save-before-switch failed:", err);
  }
}

/**
 * Install the debounced autosave trigger once, and return it.
 * Idempotent: later calls reuse the existing trigger.
 */
export function ensureAutoSaveTrigger() {
  const existing = getTriggerAutoSave();
  if (existing) return existing;

  setAutoSaveTimeout(null);

  const trigger = () => {
    // While a file switch is in flight this is a no-op, so a timer that fires
    // during the awaits in the open pipeline cannot write to the wrong path.
    if (getIsSwitchingFile()) return;
    cancelAutoSave();
    setAutoSaveTimeout(
      setTimeout(async () => {
        setAutoSaveTimeout(null);
        const view = getEditorView();
        if (!view) return;
        try {
          const written = await writeFileNow(
            getCurrentOpenFile(),
            view.state.doc.toString(),
          );
          if (written) showSaveIndicator();
        } catch {
          showToast("Auto-save failed.");
        }
      }, AUTOSAVE_DELAY_MS),
    );
  };

  setTriggerAutoSave(trigger);
  return trigger;
}
