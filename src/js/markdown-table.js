// markdown-table.js
//
// GFM table live-preview + visual editing CodeMirror extension. The pure
// model layer (parse/serialize/render) lives in ./markdown/table-model.js;
// this file owns the interactive editing surface, which closes over the
// dynamically-imported CodeMirror bundle.

import {
  parseTable,
  serializeTable,
  renderInline,
  renderTableMath,
  escCell,
} from "./markdown/table-model.js";
import { createHBar } from "./markdown/hscrollbar.js";

export async function getTableExtension() {
  const cm = await import("./libs/codemirror.js");
  const { EditorView, Decoration, WidgetType, syntaxTree, StateField } = cm;
  if (!StateField) {
    throw new Error(
      'libs/codemirror.js does not export StateField — add `export { StateField } from "@codemirror/state";` to the bundle entry and rebuild',
    );
  }

  const emptyRow = (cols) => Array.from({ length: cols }, () => "");
  const ops = {
    insertRow(m, i) {
      m.rows.splice(i, 0, emptyRow(m.header.length));
    },
    deleteRow(m, i) {
      m.rows.splice(i, 1);
    },
    duplicateRow(m, i) {
      m.rows.splice(i + 1, 0, [...m.rows[i]]);
    },
    insertCol(m, i) {
      m.header.splice(i, 0, "");
      m.aligns.splice(i, 0, null);
      for (const r of m.rows) r.splice(i, 0, "");
    },
    deleteCol(m, i) {
      m.header.splice(i, 1);
      m.aligns.splice(i, 1);
      for (const r of m.rows) r.splice(i, 1);
    },
    duplicateCol(m, i) {
      m.header.splice(i + 1, 0, m.header[i]);
      m.aligns.splice(i + 1, 0, m.aligns[i]);
      for (const r of m.rows) r.splice(i + 1, 0, r[i]);
    },
    moveRow(m, from, to) {
      const [r] = m.rows.splice(from, 1);
      m.rows.splice(to, 0, r);
    },
    moveCol(m, from, to) {
      const mv = (arr) => {
        const [v] = arr.splice(from, 1);
        arr.splice(to, 0, v);
      };
      mv(m.header);
      mv(m.aligns);
      for (const r of m.rows) mv(r);
    },
    setAlign(m, i, a) {
      m.aligns[i] = a;
    },
  };

  const getCell = (m, r, c) => (r < 0 ? m.header[c] : m.rows[r]?.[c]) ?? "";
  const setCell = (m, r, c, v) => {
    if (r < 0) m.header[c] = v;
    else if (m.rows[r]) m.rows[r][c] = v;
  };

  function trimTableEnd(state, node) {
    let lastPipeTo = node.from;
    const c = node.node.cursor();
    if (c.firstChild()) {
      do {
        if (
          (c.name === "TableHeader" || c.name === "TableRow") &&
          state.doc.sliceString(c.from, c.to).includes("|")
        ) {
          lastPipeTo = c.to;
        }
      } while (c.nextSibling());
    }
    return state.doc.lineAt(Math.max(node.from, lastPipeTo - 1)).to;
  }

  function tableRange(view, wrap) {
    const pos = Math.min(view.posAtDOM(wrap, 0), view.state.doc.length);
    const line = view.state.doc.lineAt(pos);
    let found = null;
    syntaxTree(view.state).iterate({
      from: line.from,
      to: line.to,
      enter(n) {
        if (n.name === "Table" && !found) {
          found = { from: n.from, to: trimTableEnd(view.state, n) };
          return false;
        }
      },
    });
    return found;
  }

  function commit(view, wrap, focus) {
    const range = tableRange(view, wrap);
    if (!range) return;
    const text = serializeTable(wrap._model);
    if (view.state.doc.sliceString(range.from, range.to) !== text) {
      view.dispatch({
        changes: { from: range.from, to: range.to, insert: text },
        userEvent: "input.table",
      });
    }
    if (focus) {
      requestAnimationFrame(() => {
        const cell = wrap.querySelector(
          `[data-r="${focus.r}"][data-c="${focus.c}"]`,
        );
        if (cell) cell.focus();
      });
    }
  }

  function commitRowFast(view, wrap, r) {
    const range = tableRange(view, wrap);
    if (!range) return;

    const m = wrap._model;
    const doc = view.state.doc;
    const startLineIdx = doc.lineAt(range.from).number;
    const lineOffset = r < 0 ? 0 : r + 2;
    const targetLineIdx = startLineIdx + lineOffset;

    if (targetLineIdx > doc.lines) return;

    const targetLine = doc.line(targetLineIdx);
    const rowData = r < 0 ? m.header : m.rows[r];

    const text = "| " + rowData.map(escCell).join(" | ") + " |";

    if (targetLine.text !== text) {
      view.dispatch({
        changes: { from: targetLine.from, to: targetLine.to, insert: text },
        userEvent: "input.table.fast",
      });
    }
  }

  function removeTable(view, wrap) {
    const range = tableRange(view, wrap);
    if (!range) return;
    const to = Math.min(view.state.doc.length, range.to + 1);
    view.dispatch({
      changes: { from: range.from, to },
      selection: { anchor: range.from },
      userEvent: "delete.table",
    });
    view.focus();
  }

  function exitTable(view, wrap, above) {
    const range = tableRange(view, wrap);
    if (!range) return;
    const doc = view.state.doc;
    if (above) {
      if (doc.lineAt(range.from).number === 1) {
        view.dispatch({
          changes: { from: 0, insert: "\n" },
          selection: { anchor: 0 },
        });
      } else {
        view.dispatch({
          selection: { anchor: doc.lineAt(range.from).from - 1 },
        });
      }
    } else {
      if (doc.lineAt(range.to).number === doc.lines) {
        view.dispatch({
          changes: { from: doc.length, insert: "\n" },
          selection: { anchor: doc.length + 1 },
        });
      } else {
        view.dispatch({ selection: { anchor: doc.lineAt(range.to).to + 1 } });
      }
    }
    view.focus();
  }

  function caretOffsets(cell) {
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

  function placeCaretEnd(cell) {
    const sel = window.getSelection();
    if (!sel) return;
    const rg = document.createRange();
    rg.selectNodeContents(cell);
    rg.collapse(false);
    sel.removeAllRanges();
    sel.addRange(rg);
  }

  const readCell = (cell) =>
    cell.textContent.replace(/\u00a0/g, " ").replace(/\n+/g, " ");

  function paintSel(wrap) {
    const s = wrap._sel;
    wrap.querySelectorAll("th, td").forEach((cell) => {
      const r = Number(cell.dataset.r);
      const c = Number(cell.dataset.c);
      const on = s && r >= s.r1 && r <= s.r2 && c >= s.c1 && c <= s.c2;
      cell.classList.toggle("cm-md-sel", !!on);
    });
  }

  function clearSel(wrap) {
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
          clearSelValues(view, wrap);
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

  function clearSelValues(view, wrap) {
    const m = wrap._model;
    const s = wrap._sel;
    if (!s) return;
    for (let r = s.r1; r <= s.r2; r++)
      for (let c = s.c1; c <= s.c2; c++) setCell(m, r, c, "");
    clearSel(wrap);
    commit(view, wrap, null);
  }

  function deleteSel(view, wrap) {
    const m = wrap._model;
    const s = wrap._sel;
    if (!s) return;
    const cols = m.header.length;
    const rows = m.rows.length;
    const fullW = s.c1 === 0 && s.c2 === cols - 1;
    const fullH = s.r1 === -1 && s.r2 === rows - 1;
    if (fullW && fullH) {
      clearSel(wrap);
      removeTable(view, wrap);
      return;
    }
    if (fullW && s.r1 >= 0) {
      m.rows.splice(s.r1, s.r2 - s.r1 + 1);
    } else if (fullH) {
      for (let c = s.c2; c >= s.c1; c--) ops.deleteCol(m, c);
      if (m.header.length === 0) {
        clearSel(wrap);
        removeTable(view, wrap);
        return;
      }
    } else {
      for (let r = s.r1; r <= s.r2; r++)
        for (let c = s.c1; c <= s.c2; c++) setCell(m, r, c, "");
    }
    clearSel(wrap);
    commit(view, wrap, null);
  }

  function closeMenu(wrap) {
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
      if (el._depth > depth) {
        el.remove();
        return false;
      }
      return true;
    });
  }

  function renderMenu(view, wrap, items, x, y, depth) {
    const menu = document.createElement("div");
    menu.className = "context-menu cm-md-table-menu show";
    menu.style.position = "fixed";
    menu.style.visibility = "hidden";
    menu._depth = depth;

    for (const item of items) {
      if (item.divider) {
        const sep = document.createElement("div");
        sep.className = "context-menu-divider";
        menu.appendChild(sep);
        continue;
      }
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
        arrow.textContent = "›";
        el.appendChild(arrow);
      }

      if (item.disabled) {
        menu.appendChild(el);
        continue;
      }

      if (item.children) {
        el.addEventListener("mouseenter", () => {
          closeMenuToDepth(wrap, depth);
          const rect = el.getBoundingClientRect();
          renderMenu(
            view,
            wrap,
            item.children,
            rect.right - 3,
            rect.top - 5,
            depth + 1,
          );
        });
      } else {
        el.addEventListener("mouseenter", () => closeMenuToDepth(wrap, depth));
        el.addEventListener("mousedown", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const active = document.activeElement;
          if (active && wrap.contains(active) && active.blur) active.blur();
          closeMenu(wrap);
          item.action();
          commit(view, wrap, null);
        });
      }
      menu.appendChild(el);
    }

    document.body.appendChild(menu);
    wrap._menuEls.push(menu);

    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    let left = x;
    if (left + mw > window.innerWidth - 6) {
      left =
        depth > 0 ? x - mw - (menu._parentW || 0) : window.innerWidth - mw - 6;
      if (left < 6) left = 6;
    }
    const top = Math.max(6, Math.min(y, window.innerHeight - mh - 6));
    menu.style.left = Math.max(6, left) + "px";
    menu.style.top = top + "px";
    menu.style.visibility = "";
    return menu;
  }

  function openMenu(view, wrap, r, c, x, y) {
    closeMenu(wrap);
    const m = wrap._model;
    c = Math.max(0, Math.min(c, m.header.length - 1));
    r = Math.min(r, m.rows.length - 1);
    const headerRow = r < 0;

    const items = [
      {
        label: "Align",
        children: [
          { label: "Left", action: () => ops.setAlign(m, c, "left") },
          { label: "Center", action: () => ops.setAlign(m, c, "center") },
          { label: "Right", action: () => ops.setAlign(m, c, "right") },
        ],
      },
      { divider: true },
      {
        label: "Insert",
        children: [
          {
            label: "Row",
            children: [
              {
                label: "Above",
                action: () => ops.insertRow(m, headerRow ? 0 : r),
              },
              {
                label: "Below",
                action: () => ops.insertRow(m, headerRow ? 0 : r + 1),
              },
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
          {
            label: "Row",
            disabled: headerRow,
            action: () => ops.duplicateRow(m, r),
          },
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
            // "complete" threshold in isCompleteTable() and bounce it back to
            // raw markdown, so keep at least one row.
            disabled: headerRow || m.rows.length <= 1,
            action: () => ops.deleteRow(m, r),
          },
          {
            label: "Column",
            danger: true,
            action: () => {
              if (m.header.length <= 1) return removeTable(view, wrap);
              ops.deleteCol(m, c);
            },
          },
        ],
      },
    ];

    showMenu(view, wrap, items, x, y);
  }

  function showMenu(view, wrap, items, x, y) {
    wrap._menuEls = [];
    renderMenu(view, wrap, items, x, y, 0);
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

  function openSelectionMenu(view, wrap, s, x, y) {
    closeMenu(wrap);
    const m = wrap._model;
    const cols = m.header.length;
    const rows = m.rows.length;
    const alignAll = (a) => {
      for (let c = s.c1; c <= s.c2; c++) ops.setAlign(m, c, a);
    };
    const bodyFrom = Math.max(0, s.r1);

    const fullW = s.c1 === 0 && s.c2 === cols - 1;
    const fullH = s.r1 === -1 && s.r2 === rows - 1;
    const delChildren = [];
    if (fullW && s.r2 >= 0) {
      const n = s.r2 - bodyFrom + 1;
      delChildren.push({
        label: n === 1 ? "Row" : "Rows",
        danger: true,
        action: () => {
          // Same rule as the column branch below: wiping out every body row
          // would leave a header-only table that isCompleteTable() refuses to
          // render, so treat "delete all rows" as "delete the table".
          if (n >= rows) return removeTable(view, wrap);
          m.rows.splice(bodyFrom, n);
          clearSel(wrap);
        },
      });
    }
    if (fullH) {
      const n = s.c2 - s.c1 + 1;
      delChildren.push({
        label: n === 1 ? "Column" : "Columns",
        danger: true,
        action: () => {
          if (n >= cols) return removeTable(view, wrap);
          for (let c = s.c2; c >= s.c1; c--) ops.deleteCol(m, c);
          clearSel(wrap);
        },
      });
    }

    const items = [
      {
        label: "Align",
        children: [
          { label: "Left", action: () => alignAll("left") },
          { label: "Center", action: () => alignAll("center") },
          { label: "Right", action: () => alignAll("right") },
        ],
      },
      { divider: true },
      {
        label: "Clear Values",
        action: () => {
          for (let r = s.r1; r <= s.r2; r++)
            for (let c = s.c1; c <= s.c2; c++) setCell(m, r, c, "");
          clearSel(wrap);
        },
      },
    ];
    if (delChildren.length === 1) {
      const only = delChildren[0];
      items.push({
        label: "Delete " + only.label,
        danger: true,
        action: only.action,
      });
    } else if (delChildren.length > 1) {
      items.push({ label: "Delete", danger: true, children: delChildren });
    }
    showMenu(view, wrap, items, x, y);
  }

  function clearDrop(wrap) {
    wrap
      .querySelectorAll(".cm-md-table-drop")
      .forEach((el) => el.classList.remove("cm-md-table-drop"));
  }

  function markDrop(wrap, type, index) {
    clearDrop(wrap);
    const sel =
      type === "col" ? `[data-c="${index}"]` : `tbody [data-r="${index}"]`;
    wrap
      .querySelectorAll(sel)
      .forEach((el) => el.classList.add("cm-md-table-drop"));
  }

  function colAtX(wrap, x) {
    const ths = [...wrap.querySelectorAll("thead th")];
    for (let i = 0; i < ths.length; i++) {
      if (x < ths[i].getBoundingClientRect().right) return i;
    }
    return ths.length - 1;
  }

  function rowAtY(wrap, y) {
    const trs = [...wrap.querySelectorAll("tbody tr")];
    if (trs.length === 0) return 0;
    for (let i = 0; i < trs.length; i++) {
      if (y < trs[i].getBoundingClientRect().bottom) return i;
    }
    return trs.length - 1;
  }

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

    const onMove = (ev) => {
      if (
        !dragging &&
        Math.hypot(ev.clientX - startX, ev.clientY - startY) > 4
      ) {
        dragging = true;
        wrap.classList.add("cm-md-table-dragging");
        wrap.classList.add(
          type === "col"
            ? "cm-md-table-dragging-col"
            : "cm-md-table-dragging-row",
        );
      }
      if (!dragging) return;
      target =
        type === "col" ? colAtX(wrap, ev.clientX) : rowAtY(wrap, ev.clientY);
      markDrop(wrap, type, target);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      wrap.classList.remove("cm-md-table-dragging");
      wrap.classList.remove("cm-md-table-dragging-col");
      wrap.classList.remove("cm-md-table-dragging-row");
      clearDrop(wrap);
      const m = wrap._model;
      if (dragging) {
        if (target !== src) {
          if (type === "col") ops.moveCol(m, src, target);
          else ops.moveRow(m, src, target);
          commit(view, wrap, null);
        }
      } else {
        const rect =
          type === "col"
            ? { r1: -1, r2: m.rows.length - 1, c1: src, c2: src }
            : { r1: src, r2: src, c1: 0, c2: m.header.length - 1 };
        setSel(view, wrap, rect);
      }
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
    const colH = wrap.querySelector(".cm-md-table-colhandle");
    const gr = colH.parentElement.getBoundingClientRect();
    const cr = th.getBoundingClientRect();
    colH.style.left = cr.left - gr.left + cr.width / 2 + "px";
  }

  function positionRowHandle(wrap, y) {
    if (wrap.classList.contains("cm-md-table-dragging")) return;
    const r = rowAtY(wrap, y);
    const cellInRow = wrap.querySelector(`tbody [data-r="${r}"]`);
    if (!cellInRow) return;
    wrap._hoverR = r;
    const rowH = wrap.querySelector(".cm-md-table-rowhandle");
    const gr = rowH.parentElement.getBoundingClientRect();
    const cr = cellInRow.parentElement.getBoundingClientRect();
    rowH.style.top = cr.top - gr.top + cr.height / 2 + "px";
  }

  function focusCellAt(wrap, r, c) {
    const cell = wrap.querySelector(`[data-r="${r}"][data-c="${c}"]`);
    if (cell) cell.focus();
    return !!cell;
  }

  function onCellKeydown(view, wrap, cell, e) {
    const m = wrap._model;
    const cols = m.header.length;
    const rows = m.rows.length;
    const r = Number(cell.dataset.r);
    const c = Number(cell.dataset.c);
    const i = (r + 1) * cols + c;
    const total = (rows + 1) * cols;
    const toCoords = (idx) => ({
      r: Math.floor(idx / cols) - 1,
      c: idx % cols,
    });

    if (e.key === "Tab") {
      e.preventDefault();
      if (e.shiftKey) {
        if (i > 0) {
          const p = toCoords(i - 1);
          focusCellAt(wrap, p.r, p.c);
        }
      } else if (i + 1 < total) {
        const n = toCoords(i + 1);
        focusCellAt(wrap, n.r, n.c);
      } else {
        ops.insertRow(m, rows);
        commit(view, wrap, { r: rows, c: 0 });
      }
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) {
        const sel = window.getSelection();
        if (sel && sel.rangeCount) {
          const rg = sel.getRangeAt(0);
          rg.deleteContents();
          const tn = document.createTextNode("<br>");
          rg.insertNode(tn);
          rg.setStartAfter(tn);
          rg.collapse(true);
          sel.removeAllRanges();
          sel.addRange(rg);
          cell.dispatchEvent(new Event("input", { bubbles: true }));
        }
        return;
      }
      const at = r < 0 ? 0 : r + 1;
      ops.insertRow(m, at);
      commit(view, wrap, { r: at, c });
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

    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const off = caretOffsets(cell);
      if (!off || !off.collapsed) return;
      if (e.key === "ArrowLeft" && off.before === 0) {
        e.preventDefault();
        if (i === 0) exitTable(view, wrap, true);
        else {
          const p = toCoords(i - 1);
          focusCellAt(wrap, p.r, p.c);
        }
      } else if (e.key === "ArrowRight" && off.after === 0) {
        e.preventDefault();
        if (i + 1 >= total) exitTable(view, wrap, false);
        else {
          const n = toCoords(i + 1);
          focusCellAt(wrap, n.r, n.c);
        }
      }
    }
  }

  function makeCell(tag, r, c, raw, align) {
    const cell = document.createElement(tag);
    cell.dataset.r = String(r);
    cell.dataset.c = String(c);
    cell.dataset.raw = raw;
    cell.contentEditable = "true";
    cell.spellcheck = false;
    cell.innerHTML = renderInline(raw);
    renderTableMath(cell);
    cell.style.textAlign = align || "left";
    return cell;
  }

  function renderTable(wrap) {
    const m = wrap._model;
    const table = wrap.querySelector("table");
    table.textContent = "";
    const thead = document.createElement("thead");
    const hr = document.createElement("tr");
    m.header.forEach((raw, c) =>
      hr.appendChild(makeCell("th", -1, c, raw, m.aligns[c])),
    );
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    m.rows.forEach((row, r) => {
      const tr = document.createElement("tr");
      row.forEach((raw, c) =>
        tr.appendChild(makeCell("td", r, c, raw, m.aligns[c])),
      );
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
  }

  // Hide an add-bar the instant it is pressed, BEFORE the row/column is
  // inserted. Otherwise the "+" is still under the pointer while the table
  // grows, the bar only slides out from under the cursor once the new DOM is
  // laid out, and just then does :hover drop and the 0.12s fade begin — so the
  // button visibly outlives the thing it created. Inline styles outrank the
  // :hover rule in markdown-preview.css, and the suppression lifts as soon as
  // the pointer leaves the bar or moves again, so a second click still works.
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

  function buildDOM(wrap, view) {
    wrap.className = "cm-md-table-wrap";
    wrap._isMdTable = true;
    wrap.contentEditable = "false";

    // The table sits in its own horizontal scroller so a wide table pans
    // INSIDE the widget instead of being clipped by the editor's
    // overflow-x:hidden. Gutters/handles/+bars stay direct children of wrap:
    // their positioning is getBoundingClientRect-based, so the scroll offset
    // is reflected automatically, and they keep anchoring to the VISIBLE
    // box (the add-col "+" stays at the right edge even mid-scroll).
    const scroll = document.createElement("div");
    scroll.className = "cm-md-table-scroll";
    wrap.appendChild(scroll);

    const table = document.createElement("table");
    table.className = "cm-md-table";
    scroll.appendChild(table);
    renderTable(wrap);

    // Floating horizontal scrollbar, shared with fenced code blocks
    // (hscrollbar.js). Metrics in scroller-content coordinates; the thumb
    // element lives in .cm-scroller, so it follows vertical scrolling and
    // gets clipped by the editor for free.
    const bar = createHBar({
      container: view.scrollDOM,
      onDrag: (left) => {
        scroll.scrollLeft = left; // fires "scroll" → syncBar below
      },
    });
    const measureBar = () => {
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
        // BELOW the add-row "+" strip, with clearance on both sides. The
        // wrap's bottom padding is 28px (layout in markdown-preview.css):
        // strip at table_bottom+2..+15, thumb at +19..+23 (4px gap above,
        // 5px+ to the next content below). `bottom` here is the scroll
        // element's bottom = the table's bottom border; y is the thumb's
        // BOTTOM edge in scroller-content coordinates.
        y: bottom + 23,
        scrollLeft: scroll.scrollLeft,
        clientWidth: scroll.clientWidth,
        maxScroll,
        // hoverRect grown to include the new thumb zone, so moving the
        // pointer from the table down onto the thumb doesn't count as
        // leaving and fade it out mid-reach.
        hoverRect: { left, right: left + r.width, top, bottom: bottom + 26 },
      };
    };
    const syncBar = () => bar.sync(measureBar());
    scroll.addEventListener(
      "scroll",
      () => {
        if (wrap._syncAddCol) wrap._syncAddCol();
        syncBar();
        bar.showTemp();
      },
      { passive: true },
    );
    // Cell edits reflow row heights / table width while the pointer is on
    // the table (i.e. while the bar may be showing) — keep it glued. Skip
    // the layout reads entirely while the bar is idle; geometry is
    // re-measured lazily on the next mouseenter anyway.
    let roRaf = false;
    const ro = new ResizeObserver(() => {
      if (wrap._syncAddCol) wrap._syncAddCol();
      if (!bar.isActive() || roRaf) return;
      roRaf = true;
      window.requestAnimationFrame(() => {
        roRaf = false;
        syncBar();
      });
    });
    ro.observe(scroll);
    ro.observe(table);
    // Hover routing: enter → fresh measure; move → cached-metrics hit test
    // (zero layout reads), rAF-coalesced like the app scrollbar.
    let moveRaf = false;
    let lastMove = null;
    wrap.addEventListener("mouseenter", syncBar);
    wrap.addEventListener("mousemove", (e) => {
      lastMove = e;
      if (moveRaf) return;
      moveRaf = true;
      window.requestAnimationFrame(() => {
        moveRaf = false;
        const ev = lastMove;
        lastMove = null;
        if (!ev) return;
        const sr = view.scrollDOM.getBoundingClientRect();
        bar.pointer(
          ev.clientX - sr.left,
          ev.clientY - sr.top + view.scrollDOM.scrollTop,
        );
      });
    });
    wrap.addEventListener("mouseleave", () => bar.pointerLeave());
    wrap._destroyHBar = () => {
      ro.disconnect();
      bar.destroy();
    };

    const topGutter = document.createElement("div");
    topGutter.className = "cm-md-table-gutter cm-md-table-gutter-top";
    const colH = document.createElement("span");
    colH.className = "cm-md-table-handle cm-md-table-colhandle";
    colH.textContent = "⋯";
    colH.addEventListener("mousedown", (e) =>
      handleMousedown(view, wrap, "col", e),
    );
    topGutter.appendChild(colH);
    topGutter.addEventListener("mousemove", (e) =>
      positionColHandle(wrap, e.clientX),
    );
    wrap.appendChild(topGutter);

    const leftGutter = document.createElement("div");
    leftGutter.className = "cm-md-table-gutter cm-md-table-gutter-left";
    const rowH = document.createElement("span");
    rowH.className = "cm-md-table-handle cm-md-table-rowhandle";
    rowH.textContent = "⋮";
    rowH.addEventListener("mousedown", (e) =>
      handleMousedown(view, wrap, "row", e),
    );
    leftGutter.appendChild(rowH);
    leftGutter.addEventListener("mousemove", (e) =>
      positionRowHandle(wrap, e.clientY),
    );
    wrap.appendChild(leftGutter);

    const addCol = document.createElement("span");
    addCol.className = "cm-md-table-addbar cm-md-table-addcol";
    addCol.textContent = "+";
    addCol.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      suppressAddBar(addCol);
      ops.insertCol(wrap._model, wrap._model.header.length);
      commit(view, wrap, null);
      // The table just got wider, which can push its right edge out of view
      // and hide the "+" by the rule below. Follow the new column so the bar
      // stays where the user just clicked.
      window.requestAnimationFrame(() => {
        scroll.scrollLeft = scroll.scrollWidth;
        if (wrap._syncAddCol) wrap._syncAddCol();
      });
    });
    wrap.appendChild(addCol);

    // The "+" is anchored to the wrap's VISIBLE right edge, not to the table's
    // last column, so on a horizontally scrolled table it floats over a cut-off
    // column and offers to append there — which is a lie about where the column
    // lands and hides part of the table. Only offer it once the table's real
    // right edge is on screen. display:none rather than opacity so it also
    // stops taking hover while it's out of play.
    wrap._syncAddCol = () => {
      const atEnd =
        scroll.scrollWidth - scroll.clientWidth - scroll.scrollLeft <= 1;
      addCol.style.display = atEnd ? "" : "none";
    };
    wrap._syncAddCol();

    const addRow = document.createElement("span");
    addRow.className = "cm-md-table-addbar cm-md-table-addrow";
    addRow.textContent = "+";
    addRow.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      suppressAddBar(addRow);
      ops.insertRow(wrap._model, wrap._model.rows.length);
      commit(view, wrap, null);
    });
    wrap.appendChild(addRow);

    wrap.addEventListener("contextmenu", (e) => {
      let r, c;
      const cell = e.target.closest ? e.target.closest("th, td") : null;
      if (cell && wrap.contains(cell)) {
        r = Number(cell.dataset.r);
        c = Number(cell.dataset.c);
        const s = wrap._sel;
        if (
          s &&
          r >= s.r1 &&
          r <= s.r2 &&
          c >= s.c1 &&
          c <= s.c2 &&
          (s.r1 !== s.r2 || s.c1 !== s.c2)
        ) {
          e.preventDefault();
          e.stopPropagation();
          openSelectionMenu(view, wrap, s, e.clientX, e.clientY);
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
      openMenu(view, wrap, r, c, e.clientX, e.clientY);
    });

    table.addEventListener("mousedown", (e) => {
      if (e.button === 2) {
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
        const el = document.elementFromPoint(ev.clientX, ev.clientY);
        const over = el && el.closest ? el.closest("th, td") : null;
        if (!over || !wrap.contains(over)) return;
        const cur = { r: Number(over.dataset.r), c: Number(over.dataset.c) };
        if (!selecting && (cur.r !== anchor.r || cur.c !== anchor.c)) {
          selecting = true;
          wrap.classList.add("cm-md-table-selecting");
          const ae = document.activeElement;
          if (ae && wrap.contains(ae)) ae.blur();
        }
        if (selecting) {
          window.getSelection()?.removeAllRanges();
          setSel(view, wrap, {
            r1: Math.min(anchor.r, cur.r),
            r2: Math.max(anchor.r, cur.r),
            c1: Math.min(anchor.c, cur.c),
            c2: Math.max(anchor.c, cur.c),
          });
        }
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        wrap.classList.remove("cm-md-table-selecting");
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    });

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
      cell.innerHTML = renderInline(raw);
      renderTableMath(cell);

      setCell(wrap._model, Number(cell.dataset.r), Number(cell.dataset.c), raw);
      commit(view, wrap, null);
    });

    table.addEventListener("input", (e) => {
      const cell = e.target.closest("th, td");
      if (!cell) return;
      const raw = readCell(cell);
      cell.dataset.raw = raw;

      const r = Number(cell.dataset.r);
      const c = Number(cell.dataset.c);
      setCell(wrap._model, r, c, raw);

      commitRowFast(view, wrap, r);
    });

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

  class TableWidget extends WidgetType {
    constructor(text) {
      super();
      this.text = text;
      this.model = parseTable(text);
    }
    eq(other) {
      return other.text === this.text;
    }
    toDOM(view) {
      const wrap = document.createElement("div");
      wrap._model = this.model;
      buildDOM(wrap, view);
      return wrap;
    }
    updateDOM(dom, view) {
      if (!dom._isMdTable) return false;
      dom._model = this.model;
      const m = this.model;
      const sameDims =
        dom.querySelectorAll("thead th").length === m.header.length &&
        dom.querySelectorAll("tbody tr").length === m.rows.length;
      if (!sameDims) {
        closeMenu(dom);
        clearSel(dom);
        renderTable(dom);
        if (dom._syncAddCol) dom._syncAddCol();
        return true;
      }
      dom.querySelectorAll("th, td").forEach((cell) => {
        const r = Number(cell.dataset.r);
        const c = Number(cell.dataset.c);
        const raw = getCell(m, r, c);
        cell.style.textAlign = m.aligns[c] || "left";
        if (cell === document.activeElement) {
          cell.dataset.raw = raw;
          return;
        }
        if (cell.dataset.raw !== raw) {
          cell.dataset.raw = raw;
          cell.innerHTML = renderInline(raw);
          renderTableMath(cell);
        }
      });
      if (dom._syncAddCol) dom._syncAddCol();
      return true;
    }
    destroy(dom) {
      closeMenu(dom);
      clearSel(dom);
      if (dom._destroyHBar) dom._destroyHBar();
    }
    ignoreEvent() {
      return true;
    }
  }

  // A Table node only earns a rendered widget once it is actually complete:
  // header + delimiter + at least one body row (i.e. a minimum 1x1 grid).
  // While the user is still typing "| | |" / "|-|-|" the header-only node
  // would otherwise be replaced by a widget with the delimiter line left
  // dangling underneath it, because trimTableEnd() stops at the last
  // pipe-bearing TableHeader/TableRow and therefore excludes the delimiter.
  // Cell *content* is deliberately not checked — an all-empty row is still a
  // real 1x1 table and stays rendered so a skeleton can be filled in place.
  function isCompleteTable(state, node) {
    const c = node.node.cursor();
    if (!c.firstChild()) return false;
    do {
      if (
        c.name === "TableRow" &&
        state.doc.sliceString(c.from, c.to).includes("|")
      )
        return true;
    } while (c.nextSibling());
    return false;
  }

  function findTableRanges(state) {
    const ranges = [];
    syntaxTree(state).iterate({
      enter(node) {
        if (node.name !== "Table") return;
        if (!isCompleteTable(state, node)) return false;
        ranges.push({
          from: state.doc.lineAt(node.from).from,
          to: trimTableEnd(state, node),
        });
        return false;
      },
    });
    return ranges;
  }

  // Reveal the raw markdown whenever the selection touches the table — that is
  // what makes the source itself selectable and copyable with a normal drag.
  const isRevealed = (state, r) => {
    const sel = state.selection.main;
    return sel.from <= r.to && sel.to >= r.from;
  };

  // Revealing mid-drag is a layout feedback loop: the source block is a
  // different height than the widget, so everything below it shifts, the same
  // pointer coordinate now maps to a different document position, the
  // selection slips back off the table, the widget returns, the layout shifts
  // back — and that repeats for as long as the drag lasts. The cure is to make
  // the reveal monotone while the mouse button is down: once a table has
  // opened during this drag it stays open, so there is exactly one layout
  // change instead of an oscillation. The latch is released on mouseup, which
  // dispatches a selection transaction so the settled state is recomputed —
  // needed when the drag ends outside a table it merely passed through.
  const EMPTY_LATCH = new Set();
  let pointerSelecting = false;
  let latchUsed = false;

  const dragTracker = EditorView.domEventHandlers({
    mousedown(_e, view) {
      if (pointerSelecting) return false;
      pointerSelecting = true;
      latchUsed = false;
      const onUp = () => {
        window.removeEventListener("mouseup", onUp, true);
        pointerSelecting = false;
        if (!latchUsed || !view.dom.isConnected) return;
        view.dispatch({ selection: view.state.selection });
      };
      window.addEventListener("mouseup", onUp, true);
      return false;
    },
  });

  // Range starts whose source should be showing: the ones the selection
  // touches, plus the ones the latch is holding open for the current drag.
  // Keyed by `from` rather than array index so a mid-drag reparse that
  // rebuilds the ranges array doesn't drop the latch.
  function revealedSet(state, ranges, latch) {
    const out = new Set();
    for (const r of ranges)
      if (isRevealed(state, r) || latch.has(r.from)) out.add(r.from);
    return out;
  }

  const sameSet = (a, b) => {
    if (a.size !== b.size) return false;
    for (const v of a) if (!b.has(v)) return false;
    return true;
  };

  function buildDecosFromRanges(state, ranges, revealed) {
    const decos = [];
    for (const r of ranges) {
      if (revealed.has(r.from)) continue;
      decos.push(
        Decoration.replace({
          widget: new TableWidget(state.doc.sliceString(r.from, r.to)),
          block: true,
        }).range(r.from, r.to),
      );
    }
    return Decoration.set(decos);
  }

  const tableField = StateField.define({
    create(state) {
      const ranges = findTableRanges(state);
      const revealed = revealedSet(state, ranges, EMPTY_LATCH);
      return {
        tree: syntaxTree(state),
        ranges,
        revealed,
        decos: buildDecosFromRanges(state, ranges, revealed),
      };
    },
    update(value, tr) {
      const tree = syntaxTree(tr.state);
      const treeChanged = tree !== value.tree;
      if (!tr.docChanged && !tr.selection && !treeChanged) return value;
      let ranges = value.ranges;
      if (tr.docChanged) {
        const mapped = [];
        for (const r of ranges) {
          const from = tr.changes.mapPos(r.from, -1);
          const to = tr.changes.mapPos(r.to, 1);
          if (from < to) mapped.push({ from, to });
        }
        let needsRescan = mapped.length !== ranges.length;
        tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
          if (needsRescan) return;
          if (inserted.toString().includes("|")) {
            needsRescan = true;
            return;
          }
          if (tr.startState.doc.sliceString(fromA, toA).includes("|")) {
            needsRescan = true;
            return;
          }
          const near = mapped.some(
            (r) => fromB <= r.to + 1 && toB >= r.from - 1,
          );
          if (near) needsRescan = true;
        });
        ranges = needsRescan ? findTableRanges(tr.state) : mapped;
      } else if (treeChanged) {
        ranges = findTableRanges(tr.state);
      }
      // A doc change remaps positions, so the latch keys are stale — drop it.
      const latch =
        pointerSelecting && !tr.docChanged ? value.revealed : EMPTY_LATCH;
      const revealed = revealedSet(tr.state, ranges, latch);
      if (pointerSelecting && revealed.size) latchUsed = true;
      // A pure selection move that changes nothing about what is rendered (the
      // common case while dragging across the document) reuses the existing
      // decoration set instead of re-parsing every table into a fresh widget.
      if (
        !tr.docChanged &&
        ranges === value.ranges &&
        sameSet(revealed, value.revealed)
      )
        return { tree, ranges, revealed, decos: value.decos };
      return {
        tree,
        ranges,
        revealed,
        decos: buildDecosFromRanges(tr.state, ranges, revealed),
      };
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.decos),
  });

  return [dragTracker, tableField];
}
