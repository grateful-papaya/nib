// js/app/dom.js
// Memoized lookups for the static chrome declared in index.html.
//
// Why: several hot paths re-queried the same elements on every event. The
// file-meta tooltip's mouseover handler alone ran two getElementById calls per
// mouse move, and the editor-stats outside-click handler ran two more per
// click anywhere in the window. Those elements are written once in index.html
// and never replaced, so caching them is free.
//
// The isConnected re-check keeps this honest: if an element ever IS replaced,
// the stale node is dropped and the lookup falls through to the live document
// instead of silently writing into a detached tree.

const idCache = new Map();
const selectorCache = new Map();

/** @param {string} id @returns {HTMLElement|null} */
export function byId(id) {
  const cached = idCache.get(id);
  if (cached && cached.isConnected) return cached;

  const el = document.getElementById(id);
  if (el) idCache.set(id, el);
  else idCache.delete(id);
  return el;
}

/** @param {string} selector @returns {Element|null} */
export function bySelector(selector) {
  const cached = selectorCache.get(selector);
  if (cached && cached.isConnected) return cached;

  const el = document.querySelector(selector);
  if (el) selectorCache.set(selector, el);
  else selectorCache.delete(selector);
  return el;
}

/**
 * Attribute-selector-safe path matching. Paths can legally contain quotes,
 * brackets and backslashes; interpolating them raw produced either a silently
 * empty match or a SyntaxError. Several call sites used CSS.escape and several
 * did not, so this centralizes it.
 *
 * @param {string} path absolute file path stored in data-path
 * @param {boolean} excludePinnedCopies skip the duplicated pinned-section rows
 * @returns {Element|null} the row's clickable label
 */
export function findTreeFileLabel(path, excludePinnedCopies = false) {
  if (!path) return null;
  const pinned = excludePinnedCopies ? ":not([data-pinned-copy])" : "";
  return document.querySelector(
    `.tree-item.file[data-path="${CSS.escape(path)}"]${pinned} .item-label`,
  );
}
