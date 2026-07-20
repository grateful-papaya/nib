// js/tree/view.js
// Everything that PUTS PIXELS ON SCREEN for the sidebar file tree: building
// the DOM, painting selection state, and revealing/scrolling a row.
//
// This module never attaches an event listener and never reads a pointer
// event. Input lives in tree/input.js, which imports from here. The dependency
// runs one way only — view knows nothing about input — which is what keeps the
// two files honest about the split.

import {
  getRawTreeData,
  setRawTreeData,
  getExpandedFolders,
  getSelectedTreePath,
  setSelectedTreePath,
  getPinnedPaths,
  isPinnedExpanded,
  isVaultExpanded,
  setVaultExpanded,
} from "../state/treeState.js";
import { getVaultPath } from "../state/appState.js";
import { getCurrentOpenFile } from "../state/editorState.js";
import {
  ICONS,
  VIRTUAL_PINNED_ROOT,
  VIRTUAL_VAULT_ROOT,
  getTreeNodeIcon,
} from "../file-types.js";

export const TREE_CONTAINER_SELECTOR = ".file-tree-container";

/** Indent geometry, kept in one place so the guide line can't drift. */
const INDENT_PX = 14;
const BASE_PAD_PX = 6;
const GUIDE_OFFSET_PX = 5;

export const getTreeContainer = () =>
  document.querySelector(TREE_CONTAINER_SELECTOR);

// ── Tree data lookups ───────────────────────────────────────────────────────

/**
 * A pinned shortcut and the Workspace original are two DOM rows for the same
 * path, and they expand/collapse independently, so their expansion state is
 * keyed separately.
 */
export const expansionKey = (path, isPinnedCopy) =>
  isPinnedCopy ? `${path}__PINNED__` : path;

export const isRowExpanded = (path, isPinnedCopy) =>
  getExpandedFolders().has(expansionKey(path, isPinnedCopy));

/**
 * Recursively find a node by its path within a tree.
 * @param {Array|null} nodes
 * @param {string} path
 * @returns {object|null}
 */
export function findNodeByPath(nodes, path) {
  if (!nodes) return null;
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.children) {
      const found = findNodeByPath(node.children, path);
      if (found) return found;
    }
  }
  return null;
}

// ── Rendering ───────────────────────────────────────────────────────────────

// One string, assigned once, instead of six separate style-property writes per
// row (each of which invalidates the element's inline style declaration).
// Only padding-left varies, so it is appended per row.
const LABEL_BASE_CSS =
  "padding-right:10px;width:100%;display:inline-flex;" +
  "align-items:center;box-sizing:border-box;padding-left:";

/**
 * Build a single row. `isVirtual` marks the two section headers (Pinned /
 * Workspace), which are not real filesystem entries.
 */
function makeItem(node, depth, isVirtual, isPinnedCopy) {
  const row = document.createElement("div");
  row.className = node.is_dir ? "tree-item directory" : "tree-item file";
  row.dataset.path = node.path;
  if (isVirtual) row.dataset.virtualRoot = "true";
  if (isPinnedCopy) row.dataset.pinnedCopy = "true";
  if (!isVirtual && !isPinnedCopy) row.draggable = true;

  if (!isVirtual) {
    if (getCurrentOpenFile() === node.path) {
      row.classList.add("selected", "opened");
    } else if (getSelectedTreePath() === node.path) {
      row.classList.add("focused-item");
    }
  }

  const label = document.createElement("span");
  label.className = "item-label";
  label.style.cssText =
    LABEL_BASE_CSS + (BASE_PAD_PX + depth * INDENT_PX) + "px";

  const icon = document.createElement("img");
  icon.className = "tree-icon";
  icon.src = getTreeNodeIcon(node, isRowExpanded(node.path, isPinnedCopy));
  icon.alt = node.is_dir ? "folder" : "file";
  if (node.path === VIRTUAL_PINNED_ROOT) {
    icon.style.cssText = "width:13px;height:13px";
  }
  label.appendChild(icon);

  const text = document.createElement("span");
  text.className = "item-text";
  text.textContent = node.name;
  label.appendChild(text);

  if (isVirtual) {
    const arrow = document.createElement("img");
    arrow.className = "section-arrow-icon";
    arrow.src = ICONS.arrowDown;
    const expanded =
      node.path === VIRTUAL_VAULT_ROOT ? isVaultExpanded() : isPinnedExpanded();
    if (expanded) arrow.classList.add("expanded");
    label.appendChild(arrow);
  }

  row.appendChild(label);
  return row;
}

function buildSubTree(parent, node, depth, isPinnedCopy) {
  parent.appendChild(makeItem(node, depth, false, isPinnedCopy));

  if (!node.is_dir || !node.children) return;

  const wrapper = document.createElement("div");
  wrapper.className = "tree-children";
  if (isRowExpanded(node.path, isPinnedCopy)) wrapper.classList.add("expanded");

  const inner = document.createElement("div");
  inner.className = "tree-children-inner";
  // Vertical guide line, aligned under the parent folder's icon.
  inner.style.setProperty(
    "--guide-x",
    `${BASE_PAD_PX + depth * INDENT_PX + GUIDE_OFFSET_PX}px`,
  );

  for (const child of node.children) {
    buildSubTree(inner, child, depth + 1, isPinnedCopy);
  }

  wrapper.appendChild(inner);
  parent.appendChild(wrapper);
}

function buildSection(fragment, header, expanded, fill) {
  fragment.appendChild(header);

  const wrapper = document.createElement("div");
  wrapper.className = "tree-children";
  if (expanded) wrapper.classList.add("expanded");

  const inner = document.createElement("div");
  inner.className = "tree-children-inner tree-children-root";
  fill(inner);

  wrapper.appendChild(inner);
  fragment.appendChild(wrapper);
}

/**
 * Re-render the whole tree.
 *
 * Everything is assembled in a DocumentFragment and swapped in with a single
 * replaceChildren(). The old code cleared innerHTML and then appended each
 * section directly to the live container, so a large vault paid for layout
 * work against a half-built, on-screen tree.
 */
export function renderTree() {
  const container = getTreeContainer();
  const treeData = getRawTreeData();
  if (!container || !treeData) return;

  const fragment = document.createDocumentFragment();
  const pinned = getPinnedPaths();

  if (pinned.size > 0) {
    buildSection(
      fragment,
      makeItem(
        { name: "Pinned", path: VIRTUAL_PINNED_ROOT, is_dir: true },
        0,
        true,
        false,
      ),
      isPinnedExpanded(),
      (inner) => {
        // Reverse so the most recently pinned entry sits on top.
        for (const path of [...pinned].reverse()) {
          const node = findNodeByPath(treeData, path);
          if (node) buildSubTree(inner, node, 0, true);
        }
      },
    );
  }

  buildSection(
    fragment,
    makeItem(
      { name: "Workspace", path: VIRTUAL_VAULT_ROOT, is_dir: true },
      0,
      true,
      false,
    ),
    isVaultExpanded(),
    // Workspace direct children start at depth 0 — the virtual header should
    // not cost a level. Nested folders still cascade normally.
    (inner) => {
      for (const node of treeData) buildSubTree(inner, node, 0, false);
    },
  );

  container.replaceChildren(fragment);
}

/**
 * Re-read the vault from disk and repaint.
 *
 * This lives here rather than in file-tree.js so that input.js can trigger a
 * refresh after a drag-move without importing the barrel — which is exactly
 * the import cycle the earlier split had to paper over with a dynamic import.
 */
export async function reloadTree() {
  const vaultPath = getVaultPath();
  if (!vaultPath) return;
  try {
    setRawTreeData(await api.getFileTree({ vaultPath }));
    renderTree();
  } catch (err) {
    console.error("[Vault] Failed to refresh file tree:", err);
  }
}

// ── Selection painting ──────────────────────────────────────────────────────

const SELECTION_CLASSES = ["selected", "opened", "focused-item"];

/**
 * Repaint selection classes across the tree.
 *
 * Always clears via a fresh query rather than trusting a cached reference. A
 * file open spans several async steps (click -> read file -> dynamic import ->
 * editor mount) and this runs more than once across that gap; a cached element
 * can go stale if another sync interleaves, leaving classes stuck on the wrong
 * row. A full clear is cheap and removes that whole class of races.
 *
 * Queries are scoped to the tree container — rows never exist outside it, and
 * a document-wide querySelectorAll walks the entire editor DOM for nothing.
 */
export function syncTreeSelectionUI() {
  const container = getTreeContainer();
  if (!container) return;

  // One pass instead of two separate queries; removing a class the element
  // doesn't have is a no-op.
  for (const el of container.querySelectorAll(
    ".tree-item.selected, .tree-item.opened, .tree-item.focused-item",
  )) {
    el.classList.remove(...SELECTION_CLASSES);
  }

  const openFile = getCurrentOpenFile();
  if (openFile) {
    // A pinned file exists in the DOM twice (Pinned copy + Workspace
    // original), both sharing the same data-path, so querySelectorAll keeps
    // BOTH rows in sync rather than only whichever renders first.
    for (const el of container.querySelectorAll(
      `.tree-item[data-path="${CSS.escape(openFile)}"]:not([data-virtual-root])`,
    )) {
      el.classList.add("selected", "opened");
    }
  }

  const selected = getSelectedTreePath();
  if (selected && selected !== openFile) {
    for (const el of container.querySelectorAll(
      `.tree-item[data-path="${CSS.escape(selected)}"]:not([data-virtual-root]):not(.selected)`,
    )) {
      el.classList.add("focused-item");
    }
  }
}

// ── Reveal ──────────────────────────────────────────────────────────────────

/**
 * Center a tree row inside the sidebar's OWN scroller, and nothing else.
 *
 * element.scrollIntoView() walks the entire ancestor chain and scrolls every
 * scroll container it finds — and overflow:hidden boxes ARE scroll containers
 * (their scrollbars are hidden, but they remain programmatically scrollable).
 * .app-container, .window, <body> and <html> are all overflow:hidden here, and
 * .window has ~10px of scrollable overflow because #apply-toast rests at
 * bottom:-10px inside it. So block:"center" nudged .window.scrollTop by up to
 * that 10px, shifting the titlebar/sidebar/editor up permanently — nothing
 * ever resets that scrollTop and the hidden scrollbar gives the user no way
 * to. Same class of bug as CodeMirror's built-in scrollIntoView (see
 * titlebar-search.js scrollMatchIntoView); same cure: scroll only the intended
 * scroller, by hand.
 */
function scrollRowIntoTreeView(row, behavior = "smooth") {
  const scroller = row.closest(TREE_CONTAINER_SELECTOR);
  if (!scroller) return;

  const rowRect = row.getBoundingClientRect();
  const scrollerRect = scroller.getBoundingClientRect();
  const delta =
    rowRect.top +
    rowRect.height / 2 -
    (scrollerRect.top + scrollerRect.height / 2);

  if (Math.abs(delta) < 1) return; // already centered; skip a no-op scroll

  scroller.scrollTo({
    top: scroller.scrollTop + delta, // scrollTo clamps to a valid range itself
    behavior: behavior === "smooth" ? "smooth" : "auto",
  });
}

/** Flash a row so it is easy to spot after being revealed. */
function flashRevealRow(row) {
  const label = row.querySelector(".item-label");
  if (!label) return;
  label.classList.remove("reveal-flash"); // restart if already flashing
  void label.offsetWidth; // reflow, so re-adding restarts the animation
  label.classList.add("reveal-flash");
  label.addEventListener(
    "animationend",
    () => label.classList.remove("reveal-flash"),
    { once: true },
  );
}

/** The Workspace copy of a row, never a pinned shortcut. */
const findWorkspaceRow = (container, path) =>
  container.querySelector(
    `.tree-item.file[data-path="${CSS.escape(path)}"]:not([data-pinned-copy])`,
  );

function openSidebarIfCollapsed() {
  const sidebar = document.getElementById("sidebar");
  if (!sidebar || sidebar.classList.contains("open")) return;

  sidebar.classList.add("open");
  const width = getComputedStyle(document.documentElement)
    .getPropertyValue("--sidebar-width")
    .trim();
  if (!width || width === "0px") {
    document.documentElement.style.setProperty("--sidebar-width", "200px");
  }
}

/**
 * Reveal a file in the sidebar: open the sidebar, expand every ancestor
 * folder, re-render, then select and scroll the row into view.
 */
export function revealInSidebar(targetPath, scrollBehavior = "smooth") {
  const filePath = targetPath || getCurrentOpenFile();
  const vault = getVaultPath();
  if (!filePath || !vault || !filePath.startsWith(vault + "/")) return;

  const container = getTreeContainer();
  if (!container) return;

  const finish = (row) => {
    setSelectedTreePath(filePath);
    syncTreeSelectionUI();
    scrollRowIntoTreeView(row, scrollBehavior);
    flashRevealRow(row);
  };

  // Fast path: the row is already in the DOM (ancestors expanded, sidebar
  // open), so skip straight to scrolling it into view. No expanded-folder
  // writes, no forcing the sidebar open, no full renderTree(). This is the
  // common case when called from search results, and doing all that work
  // unconditionally on every result click was the one operation unique to
  // this path versus a normal sidebar click — a likely source of an unwanted
  // layout shift elsewhere in the window.
  const existingRow = findWorkspaceRow(container, filePath);
  if (existingRow) {
    finish(existingRow);
    return;
  }

  // Expand every ancestor folder between the vault and the file:
  // vault/a/b/c.md -> expand vault/a and vault/a/b.
  const parts = filePath.slice(vault.length + 1).split("/");
  parts.pop(); // drop the file name
  const expandedFolders = getExpandedFolders();
  let acc = vault;
  for (const part of parts) {
    acc = `${acc}/${part}`;
    expandedFolders.add(acc);
  }
  setVaultExpanded(true);
  openSidebarIfCollapsed();

  setSelectedTreePath(filePath);
  renderTree(); // synchronous, so the row exists immediately afterwards
  syncTreeSelectionUI();

  const row = findWorkspaceRow(container, filePath);
  if (row) finish(row);
}
