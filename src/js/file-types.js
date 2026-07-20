// js/file-types.js
// Single source of truth for "what kind of file is this" and "which icon does
// it get". Previously the image-extension list was spelled out three separate
// times inside file-tree.js and the three copies had already drifted apart
// (the open handler was missing ".ico"), so an .ico file drew an image icon in
// the tree but was rejected as "Unsupported file type" on click.

export const VIRTUAL_PINNED_ROOT = "__VIRTUAL_PINNED_ROOT__";
export const VIRTUAL_VAULT_ROOT = "__VIRTUAL_VAULT_ROOT__";

export const ICONS = {
  pin: "assets/pin.svg",
  vault: "assets/box.svg",
  folderOpen: "assets/open-folder.svg",
  folderClosed: "assets/close-folder.svg",
  image: "assets/image.svg",
  document: "assets/document.svg",
  arrowDown: "assets/arrow-down.svg",
};

// Set lookup on the extension instead of Array.some() + endsWith() per entry:
// one lastIndexOf + one hash probe rather than up to 8 string scans per row.
const IMAGE_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".webp",
  ".bmp",
  ".ico",
]);

const TEXT_EXTS = new Set([".md", ".txt"]);

/** Lowercased extension including the leading dot, or "" if there is none. */
export function extensionOf(nameOrPath) {
  if (!nameOrPath) return "";
  const base = nameOrPath.slice(nameOrPath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

export const isImageFile = (nameOrPath) => IMAGE_EXTS.has(extensionOf(nameOrPath));
export const isTextFile = (nameOrPath) => TEXT_EXTS.has(extensionOf(nameOrPath));
export const isMarkdownFile = (nameOrPath) => extensionOf(nameOrPath) === ".md";
export const isOpenableFile = (nameOrPath) =>
  isImageFile(nameOrPath) || isTextFile(nameOrPath);

/** Strip the extension from a file name, for the editor title field. */
export function baseName(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * Icon for a row in the tree. Folder icons reflect live expansion state, so
 * this needs the expanded-folder set passed in rather than importing tree
 * state (keeps this module dependency-free and unit-testable).
 *
 * @param {{path: string, name: string, is_dir: boolean}} node
 * @param {boolean} isExpanded  whether this row's folder is currently open
 */
export function getTreeNodeIcon(node, isExpanded) {
  if (node.path === VIRTUAL_PINNED_ROOT) return ICONS.pin;
  if (node.path === VIRTUAL_VAULT_ROOT) return ICONS.vault;
  if (node.is_dir) return isExpanded ? ICONS.folderOpen : ICONS.folderClosed;
  return isImageFile(node.name) ? ICONS.image : ICONS.document;
}

/**
 * Icon for a flat search-result row. A search result is never expanded in
 * place, so folders always show the closed icon.
 */
export function getSearchResultIcon(isDir, name) {
  if (isDir) return ICONS.folderClosed;
  return isImageFile(name) ? ICONS.image : ICONS.document;
}
