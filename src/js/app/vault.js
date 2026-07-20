// js/app/vault.js
// Where the vault lives, once resolved. Persisted because the default
// location is not always usable: on Windows, Defender's Controlled Folder
// Access blocks unsigned apps from writing to Documents, and corporate policy
// or a broken OneDrive redirect can do the same. When that happens we ask the
// user for a folder ONCE and remember it, rather than silently relocating the
// vault somewhere they'd never find it.

import { showToast } from "../utils.js";
import { getVaultPath, setVaultPath } from "../state/appState.js";
import { LAST_OPENED_FILE_KEY } from "./persistence.js";

export const VAULT_PATH_KEY = "vault_path";

/**
 * Try the remembered location.
 * @returns {Promise<boolean>}
 */
async function useSavedVault() {
  const saved = localStorage.getItem(VAULT_PATH_KEY);
  if (!saved) return false;

  try {
    setVaultPath(await api.verifyVault({ path: saved }));
    return true;
  } catch (err) {
    // Don't clear the key yet — the picker may overwrite it, and if the user
    // cancels we'd rather keep pointing at their real vault (which might just
    // be on an unmounted drive) than forget where it was.
    console.warn("[Init] Saved vault unusable:", err);
    return false;
  }
}

/**
 * Try the platform default. Windows is skipped by the caller.
 * @returns {Promise<boolean>}
 */
async function useDefaultVault() {
  try {
    const path = await api.createVaultDirectory();
    if (!path) throw new Error("Vault path is empty or invalid.");
    setVaultPath(path);
    localStorage.setItem(VAULT_PATH_KEY, path);
    return true;
  } catch (err) {
    console.error("[Init] Default vault location failed:", err);
    return false;
  }
}

/**
 * Ask the user, repeatedly, until they pick something writable or cancel.
 * @returns {Promise<boolean>}
 */
async function promptForVault() {
  for (;;) {
    let picked = null;
    try {
      picked = await api.pickVaultFolder();
    } catch (err) {
      console.error("[Init] Folder picker failed:", err);
      return false;
    }
    if (!picked) {
      showToast("No folder selected. Choose one in Settings.");
      return false;
    }

    try {
      setVaultPath(await api.createVaultAt({ path: picked }));
      localStorage.setItem(VAULT_PATH_KEY, getVaultPath());
      return true;
    } catch (err) {
      console.error("[Init] Chosen folder unusable:", err);
      showToast("That folder can't be written to. Try another.");
      // Ask again.
    }
  }
}

/**
 * Resolve the vault path: saved location first, then the default, then ask.
 * @returns {Promise<boolean>} true if we ended up with a usable vault.
 */
export async function resolveVaultPath() {
  if (await useSavedVault()) return true;

  // Windows skips the default location entirely. Defender's Controlled Folder
  // Access protects Documents from unsigned apps by default, so attempting it
  // there mostly produces a confusing failure toast before the picker appears
  // anyway — and when it does succeed, the vault lands in a folder that may
  // start being blocked later. Ask up front instead.
  if (api.platform === "win32") {
    showToast("Choose where to keep your notes.");
  } else {
    if (await useDefaultVault()) return true;
    showToast("Couldn't use the default folder. Please choose one.");
  }

  return promptForVault();
}

/**
 * Let the user move the vault to a different folder. Existing notes are NOT
 * copied — this only repoints the app — so the caller should make that clear.
 * Reloads on success: nearly every module caches state derived from the vault.
 *
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
    const path = await api.createVaultAt({ path: picked });
    localStorage.setItem(VAULT_PATH_KEY, path);
    // Per-file scroll/cursor state and the last-opened file are keyed by
    // absolute path; they mean nothing under a different root.
    localStorage.removeItem(LAST_OPENED_FILE_KEY);
    location.reload();
    return true;
  } catch (err) {
    console.error("[Vault] Chosen folder unusable:", err);
    showToast("That folder can't be written to. Try another.");
    return false;
  }
}
