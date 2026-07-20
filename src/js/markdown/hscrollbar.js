// hscrollbar.js
//
// Shared floating horizontal scrollbar thumb for the live preview's scroll
// surfaces: per-block fenced-code panning (markdown-preview.js) and the table
// widget's scroller (markdown-table.js). Pure module — no CodeMirror
// dependency.
//
// Design differs from the app's vertical scrollbar (js/scrollbar.js) on
// purpose:
//   • The thumb is position:absolute INSIDE the editor's .cm-scroller (which
//     is position:relative — the title input already relies on that), in
//     scroller-CONTENT coordinates. It therefore rides along with vertical
//     scrolling for free and is clipped by the scroller for free — no
//     per-scroll repositioning, no viewport clamp math, and it naturally
//     sits under overlays (settings, dialogs) that cover the editor.
//   • The bar does NOT install its own window listeners for proximity. The
//     OWNER routes events in (pointer(), showTemp(), sync()); pointer() only
//     compares against the cached metrics from the last sync(), so it does
//     ZERO layout reads — safe to call for every bar on every mousemove.
//
// Metrics contract for sync(m) — all values in scroller-content px:
//   trackLeft / trackWidth   horizontal span the thumb travels in
//   y                        BOTTOM edge of the thumb, fixed. The thumb is
//                            anchored here and grows UPWARD when it thickens
//                            (thin bar sits flush at the bottom; hovering
//                            expands it up, not down).
//   scrollLeft / maxScroll   current offset and its ceiling
//   clientWidth              visible width of the scroll surface (thumb
//                            length = clientWidth / (clientWidth+maxScroll))
//   hoverRect {left,right,top,bottom}
//                            area that counts as "hovering the surface"
// Pass null (or maxScroll <= 0) to declare "nothing to scroll" — the thumb
// hides and pointer() becomes a no-op until the next real sync.

const THIN = 4;
const THICK = 8;
const MIN_THUMB = 24;
const FADE_AFTER = 1000;
const NEAR_PAD = 14; // px above the bar strip that counts as "near"

// Coalesce a high-frequency handler (mousemove, resize) to one call per frame,
// always with the most recent arguments. Lives here because the two owners of a
// floating bar — the table widget and the fenced-code plugin — are the ones
// routing those events in.
export function rafThrottle(fn) {
  let queued = false;
  let args = null;
  const run = () => {
    queued = false;
    const a = args;
    args = null;
    if (a) fn(...a);
  };
  const wrapped = (...a) => {
    args = a;
    if (queued) return;
    queued = true;
    window.requestAnimationFrame(run);
  };
  wrapped.cancel = () => {
    queued = false;
    args = null;
  };
  return wrapped;
}

export function createHBar({ container, onDrag }) {
  const thumb = document.createElement("div");
  thumb.className = "cm-md-hbar-thumb";
  container.appendChild(thumb);

  let m = null; // last usable metrics from sync()
  let visible = false;
  let near = false;
  let dragging = false;
  let hideTimer = null;
  let destroyed = false;
  // The thumb is NOT a descendant of the surface it scrolls — it lives in
  // .cm-scroller while the owner routes pointer positions from its own
  // element. So moving the pointer onto the thumb reads, to the owner, as
  // leaving the surface: it fires pointerLeave(), near drops, and the fade
  // timer runs to completion under a perfectly stationary cursor. Nothing can
  // revive it either, because the owner sees no mousemove while the pointer
  // rests on the thumb. Hence the thumb tracks its own hover, and that flag
  // outranks anything the owner routes in.
  let hoverThumb = false;

  const isActive = () => visible || near || dragging || hoverThumb;

  function thumbBox() {
    const total = m.clientWidth + m.maxScroll;
    const w = Math.max(
      MIN_THUMB,
      Math.min(m.trackWidth, (m.clientWidth / total) * m.trackWidth),
    );
    const maxX = Math.max(0, m.trackWidth - w);
    const x =
      m.maxScroll > 0
        ? (Math.min(m.scrollLeft, m.maxScroll) / m.maxScroll) * maxX
        : 0;
    return { w, x, maxX };
  }

  function render() {
    if (!m) return;
    const { w, x } = thumbBox();
    const h = near || dragging ? THICK : THIN;
    thumb.style.width = w + "px";
    thumb.style.height = h + "px";
    thumb.style.left = m.trackLeft + x + "px";
    // m.y is the fixed BOTTOM edge — top = y - height pins the bottom so the
    // bar grows upward when it thickens. height must NOT be CSS-animated (see
    // markdown-preview.css): top is written here every frame, so an animated
    // height would lag behind the instant top and make the bar teleport up
    // then expand back down. Both dims change together, same frame.
    thumb.style.top = m.y - h + "px";
  }

  function hide() {
    if (dragging) return;
    visible = false;
    clearTimeout(hideTimer);
    thumb.classList.remove("visible");
  }

  function show() {
    if (!m) return;
    if (!visible) {
      // First paint at a new position must not animate FROM the stale one:
      // suppress transitions, place, flush, restore (scrollbar.js trick).
      thumb.style.transition = "none";
      render();
      void thumb.offsetWidth;
      thumb.style.transition = "";
    }
    visible = true;
    thumb.classList.add("visible");
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (dragging || near || hoverThumb) return;
      hide();
    }, FADE_AFTER);
  }

  function sync(metrics) {
    if (destroyed) return;
    if (!metrics || metrics.maxScroll <= 0) {
      m = null;
      if (!dragging) {
        near = false;
        hide();
      }
      return;
    }
    m = metrics;
    render();
  }

  // Owner routes pointer positions in SCROLLER-CONTENT coordinates. Touches
  // only cached metrics — no layout reads.
  function pointer(x, y) {
    if (destroyed || !m || dragging || hoverThumb) return;
    const hr = m.hoverRect;
    const inside =
      x >= hr.left && x <= hr.right && y >= hr.top && y <= hr.bottom;
    // Near = within NEAR_PAD above the bottom anchor (the thumb lives above
    // m.y and grows further up when thick, so the zone opens upward).
    const nearNow = inside && y <= m.y && y >= m.y - THICK - NEAR_PAD;
    if (nearNow !== near) {
      near = nearNow;
      if (near) show();
      render(); // thickness change
    }
    if (inside) {
      show();
      scheduleHide();
    } else if (visible) {
      scheduleHide();
    }
  }

  function pointerLeave() {
    // The owner fires this when the pointer moves onto the thumb, so a hovered
    // thumb must veto it — otherwise it hides the very thing under the cursor.
    if (hoverThumb || dragging) return;
    near = false;
    scheduleHide();
  }

  // Hovering the thumb pins it open: no fade timer, and it stays thick. The
  // pointer being on the thumb at all means the surface is in play, so this
  // takes the same path as the owner's own "near" state.
  function onThumbEnter() {
    if (destroyed || !m) return;
    hoverThumb = true;
    clearTimeout(hideTimer);
    near = true;
    show();
    render();
  }

  function onThumbLeave() {
    hoverThumb = false;
    if (destroyed || dragging) return;
    // The owner will re-assert `near` on its next routed mousemove if the
    // pointer merely stepped off the thumb onto the surface; until then treat
    // it as left, and let the normal fade timer decide.
    near = false;
    render();
    scheduleHide();
  }

  function showTemp() {
    if (destroyed || !m) return;
    show();
    scheduleHide();
  }

  // ── Thumb drag ────────────────────────────────────────────────────────────
  // Client-px deltas equal content-px deltas 1:1, so the drag math never
  // needs a coordinate conversion. Baseline (start X / start scrollLeft) is
  // captured at mousedown, so owner syncs mid-drag can't corrupt it. Same
  // rAF coalescing + overshoot anchor reset as the vertical scrollbar.
  let dragStartX = 0;
  let dragStartScroll = 0;
  let dragRaf = false;
  let lastDragE = null;

  function onThumbDown(e) {
    if (e.button !== 0 || !m) return;
    e.preventDefault(); // keeps editor focus/caret
    e.stopPropagation();
    dragging = true;
    near = true;
    thumb.classList.add("dragging");
    dragStartX = e.clientX;
    dragStartScroll = Math.min(m.scrollLeft, m.maxScroll);
    show();
    render();
    window.addEventListener("mousemove", onDragMove, { capture: true });
    window.addEventListener("mouseup", onDragUp, { capture: true });
  }

  function onDragMove(e) {
    if (!dragging) return;
    e.preventDefault();
    e.stopPropagation();
    lastDragE = e;
    if (!dragRaf) {
      dragRaf = true;
      window.requestAnimationFrame(processDrag);
    }
  }

  function processDrag() {
    dragRaf = false;
    if (destroyed || !dragging || !m) return;
    const e = lastDragE;
    lastDragE = null;
    if (!e) return;
    const { maxX } = thumbBox();
    if (maxX <= 0) return;
    const dx = e.clientX - dragStartX;
    const raw = dragStartScroll + (dx / maxX) * m.maxScroll;
    // Reset anchor on overshoot to prevent a deadzone (scrollbar.js pattern).
    if (raw < 0) {
      dragStartX = e.clientX;
      dragStartScroll = 0;
    } else if (raw > m.maxScroll) {
      dragStartX = e.clientX;
      dragStartScroll = m.maxScroll;
    }
    onDrag(Math.max(0, Math.min(m.maxScroll, raw)));
  }

  function onDragUp() {
    if (!dragging) return;
    dragging = false;
    lastDragE = null;
    thumb.classList.remove("dragging");
    window.removeEventListener("mousemove", onDragMove, { capture: true });
    window.removeEventListener("mouseup", onDragUp, { capture: true });
    scheduleHide();
  }

  thumb.addEventListener("mousedown", onThumbDown);
  thumb.addEventListener("mouseenter", onThumbEnter);
  thumb.addEventListener("mouseleave", onThumbLeave);

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    clearTimeout(hideTimer);
    thumb.removeEventListener("mousedown", onThumbDown);
    thumb.removeEventListener("mouseenter", onThumbEnter);
    thumb.removeEventListener("mouseleave", onThumbLeave);
    window.removeEventListener("mousemove", onDragMove, { capture: true });
    window.removeEventListener("mouseup", onDragUp, { capture: true });
    lastDragE = null;
    thumb.remove();
  }

  return { sync, pointer, pointerLeave, showTemp, isActive, destroy };
}
