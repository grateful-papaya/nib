// table-view.js
//
// Behaviour of a rendered GFM table: rectangle selection, row/column reorder
// handles, keyboard navigation, add bars, context-menu wiring and the floating
// horizontal scrollbar. The cell DOM itself lives in table-cells.js and the
// mapping back to markdown in table-doc.js; everything here mutates
// wrap._model and then asks table-doc to write the result out.
//
// It is one large module on purpose: these pieces share the wrap element, the
// same drag lifecycle and the same commit path, so splitting them further would
// only turn direct calls into parameter passing.

import { ops, setCell, fillCells } from "./table-model.js";
import {
  renderTable,
  renderCell,
  caretOffsets,
  placeCaretEnd,
  readCell,
  paintSel,
  clearSel,
  clearDrop,
  markDrop,
  colAtX,
  rowAtY,
} from "./table-cells.js";
import {
  closeMenu,
  showMenu,
  buildCellMenu,
  buildSelectionMenu,
} from "./table-menu.js";
import { createHBar, rafThrottle } from "./hscrollbar.js";

const DRAG_THRESHOLD = 4; // px before a handle press becomes a reorder drag

export function createTableView(tableDoc) {
  const { commit, commitRowFast, removeTable, exitTable, tableRange } = tableDoc;

  // ── Rectangle selection ─────────────────────────────────────────────────

  // The keys are captured at the document level because focus sits nowhere in
  // particular while a rectangle is active (the cells are blurred).
  function setSel(view, wrap, rect) {
    wrap._sel = rect;
    paintSel(wrap);
    if (!wrap._selKey) {
      wrap._selKey = (e) => {
        if (!wrap._sel) return;
        const stop = () => {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
        };
        if (e.key === "Delete") {
          stop();
          deleteSel(view, wrap);
        } else if (e.key === "Backspace") {
          stop();
          fillCells(wrap._model, wrap._sel);
          clearSel(wrap);
          commit(view, wrap, null);
        } else if (e.key === "Escape") {
          stop();
          clearSel(wrap);
        }
      };
      document.addEventListener("keydown", wrap._selKey, true);
    }
    if (!wrap._selAway) {
      wrap._selAway = (e) => {
        if (!wrap.contains(e.target)) clearSel(wrap);
      };
      document.addEventListener("mousedown", wrap._selAway, true);
    }
  }

  // Delete semantics depend on what the rectangle covers: whole rows or whole
  // columns are removed structurally, anything else just has its values wiped.
  // Selecting everything (or emptying the grid) deletes the table.
  function deleteSel(view, wrap) {
    const m = wrap._model;
    const s = wrap._sel;
    if (!s) return;
    const fullW = s.c1 === 0 && s.c2 === m.header.length - 1;
    const fullH = s.r1 === -1 && s.r2 === m.rows.length - 1;

    if (fullW && fullH) {
      clearSel(wrap);
      return removeTable(view, wrap);
    }
    if (fullW && s.r1 >= 0) {
      m.rows.splice(s.r1, s.r2 - s.r1 + 1);
    } else if (fullH) {
      for (let c = s.c2; c >= s.c1; c--) ops.deleteCol(m, c);
      if (m.header.length === 0) {
        clearSel(wrap);
        return removeTable(view, wrap);
      }
    } else {
      fillCells(m, s);
    }
    clearSel(wrap);
    commit(view, wrap, null);
  }

  // ── Row / column reorder handles ────────────────────────────────────────

  // Press-and-move on a gutter handle reorders; press-and-release selects the
  // whole row/column instead.
  function handleMousedown(view, wrap, type, e) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const active = document.activeElement;
    if (active && wrap.contains(active) && active.blur) active.blur();

    const src = type === "col" ? wrap._hoverC : wrap._hoverR;
    if (src == null) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    let target = src;

    // The hit test reads a rect per column/row, so keep it to one per frame.
    const track = rafThrottle((x, y) => {
      if (!dragging) return;
      target = type === "col" ? colAtX(wrap, x) : rowAtY(wrap, y);
      markDrop(wrap, type, target);
    });

    const onMove = (ev) => {
      if (
        !dragging &&
        Math.hypot(ev.clientX - startX, ev.clientY - startY) > DRAG_THRESHOLD
      ) {
        dragging = true;
        wrap.classList.add("cm-md-table-dragging");
        wrap.classList.add(
          type === "col"
            ? "cm-md-table-dragging-col"
            : "cm-md-table-dragging-row",
        );
      }
      if (dragging) track(ev.clientX, ev.clientY);
    };

    const onUp = () => {
      track.cancel();
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      wrap.classList.remove("cm-md-table-dragging");
      wrap.classList.remove("cm-md-table-dragging-col");
      wrap.classList.remove("cm-md-table-dragging-row");
      clearDrop(wrap);

      const m = wrap._model;
      if (!dragging) {
        setSel(
          view,
          wrap,
          type === "col"
            ? { r1: -1, r2: m.rows.length - 1, c1: src, c2: src }
            : { r1: src, r2: src, c1: 0, c2: m.header.length - 1 },
        );
        return;
      }
      if (target === src) return;
      if (type === "col") ops.moveCol(m, src, target);
      else ops.moveRow(m, src, target);
      commit(view, wrap, null);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function positionColHandle(wrap, x) {
    if (wrap.classList.contains("cm-md-table-dragging")) return;
    const c = colAtX(wrap, x);
    const th = wrap.querySelector(`thead th[data-c="${c}"]`);
    if (!th) return;
    wrap._hoverC = c;
    const handle = wrap.querySelector(".cm-md-table-colhandle");
    const gr = handle.parentElement.getBoundingClientRect();
    const cr = th.getBoundingClientRect();
    handle.style.left = cr.left - gr.left + cr.width / 2 + "px";
  }

  function positionRowHandle(wrap, y) {
    if (wrap.classList.contains("cm-md-table-dragging")) return;
    const r = rowAtY(wrap, y);
    const cell = wrap.querySelector(`tbody [data-r="${r}"]`);
    if (!cell) return;
    wrap._hoverR = r;
    const handle = wrap.querySelector(".cm-md-table-rowhandle");
    const gr = handle.parentElement.getBoundingClientRect();
    const cr = cell.parentElement.getBoundingClientRect();
    handle.style.top = cr.top - gr.top + cr.height / 2 + "px";
  }

  // ── Keyboard ────────────────────────────────────────────────────────────

  const focusCellAt = (wrap, r, c) => {
    const cell = wrap.querySelector(`[data-r="${r}"][data-c="${c}"]`);
    if (cell) cell.focus();
  };

  function onCellKeydown(view, wrap, cell, e) {
    const m = wrap._model;
    const cols = m.header.length;
    const rows = m.rows.length;
    const r = Number(cell.dataset.r);
    const c = Number(cell.dataset.c);
    // Flat cell index, header row included, so Tab/arrow traversal is 1-D.
    const i = (r + 1) * cols + c;
    const total = (rows + 1) * cols;
    const focusIdx = (idx) =>
      focusCellAt(wrap, Math.floor(idx / cols) - 1, idx % cols);

    if (e.key === "Tab") {
      e.preventDefault();
      if (e.shiftKey) {
        if (i > 0) focusIdx(i - 1);
      } else if (i + 1 < total) {
        focusIdx(i + 1);
      } else {
        // Tab off the last cell appends a row, like a spreadsheet.
        ops.insertRow(m, rows);
        commit(view, wrap, { r: rows, c: 0 });
      }
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) {
        // Soft break inside a cell: GFM has no way to express a newline other
        // than a literal <br>, so insert exactly that as text.
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount) return;
        const rg = sel.getRangeAt(0);
        rg.deleteContents();
        const node = document.createTextNode("<br>");
        rg.insertNode(node);
        rg.setStartAfter(node);
        rg.collapse(true);
        sel.removeAllRanges();
        sel.addRange(rg);
        cell.dispatchEvent(new Event("input", { bubbles: true }));
        return;
      }
      const insertAt = r < 0 ? 0 : r + 1;
      ops.insertRow(m, insertAt);
      commit(view, wrap, { r: insertAt, c });
      return;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      cell.blur();
      const range = tableRange(view, wrap);
      if (range) {
        view.dispatch({ selection: { anchor: range.from } });
        view.focus();
      }
      return;
    }

    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const nr = e.key === "ArrowUp" ? r - 1 : r + 1;
      if (nr < -1) exitTable(view, wrap, true);
      else if (nr >= rows) exitTable(view, wrap, false);
      else focusCellAt(wrap, nr, c);
      return;
    }

    // Horizontal arrows only leave the cell from its very edge, so inside it
    // they behave like normal text navigation.
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const off = caretOffsets(cell);
      if (!off || !off.collapsed) return;
      if (e.key === "ArrowLeft" && off.before === 0) {
        e.preventDefault();
        if (i === 0) exitTable(view, wrap, true);
        else focusIdx(i - 1);
      } else if (e.key === "ArrowRight" && off.after === 0) {
        e.preventDefault();
        if (i + 1 >= total) exitTable(view, wrap, false);
        else focusIdx(i + 1);
      }
    }
  }

  // ── Add bars ────────────────────────────────────────────────────────────

  // Hide an add bar the instant it is pressed, BEFORE the row/column is
  // inserted. Otherwise the "+" is still under the pointer while the table
  // grows, only slides out from under the cursor once the new DOM is laid out,
  // and just then does :hover drop and the fade begin — so the button visibly
  // outlives the thing it created. Inline styles outrank the :hover rule, and
  // the suppression lifts as soon as the pointer leaves or moves again, so a
  // second click still works.
  function suppressAddBar(el) {
    if (el._addBarRelease) el._addBarRelease();
    el.style.transition = "none";
    el.style.opacity = "0";
    const release = () => {
      el._addBarRelease = null;
      el.removeEventListener("mouseleave", release);
      el.removeEventListener("mousemove", release);
      el.style.transition = "";
      el.style.opacity = "";
    };
    el._addBarRelease = release;
    el.addEventListener("mouseleave", release);
    el.addEventListener("mousemove", release);
  }

  function addBar(wrap, cls, onPress) {
    const el = document.createElement("span");
    el.className = "cm-md-table-addbar " + cls;
    el.textContent = "+";
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      suppressAddBar(el);
      onPress();
    });
    wrap.appendChild(el);
    return el;
  }

  // ── Horizontal scrollbar ────────────────────────────────────────────────

  // The table sits in its own horizontal scroller so a wide table pans INSIDE
  // the widget instead of being clipped by the editor's overflow-x:hidden. The
  // floating thumb is shared with fenced code blocks; its element lives in
  // .cm-scroller, so it follows vertical scrolling and is clipped by the editor
  // for free, and its metrics are in scroller-content coordinates.
  function attachHBar(wrap, view, scroll, table) {
    const bar = createHBar({
      container: view.scrollDOM,
      onDrag: (left) => {
        scroll.scrollLeft = left; // fires "scroll" → syncBar below
      },
    });

    const measure = () => {
      const maxScroll = scroll.scrollWidth - scroll.clientWidth;
      if (maxScroll <= 1) return null;
      const r = scroll.getBoundingClientRect();
      const sr = view.scrollDOM.getBoundingClientRect();
      const st = view.scrollDOM.scrollTop;
      const left = r.left - sr.left;
      const top = r.top - sr.top + st;
      const bottom = r.bottom - sr.top + st;
      return {
        trackLeft: left + 8,
        trackWidth: Math.max(0, r.width - 16),
        // BELOW the add-row "+" strip, with clearance on both sides: the wrap's
        // bottom padding is 28px, the strip sits at +2..+15, the thumb at
        // +19..+23. `bottom` is the table's bottom border; y is the thumb's
        // BOTTOM edge in scroller-content coordinates.
        y: bottom + 23,
        scrollLeft: scroll.scrollLeft,
        clientWidth: scroll.clientWidth,
        maxScroll,
        // Grown to include the thumb zone so moving the pointer from the table
        // down onto the thumb doesn't count as leaving and fade it mid-reach.
        hoverRect: { left, right: left + r.width, top, bottom: bottom + 26 },
      };
    };
    const syncBar = () => bar.sync(measure());

    scroll.addEventListener(
      "scroll",
      () => {
        wrap._syncAddCol?.();
        syncBar();
        bar.showTemp();
      },
      { passive: true },
    );

    // Cell edits reflow row heights / table width while the pointer is on the
    // table (i.e. while the bar may be showing) — keep it glued. The layout
    // reads are skipped entirely while the bar is idle; geometry is re-measured
    // lazily on the next mouseenter anyway.
    const onResize = rafThrottle(syncBar);
    const ro = new ResizeObserver(() => {
      wrap._syncAddCol?.();
      if (bar.isActive()) onResize();
    });
    ro.observe(scroll);
    ro.observe(table);

    // Hover routing: enter → fresh measure; move → cached-metrics hit test with
    // zero layout reads, coalesced to one per frame.
    const onMove = rafThrottle((clientX, clientY) => {
      const sr = view.scrollDOM.getBoundingClientRect();
      bar.pointer(
        clientX - sr.left,
        clientY - sr.top + view.scrollDOM.scrollTop,
      );
    });
    wrap.addEventListener("mouseenter", syncBar);
    wrap.addEventListener("mousemove", (e) => onMove(e.clientX, e.clientY));
    wrap.addEventListener("mouseleave", () => bar.pointerLeave());

    wrap._destroyHBar = () => {
      onResize.cancel();
      onMove.cancel();
      ro.disconnect();
      bar.destroy();
    };
  }

  // ── Wiring ──────────────────────────────────────────────────────────────

  function wireContextMenu(wrap, view) {
    const onAction = () => commit(view, wrap, null);
    wrap.addEventListener("contextmenu", (e) => {
      let r;
      let c;
      const cell = e.target.closest ? e.target.closest("th, td") : null;

      if (cell && wrap.contains(cell)) {
        r = Number(cell.dataset.r);
        c = Number(cell.dataset.c);
        const s = wrap._sel;
        // Right-clicking inside a multi-cell rectangle acts on the rectangle.
        const inRect =
          s &&
          r >= s.r1 &&
          r <= s.r2 &&
          c >= s.c1 &&
          c <= s.c2 &&
          (s.r1 !== s.r2 || s.c1 !== s.c2);
        if (inRect) {
          e.preventDefault();
          e.stopPropagation();
          showMenu(
            wrap,
            buildSelectionMenu({
              model: wrap._model,
              sel: s,
              removeTable: () => removeTable(view, wrap),
              clearSel: () => clearSel(wrap),
            }),
            e.clientX,
            e.clientY,
            onAction,
          );
          return;
        }
      } else if (
        e.target.closest(".cm-md-table-rowhandle") ||
        e.target.closest(".cm-md-table-gutter-left")
      ) {
        r = wrap._hoverR ?? 0;
        c = 0;
      } else if (
        e.target.closest(".cm-md-table-colhandle") ||
        e.target.closest(".cm-md-table-gutter-top")
      ) {
        r = -1;
        c = wrap._hoverC ?? 0;
      } else {
        return;
      }

      e.preventDefault();
      e.stopPropagation();
      clearSel(wrap);
      showMenu(
        wrap,
        buildCellMenu({
          model: wrap._model,
          r,
          c,
          removeTable: () => removeTable(view, wrap),
        }),
        e.clientX,
        e.clientY,
        onAction,
      );
    });
  }

  function wireTableEvents(wrap, view, table) {
    // Rectangle selection by dragging across cells.
    table.addEventListener("mousedown", (e) => {
      if (e.button === 2) {
        // Keep an existing rectangle alive for the context menu above.
        if (wrap._sel && e.target.closest("th, td")) e.preventDefault();
        return;
      }
      if (e.button !== 0) return;
      const startCell = e.target.closest("th, td");
      if (!startCell) return;
      clearSel(wrap);

      const anchor = {
        r: Number(startCell.dataset.r),
        c: Number(startCell.dataset.c),
      };
      let selecting = false;

      const onMove = (ev) => {
        // elementFromPoint rather than ev.target: the pointer may be over a
        // text node, or over a child span of rendered inline markup.
        const el = document.elementFromPoint(ev.clientX, ev.clientY);
        const over = el && el.closest ? el.closest("th, td") : null;
        if (!over || !wrap.contains(over)) return;
        const cur = { r: Number(over.dataset.r), c: Number(over.dataset.c) };
        if (!selecting && (cur.r !== anchor.r || cur.c !== anchor.c)) {
          selecting = true;
          wrap.classList.add("cm-md-table-selecting");
          const active = document.activeElement;
          if (active && wrap.contains(active)) active.blur();
        }
        if (!selecting) return;
        window.getSelection()?.removeAllRanges();
        setSel(view, wrap, {
          r1: Math.min(anchor.r, cur.r),
          r2: Math.max(anchor.r, cur.r),
          c1: Math.min(anchor.c, cur.c),
          c2: Math.max(anchor.c, cur.c),
        });
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        wrap.classList.remove("cm-md-table-selecting");
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    });

    // Focusing a cell swaps its rendered HTML for the raw markdown behind it;
    // blurring renders it again and writes the value back.
    table.addEventListener("focusin", (e) => {
      const cell = e.target.closest("th, td");
      if (!cell) return;
      clearSel(wrap);
      cell.classList.add("cm-md-cell-editing");
      cell.textContent = cell.dataset.raw ?? "";
      placeCaretEnd(cell);
    });

    table.addEventListener("focusout", (e) => {
      const cell = e.target.closest("th, td");
      if (!cell) return;
      cell.classList.remove("cm-md-cell-editing");
      const raw = readCell(cell).trim();
      cell.dataset.raw = raw;
      // Render here rather than relying on the commit below: if the serialized
      // text is unchanged, commit dispatches nothing, no widget update runs,
      // and the cell would be left showing its raw markdown.
      renderCell(cell, raw);
      setCell(wrap._model, Number(cell.dataset.r), Number(cell.dataset.c), raw);
      commit(view, wrap, null);
    });

    table.addEventListener("input", (e) => {
      const cell = e.target.closest("th, td");
      if (!cell) return;
      const raw = readCell(cell);
      cell.dataset.raw = raw;
      const r = Number(cell.dataset.r);
      setCell(wrap._model, r, Number(cell.dataset.c), raw);
      commitRowFast(view, wrap, r);
    });

    // Clipboard events inside a cell belong to the cell, not to the editor.
    table.addEventListener("copy", (e) => {
      if (e.target.closest("th, td")) e.stopPropagation();
    });
    table.addEventListener("cut", (e) => {
      if (e.target.closest("th, td")) e.stopPropagation();
    });
    table.addEventListener("paste", (e) => {
      const cell = e.target.closest("th, td");
      if (!cell) return;
      e.preventDefault();
      e.stopPropagation();
      // A cell is a single line: flatten any pasted newlines.
      const txt = (e.clipboardData?.getData("text/plain") || "").replace(
        /\s*\n\s*/g,
        " ",
      );
      document.execCommand("insertText", false, txt);
    });

    table.addEventListener("keydown", (e) => {
      const cell = e.target.closest("th, td");
      if (cell) onCellKeydown(view, wrap, cell, e);
    });
  }

  // Gutters, handles and add bars stay direct children of wrap rather than of
  // the scroller: their positioning is getBoundingClientRect-based, so the
  // scroll offset is reflected automatically and they keep anchoring to the
  // VISIBLE box (the add-col "+" stays at the right edge even mid-scroll).
  function buildChrome(wrap, view, scroll) {
    const onColMove = rafThrottle((x) => positionColHandle(wrap, x));
    const onRowMove = rafThrottle((y) => positionRowHandle(wrap, y));

    const gutter = (cls, handleCls, glyph, type, onMove) => {
      const el = document.createElement("div");
      el.className = "cm-md-table-gutter " + cls;
      const handle = document.createElement("span");
      handle.className = "cm-md-table-handle " + handleCls;
      handle.textContent = glyph;
      handle.addEventListener("mousedown", (e) =>
        handleMousedown(view, wrap, type, e),
      );
      el.appendChild(handle);
      el.addEventListener("mousemove", onMove);
      wrap.appendChild(el);
    };

    gutter(
      "cm-md-table-gutter-top",
      "cm-md-table-colhandle",
      "\u22ef",
      "col",
      (e) => onColMove(e.clientX),
    );
    gutter(
      "cm-md-table-gutter-left",
      "cm-md-table-rowhandle",
      "\u22ee",
      "row",
      (e) => onRowMove(e.clientY),
    );

    const addCol = addBar(wrap, "cm-md-table-addcol", () => {
      ops.insertCol(wrap._model, wrap._model.header.length);
      commit(view, wrap, null);
      // The table just got wider, which can push its right edge out of view and
      // hide the "+" by the rule below. Follow the new column so the bar stays
      // where the user just clicked.
      window.requestAnimationFrame(() => {
        scroll.scrollLeft = scroll.scrollWidth;
        wrap._syncAddCol?.();
      });
    });

    // The "+" is anchored to the wrap's VISIBLE right edge, not to the table's
    // last column, so on a horizontally scrolled table it would float over a
    // cut-off column and offer to append there — a lie about where the column
    // lands. Only offer it once the table's real right edge is on screen.
    // display:none rather than opacity so it also stops taking hover.
    wrap._syncAddCol = () => {
      const atEnd =
        scroll.scrollWidth - scroll.clientWidth - scroll.scrollLeft <= 1;
      addCol.style.display = atEnd ? "" : "none";
    };
    wrap._syncAddCol();

    addBar(wrap, "cm-md-table-addrow", () => {
      ops.insertRow(wrap._model, wrap._model.rows.length);
      commit(view, wrap, null);
    });
  }

  // Read mode builds a display-only table: everything that exists to MUTATE the
  // document is skipped outright rather than hidden, so there is nothing to
  // hover, click, focus or right-click into. What survives is what a reader
  // needs — the rendered table, its horizontal scroller and the scrollbar.
  function buildDOM(wrap, view) {
    wrap.className = "cm-md-table-wrap";
    wrap._isMdTable = true;
    wrap.contentEditable = "false";
    const readOnly = !!wrap._readOnly;
    if (readOnly) wrap.classList.add("cm-md-table-readonly");

    const scroll = document.createElement("div");
    scroll.className = "cm-md-table-scroll";
    wrap.appendChild(scroll);

    const table = document.createElement("table");
    table.className = "cm-md-table";
    scroll.appendChild(table);
    renderTable(wrap);

    attachHBar(wrap, view, scroll, table);

    if (readOnly) {
      // Right-click opens nothing: no table menu is wired up, and the event is
      // stopped so the editor's document-level menu can't surface over the
      // table either. Delete this listener if that app menu should still be
      // reachable in read mode.
      wrap.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      return;
    }

    buildChrome(wrap, view, scroll);
    wireContextMenu(wrap, view);
    wireTableEvents(wrap, view, table);
  }

  function destroyDOM(wrap) {
    closeMenu(wrap);
    clearSel(wrap);
    wrap._destroyHBar?.();
  }

  return { buildDOM, destroyDOM };
}
