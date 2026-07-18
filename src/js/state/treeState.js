// js/state/treeState.js
// Owns the file-tree data and its view state: folder expansion, pins,
// selection, section collapse, and the rename-in-progress flag.
// Was: window.app.rawTreeData / expandedFolders / pinnedPaths /
//      selectedTreePath / isPinnedSectionExpanded / isVaultSectionExpanded /
//      isRenaming

function loadSet(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

let rawTreeData = null;
let selectedTreePath = null;
let isRenaming = false;
let isPinnedSectionExpanded = true;
let isVaultSectionExpanded = true;

const expandedFolders = loadSet("vault_expanded_folders");
const pinnedPaths = loadSet("vault_pinned_paths");

export const getRawTreeData = () => rawTreeData;
export function setRawTreeData(d) {
  rawTreeData = d;
}

export const getSelectedTreePath = () => selectedTreePath;
export function setSelectedTreePath(p) {
  selectedTreePath = p;
}

export const getIsRenaming = () => isRenaming;
export function setIsRenaming(v) {
  isRenaming = v;
}

export const isPinnedExpanded = () => isPinnedSectionExpanded;
export function setPinnedExpanded(v) {
  isPinnedSectionExpanded = v;
}

export const isVaultExpanded = () => isVaultSectionExpanded;
export function setVaultExpanded(v) {
  isVaultSectionExpanded = v;
}

// Live references — callers use .has()/.add()/.delete() directly.
export const getExpandedFolders = () => expandedFolders;
export const getPinnedPaths = () => pinnedPaths;

// Persistence co-located. sidebar.js currently repeats the pin-save
// JSON.stringify([...set]) pattern ~5 times; this replaces all of them.
export function persistPins() {
  localStorage.setItem("vault_pinned_paths", JSON.stringify([...pinnedPaths]));
}

// Rewrite any pinned path affected by a move/rename of oldPath -> newPath.
// Handles both the exact pin (a pinned file/folder itself moved) and pins
// nested inside a renamed/moved folder (prefix rewrite). Persists and
// returns true only if something actually changed.
export function remapPinnedPaths(oldPath, newPath) {
  let changed = false;
  const prefix = oldPath + "/";
  for (const pinnedPath of [...pinnedPaths]) {
    if (pinnedPath === oldPath) {
      pinnedPaths.delete(pinnedPath);
      pinnedPaths.add(newPath);
      changed = true;
    } else if (pinnedPath.startsWith(prefix)) {
      pinnedPaths.delete(pinnedPath);
      pinnedPaths.add(newPath + pinnedPath.slice(oldPath.length));
      changed = true;
    }
  }
  if (changed) persistPins();
  return changed;
}
export function persistExpanded() {
  localStorage.setItem(
    "vault_expanded_folders",
    JSON.stringify([...expandedFolders]),
  );
}
