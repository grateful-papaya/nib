import {
  setScrollbarDragging,
  isSettingsSliderDragging,
} from "./state/uiState.js";
import { getEditorView } from "./state/editorState.js";

const THIN = 4;
const THICK = 8;
const EDITOR_HOVER_SHIFT = 4; // extra left offset for the editor thumb when thick
const NEAR_ZONE = 22;
const FADE_AFTER = 1000;
const TYPING_HIDE = 900;
const MIN_THUMB = 24;

export function attachScrollbar(scrollEl, opts = {}) {
  if (!scrollEl) return () => {};
  if (scrollEl._detachCustomScrollbar) scrollEl._detachCustomScrollbar();

  const isEditor = !!opts.editor;
  const isSettings = !!opts.settings;
  const isSidebar = !!opts.sidebar;
  // How far the thumb's travel stops short of the track's bottom edge.
  // Defaults preserve prior behavior (0 for sidebar, 16 elsewhere); callers
  // with their own rounded-corner containers (e.g. a dropdown) can pass an
  // explicit value instead so the thumb doesn't ride into the border-radius.
  const bottomGap =
    typeof opts.bottomGap === "number" ? opts.bottomGap : isSidebar ? 0 : 16;

  const thumb = document.createElement("div");
  thumb.className = isSidebar
    ? "custom-scrollbar-thumb custom-scrollbar-thumb--sidebar"
    : "custom-scrollbar-thumb";
  document.body.appendChild(thumb);

  let visible = false;
  let near = false;
  let dragging = false;
  let hideTimer = null;
  let typingTimer = null;
  let typingHidden = false;
  let pointerInside = false;
  let placed = false;
  let renderTicking = false;
  // Set on detach so any rAF callback already queued for this frame bails out
  // instead of touching a scrollEl whose thumb has been removed.
  let detached = false;

  function metrics() {
    const rect = scrollEl.getBoundingClientRect();
    const sh = scrollEl.scrollHeight;
    const ch = scrollEl.clientHeight;
    const st = scrollEl.scrollTop;
    const scrollable = sh - ch;
    return { rect, sh, ch, st, scrollable };
  }

  function hideInstantly() {
    if (!visible) return;
    visible = false;
    clearTimeout(hideTimer);

    thumb.style.transition = "none";
    thumb.classList.remove("visible");
    void thumb.offsetWidth;
    thumb.style.transition = "";
  }

  scrollEl._hideScrollbarInstantly = hideInstantly;

  function isSettingsOpen() {
    return !!(
      document.querySelector(".window.settings-active") ||
      document.querySelector(".settings-overlay.visible")
    );
  }

  function show() {
    if (typingHidden) return;
    if (!isSettings && isSettingsOpen()) {
      hideInstantly();
      return;
    }
    if (isSettings && isSettingsSliderDragging()) {
      hideInstantly();
      return;
    }
    if (metrics().scrollable <= 0) return;

    visible = true;
    thumb.classList.add("visible");
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (dragging || near) return;
      visible = false;
      thumb.classList.remove("visible");
    }, FADE_AFTER);
  }

  // Accepts an already-read metrics object so a caller that has just paid for
  // one getBoundingClientRect() this frame doesn't force a second reflow.
  function calculateStyles(m = metrics()) {
    const { rect, sh, ch, st, scrollable } = m;
    if (scrollable <= 0) return { scrollable };

    const trackH = ch;
    const thumbH = Math.max(MIN_THUMB, (ch / sh) * trackH);
    const maxThumbTop = Math.max(0, trackH - thumbH - bottomGap);
    const top = scrollable > 0 ? (st / scrollable) * maxThumbTop : 0;

    const isThick = near || dragging;
    const editorShift = isEditor && isThick ? EDITOR_HOVER_SHIFT : 0;

    return {
      scrollable,
      width: isThick ? THICK : THIN,
      thumbH,
      rightPx: window.innerWidth - rect.right + 2 + editorShift,
      topPx: rect.top + top,
    };
  }

  function applyStyles(styles) {
    if (isSettings && isSettingsSliderDragging()) {
      hideInstantly();
      return;
    }
    if (!isSettings && isSettingsOpen()) {
      hideInstantly();
      return;
    }
    if (styles.scrollable <= 0) {
      if (visible) hideInstantly();
      return;
    }

    if (!placed) {
      thumb.style.transition = "none";
      thumb.style.width = styles.width + "px";
      thumb.style.height = styles.thumbH + "px";
      thumb.style.right = styles.rightPx + "px";
      thumb.style.top = styles.topPx + "px";
      void thumb.offsetWidth;
      thumb.style.transition = "";
      placed = true;
      return;
    }

    thumb.style.width = styles.width + "px";
    thumb.style.height = styles.thumbH + "px";
    thumb.style.right = styles.rightPx + "px";
    thumb.style.top = styles.topPx + "px";
  }

  function requestRender() {
    if (!renderTicking) {
      renderTicking = true;
      window.requestAnimationFrame(() => {
        renderTicking = false;
        if (detached) return;
        applyStyles(calculateStyles());
      });
    }
  }

  // ── Scroll ────────────────────────────────────────────────────────────────
  function onScroll() {
    if (isEditor && typingHidden) return;
    if (isSettings && isSettingsSliderDragging()) {
      hideInstantly();
      return;
    }
    show();
    requestRender();
    scheduleHide();
  }

  // ── Pointer proximity ─────────────────────────
  // A window-wide mousemove fires far more often than one per frame (high-poll
  // mice easily hit 8–16 events/frame). Doing the getBoundingClientRect() read
  // inline on every event is the biggest steady-state cost on a slow machine,
  // so the handler now only stashes the latest event and coalesces the actual
  // layout read + proximity math into a single rAF per frame. The `e.buttons`
  // guard stays inline (and short-circuits BEFORE scheduling) so a text-
  // selection drag still costs nothing.
  let pointerRafPending = false;
  let lastPointerEvent = null;

  function onPointerMove(e) {
    if (e.buttons !== 0 && !dragging) return;
    lastPointerEvent = e;
    if (!pointerRafPending) {
      pointerRafPending = true;
      window.requestAnimationFrame(processPointer);
    }
  }

  function processPointer() {
    pointerRafPending = false;
    if (detached) return;

    const e = lastPointerEvent;
    lastPointerEvent = null;
    if (!e) return;

    // These guards read DOM state / flags, not layout, so keeping them here
    // (one frame later than the raw event) is behaviorally identical.
    if (!isSettings && isSettingsOpen()) {
      pointerInside = false;
      near = false;
      hideInstantly();
      return;
    }
    if (isSettings && isSettingsSliderDragging()) {
      pointerInside = false;
      near = false;
      hideInstantly();
      return;
    }

    const m = metrics(); // the single layout read for this frame
    const { rect } = m;
    const insideY = e.clientY >= rect.top && e.clientY <= rect.bottom;
    const insideX = e.clientX >= rect.left && e.clientX <= rect.right;
    pointerInside = insideX && insideY;

    const nearNow =
      insideY &&
      e.clientX >= rect.right - NEAR_ZONE &&
      e.clientX <= rect.right + 4;

    if (nearNow !== near) {
      near = nearNow;
      if (near) show();
      // Reuse the metrics we already read instead of scheduling another rAF
      // that would pay for a second getBoundingClientRect().
      applyStyles(calculateStyles(m));
    }
    if (pointerInside && !typingHidden) {
      show();
      scheduleHide();
    }
  }

  function onPointerLeaveWindow() {
    pointerInside = false;
    near = false;
    scheduleHide();
  }

  // ── Drag the thumb ──────────────────────────────────────────────────────────
  let dragStartY = 0;
  let dragStartScroll = 0;

  function onThumbDown(e) {
    e.preventDefault();
    e.stopPropagation();

    dragging = true;
    thumb.classList.add("dragging");
    setScrollbarDragging(true);

    dragStartY = e.clientY;
    dragStartScroll = scrollEl.scrollTop;
    near = true;

    show();
    applyStyles(calculateStyles());

    // Capture phase prevents DOM elements (like editors) from stopping the event
    window.addEventListener("mousemove", onDragMove, { capture: true });
    window.addEventListener("mouseup", onDragUp, { capture: true });
  }

  // preventDefault/stopPropagation must run synchronously on the event, so they
  // stay here; the scrollTop write + reposition (the expensive part) is
  // coalesced to one rAF per frame the same way proximity is.
  let dragRafPending = false;
  let lastDragEvent = null;

  function onDragMove(e) {
    if (!dragging) return;
    e.preventDefault();
    e.stopPropagation();

    lastDragEvent = e;
    if (!dragRafPending) {
      dragRafPending = true;
      window.requestAnimationFrame(processDrag);
    }
  }

  function processDrag() {
    dragRafPending = false;
    if (detached || !dragging) return;

    const e = lastDragEvent;
    lastDragEvent = null;
    if (!e) return;

    const { sh, ch, scrollable } = metrics();
    const trackH = ch;
    const thumbH = Math.max(MIN_THUMB, (ch / sh) * trackH);
    const maxThumbTop = Math.max(0, trackH - thumbH - bottomGap);

    const dy = e.clientY - dragStartY;
    const deltaScroll = maxThumbTop > 0 ? (dy / maxThumbTop) * scrollable : 0;
    const rawScrollTop = dragStartScroll + deltaScroll;

    // Reset anchor on overshoot to prevent deadzone
    if (rawScrollTop < 0) {
      dragStartY = e.clientY;
      dragStartScroll = 0;
    } else if (rawScrollTop > scrollable) {
      dragStartY = e.clientY;
      dragStartScroll = scrollable;
    }

    scrollEl.scrollTop = Math.max(0, Math.min(scrollable, rawScrollTop));
    applyStyles(calculateStyles());
  }

  function onDragUp() {
    if (!dragging) return;

    dragging = false;
    lastDragEvent = null;
    thumb.classList.remove("dragging");
    setScrollbarDragging(false);

    window.removeEventListener("mousemove", onDragMove, { capture: true });
    window.removeEventListener("mouseup", onDragUp, { capture: true });
    scheduleHide();
  }

  // ── Editor: hide while typing ───────────────────────────────────────────────
  function onKeyTyping() {
    if (!isEditor) return;
    typingHidden = true;
    hideInstantly();
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      typingHidden = false;
    }, TYPING_HIDE);
  }

  const reposition = () => applyStyles(calculateStyles());
  const ro = new ResizeObserver(reposition);
  ro.observe(scrollEl);
  window.addEventListener("resize", reposition);

  // ── Detach ──────────────────────────────────────────────────────────────────
  const detachFunc = function detach() {
    detached = true;

    scrollEl.removeEventListener("scroll", onScroll);
    window.removeEventListener("mousemove", onPointerMove);
    document.removeEventListener("mouseleave", onPointerLeaveWindow);
    thumb.removeEventListener("mousedown", onThumbDown);
    if (isEditor) scrollEl.removeEventListener("keydown", onKeyTyping, true);

    ro.disconnect();
    window.removeEventListener("resize", reposition);

    window.removeEventListener("mousemove", onDragMove, { capture: true });
    window.removeEventListener("mouseup", onDragUp, { capture: true });

    lastPointerEvent = null;
    lastDragEvent = null;

    clearTimeout(hideTimer);
    clearTimeout(typingTimer);
    thumb.remove();

    delete scrollEl.dataset.scrollbarAttached;
    delete scrollEl._detachCustomScrollbar;
    delete scrollEl._hideScrollbarInstantly;
    scrollEl.classList.remove("custom-scroll");
  };

  scrollEl.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("mousemove", onPointerMove);
  document.addEventListener("mouseleave", onPointerLeaveWindow);
  thumb.addEventListener("mousedown", onThumbDown);

  if (isEditor) scrollEl.addEventListener("keydown", onKeyTyping, true);

  scrollEl._detachCustomScrollbar = detachFunc;
  return detachFunc;
}

export function hideAllScrollbarsInstantly() {
  document.querySelectorAll(".custom-scroll").forEach((el) => {
    if (el._hideScrollbarInstantly) el._hideScrollbarInstantly();
  });
}

// ── Wiring ───────────────────────────────────────────────────────────
let activeScrollbarDetachers = [];

export function initCustomScrollbars() {
  if (activeScrollbarDetachers.length > 0) {
    activeScrollbarDetachers.forEach((detach) => detach());
    activeScrollbarDetachers = [];
  }

  const detachers = [];

  const attach = (el, options) => {
    if (!el || el.dataset.scrollbarAttached) return;
    el.classList.add("custom-scroll");
    el.dataset.scrollbarAttached = "1";
    detachers.push(attachScrollbar(el, options));
  };

  attach(document.querySelector(".file-tree-container"), { sidebar: true });
  attach(document.querySelector(".settings-menu"), { settings: true });
  attach(document.querySelector(".settings-body"), { settings: true });

  const tryEditor = (tries = 0) => {
    const scroller =
      getEditorView()?.scrollDOM || document.querySelector(".cm-scroller");
    if (scroller) {
      attach(scroller, { editor: true });
    } else if (tries < 20) {
      setTimeout(() => tryEditor(tries + 1), 100);
    }
  };
  tryEditor();

  activeScrollbarDetachers = detachers;

  return () => {
    detachers.forEach((d) => d());
    activeScrollbarDetachers = [];
  };
}
