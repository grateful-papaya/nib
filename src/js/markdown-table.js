// markdown-table.js
//
// GFM table live-preview + visual editing CodeMirror extension. The layers
// below it live in ./markdown/:
//   table-model.js  parse / mutate / serialize / render inline content (pure)
//   table-cells.js  the cell grid DOM, caret helpers, selection painting
//   table-menu.js   context menus (DOM only)
//   table-doc.js    mapping a widget back to its markdown source
//   table-view.js   the widget's interactive behaviour
// This file owns the CodeMirror-facing pieces: the widget, the drag latch and
// the decoration field.

import { parseTable } from "./markdown/table-model.js";
import { renderTable, syncCells, clearSel } from "./markdown/table-cells.js";
import { closeMenu } from "./markdown/table-menu.js";
import { createTableDoc } from "./markdown/table-doc.js";
import { createTableView } from "./markdown/table-view.js";

export async function getTableExtension() {
  const cm = await import("./libs/codemirror.js");
  const { EditorView, Decoration, WidgetType, syntaxTree, StateField } = cm;
  if (!StateField)
    throw new Error(
      "libs/codemirror.js does not export StateField — add " +
        '`export { StateField } from "@codemirror/state";` to the bundle entry ' +
        "and rebuild",
    );

  const tableDoc = createTableDoc({ syntaxTree });
  const { findTableRanges } = tableDoc;
  const { buildDOM, destroyDOM } = createTableView(tableDoc);

  // Read-only and non-editable are separate switches in CodeMirror and either
  // one means "reader".
  const isReadMode = (state) =>
    state.readOnly || state.facet(EditorView.editable) === false;

  const sameSet = (a, b) => {
    if (a.size !== b.size) return false;
    for (const v of a) if (!b.has(v)) return false;
    return true;
  };

  class TableWidget extends WidgetType {
    constructor(text, readOnly) {
      super();
      this.text = text;
      this.readOnly = !!readOnly;
      this.model = parseTable(text);
    }

    eq(other) {
      return other.text === this.text && other.readOnly === this.readOnly;
    }

    toDOM(view) {
      const wrap = document.createElement("div");
      wrap._model = this.model;
      wrap._readOnly = this.readOnly;
      buildDOM(wrap, view);
      return wrap;
    }

    updateDOM(dom) {
      if (!dom._isMdTable) return false;
      // An editable table and a read-mode one are different DOM entirely
      // (handles, bars and listeners exist or don't), so a mode flip can't be
      // patched in place — returning false makes CodeMirror throw this one away
      // and call toDOM() again.
      if (!!dom._readOnly !== this.readOnly) return false;

      dom._model = this.model;
      const m = this.model;
      const dims = dom._dims;
      // Same grid: patch cell content and keep the caret. Different grid: the
      // row/column structure changed, so rebuild and drop menu/selection state
      // that referenced the old coordinates.
      if (!dims || dims.cols !== m.header.length || dims.rows !== m.rows.length) {
        closeMenu(dom);
        clearSel(dom);
        renderTable(dom);
      } else {
        syncCells(dom, m);
      }
      dom._syncAddCol?.();
      return true;
    }

    destroy(dom) {
      destroyDOM(dom);
    }

    ignoreEvent() {
      // Editable tables handle their own mouse work (cell focus, rectangle
      // selection, handles), so CodeMirror must keep its hands off. A read-mode
      // table has no such handling and the one thing it must support is
      // selection, so its events go to CodeMirror instead.
      return !this.readOnly;
    }
  }

  // Reveal the raw markdown whenever the selection touches the table — that is
  // what makes the source itself selectable and copyable with a normal drag. In
  // read mode there is nothing to edit, so tables never drop back to source.
  const isRevealed = (state, r) => {
    if (isReadMode(state)) return false;
    const sel = state.selection.main;
    return sel.from <= r.to && sel.to >= r.from;
  };

  // Revealing mid-drag is a layout feedback loop: the source block is a
  // different height than the widget, so everything below it shifts, the same
  // pointer coordinate now maps to a different document position, the selection
  // slips back off the table, the widget returns, the layout shifts back — for
  // as long as the drag lasts. The cure is to make the reveal monotone while
  // the button is down: once a table has opened during this drag it stays open,
  // so there is exactly one layout change instead of an oscillation. The latch
  // is released on mouseup, which dispatches a selection transaction so the
  // settled state is recomputed (needed when the drag ends outside a table it
  // merely passed through).
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

  // Range starts whose source should be showing: the ones the selection touches
  // plus the ones the latch holds open for the current drag. Keyed by `from`
  // rather than array index, so a mid-drag reparse that rebuilds the ranges
  // array doesn't drop the latch.
  function revealedSet(state, ranges, latch) {
    const out = new Set();
    for (const r of ranges)
      if (isRevealed(state, r) || latch.has(r.from)) out.add(r.from);
    return out;
  }

  function buildDecos(state, ranges, revealed) {
    const decos = [];
    const readOnly = isReadMode(state);
    for (const r of ranges) {
      if (revealed.has(r.from)) continue;
      decos.push(
        Decoration.replace({
          widget: new TableWidget(state.doc.sliceString(r.from, r.to), readOnly),
          block: true,
        }).range(r.from, r.to),
      );
    }
    return Decoration.set(decos);
  }

  // Which ranges survive a document change without a full rescan: only edits
  // that touch a pipe, or land next to a known table, can change the set.
  function remapRanges(tr, ranges) {
    const mapped = [];
    for (const r of ranges) {
      const from = tr.changes.mapPos(r.from, -1);
      const to = tr.changes.mapPos(r.to, 1);
      if (from < to) mapped.push({ from, to });
    }
    let rescan = mapped.length !== ranges.length;
    tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
      if (rescan) return;
      if (
        inserted.toString().includes("|") ||
        tr.startState.doc.sliceString(fromA, toA).includes("|") ||
        mapped.some((r) => fromB <= r.to + 1 && toB >= r.from - 1)
      )
        rescan = true;
    });
    return rescan ? findTableRanges(tr.state) : mapped;
  }

  const tableField = StateField.define({
    create(state) {
      const ranges = findTableRanges(state);
      const revealed = revealedSet(state, ranges, EMPTY_LATCH);
      return {
        tree: syntaxTree(state),
        ranges,
        revealed,
        decos: buildDecos(state, ranges, revealed),
      };
    },

    update(value, tr) {
      const tree = syntaxTree(tr.state);
      const treeChanged = tree !== value.tree;
      // Switching in or out of read mode changes what should be revealed but
      // touches neither the doc, the selection nor the tree, so it needs its own
      // trigger or the old state would linger until the next edit.
      const modeChanged = isReadMode(tr.startState) !== isReadMode(tr.state);
      if (!tr.docChanged && !tr.selection && !treeChanged && !modeChanged)
        return value;

      let ranges = value.ranges;
      if (tr.docChanged) ranges = remapRanges(tr, ranges);
      else if (treeChanged) ranges = findTableRanges(tr.state);

      // A doc change remaps positions, so the latch keys are stale — drop it.
      const latch =
        pointerSelecting && !tr.docChanged ? value.revealed : EMPTY_LATCH;
      const revealed = revealedSet(tr.state, ranges, latch);
      if (pointerSelecting && revealed.size) latchUsed = true;

      // A pure selection move that changes nothing about what is rendered (the
      // common case while dragging across the document) reuses the existing
      // decoration set instead of re-parsing every table into a fresh widget.
      const unchanged =
        !tr.docChanged &&
        !modeChanged &&
        ranges === value.ranges &&
        sameSet(revealed, value.revealed);

      return {
        tree,
        ranges,
        revealed,
        decos: unchanged ? value.decos : buildDecos(tr.state, ranges, revealed),
      };
    },

    provide: (f) => EditorView.decorations.from(f, (v) => v.decos),
  });

  return [dragTracker, tableField];
}
