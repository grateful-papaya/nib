// table-doc.js
//
// Everything that maps between a rendered table widget and the markdown source
// behind it: locating the Table node, writing the model back, deleting the
// block, and moving the caret out of it. Factory form — it needs syntaxTree
// from the dynamically imported bundle.

import { serializeTable, escCell } from "./table-model.js";

export function createTableDoc({ syntaxTree }) {
  // The end of the last pipe-bearing header/row line. The Table node itself can
  // run past the last real row (trailing blank content), so this trims it back.
  function trimTableEnd(state, node) {
    let lastPipeTo = node.from;
    const c = node.node.cursor();
    if (c.firstChild()) {
      do {
        if (
          (c.name === "TableHeader" || c.name === "TableRow") &&
          state.doc.sliceString(c.from, c.to).includes("|")
        )
          lastPipeTo = c.to;
      } while (c.nextSibling());
    }
    return state.doc.lineAt(Math.max(node.from, lastPipeTo - 1)).to;
  }

  // A Table node only earns a rendered widget once it is actually complete:
  // header + delimiter + at least one body row. While the user is still typing
  // "| | |" / "|-|-|" the header-only node would otherwise be replaced by a
  // widget with the delimiter line dangling underneath, because trimTableEnd()
  // stops at the last pipe-bearing row and so excludes the delimiter. Cell
  // CONTENT is deliberately not checked — an all-empty row is still a real 1x1
  // table and stays rendered so a skeleton can be filled in place.
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

  // Source range of the table a widget stands for, resolved through the
  // widget's DOM position so it survives edits elsewhere in the document.
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

  // Full rewrite: re-serializes the whole table (column widths realign).
  // `focus` optionally re-focuses a cell once the new widget DOM exists.
  function commit(view, wrap, focus) {
    const range = tableRange(view, wrap);
    if (!range) return;
    const text = serializeTable(wrap._model);
    if (view.state.doc.sliceString(range.from, range.to) !== text)
      view.dispatch({
        changes: { from: range.from, to: range.to, insert: text },
        userEvent: "input.table",
      });
    if (!focus) return;
    requestAnimationFrame(() => {
      const cell = wrap.querySelector(
        `[data-r="${focus.r}"][data-c="${focus.c}"]`,
      );
      if (cell) cell.focus();
    });
  }

  // Typing path: rewrite only the edited row. Skips the O(cells) re-serialize
  // and, more importantly, leaves the other lines untouched so the caret in the
  // focused cell is never disturbed. Column padding is realigned by the next
  // full commit (on blur).
  function commitRowFast(view, wrap, r) {
    const range = tableRange(view, wrap);
    if (!range) return;
    const doc = view.state.doc;
    // Line layout is header, delimiter, then body rows.
    const targetIdx = doc.lineAt(range.from).number + (r < 0 ? 0 : r + 2);
    if (targetIdx > doc.lines) return;

    const line = doc.line(targetIdx);
    const row = r < 0 ? wrap._model.header : wrap._model.rows[r];
    if (!row) return;
    const text = "| " + row.map(escCell).join(" | ") + " |";
    if (line.text === text) return;
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: text },
      userEvent: "input.table.fast",
    });
  }

  function removeTable(view, wrap) {
    const range = tableRange(view, wrap);
    if (!range) return;
    view.dispatch({
      changes: { from: range.from, to: Math.min(view.state.doc.length, range.to + 1) },
      selection: { anchor: range.from },
      userEvent: "delete.table",
    });
    view.focus();
  }

  // Move the caret to the line above or below the table, creating one when the
  // table is flush against the start or end of the document.
  function exitTable(view, wrap, above) {
    const range = tableRange(view, wrap);
    if (!range) return;
    const doc = view.state.doc;
    if (above) {
      if (doc.lineAt(range.from).number === 1)
        view.dispatch({ changes: { from: 0, insert: "\n" }, selection: { anchor: 0 } });
      else view.dispatch({ selection: { anchor: doc.lineAt(range.from).from - 1 } });
    } else if (doc.lineAt(range.to).number === doc.lines) {
      view.dispatch({
        changes: { from: doc.length, insert: "\n" },
        selection: { anchor: doc.length + 1 },
      });
    } else {
      view.dispatch({ selection: { anchor: doc.lineAt(range.to).to + 1 } });
    }
    view.focus();
  }

  return {
    trimTableEnd,
    isCompleteTable,
    findTableRanges,
    tableRange,
    commit,
    commitRowFast,
    removeTable,
    exitTable,
  };
}
