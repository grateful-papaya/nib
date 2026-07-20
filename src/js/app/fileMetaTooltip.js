// js/app/fileMetaTooltip.js
// Hover a file-tree row for ~0.8s to get a size/created/modified card beside
// the sidebar. Folders and the two virtual roots show aggregate counts.

import { findNodeByPath } from "../file-tree.js";
import { getPinnedPaths, getRawTreeData } from "../state/treeState.js";
import { formatBytes, formatDate } from "./format.js";
import { byId, bySelector } from "./dom.js";

const HOVER_DELAY_MS = 800;
const VIRTUAL_VAULT_ROOT = "__VIRTUAL_VAULT_ROOT__";
const VIRTUAL_PINNED_ROOT = "__VIRTUAL_PINNED_ROOT__";

/**
 * Recursively total the files, folders and bytes under a list of tree nodes.
 *
 * This replaces countContents() and countAll(), which were byte-for-byte the
 * same traversal differing only in whether the caller passed `node.children`
 * or a root array.
 *
 * @param {Array<{ is_dir?: boolean, size?: number, children?: Array }>|null|undefined} nodes
 * @returns {{ files: number, folders: number, totalSize: number }}
 */
function countTree(nodes) {
  const totals = { files: 0, folders: 0, totalSize: 0 };
  if (!nodes) return totals;

  // Explicit stack rather than recursion: a deeply nested vault should not be
  // able to blow the call stack on a mouse hover.
  const stack = [nodes];
  while (stack.length) {
    for (const node of stack.pop()) {
      if (node.is_dir) {
        totals.folders++;
        if (node.children) stack.push(node.children);
      } else {
        totals.files++;
        totals.totalSize += node.size || 0;
      }
    }
  }
  return totals;
}

/**
 * @param {string} label
 * @param {string|number} value
 * @returns {HTMLDivElement}
 */
function metaRow(label, value) {
  const row = document.createElement("div");
  row.className = "fmeta-row";

  const key = document.createElement("span");
  key.textContent = label;
  const val = document.createElement("span");
  val.textContent = String(value);

  row.append(key, val);
  return row;
}

/**
 * Build the stat rows for whichever kind of row is hovered.
 *
 * Was three template-literal HTML blobs fed to insertAdjacentHTML. Building
 * nodes instead removes the injection surface entirely — filenames reach this
 * code unescaped — and skips a parse on every hover.
 *
 * @param {{ path: string, isDir: boolean, meta: { size: number, created: number, modified: number } }} ctx
 * @returns {DocumentFragment}
 */
function buildStats({ path, isDir, meta }) {
  const frag = document.createDocumentFragment();

  if (path === VIRTUAL_PINNED_ROOT) {
    frag.append(metaRow("Pinned Items", getPinnedPaths()?.size ?? 0));
    return frag;
  }

  if (path === VIRTUAL_VAULT_ROOT) {
    const totals = countTree(getRawTreeData());
    frag.append(
      metaRow("Folders", totals.folders),
      metaRow("Files", totals.files),
      metaRow("Size", formatBytes(totals.totalSize || meta.size)),
    );
    return frag;
  }

  if (isDir) {
    const totals = countTree(findNodeByPath(getRawTreeData(), path)?.children);
    frag.append(
      metaRow("Folders", totals.folders),
      metaRow("Files", totals.files),
      metaRow("Created", formatDate(meta.created)),
      metaRow("Modified", formatDate(meta.modified)),
      metaRow("Size", formatBytes(totals.totalSize)),
    );
    return frag;
  }

  frag.append(
    metaRow("Created", formatDate(meta.created)),
    metaRow("Modified", formatDate(meta.modified)),
    metaRow("Size", formatBytes(meta.size)),
  );
  return frag;
}

/**
 * @param {Element} item
 * @param {string} path
 * @returns {string}
 */
function displayName(item, path) {
  if (item.getAttribute("data-virtual-root") !== "true") {
    return path.split("/").pop();
  }
  return path === VIRTUAL_VAULT_ROOT ? "Workspace" : "Pinned";
}

export function initFileHoverTooltip() {
  const tooltip = byId("file-meta-tooltip");
  if (!tooltip) return;

  const sidebar = byId("sidebar");
  if (!sidebar) return;

  let showTimer = null;
  let hoveredItem = null;

  const isSuppressed = () =>
    sidebar.classList.contains("resizing") ||
    byId("sidebar-context-menu")?.classList.contains("show") === true;

  const hide = () => {
    clearTimeout(showTimer);
    hoveredItem = null;
    tooltip.classList.remove("visible");
  };

  bySelector(".file-tree-container")?.addEventListener("scroll", hide, {
    passive: true,
  });
  document.addEventListener("contextmenu", hide);

  // Scoped to the sidebar rather than document. The old listener ran on every
  // mouseover anywhere in the window — including every character of the
  // editor — and did two getElementById calls before finding out the target
  // was not a tree row.
  sidebar.addEventListener("mouseleave", hide);

  sidebar.addEventListener("mouseover", (e) => {
    if (isSuppressed()) {
      hide();
      return;
    }

    const item = e.target.closest(".tree-item");
    if (!item) {
      if (hoveredItem) hide();
      return;
    }
    if (hoveredItem === item) return;

    clearTimeout(showTimer);
    tooltip.classList.remove("visible");
    hoveredItem = item;

    const path = item.getAttribute("data-path");
    if (!path) return;

    const isDir = item.classList.contains("directory");
    const name = displayName(item, path);

    showTimer = setTimeout(async () => {
      if (hoveredItem !== item || isSuppressed()) return;

      let meta = { size: 0, created: 0, modified: 0 };
      try {
        meta = await api.getFileMeta({ filePath: path });
      } catch (err) {
        // A missing stat is not fatal — the aggregate counts below still
        // render — so fall through with the zeroed default.
        console.warn("[Tooltip] getFileMeta failed:", err?.message || err);
      }

      // The await above yields. The pointer may have moved on, or the sidebar
      // may have started resizing, in which case painting now would leave a
      // tooltip pinned to a row nobody is hovering. The original only checked
      // this before the fetch, not after.
      if (hoveredItem !== item || !item.isConnected || isSuppressed()) return;

      try {
        const nameEl = document.createElement("div");
        nameEl.className = "fmeta-name";
        nameEl.textContent = name;

        tooltip.replaceChildren(nameEl, buildStats({ path, isDir, meta }));

        const sidebarRect = sidebar.getBoundingClientRect();
        const itemRect = item.getBoundingClientRect();
        tooltip.style.top = `${itemRect.top}px`;
        tooltip.style.left = `${sidebarRect.right + 8}px`;
        tooltip.classList.add("visible");
      } catch (err) {
        console.error("[Tooltip] render failed:", err);
      }
    }, HOVER_DELAY_MS);
  });
}
