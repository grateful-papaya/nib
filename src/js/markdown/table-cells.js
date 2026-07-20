// table-cells.js
//
// Cell-level DOM for the table widget: building and patching the grid, reading
// and positioning the caret inside a contenteditable cell, and painting the
// rectangle selection. Deliberately knows nothing about CodeMirror, the
// document, or the widget's chrome — table-view.js drives all of it.
//
// State parked on the wrap element (it must survive across updateDOM calls):
//   _model    the { header, aligns, rows } this widget renders
//   _cells    cached th/td list, refreshed by renderTable
//   _dims     { cols, rows } of the rendered DOM
//   _sel      active rectangle { r1, r2, c1, c2 } or null

import { renderInline, renderTableMath, getCell } from "./table-model.js";

function makeCell(tag, r, c, raw, align, editable) {
  const cell = document.createElement(tag);
  cell.dataset.r = String(r);
  cell.dataset.c = String(c);
  cell.dataset.raw = raw;
  cell.contentEditable = editable ? "true" : "false";
  cell.spellcheck = false;
  cell.innerHTML = renderInline(raw);
  renderTableMath(cell);
  cell.style.textAlign = align || "left";
  return cell;
}

// Full rebuild of the grid. Row index -1 addresses the header, matching the
// data-r attribute the rest of the code reads back.
export function renderTable(wrap) {
  const m = wrap._model;
  const editable = !wrap._readOnly;
  const table = wrap.querySelector("table");
  table.textContent = "";

  const cells = [];
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  m.header.forEach((raw, c) => {
    const cell = makeCell("th", -1, c, raw, m.aligns[c], editable);
    headRow.appendChild(cell);
    cells.push(cell);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  m.rows.forEach((row, r) => {
    const tr = document.createElement("tr");
    row.forEach((raw, c) => {
      const cell = makeCell("td", r, c, raw, m.aligns[c], editable);
      tr.appendChild(cell);
      cells.push(cell);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  // Cached so the selection painter and the update path never have to run a
  // querySelectorAll — the painter runs on every mousemove of a rectangle drag.
  wrap._cells = cells;
  wrap._dims = { cols: m.header.length, rows: m.rows.length };
  wrap._dropKey = null; // the drop highlight died with the old cells
}

// Patch rendered cell content in place, used when the grid dimensions are
// unchanged. The focused cell is skipped: it holds raw text the user is typing,
// and re-rendering it would eat the caret.
export function syncCells(wrap, m) {
  for (const cell of wrap._cells || []) {
    const r = Number(cell.dataset.r);
    const c = Number(cell.dataset.c);
    const raw = getCell(m, r, c);
    cell.style.textAlign = m.aligns[c] || "left";
    if (cell === document.activeElement) {
      cell.dataset.raw = raw;
      continue;
    }
    if (cell.dataset.raw === raw) continue;
    cell.dataset.raw = raw;
    cell.innerHTML = renderInline(raw);
    renderTableMath(cell);
  }
}

// Paint one cell's rendered content from its raw markdown.
export function renderCell(cell, raw) {
  cell.innerHTML = renderInline(raw);
  renderTableMath(cell);
}

// ── Caret ─────────────────────────────────────────────────────────────────

// Characters before and after the caret within the cell, used to decide when a
// horizontal arrow should leave the cell instead of moving inside it.
export function caretOffsets(cell) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const rg = sel.getRangeAt(0);
  if (!cell.contains(rg.startContainer)) return null;
  const pre = rg.cloneRange();
  pre.selectNodeContents(cell);
  pre.setEnd(rg.startContainer, rg.startOffset);
  const before = pre.toString().length;
  return {
    before,
    after: cell.textContent.length - before,
    collapsed: sel.isCollapsed,
  };
}

export function placeCaretEnd(cell) {
  const sel = window.getSelection();
  if (!sel) return;
  const rg = document.createRange();
  rg.selectNodeContents(cell);
  rg.collapse(false);
  sel.removeAllRanges();
  sel.addRange(rg);
}

// A cell is one markdown line, so the hard spaces and newlines the browser
// inserts during contenteditable editing collapse back to plain spaces.
export const readCell = (cell) =>
  cell.textContent.replace(/\u00a0/g, " ").replace(/\n+/g, " ");

// ── Rectangle selection painting ──────────────────────────────────────────

export function paintSel(wrap) {
  const s = wrap._sel;
  for (const cell of wrap._cells || []) {
    const r = Number(cell.dataset.r);
    const c = Number(cell.dataset.c);
    const on = !!s && r >= s.r1 && r <= s.r2 && c >= s.c1 && c <= s.c2;
    cell.classList.toggle("cm-md-sel", on);
  }
}

// Also detaches the document-level listeners the active rectangle installed, so
// this is what teardown calls too.
export function clearSel(wrap) {
  wrap._sel = null;
  paintSel(wrap);
  if (wrap._selKey) {
    document.removeEventListener("keydown", wrap._selKey, true);
    wrap._selKey = null;
  }
  if (wrap._selAway) {
    document.removeEventListener("mousedown", wrap._selAway, true);
    wrap._selAway = null;
  }
}

// ── Drop-target highlight (row/column reorder) ────────────────────────────

export function clearDrop(wrap) {
  if (!wrap._dropKey) return;
  wrap._dropKey = null;
  for (const el of wrap.querySelectorAll(".cm-md-table-drop"))
    el.classList.remove("cm-md-table-drop");
}

export function markDrop(wrap, type, index) {
  const key = type + index;
  if (wrap._dropKey === key) return; // same target: nothing to repaint
  clearDrop(wrap);
  wrap._dropKey = key;
  const sel =
    type === "col" ? `[data-c="${index}"]` : `tbody [data-r="${index}"]`;
  for (const el of wrap.querySelectorAll(sel))
    el.classList.add("cm-md-table-drop");
}

// Hit-testing for the gutter handles.
export function colAtX(wrap, x) {
  const ths = wrap.querySelectorAll("thead th");
  for (let i = 0; i < ths.length; i++)
    if (x < ths[i].getBoundingClientRect().right) return i;
  return ths.length - 1;
}

export function rowAtY(wrap, y) {
  const trs = wrap.querySelectorAll("tbody tr");
  if (!trs.length) return 0;
  for (let i = 0; i < trs.length; i++)
    if (y < trs[i].getBoundingClientRect().bottom) return i;
  return trs.length - 1;
}
