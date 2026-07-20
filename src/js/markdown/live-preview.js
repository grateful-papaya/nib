// live-preview.js
//
// The ViewPlugin that owns the live-preview decoration set. It holds the
// per-document scan (scanner.js) and decides, per update, whether to rescan,
// re-assemble from the cache, or freeze.

export function createLivePreviewPlugin({
  ViewPlugin,
  Decoration,
  syntaxTree,
  scanDoc,
  assemble,
  isReadMode,
}) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.tree = null;
        this.scan = null;
        this.sig = null;
        this.pendingRefresh = false;
        this.pointerDragging = false;
        this.detached = false;
        this.decorations = Decoration.none;

        // Releasing a pointer drag produces no transaction of its own, so work
        // deferred in update() would sit stale until the next keystroke. A
        // window-level (drags routinely end outside the editor) mouseup clears
        // the drag flag and dispatches one empty transaction to run it;
        // setTimeout lets CodeMirror finish its own mouseup handling first.
        this.onWinMouseUp = () => {
          this.pointerDragging = false;
          if (!this.pendingRefresh) return;
          setTimeout(() => {
            // "reveal.sync": both this plugin and the math field key off it to
            // reconcile after a drag. Deliberately NOT named under
            // "select.pointer" — isUserEvent matches by dot-prefix, so anything
            // under that name would re-trigger the freezes it exists to release.
            if (!this.detached) view.dispatch({ userEvent: "reveal.sync" });
          }, 0);
        };
        window.addEventListener("mouseup", this.onWinMouseUp);
        this.refresh(view.state, true);
      }

      destroy() {
        this.detached = true;
        window.removeEventListener("mouseup", this.onWinMouseUp);
      }

      update(update) {
        // ── IME composition guard ────────────────────────────────────────
        // While a hangul/CJK preedit is active, never rebuild the decoration
        // set. Each preedit keystroke is a doc change; rebuilding makes
        // CodeMirror reconcile the composed line's DOM while the IME still
        // owns uncommitted text there. With a replace widget on the ListMark
        // that reconciliation surfaces the raw literal ("1.") next to the
        // rendered marker — which reads as an extra nesting level — and the
        // DOM reader can even feed the duplicate back into the document.
        // Freeze instead: map the existing decorations through the changes so
        // positions stay correct, and defer the rebuild to composition end
        // (composeEndNudge guarantees an update fires then).
        if (update.view.composing || update.view.compositionStarted === true) {
          if (update.docChanged)
            this.decorations = this.decorations.map(update.changes);
          this.pendingRefresh = true;
          return;
        }

        // Flipping read mode changes every reveal decision but touches neither
        // the doc, the selection nor the tree, so nothing below would fire and
        // whatever was revealed at the flip would stay raw. Reassemble now, and
        // drop drag bookkeeping since the gesture's reveal state is moot.
        if (isReadMode(update.startState) !== isReadMode(update.state)) {
          this.pointerDragging = false;
          this.pendingRefresh = false;
          this.refresh(update.state, false);
          return;
        }

        // ── Pointer-drag live reveal ─────────────────────────────────────
        // While a mouse selection is extended, re-assemble LIVE in both
        // directions: content the selection sweeps unrenders immediately,
        // content it leaves re-renders immediately.
        //
        // The drag state is STATEFUL rather than per-update because in long
        // documents the incremental parser keeps progressing in the background
        // and each progression fires an update that is not "select.pointer";
        // those keep deferring, since a rescan mid-gesture would rebuild
        // rangeItems and restyle the document's tail under the pointer.
        // pendingRefresh stays armed for the whole drag so the mouseup
        // listener always dispatches the "reveal.sync" that runs the deferred
        // rescan.
        if (this.pointerDragging) {
          const pointer = update.transactions.some((tr) =>
            tr.isUserEvent("select.pointer"),
          );
          if (!update.docChanged && (pointer || !update.selectionSet)) {
            if (pointer && this.scan) this.liveAssemble(update.state);
            this.pendingRefresh = true;
            return;
          }
          // A doc change or non-pointer selection can't happen mid-drag: the
          // release was missed (button let go outside the window, focus loss).
          // Unstick and fall through to normal handling.
          this.pointerDragging = false;
        } else if (
          update.selectionSet &&
          !update.docChanged &&
          !update.state.selection.main.empty &&
          update.transactions.some((tr) => tr.isUserEvent("select.pointer"))
        ) {
          this.pointerDragging = true;
          this.pendingRefresh = true; // arms the mouseup reveal.sync nudge
          if (this.scan) this.liveAssemble(update.state);
          return;
        }

        if (this.pendingRefresh) {
          this.pendingRefresh = false;
          this.refresh(update.state, true);
          return;
        }

        // Rescan when the doc changed OR the syntax tree progressed (large
        // documents parse incrementally in the background; without this the
        // tail would stay unstyled after the parse finishes).
        const tree = syntaxTree(update.state);
        if (update.docChanged || tree !== this.tree) {
          this.refresh(update.state, true);
          return;
        }

        // Selection-only change: re-assemble from the cache. The signature
        // check inside assemble() makes moves that don't alter any reveal
        // state completely free.
        if (update.selectionSet) this.refresh(update.state, false);
      }

      refresh(state, rescan) {
        try {
          if (rescan || !this.scan) {
            this.tree = syntaxTree(state);
            this.scan = scanDoc(state, this.tree);
            this.sig = null;
          }
          this.apply(assemble(this.scan, state, this.sig));
        } catch (err) {
          // Never let a build error kill the plugin, which would drop every
          // decoration permanently. Log and fall back for this pass only.
          console.warn("[markdown-preview] build error:", err);
          this.decorations = Decoration.none;
          this.scan = null;
          this.sig = null;
        }
      }

      // Mid-drag assembly: the same cache-only path as a normal selection
      // change. Separate from refresh() only for the catch — a build error
      // mid-gesture must keep the CURRENT decorations rather than flash the
      // document unstyled.
      liveAssemble(state) {
        try {
          this.apply(assemble(this.scan, state, this.sig));
        } catch (err) {
          console.warn("[markdown-preview] drag assemble error:", err);
        }
      }

      apply(res) {
        if (!res) return; // reveal state unchanged
        this.decorations = res.deco;
        this.sig = res.sig;
      }
    },
    { decorations: (v) => v.decorations },
  );
}
