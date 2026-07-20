// table-menu.js
//
// Context menus for the table widget: the nested flyout renderer plus the two
// item-tree builders (single cell, rectangular selection). Knows nothing about
// CodeMirror — callers hand in the model and a few callbacks, and every item's
// action() mutates the model only. `onAction` is invoked once afterwards so the
// caller can commit the result to the document.
//
// Menu elements are appended to document.body (they must escape the editor's
// overflow) and tracked on the wrap as wrap._menuEls so they can be torn down
// with the widget.

import { ops, fillCells } from "./table-model.js";

const EDGE = 6; // px viewport margin for menu placement

export function closeMenu(wrap) {
  if (wrap._menuEls) {
    for (const el of wrap._menuEls) el.remove();
    wrap._menuEls = null;
  }
  if (wrap._menuAway) {
    document.removeEventListener("mousedown", wrap._menuAway, true);
    window.removeEventListener("scroll", wrap._menuAway, true);
    wrap._menuAway = null;
  }
}

function closeMenuToDepth(wrap, depth) {
  if (!wrap._menuEls) return;
  wrap._menuEls = wrap._menuEls.filter((el) => {
    if (el._depth <= depth) return true;
    el.remove();
    return false;
  });
}

function buildItemEl(wrap, item, depth, onAction) {
  const el = document.createElement("div");
  el.className =
    "context-menu-item" +
    (item.danger ? " delete" : "") +
    (item.disabled ? " disabled" : "") +
    (item.children ? " has-submenu" : "");

  const span = document.createElement("span");
  span.textContent = item.label;
  el.appendChild(span);

  if (item.children) {
    const arrow = document.createElement("span");
    arrow.className = "cm-md-table-menu-arrow";
    arrow.textContent = "\u203a";
    el.appendChild(arrow);
  }

  if (item.disabled) return el;

  if (item.children) {
    el.addEventListener("mouseenter", () => {
      closeMenuToDepth(wrap, depth);
      const rect = el.getBoundingClientRect();
      renderMenu(wrap, item.children, rect.right - 3, rect.top - 5, depth + 1, onAction);
    });
    return el;
  }

  el.addEventListener("mouseenter", () => closeMenuToDepth(wrap, depth));
  el.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Blur an editing cell first: its focusout handler writes the cell back to
    // the model, and running it after the action would clobber the action.
    const active = document.activeElement;
    if (active && wrap.contains(active) && active.blur) active.blur();
    closeMenu(wrap);
    item.action();
    onAction();
  });
  return el;
}

function renderMenu(wrap, items, x, y, depth, onAction) {
  const menu = document.createElement("div");
  menu.className = "context-menu cm-md-table-menu show";
  menu.style.position = "fixed";
  menu.style.visibility = "hidden"; // measure before placing
  menu._depth = depth;

  for (const item of items) {
    if (item.divider) {
      const sep = document.createElement("div");
      sep.className = "context-menu-divider";
      menu.appendChild(sep);
      continue;
    }
    menu.appendChild(buildItemEl(wrap, item, depth, onAction));
  }

  document.body.appendChild(menu);
  wrap._menuEls.push(menu);

  // Flip a submenu to the left of its parent when it would overflow; a
  // top-level menu just gets pinned inside the viewport.
  const { offsetWidth: mw, offsetHeight: mh } = menu;
  let left = x;
  if (left + mw > window.innerWidth - EDGE)
    left = Math.max(EDGE, depth > 0 ? x - mw : window.innerWidth - mw - EDGE);
  menu.style.left = Math.max(EDGE, left) + "px";
  menu.style.top = Math.max(EDGE, Math.min(y, window.innerHeight - mh - EDGE)) + "px";
  menu.style.visibility = "";
  return menu;
}

export function showMenu(wrap, items, x, y, onAction) {
  closeMenu(wrap);
  wrap._menuEls = [];
  renderMenu(wrap, items, x, y, 0, onAction);
  wrap._menuAway = (e) => {
    const inMenu =
      e.type !== "scroll" &&
      wrap._menuEls &&
      wrap._menuEls.some((el) => el.contains(e.target));
    if (!inMenu) closeMenu(wrap);
  };
  document.addEventListener("mousedown", wrap._menuAway, true);
  window.addEventListener("scroll", wrap._menuAway, true);
}

const alignItems = (apply) => ({
  label: "Align",
  children: [
    { label: "Left", action: () => apply("left") },
    { label: "Center", action: () => apply("center") },
    { label: "Right", action: () => apply("right") },
  ],
});

// Menu for a single cell (or a gutter handle, which addresses a whole
// row/column via r = -1 / c).
export function buildCellMenu({ model: m, r, c, removeTable }) {
  c = Math.max(0, Math.min(c, m.header.length - 1));
  r = Math.min(r, m.rows.length - 1);
  const headerRow = r < 0;

  return [
    alignItems((a) => ops.setAlign(m, c, a)),
    { divider: true },
    {
      label: "Insert",
      children: [
        {
          label: "Row",
          children: [
            { label: "Above", action: () => ops.insertRow(m, headerRow ? 0 : r) },
            { label: "Below", action: () => ops.insertRow(m, headerRow ? 0 : r + 1) },
          ],
        },
        {
          label: "Column",
          children: [
            { label: "Left", action: () => ops.insertCol(m, c) },
            { label: "Right", action: () => ops.insertCol(m, c + 1) },
          ],
        },
      ],
    },
    {
      label: "Duplicate",
      children: [
        { label: "Row", disabled: headerRow, action: () => ops.duplicateRow(m, r) },
        { label: "Column", action: () => ops.duplicateCol(m, c) },
      ],
    },
    {
      label: "Delete",
      danger: true,
      children: [
        {
          label: "Row",
          danger: true,
          // Removing the last body row would drop the table below the
          // "complete" threshold and bounce it back to raw markdown, so keep
          // at least one.
          disabled: headerRow || m.rows.length <= 1,
          action: () => ops.deleteRow(m, r),
        },
        {
          label: "Column",
          danger: true,
          action: () =>
            m.header.length <= 1 ? removeTable() : ops.deleteCol(m, c),
        },
      ],
    },
  ];
}

// Menu for a rectangular selection. Whole-width / whole-height selections gain
// the matching delete entry; wiping out every row or column is treated as
// deleting the table, for the same completeness reason as above.
export function buildSelectionMenu({ model: m, sel, removeTable, clearSel }) {
  const cols = m.header.length;
  const rows = m.rows.length;
  const fullW = sel.c1 === 0 && sel.c2 === cols - 1;
  const fullH = sel.r1 === -1 && sel.r2 === rows - 1;
  const bodyFrom = Math.max(0, sel.r1);

  const deletions = [];
  if (fullW && sel.r2 >= 0) {
    const n = sel.r2 - bodyFrom + 1;
    deletions.push({
      label: n === 1 ? "Row" : "Rows",
      danger: true,
      action: () => {
        if (n >= rows) return removeTable();
        m.rows.splice(bodyFrom, n);
        clearSel();
      },
    });
  }
  if (fullH) {
    const n = sel.c2 - sel.c1 + 1;
    deletions.push({
      label: n === 1 ? "Column" : "Columns",
      danger: true,
      action: () => {
        if (n >= cols) return removeTable();
        for (let c = sel.c2; c >= sel.c1; c--) ops.deleteCol(m, c);
        clearSel();
      },
    });
  }

  const items = [
    alignItems((a) => {
      for (let c = sel.c1; c <= sel.c2; c++) ops.setAlign(m, c, a);
    }),
    { divider: true },
    {
      label: "Clear Values",
      action: () => {
        fillCells(m, sel);
        clearSel();
      },
    },
  ];

  if (deletions.length === 1)
    items.push({
      label: "Delete " + deletions[0].label,
      danger: true,
      action: deletions[0].action,
    });
  else if (deletions.length > 1)
    items.push({ label: "Delete", danger: true, children: deletions });

  return items;
}
