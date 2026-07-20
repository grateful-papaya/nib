// code-hscroll.js
//
// Per-block horizontal scrolling for fenced code.
//
// Code lines are individual overflow-x containers (see the CSS), so the browser
// gives each LINE panning; this plugin turns that into BLOCK panning: when any
// line of a fence scrolls, every line of that fence follows. It also survives
// CodeMirror recreating line DOM (which resets scrollLeft to 0) by remembering
// offsets per fence, keyed by the fence's start position and remapped through
// document changes.
//
// It also owns one floating scrollbar PER overflowing block (hscrollbar.js):
// per-line native scrollbars are hidden in CSS because a scrollbar on every
// line would be absurd, and no single line can host the bar (a short last
// line's own scroll range doesn't cover the block's). Bars live in
// scroller-content coordinates inside .cm-scroller, are created and positioned
// in a two-phase (read all, then write all) measure pass to avoid layout
// thrash, and pointer routing hits cached rects only — zero layout reads per
// mousemove.

import { createHBar, rafThrottle } from "./hscrollbar.js";

const TYPING_QUIET_MS = 500; // don't flash a bar right after a keystroke

export function createCodeBlockHScroll({ ViewPlugin, syntaxTree }) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.view = view;
        this.offsets = new Map(); // FencedCode.from -> scrollLeft
        this.bars = new Map(); // FencedCode.from -> { from, to, bar }
        this.syncing = false;
        this.destroyed = false;
        this.barsMeasureKey = {}; // stable requestMeasure dedupe key

        // Caret-follow scrolls while typing at an overflowing line would flash
        // the bar on every keystroke; suppress showTemp shortly after a keydown
        // (position sync still runs).
        this.lastKeyTs = 0;
        this.onKeyDown = () => {
          this.lastKeyTs = Date.now();
        };

        // One rAF-coalesced mousemove converts to content coordinates once,
        // then fans out to every bar's cached-metrics hit test.
        this.onMove = rafThrottle((clientX, clientY) => {
          if (this.destroyed || !this.bars.size) return;
          const sr = this.view.scrollDOM.getBoundingClientRect();
          const x = clientX - sr.left;
          const y = clientY - sr.top + this.view.scrollDOM.scrollTop;
          for (const rec of this.bars.values()) rec.bar.pointer(x, y);
        });
        this.onMoveEvent = (e) => {
          if (this.bars.size) this.onMove(e.clientX, e.clientY);
        };
        this.onLeave = () => {
          for (const rec of this.bars.values()) rec.bar.pointerLeave();
        };

        this.onScroll = (e) => {
          const el = e.target;
          if (!el || el.nodeType !== 1 || !el.classList?.contains("cm-line"))
            return;
          if (!el.classList.contains("cm-md-code-line")) return;
          if (this.syncing) return;
          let pos;
          try {
            pos = view.posAtDOM(el, 0);
          } catch {
            return;
          }
          const block = this.blockAt(pos);
          if (!block) return;
          // The equality check both dedupes and terminates the echo loop: our
          // own sibling writes fire scroll events asynchronously, after the
          // syncing flag has already been cleared.
          if (this.offsets.get(block.from) === el.scrollLeft) return;
          this.offsets.set(block.from, el.scrollLeft);
          this.applyBlock(block.from, block.to, el.scrollLeft, el);

          const rec = this.bars.get(block.from);
          if (rec && Date.now() - this.lastKeyTs > TYPING_QUIET_MS)
            rec.bar.showTemp();
          this.scheduleBarsRefresh();
          // Cursor/selection overlays are positioned from measured text
          // geometry; refresh them for the new offsets.
          view.requestMeasure();
        };

        view.scrollDOM.addEventListener("keydown", this.onKeyDown, true);
        view.scrollDOM.addEventListener("mousemove", this.onMoveEvent);
        view.scrollDOM.addEventListener("mouseleave", this.onLeave);
        // scroll doesn't bubble; capture catches it from descendant lines.
        view.scrollDOM.addEventListener("scroll", this.onScroll, true);
        this.scheduleBarsRefresh();
      }

      blockAt(pos) {
        let n = syntaxTree(this.view.state).resolveInner(pos, 1);
        while (n && n.name !== "FencedCode") n = n.parent;
        return n;
      }

      lineEl(pos) {
        try {
          let n = this.view.domAtPos(pos).node;
          while (n && !(n.classList && n.classList.contains("cm-line")))
            n = n.parentNode;
          return n;
        } catch {
          return null;
        }
      }

      // Line-number span of a block, clipped to the rendered viewport: lines
      // outside it have no DOM at all, so touching them is pure waste.
      visibleLines(from, to) {
        const doc = this.view.state.doc;
        if (to > doc.length) return null;
        const vp = this.view.viewport;
        const first = Math.max(
          doc.lineAt(from).number,
          doc.lineAt(Math.min(vp.from, doc.length)).number,
        );
        const last = Math.min(
          doc.lineAt(to).number,
          doc.lineAt(Math.min(vp.to, doc.length)).number,
        );
        return first > last ? null : { first, last, doc };
      }

      applyBlock(from, to, left, skipEl) {
        const span = this.visibleLines(from, to);
        if (!span) return;
        this.syncing = true;
        try {
          for (let ln = span.first; ln <= span.last; ln++) {
            const el = this.lineEl(span.doc.line(ln).from);
            if (el && el !== skipEl && el.scrollLeft !== left)
              el.scrollLeft = left;
          }
        } finally {
          this.syncing = false;
        }
      }

      // ── Scrollbar refresh ────────────────────────────────────────────────
      // Two-phase via requestMeasure: read() measures every visible fenced
      // block (rects + scrollWidths, batched with no interleaved writes),
      // write() creates/syncs/destroys bar DOM. The stable key dedupes to one
      // refresh per frame no matter how many callers ask.
      scheduleBarsRefresh() {
        this.view.requestMeasure({
          key: this.barsMeasureKey,
          read: (view) => this.readBars(view),
          write: (measured) => this.writeBars(measured),
        });
      }

      eachVisibleFence(view, fn) {
        const tree = syntaxTree(view.state);
        for (const { from, to } of view.visibleRanges) {
          tree.iterate({
            from,
            to,
            enter: (n) => {
              if (n.name !== "FencedCode") return;
              fn(n.from, n.to);
              return false;
            },
          });
        }
      }

      readBars(view) {
        const out = [];
        const sr = view.scrollDOM.getBoundingClientRect();
        const st = view.scrollDOM.scrollTop;
        this.eachVisibleFence(view, (from, to) => {
          out.push({ from, to, m: this.measureBlock(from, to, sr, st) });
        });
        return out;
      }

      // Metrics for one block in scroller-content coordinates (the
      // hscrollbar.js contract). Only code-line scroll containers count —
      // fence lines are collapsed non-containers in rendered mode. maxScroll
      // comes from the widest RENDERED line, so a huge block whose widest line
      // is offscreen underestimates until it scrolls in; the thumb just
      // recalibrates on the next refresh.
      measureBlock(from, to, sr, st) {
        const span = this.visibleLines(from, to);
        if (!span) return null;
        let maxSW = 0;
        let cw = 0;
        let sl = 0;
        let firstRect = null;
        let lastRect = null;
        for (let ln = span.first; ln <= span.last; ln++) {
          const el = this.lineEl(span.doc.line(ln).from);
          if (!el || !el.classList.contains("cm-md-code-line")) continue;
          if (el.scrollWidth > maxSW) maxSW = el.scrollWidth;
          if (el.scrollLeft > sl) sl = el.scrollLeft;
          cw = el.clientWidth;
          const r = el.getBoundingClientRect();
          if (!firstRect) firstRect = r;
          lastRect = r;
        }
        if (!firstRect) return null;
        const maxScroll = maxSW - cw;
        if (maxScroll <= 1) return null;

        // The intended offset beats the measured one: on the update that
        // recreates line DOM this read pass runs BEFORE the offsets-restore
        // write pass, so the lines still sit at 0.
        const intent = this.offsets.get(from);
        const left = lastRect.left - sr.left;
        const top = firstRect.top - sr.top + st;
        const bottom = lastRect.bottom - sr.top + st;
        return {
          trackLeft: left + 8,
          trackWidth: Math.max(0, lastRect.width - 16),
          y: bottom - 5, // thumb BOTTOM edge, flush near the block bottom
          scrollLeft: Math.min(intent != null ? intent : sl, maxScroll),
          clientWidth: cw,
          maxScroll,
          hoverRect: { left, right: left + lastRect.width, top, bottom },
        };
      }

      writeBars(measured) {
        if (this.destroyed) return;
        const seen = new Set();
        for (const item of measured) {
          seen.add(item.from);
          let rec = this.bars.get(item.from);
          if (!item.m) {
            if (rec) {
              rec.bar.destroy();
              this.bars.delete(item.from);
            }
            continue;
          }
          if (!rec) {
            rec = { from: item.from, to: item.to, bar: null };
            rec.bar = createHBar({
              container: this.view.scrollDOM,
              onDrag: (left) => {
                this.offsets.set(rec.from, left);
                this.applyBlock(rec.from, rec.to, left, null);
                this.scheduleBarsRefresh();
                this.view.requestMeasure();
              },
            });
            this.bars.set(item.from, rec);
          }
          rec.from = item.from;
          rec.to = item.to;
          rec.bar.sync(item.m);
        }
        for (const [key, rec] of this.bars) {
          if (!seen.has(key)) {
            rec.bar.destroy();
            this.bars.delete(key);
          }
        }
      }

      update(update) {
        if (update.docChanged) {
          const offsets = new Map();
          for (const [k, v] of this.offsets)
            offsets.set(update.changes.mapPos(k, 1), v);
          this.offsets = offsets;
          // Bars remap identically, so an edit above a block moves its record
          // (and its DOM) instead of destroy+recreate flicker.
          const bars = new Map();
          for (const [k, rec] of this.bars) {
            const pos = update.changes.mapPos(k, 1);
            const clash = bars.get(pos);
            if (clash) clash.bar.destroy(); // merged blocks: keep one bar
            rec.from = pos;
            bars.set(pos, rec);
          }
          this.bars = bars;
        }

        const layoutChanged =
          update.docChanged || update.viewportChanged || update.geometryChanged;
        if (!layoutChanged) return;
        this.scheduleBarsRefresh();

        // Line elements may have been recreated with scrollLeft 0; restore the
        // remembered offsets once the new DOM is in place.
        if (!this.offsets.size) return;
        this.view.requestMeasure({
          key: this,
          read: () => null,
          write: (_, view) => {
            this.eachVisibleFence(view, (from, to) => {
              const left = this.offsets.get(from);
              if (left) this.applyBlock(from, to, left, null);
            });
          },
        });
      }

      destroy() {
        this.destroyed = true;
        this.onMove.cancel();
        const sd = this.view.scrollDOM;
        sd.removeEventListener("scroll", this.onScroll, true);
        sd.removeEventListener("keydown", this.onKeyDown, true);
        sd.removeEventListener("mousemove", this.onMoveEvent);
        sd.removeEventListener("mouseleave", this.onLeave);
        for (const rec of this.bars.values()) rec.bar.destroy();
        this.bars.clear();
      }
    },
  );
}
