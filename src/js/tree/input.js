// js/tree/input.js
// Everything that READS USER INPUT for the sidebar file tree: click, hover,
// and drag-and-drop. Depends on tree/view.js; view.js does not depend on this.
//
// WHY DELEGATION
// The original implementation attached a fresh click listener and a drag pair
// inside the row builder, i.e. three closures per row, re-created from scratch
// on every render. A 2,000-file vault meant ~6,000 listeners per refresh, each
// capturing the node, the row element and its icon, pinning the whole previous
// DOM until GC caught up — and the tree re-renders on every pin, expand,
// rename and move. Five listeners on the container do the same job for any
// tree size, and rows become plain data.

import { showToast } from "../utils.js";
import { getVaultPath } from "../state/appState.js";
import {
  getRawTreeData,
  getExpandedFolders,
  setSelectedTreePath,
  isPinnedExpanded,
  setPinnedExpanded,
  isVaultExpanded,
  setVaultExpanded,
  remapPinnedPaths,
  getIsRenaming,
} from "../state/treeState.js";
import {
  getCurrentOpenFile,
  setCurrentOpenFile,
} from "../state/editorState.js";
import {
  ICONS,
  VIRTUAL_PINNED_ROOT,
  VIRTUAL_VAULT_ROOT,
} from "../file-types.js";
import { cancelAutoSave } from "../editor/autosave.js";
import { openFileNode } from "../editor/open-file.js";
import {
  getTreeContainer,
  findNodeByPath,
  expansionKey,
  reloadTree,
  syncTreeSelectionUI,
} from "./view.js";

const PATH_MIME = "application/x-file-tree-path";

const parentOf = (path) => path.substring(0, path.lastIndexOf("/"));
const fileNameOf = (path) => path.substring(path.lastIndexOf("/") + 1);

const isVirtualPath = (path) =>
  path === VIRTUAL_VAULT_ROOT || path === VIRTUAL_PINNED_ROOT;

const contextMenuOpen = () =>
  !!document.getElementById("sidebar-context-menu")?.classList.contains("show");

// ── Click and folder toggling ───────────────────────────────────────────────

/** The .tree-children wrapper that belongs to a folder/section row. */
function childWrapperOf(row) {
  const next = row.nextElementSibling;
  return next?.classList.contains("tree-children") ? next : null;
}

function toggleSection(row, label, path) {
  const isVault = path === VIRTUAL_VAULT_ROOT;
  const expanded = isVault ? !isVaultExpanded() : !isPinnedExpanded();
  if (isVault) setVaultExpanded(expanded);
  else setPinnedExpanded(expanded);

  childWrapperOf(row)?.classList.toggle("expanded", expanded);
  label
    .querySelector(".section-arrow-icon")
    ?.classList.toggle("expanded", expanded);
  // Section headers keep a fixed icon (pin / box), so nothing else to update.
}

function toggleFolder(row, label, path) {
  const key = expansionKey(path, row.dataset.pinnedCopy === "true");
  const expandedFolders = getExpandedFolders();
  const willExpand = !expandedFolders.has(key);

  if (willExpand) expandedFolders.add(key);
  else expandedFolders.delete(key);

  childWrapperOf(row)?.classList.toggle("expanded", willExpand);
  const icon = label.querySelector(".tree-icon");
  if (icon) icon.src = willExpand ? ICONS.folderOpen : ICONS.folderClosed;
}

function onClick(event) {
  const label = event.target.closest(".item-label");

  if (!label) {
    // A click on empty space below the tree drops the focus ring back onto
    // whatever file is actually open.
    if (!event.target.closest(".tree-item")) {
      setSelectedTreePath(getCurrentOpenFile() || null);
      syncTreeSelectionUI();
    }
    return;
  }

  // Matches the old per-row handler, which called stopPropagation() so
  // document-level click handlers (context-menu dismissal and friends) never
  // saw a row click.
  event.stopPropagation();
  if (getIsRenaming()) return;

  const row = label.closest(".tree-item");
  const path = row?.dataset.path;
  if (!path) return;

  if (isVirtualPath(path)) {
    toggleSection(row, label, path);
    return;
  }

  setSelectedTreePath(path);
  syncTreeSelectionUI();

  if (row.classList.contains("directory")) {
    toggleFolder(row, label, path);
    return;
  }

  const node = findNodeByPath(getRawTreeData(), path);
  if (node) void openFileNode(node);
}

// ── Drag and drop ───────────────────────────────────────────────────────────

function clearDragOver(container) {
  container._currentDropTarget?.classList.remove("drag-over");
  container._currentDropTarget = null;
  container.classList.remove("drag-over");
}

/**
 * Resolve the folder row a pointer position should drop into. Dropping onto a
 * file targets the folder that contains it.
 */
function resolveDropRow(eventTarget) {
  const row = eventTarget.closest?.(
    ".tree-item:not([data-virtual-root]):not([data-pinned-copy])",
  );
  if (!row || row.classList.contains("directory")) return row;

  const owner = row.closest(".tree-children")?.previousElementSibling;
  return owner?.classList.contains("directory") ? owner : null;
}

async function performMove(sourcePath, targetPath) {
  if (sourcePath === targetPath) return;
  if (targetPath.startsWith(sourcePath + "/")) {
    showToast("Cannot move into its own subfolder.");
    return;
  }
  if (parentOf(sourcePath) === targetPath) return;

  const newPath = `${targetPath}/${fileNameOf(sourcePath)}`;

  try {
    // If the file being moved is the one currently open, cancel any pending
    // debounced autosave BEFORE the move. The autosave callback reads
    // getCurrentOpenFile() live (not a captured path), so repointing
    // currentOpenFile to newPath right after the rename succeeds keeps later
    // saves correct. What we must not allow is a timer scheduled against the
    // OLD path firing mid-move: the backend's write_file_content has no
    // existence check, so it would silently recreate a file at the path we
    // just renamed away from.
    const isOpenFile = getCurrentOpenFile() === sourcePath;
    if (isOpenFile) cancelAutoSave();

    await api.renameFileOrFolder({ oldPath: sourcePath, newPath });
    remapPinnedPaths(sourcePath, newPath);
    if (isOpenFile) setCurrentOpenFile(newPath);
    if (targetPath !== getVaultPath()) getExpandedFolders().add(targetPath);
    setSelectedTreePath(newPath);
    showToast("Moved successfully.");

    await reloadTree();
    syncTreeSelectionUI();
  } catch (err) {
    showToast(`Failed to move: ${err}`);
  }
}

// ── Wiring ──────────────────────────────────────────────────────────────────

let detach = null;

/**
 * Bind all tree input to the container. Safe to call repeatedly — a previous
 * binding is torn down first. Because everything is delegated, the binding
 * survives every re-render and only needs to happen once.
 *
 * @returns {() => void} detach
 */
export function initTreeInput() {
  detach?.();

  const container = getTreeContainer();
  if (!container) return () => {};

  clearDragOver(container);
  for (const el of container.querySelectorAll(".drag-over")) {
    el.classList.remove("drag-over");
  }

  let hovered = null;

  const onMouseOver = (event) => {
    if (contextMenuOpen()) return;
    if (container.classList.contains("tree-dragging")) return;
    const label = event.target.closest(".item-label");
    if (hovered === label) return;
    hovered?.classList.remove("hovered");
    hovered = label;
    label?.classList.add("hovered");
  };

  const onMouseLeave = () => {
    if (contextMenuOpen()) return;
    hovered?.classList.remove("hovered");
    hovered = null;
    // Defensive sweep: a re-render between mouseover and mouseleave can orphan
    // the class on a row we no longer hold a reference to.
    for (const el of container.querySelectorAll(".item-label.hovered")) {
      el.classList.remove("hovered");
    }
  };

  const onDragStart = (event) => {
    const row = event.target.closest?.(".tree-item[draggable='true']");
    if (!row) return;
    if (getIsRenaming()) {
      event.preventDefault();
      return;
    }
    const path = row.dataset.path;
    container.classList.add("tree-dragging");
    event.dataTransfer.setData("text/plain", path);
    event.dataTransfer.setData(PATH_MIME, path);
    event.dataTransfer.effectAllowed = "move";
    row.classList.add("dragging");
  };

  const onDragEnd = () => {
    container.classList.remove("tree-dragging");
    for (const el of container.querySelectorAll(".dragging, .drag-over")) {
      el.classList.remove("dragging", "drag-over");
    }
    clearDragOver(container);
  };

  const onDragOver = (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";

    const newTarget = resolveDropRow(event.target) || container;
    if (container._currentDropTarget === newTarget) return;
    container._currentDropTarget?.classList.remove("drag-over");
    newTarget.classList.add("drag-over");
    container._currentDropTarget = newTarget;
  };

  const onDragLeave = (event) => {
    const rect = container.getBoundingClientRect();
    const outside =
      event.clientX < rect.left ||
      event.clientX >= rect.right ||
      event.clientY < rect.top ||
      event.clientY >= rect.bottom;
    if (outside) clearDragOver(container);
  };

  const onDrop = (event) => {
    if (event.defaultPrevented) return;
    event.preventDefault();

    const dropTarget = container._currentDropTarget;
    clearDragOver(container);

    const wasInternalDrag = container.classList.contains("tree-dragging");
    const sourcePath =
      event.dataTransfer.getData(PATH_MIME) ||
      event.dataTransfer.getData("text/plain");

    if (!sourcePath || sourcePath.startsWith("__VIRTUAL")) {
      if (wasInternalDrag) showToast("Move failed — please try dragging again.");
      return;
    }

    // Use the target dragover already resolved rather than recomputing from
    // event.target. On fast drags, dragover fires at a throttled rate, so the
    // drop's target can land on an element that never got a dragover of its
    // own (e.g. between paint frames). _currentDropTarget always holds the
    // last element dragover actually highlighted, which is what the user saw
    // as the drop target — recomputing here can silently disagree with it.
    let targetPath = getVaultPath();
    if (dropTarget && dropTarget !== container) {
      const dropPath = dropTarget.dataset.path;
      targetPath = dropTarget.classList.contains("directory")
        ? dropPath
        : parentOf(dropPath) || getVaultPath();
    }

    void performMove(sourcePath, targetPath);
  };

  const listeners = [
    ["click", onClick],
    ["mouseover", onMouseOver],
    ["mouseleave", onMouseLeave],
    ["dragstart", onDragStart],
    ["dragend", onDragEnd],
    ["dragover", onDragOver],
    ["dragleave", onDragLeave],
    ["drop", onDrop],
  ];

  for (const [type, handler] of listeners) {
    container.addEventListener(type, handler);
  }

  detach = () => {
    for (const [type, handler] of listeners) {
      container.removeEventListener(type, handler);
    }
    detach = null;
  };
  return detach;
}
