// keymaps.js
//
// Keyboard and pointer input handling for the live preview: ctrl/cmd-click link
// opening, list-aware Tab, list/blockquote-aware Enter, and the auto-close /
// type-over / stacking input handler, plus the language-data override that
// disables the built-in bracket closer and HTML autocomplete. Factory form —
// everything closes over CodeMirror symbols from the dynamic bundle.

export function createKeymaps({
  EditorView,
  syntaxTree,
  keymap,
  Prec,
  insertNewlineContinueMarkupCommand,
  markdownLanguage,
  openSearchPanel = null, // optional: @codemirror/search, if the bundle exports it
}) {
  const linkClick = EditorView.domEventHandlers({
    mousedown(event, view) {
      if (!(event.ctrlKey || event.metaKey)) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos == null) return false;
      let node = syntaxTree(view.state).resolveInner(pos, 0);
      let link = null;
      while (node) {
        if (node.name === "Link" || node.name === "Image") {
          link = node;
          break;
        }
        node = node.parent;
      }
      if (!link) return false;
      let url = null;
      const c = link.cursor();
      if (c.firstChild()) {
        do {
          if (c.name === "URL") {
            url = view.state.doc.sliceString(c.from, c.to);
            break;
          }
        } while (c.nextSibling());
      }
      if (!url) return false;
      event.preventDefault();
      // Intentional window.app interop boundary (dynamic-import module, see
      // note in image-resolver.js). The typeof guard covers the async-load race
      // where this view can mount before window.app is wired; window.open is
      // the fallback. Do not migrate to a state module.
      if (window.app && typeof window.app.openExternalLink === "function") {
        window.app.openExternalLink(url);
      } else {
        window.open(url, "_blank");
      }
      return true;
    },
  });

  // ── Tab: indent inside lists, otherwise insert spaces ────────────────────
  const isInList = (state, pos) => {
    let node = syntaxTree(state).resolve(pos, -1);
    while (node) {
      if (
        node.name === "OrderedList" ||
        node.name === "BulletList" ||
        node.name === "ListItem"
      )
        return true;
      node = node.parent;
    }
    return false;
  };

  const tabKeymap = keymap.of([
    {
      key: "Tab",
      run(view) {
        const pos = view.state.selection.main.head;
        const line = view.state.doc.lineAt(pos);
        if (isInList(view.state, pos)) {
          // Would the marker still be a list marker after indenting? CommonMark
          // allows a nested item only up to (parent's content column + 3);
          // one Tab past that turns the line into a lazy paragraph
          // continuation — the marker stops parsing, the computed label
          // (e.g. "2.2.4.5.") vanishes, and the raw literal ("5.") leaks
          // through. Simulate the indent on the enclosing top-level list and
          // reparse: if the marker doesn't survive, swallow the Tab (no-op)
          // instead of silently breaking the item out of the list.
          const m2 = /^((?:[ \t]|>[ \t]*)*)(?:([-*+])|(\d+)([.)]))(?=\s|$)/.exec(
            line.text,
          );
          if (m2) {
            const sim = simulateIndent(view.state, line, m2[1].length);
            if (!sim) return true; // consume Tab, change nothing
            const changes = [{ from: line.from, insert: "    " }];
            // Ordered marker: the literal number stays in the source after the
            // indent, and computeOrderedLabels seeds a nested list from its
            // FIRST item's literal (CommonMark start-number). So Tab-ing "3."
            // under item 2 would display "2.3." — rewrite the literal to the
            // number the item actually has in its post-indent list ("1." when
            // it starts a new nested list, prev sibling + 1 when it joins one)
            // so Nib and external renderers both show "2.1.".
            if (sim.number != null && m2[3] != null) {
              const cur = parseInt(m2[3], 10);
              if (sim.number !== cur) {
                const numFrom = line.from + m2[1].length;
                changes.push({
                  from: numFrom,
                  to: numFrom + m2[3].length,
                  insert: String(sim.number),
                });
              }
            }
            view.dispatch({ changes, userEvent: "input.indent" });
            return true;
          }
          view.dispatch({
            changes: { from: line.from, insert: "    " },
            userEvent: "input.indent",
          });
        } else {
          view.dispatch({
            changes: { from: pos, insert: "    " },
            userEvent: "input",
          });
        }
        return true;
      },
      shift(view) {
        const pos = view.state.selection.main.head;
        if (!isInList(view.state, pos)) return false;
        const line = view.state.doc.lineAt(pos);
        const m = /^ {1,4}/.exec(line.text);
        if (!m) return true;
        view.dispatch({
          changes: { from: line.from, to: line.from + m[0].length, insert: "" },
          userEvent: "input.indent",
        });
        return true;
      },
    },
  ]);

  // Reparse the enclosing outermost list with 4 extra leading spaces on
  // `line` and report what the marker (starting at 0-based column
  // `markerCol` of line.text) becomes. Scoped to the list, not the whole doc,
  // so it stays cheap even in large files; the slice keeps each line's own
  // text (quote ">" prefixes included), so context survives the cut.
  //
  // Returns:
  //   null                → the marker no longer parses as a ListMark
  //                         (indent would break the item into a lazy
  //                         paragraph continuation) — caller swallows the Tab
  //   { number: null }    → bullet marker survives; nothing to renumber
  //   { number: N }       → ordered marker survives; N is the literal the
  //                         item should carry in its post-indent list:
  //                         1 when it opens a new nested list, previous
  //                         ordered sibling's literal + 1 when it joins one.
  function simulateIndent(state, line, markerCol) {
    const doc = state.doc;
    // Outermost list ancestor → slice start (its first line).
    let node = syntaxTree(state).resolve(line.from + markerCol, 1);
    let outer = null;
    while (node) {
      if (node.name === "OrderedList" || node.name === "BulletList")
        outer = node;
      node = node.parent;
    }
    const sliceFrom = doc.lineAt(outer ? outer.from : line.from).from;
    const cut = line.from - sliceFrom;
    const src = doc.sliceString(sliceFrom, line.to);
    const indented = src.slice(0, cut) + "    " + src.slice(cut);
    const markerPos = cut + 4 + markerCol; // marker's first char, post-indent
    const tree = markdownLanguage.parser.parse(indented);
    let n = tree.resolveInner(markerPos, 1);
    while (n && n.name !== "ListMark") n = n.parent;
    if (!n) return null; // marker doesn't survive the indent
    if (!/^\d/.test(indented.slice(n.from, n.to))) return { number: null };

    // Ordered: locate our ListItem inside its (post-indent) OrderedList and
    // read the literal of the nearest ordered sibling ABOVE it. First item of
    // the list → 0 + 1 = 1.
    const item = n.parent; // ListItem
    const list = item && item.parent; // OrderedList
    let prevNum = 0;
    if (list) {
      for (let ch = list.firstChild; ch; ch = ch.nextSibling) {
        if (ch.from >= item.from) break;
        if (ch.name !== "ListItem") continue;
        const mark = ch.getChild("ListMark");
        if (!mark) continue;
        const mNum = /^(\d+)/.exec(indented.slice(mark.from, mark.to));
        if (mNum) prevNum = parseInt(mNum[1], 10);
      }
    }
    return { number: prevNum + 1 };
  }

  // ── Enter: continue/exit lists and blockquotes ──────────────────────────
  // Backspace is intentionally left to CodeMirror's default so deleting a marker
  // happens one character at a time (space → "." → "1"), like plain text, rather
  // than wiping the whole marker in a single press.
  // The default markdown Enter turns a tight two-item list "loose" instead of
  // exiting. nonTightLists:false makes an empty item's Enter delete the marker.
  // Prec.highest so it beats markdown()'s built-in Enter (Prec.high).
  const continueMarkup = insertNewlineContinueMarkupCommand({
    nonTightLists: false,
  });
  const enterKeymap = Prec.highest(
    keymap.of([
      {
        // Empty blockquote line ("> ", ">", nested "> > " …, no content): a
        // single Enter should drop the marker and exit the quote — NOT continue.
        // The built-in continueMarkup command clears the marker but still opens
        // a fresh quoted line, so it took two presses to actually leave. Handle
        // the exit here; return false for anything else so continuation still
        // runs for non-empty quote lines and for lists.
        key: "Enter",
        run: (view) => {
          const { state } = view;
          const sel = state.selection.main;
          if (!sel.empty) return false;
          const line = state.doc.lineAt(sel.head);
          if (!/^[ \t]*>(?:[ \t]*>)*[ \t]*$/.test(line.text)) return false;
          view.dispatch({
            changes: { from: line.from, to: line.to, insert: "" },
            selection: { anchor: line.from },
            userEvent: "delete",
          });
          return true;
        },
      },
      {
        key: "Enter",
        run: (view) => continueMarkup(view),
      },
    ]),
  );

  // ── Auto-close / type-over / stacking pairs ──────────────────────────────
  // English-only, so we can auto-close "[" too. Behavior:
  //   - Type an opener with empty selection -> insert opener+closer, caret between.
  //   - Type a closer when the next char is the same closer -> "type over" it
  //     (move past), UNLESS the caret sits between an empty pair (e.g. *|*),
  //     in which case we stack ( *|*  ->  **|**  ->  ***|*** ).
  const PAIRS = { "(": ")", "[": "]", "`": "`", "*": "*", _: "_", $: "$" };
  const CLOSERS = new Set([")", "]", "`", "*", "_", "$"]);
  const autoPair = EditorView.inputHandler.of((view, from, to, text) => {
    const sel = view.state.selection;
    if (sel.ranges.length !== 1 || !sel.main.empty) return false;
    if (from !== to) return false;

    const doc = view.state.doc;
    const after = doc.sliceString(to, to + 1);

    // Strikethrough uses a DOUBLE marker "~~", so it can't ride the single-char
    // pair path (a lone "~" means nothing). Handle "~" on its own:
    //   - caret right before a "~"            → type-over (step past it)
    //   - second "~" of an opener (prev is    → close the pair: "~~|~~"
    //     "~", the one before it isn't)
    //   - otherwise (the first "~")           → just type it literally
    if (text === "~") {
      if (after === "~") {
        view.dispatch({ selection: { anchor: to + 1 }, userEvent: "move" });
        return true;
      }
      const before = doc.sliceString(from - 1, from);
      const before2 = doc.sliceString(from - 2, from - 1);
      if (before === "~" && before2 !== "~") {
        view.dispatch({
          changes: { from, insert: "~~~" }, // typed "~" + the two closers
          selection: { anchor: from + 1 },
          userEvent: "input.type",
        });
        return true;
      }
      return false;
    }

    // type-over / stacking (only for symmetric markers; brackets fall through)
    if (CLOSERS.has(text) && after === text) {
      const line = doc.lineAt(from);
      const lineText = line.text;
      const col = from - line.from;

      // count same symbols immediately before the caret (already-closed run)
      let closeRun = 0;
      while (col - 1 - closeRun >= 0 && lineText[col - 1 - closeRun] === text)
        closeRun++;

      // char just left of that run = end of content (or an opening symbol)
      const contentEnd = col - 1 - closeRun;
      let i = contentEnd;
      while (i >= 0 && lineText[i] !== text) i--; // skip content leftward

      const hasContent = contentEnd > i; // content between closer-run and opener?
      const isStacking = !hasContent && closeRun > 0;

      view.dispatch(
        isStacking
          ? {
              changes: [
                { from, insert: text }, // opener side
                { from: to, insert: text }, // closer side
              ],
              selection: { anchor: from + 1 },
              userEvent: "input.type",
            }
          : { selection: { anchor: to + 1 }, userEvent: "move" },
      );
      return true;
    }

    // auto-close
    const close = PAIRS[text];
    if (!close) return false;
    // skip if a non-space word char follows (don't split a word/token)
    if (after && /\S/.test(after) && !")]}`*_$".includes(after)) return false;
    view.dispatch({
      changes: { from, insert: text + close },
      selection: { anchor: from + 1 },
      userEvent: "input.type",
    });
    return true;
  });

  // basicSetup's closeBrackets() fights our inputHandler; keep it disabled so we
  // are the single source of auto-pairing. Also neutralize the language's
  // autocomplete so typing "<" doesn't pop an HTML-tag dropdown. The autocomplete
  // languageData must be a completion SOURCE function (returning null = no
  // completions), not a boolean — a boolean throws "active.source is not a
  // function".
  const noAutoClose = markdownLanguage.data.of({
    closeBrackets: { brackets: [] },
    autocomplete: () => null,
  });

  // ── Search shortcuts ──────────────────────────────────────────────────────
  // Mod-f: basicSetup's searchKeymap opens CodeMirror's own search panel,
  // which double-fires with the app's document-level Ctrl+F handler (the
  // titlebar search) — both UIs appeared at once. This highest-precedence
  // binding preempts the searchKeymap one and simply reports the key as
  // handled. CodeMirror preventDefaults handled keys but does NOT stop
  // propagation (verified against @codemirror/view's keymap dispatch), so
  // the event still bubbles to document and the titlebar search opens as
  // the single Ctrl+F surface.
  //
  // Mod-h: in-document find & replace via CodeMirror's search panel (the
  // panel contains the replace row). The titlebar search only finds across
  // files; replace has to live in the editor. Requires the vendored bundle
  // to export openSearchPanel from @codemirror/search — if it doesn't, the
  // binding is still consumed (so the browser/Electron default can't fire)
  // and a console warning explains what to add to the bundle.
  const searchKeys = Prec.highest(
    keymap.of([
      { key: "Mod-f", run: () => true },
      {
        key: "Mod-h",
        run: (view) => {
          if (openSearchPanel) return openSearchPanel(view);
          console.warn(
            "[keymaps] Mod-h needs the bundle to export openSearchPanel " +
              '(add `export { openSearchPanel } from "@codemirror/search";` ' +
              "to the codemirror bundle entry)",
          );
          return true;
        },
      },
    ]),
  );

  return {
    linkClick,
    tabKeymap,
    enterKeymap,
    autoPair,
    noAutoClose,
    searchKeys,
  };
}
