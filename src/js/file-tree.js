// js/file-tree.js
// Public entry point for the sidebar file tree.
//
// This file used to be ~1,150 lines covering a console shim, icon tables, DOM
// rendering, selection, drag-and-drop, the whole file-open pipeline, editor
// construction, autosave and the stats bar. It is now a thin composition
// layer. Every name other modules imported from here is still exported here.
//
// LAYOUT
//   tree/view.js    render + selection + reveal   (draws)
//   tree/input.js   click + hover + drag/drop     (reads input)
//   editor/*        opening files, editor session, autosave, stats
//   file-types.js   extensions and icons
// The dependency graph is acyclic: input -> view, input -> editor, editor ->
// view. Nothing imports this barrel back.

import { getTreeContainer, reloadTree } from "./tree/view.js";
import { initTreeInput } from "./tree/input.js";

// ── Re-exports (unchanged public API) ───────────────────────────────────────
export {
  findNodeByPath,
  renderTree,
  syncTreeSelectionUI,
  revealInSidebar,
} from "./tree/view.js";
export { getSearchResultIcon } from "./file-types.js";
export { destroyEditorView } from "./editor/session.js";
export { openFileNode } from "./editor/open-file.js";

// Input is delegated to the container, so the binding survives every
// re-render and only needs to happen once — unlike the old per-row listeners,
// which had to be rebuilt on each refresh.
let bound = false;

function ensureBound() {
  if (bound || !getTreeContainer()) return;
  initTreeInput();
  bound = true;
}

/** Bind tree input explicitly (e.g. after the sidebar is first built). */
export function initFileTree() {
  bound = false;
  ensureBound();
}

/** Kept for callers still using the old name. */
export const initTreeHover = initFileTree;

/** Re-read the vault from disk, repaint, and make sure input is bound. */
export async function refreshFileTree() {
  await reloadTree();
  ensureBound();
}
